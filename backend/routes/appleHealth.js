const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseHealthAutoExportDate, dateObjToLocalDateString, getWarsawWallClock } = require('../utils/dates');

// Webhook receiving data from the "Health Auto Export" iOS app - a bridge between Apple
// Health and this backend. HealthKit has no public cloud API, so an intermediary running
// on the phone is required (see https://github.com/Lybron/health-auto-export).
//
// AUTHORISATION: this endpoint does NOT use sessions or cookies - the phone app sends the
// request in the background, with no browser. We identify the user by their unique
// `sync_token` (the users.sync_token column, long present in the database and visible in
// Settings) written directly into the webhook URL. This router MUST therefore be mounted
// in server.js BEFORE
// `app.use('/api', requireAuth)` - just like routes/healthcheck.js.
//
// RECONCILIATION WITH OURA: the Oura Ring also provides steps/active_calories/
// total_calories (services/sync.js). Oura used to be treated as the more authoritative
// source, but in practice Oura (and Withings) data syncs into Apple Health on the phone
// anyway - which makes Apple Health the fullest and fastest source. Oura can lag: daily
// figures usually finalise the following morning (see the earlier diagnosis via
// scripts/check-oura-api.sh). The priority was therefore inverted: Apple Health is now the
// AUTHORITATIVE source for activity.
// The health_metrics.activity_source column ('apple' | 'google_fit' | 'oura') records who
// last wrote activity data for a given date. The source hierarchy is defined once for the
// whole application, in utils/activitySources.js:
//   - This webhook sits at the top of the hierarchy, so it ALWAYS overwrites activity data
//     and sets activity_source='apple'. It needs no protective clause.
//   - syncOura and syncGoogleFit (services/sync.js) build their ON CONFLICT clauses from
//     that same hierarchy via preserveHigherPriority()/preserveSourceLabel(), so they will
//     not overwrite a column holding real data from a higher-ranked source. Previously the
//     only thing guarded against was overwriting 'apple', while Google Fit and Oura
//     overwrote each other - the result for a given day then depended on sync order.
//
// PAYLOAD FORMAT (Health Auto Export, the "REST API" automation type):
//   { "data": { "metrics": [ { "name": "step_count", "units": "steps",
//       "data": [ { "date": "2026-06-18 14:00:00 +0200", "qty": 1234 }, ... ] }, ... ] } }
// The "name" field is always a snake_case metric identifier ("step_count",
// "active_energy", "basal_energy_burned", "apple_exercise_time") - NOT the display name
// from the app's UI ("Step Count"). Confirmed against sample payloads from the
// documentation and community (ladvien.com, irvinlim/apple-health-ingester among others).
//
// We handle only the metrics needed for the calorie balance (steps, calories, active
// minutes), wrist temperature, distance and water ("Dietary Water" - see METRIC_FIELD_MAP
// below) from data.metrics[]. Other metrics in the payload, such as sleep, are simply
// ignored rather than treated as an error. EXCEPTION: per-workout heart rate from
// data.workouts[] (avgHeartRate/maxHeartRate/heartRateData) IS handled - see the "CARDIO
// ZONES" section below - provided the user enabled the "Include Workout Metrics" toggle in
// the Health Auto Export automation on their phone. It is off by default, and without it
// the workout payload carries no heart-rate fields at all.

// Upper size limits for the webhook payload (round 12, security audit) - see the comment
// where they are used in the POST handler below.
const MAX_METRIC_ENTRIES_PER_REQUEST = 20000;
const MAX_WORKOUTS_PER_REQUEST = 500;

const KJ_TO_KCAL = 1 / 4.184;

// Health Auto Export may send energy in "kJ" or "kcal" depending on the phone's regional
// unit settings - we always convert to kcal.
function toKcal(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'kj' || u === 'kilojoule' || u === 'kilojoules') {
    return qty * KJ_TO_KCAL;
  }
  return qty;
}

// Health Auto Export may send temperature in Fahrenheit (on a phone with US regional
// units) or Celsius - we always convert to °C.
function toCelsius(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'degf' || u === 'fahrenheit' || u === '°f' || u === 'f') {
    return (qty - 32) * (5 / 9);
  }
  return qty;
}

// Health Auto Export sends distance in "km" or "mi" depending on the phone's regional
// units - we always convert to metres (as with Oura and Google Fit).
function toMeters(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'mi' || u === 'mile' || u === 'miles') {
    return qty * 1609.344;
  }
  if (u === 'km' || u === 'kilometer' || u === 'kilometers' || u === 'kilometres') {
    return qty * 1000;
  }
  // 'm' / 'meter' / unknown - assume it is already in metres.
  return qty;
}

// Health Auto Export sends water ("Dietary Water" - HKQuantityTypeIdentifier dietaryWater)
// in "mL", "L" or "fl_oz_us"/"fl_oz_imp" depending on the phone's regional units - we
// always convert to millilitres, matching the health_metrics.water_ml column fed by
// /api/water/add in routes/health.js.
function toMilliliters(qty, units) {
  const u = (units || '').toLowerCase();
  if (u === 'l' || u === 'liter' || u === 'liters' || u === 'litre' || u === 'litres') {
    return qty * 1000;
  }
  if (u === 'fl_oz_us' || u === 'fl_oz' || u === 'floz' || u === 'fl oz' || u === 'oz' || u === 'fluid ounce' || u === 'fluid ounces') {
    return qty * 29.5735;
  }
  if (u === 'fl_oz_imp' || u === 'imperial fluid ounce' || u === 'imperial fluid ounces') {
    return qty * 28.4131;
  }
  if (u === 'cup' || u === 'cups') {
    return qty * 240;
  }
  // 'ml' / 'millilitre' / unknown - assume it is already in millilitres.
  return qty;
}

// CARDIO ZONES (Karvonen) per workout - see the migration in db.js
// (apple_health_workouts.avg_heart_rate/max_heart_rate/zone1_minutes..zone5_minutes). The
// same heart-rate-reserve percentages (50/60/70/80/90%) as the static "Heart rate zones"
// reference table on the Dashboard (frontend/src/components/Dashboard.jsx), and the same
// HRmax = 220 - age formula based on birth year (routes/dashboard.js) - so both cards show
// zone boundaries that agree with each other.
const KARVONEN_ZONE_UPPER_BOUNDS = [0.6, 0.7, 0.8, 0.9]; // <0.6 -> Z1, <0.7 -> Z2, <0.8 -> Z3, <0.9 -> Z4, >=0.9 -> Z5

function numOrNull(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const shiftDate = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Classifies a single heart-rate reading into zone 1-5 (Karvonen). Returns null when it
// cannot be computed: no HRmax, because the user has not set a birth year in their profile, or
// the heart-rate reserve comes out <= 0, e.g. a mistyped birth year giving HRmax <= RHR.
function classifyKarvonenZone(hr, userMaxHr, rhr) {
  if (!Number.isFinite(hr) || userMaxHr == null) return null;
  const hrReserve = userMaxHr - rhr;
  if (hrReserve <= 0) return null;
  const pct = (hr - rhr) / hrReserve;
  for (let i = 0; i < KARVONEN_ZONE_UPPER_BOUNDS.length; i++) {
    if (pct < KARVONEN_ZONE_UPPER_BOUNDS[i]) return i + 1;
  }
  return 5;
}

// Extracts a representative heart-rate value from one heartRateData sample. Health Auto
// Export uses DIFFERENT shapes depending on the export version ("Workouts v1": a `qty`
// field; "Workouts v2": `Min`/`Avg`/`Max` fields) - we take the average when present,
// otherwise the first available number.
function extractSampleHr(entry) {
  if (!entry) return null;
  const candidates = [entry.Avg, entry.avg, entry.qty, entry.Max, entry.max, entry.Min, entry.min];
  for (const c of candidates) {
    const n = numOrNull(c);
    if (n != null) return n;
  }
  return null;
}

const MAX_SAMPLE_GAP_MINUTES = 5; // Health Auto Export usually samples heart rate during
// a workout about once a minute - a larger gap between consecutive samples (lost samples,
// a duplicated timestamp) is clamped to this limit, so one hole in the data cannot credit
// tens of minutes to an arbitrary zone.
const DEFAULT_LAST_SAMPLE_MINUTES = 1; // duration assigned to the last sample in a series
// (there is no following sample, so the real gap cannot be computed).

// Computes the real distribution of workout minutes across the five Karvonen zones from
// the heart-rate sample series in the payload (workout.heartRateData). When the payload has
// no sample series but does carry the workout's averaged heart rate (workout.avgHeartRate)
// and we know the duration, a reasonable fallback assigns the ENTIRE duration to the single
// zone matching that average - still a real measured heart rate, just without its
// distribution over time, which beats having no zone data at all.
function computeWorkoutHrZones(workout, userMaxHr, rhr, durationMinutes) {
  const avgHrQty = numOrNull(workout.avgHeartRate && workout.avgHeartRate.qty)
    ?? numOrNull(workout.heartRate && workout.heartRate.avg && workout.heartRate.avg.qty);
  const maxHrQty = numOrNull(workout.maxHeartRate && workout.maxHeartRate.qty)
    ?? numOrNull(workout.heartRate && workout.heartRate.max && workout.heartRate.max.qty);

  if (userMaxHr == null) {
    // Without the user's birth year the Karvonen zones cannot be computed - we still return
    // the raw avg/max heart rate when the payload carries it, and leave the zones NULL.
    return { avgHr: avgHrQty, maxHr: maxHrQty, zones: [null, null, null, null, null] };
  }

  const rawSamples = Array.isArray(workout.heartRateData) ? workout.heartRateData : [];
  const samples = rawSamples
    .map((entry) => ({ date: parseHealthAutoExportDate(entry && entry.date), hr: extractSampleHr(entry) }))
    .filter((s) => s.date && s.hr != null)
    .sort((a, b) => a.date - b.date);

  const zones = [0, 0, 0, 0, 0];
  let hasZoneData = false;

  if (samples.length > 0) {
    for (let i = 0; i < samples.length; i++) {
      let dtMinutes = i < samples.length - 1
        ? (samples[i + 1].date - samples[i].date) / 60000
        : DEFAULT_LAST_SAMPLE_MINUTES;
      if (!Number.isFinite(dtMinutes) || dtMinutes <= 0) dtMinutes = DEFAULT_LAST_SAMPLE_MINUTES;
      dtMinutes = Math.min(dtMinutes, MAX_SAMPLE_GAP_MINUTES);

      const zone = classifyKarvonenZone(samples[i].hr, userMaxHr, rhr);
      if (zone) {
        zones[zone - 1] += dtMinutes;
        hasZoneData = true;
      }
    }
  } else if (avgHrQty != null && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    const zone = classifyKarvonenZone(avgHrQty, userMaxHr, rhr);
    if (zone) {
      zones[zone - 1] = durationMinutes;
      hasZoneData = true;
    }
  }

  return {
    avgHr: avgHrQty,
    maxHr: maxHrQty,
    zones: hasZoneData ? zones.map((z) => Math.round(z * 10) / 10) : [null, null, null, null, null]
  };
}

// Mapping of Health Auto Export metric names -> our fields in health_metrics.
// `field` is our internal bucket (see `byDate` below), not a 1:1 SQL column name -
// total_calories_burned is computed as active_calories + basal_calories.
// `mode: 'last'` (as opposed to the default summing): for wrist temperature we do NOT add
// up successive entries from the same day. It is a single overnight measurement, not a
// cumulative value like steps or calories - so we take the last value
// from the data batch.
const METRIC_FIELD_MAP = {
  step_count: { field: 'steps', convert: (qty) => qty },
  active_energy: { field: 'active_calories', convert: toKcal },
  basal_energy_burned: { field: 'basal_calories', convert: toKcal },
  apple_exercise_time: { field: 'active_minutes', convert: (qty) => qty },
  // Requires the "Wrist Temperature" metric to be enabled in the Health Auto Export
  // automation on the phone (off by default) - available only on Apple Watch Series
  // 8+/Ultra. A different value from Oura's `temperature_deviation`, which is a deviation
  // from baseline; this is an absolute value in °C.
  wrist_temperature: { field: 'wrist_temperature', convert: toCelsius, mode: 'last' },
  // Distance (walking + running) - previously not handled at all. The payload arrived if
  // the user had that metric enabled in the automation, but was silently ignored because
  // this map had no entry for it. Summed like steps and calories (a cumulative value across
  // the day rather than an instantaneous one).
  walking_running_distance: { field: 'distance_meters', convert: toMeters },
  // Water ("Dietary Water") - the source is the user's smart bottle, which logs intake into
  // Apple Health, from where Health Auto Export forwards it to this webhook.
  // Requires the "Dietary Water" metric to be enabled in the Health Auto Export automation
  // on the phone (off by default, like Wrist Temperature). NOTE: the JSON field name
  // "dietary_water" is inferred from the snake_case convention visible in the other
  // identifiers and from the HealthKit identifier
  // (HKQuantityTypeIdentifier.dietaryWater) - it could not be found verbatim in the Health
  // Auto Export documentation, whose wiki describes the general structure rather than a full
  // list of field names. If no water entries appear in the server log after enabling the
  // sync, check the webhook log to see which
  // name actually arrives in the payload, and correct the key in this map.
  dietary_water: { field: 'water_ml', convert: toMilliliters },
  resting_heart_rate: { field: 'rhr', convert: (qty) => qty, mode: 'last' },
  heart_rate_variability: { field: 'hrv', convert: (qty) => qty, mode: 'last' },
  heart_rate_variability_sdnn: { field: 'hrv', convert: (qty) => qty, mode: 'last' }
};

router.post('/api/integrations/apple-health/:syncToken', async (req, res) => {
  try {
    const { syncToken } = req.params;
    if (!syncToken || !syncToken.trim()) {
      return res.status(401).json({ error: 'Brak tokenu synchronizacji w adresie webhooka.' });
    }

    const user = await db.get(`
      SELECT id, birth_year,
        (SELECT 1 FROM oauth_tokens WHERE user_id = users.id AND service = 'oura') AS has_oura
      FROM users WHERE sync_token = ?
    `, [syncToken.trim()]);
    if (!user) {
      // Deliberately the same generic message as for a missing token - we do not want to
      // reveal whether the supplied token ever existed.
      return res.status(404).json({ error: 'Nieznany token synchronizacji.' });
    }

    // HRmax (220 - age) from the birth year - the same formula as in routes/dashboard.js,
    // needed here to compute the per-workout Karvonen zones (see computeWorkoutHrZones).
    // Bug fix: the year is read via getWarsawWallClock rather than a bare `new Date()` in
    // the Node process timezone - the same class of bug fixed in routes/dashboard.js (see
    // the comment there): during the Warsaw night window on a UTC server, `new
    // Date().getFullYear()` could still return the previous year, so the Karvonen cardio zones
    // of workouts saved in that short window would have used an HRmax a year too young.
    const currentYear = getWarsawWallClock().getUTCFullYear();
    const userMaxHr = user.birth_year ? (220 - (currentYear - user.birth_year)) : null;

    // Resting heart rate per workout day - cached within a single webhook request so we do
    // not query the database repeatedly for workouts from the same day.
    // Fallback: if a day has no RHR stored yet (Oura may sync later), we take the user's
    // most recent earlier known RHR; if none is known at all, we use an indicative 60 bpm
    // (a typical adult resting heart rate) - better than RHR=0, which would falsely inflate
    // the heart-rate reserve.
    const DEFAULT_RHR_FALLBACK = 60;
    const rhrCache = new Map();
    async function getRestingHrForDate(dateStr) {
      if (rhrCache.has(dateStr)) return rhrCache.get(dateStr);
      let rhr = null;
      const exact = await db.get(
        'SELECT rhr FROM health_metrics WHERE user_id = ? AND date = ? AND rhr IS NOT NULL',
        [user.id, dateStr]
      );
      if (exact && exact.rhr != null) rhr = exact.rhr;
      if (rhr == null) {
        const prior = await db.get(
          'SELECT rhr FROM health_metrics WHERE user_id = ? AND date < ? AND rhr IS NOT NULL ORDER BY date DESC LIMIT 1',
          [user.id, dateStr]
        );
        if (prior && prior.rhr != null) rhr = prior.rhr;
      }
      if (rhr == null) rhr = DEFAULT_RHR_FALLBACK;
      rhrCache.set(dateStr, rhr);
      return rhr;
    }

  // An automation with 'Data type: Workouts' sends its payload in a DIFFERENT format from
  // the general health-metrics automation - the data is in data.workouts[] rather than
  // data.metrics[] (confirmed from a manual 'Workouts-*.csv' export:
    // the Workout Type/Start/End/Active Energy (kJ)/Basal Energy (kJ)/... columns).
  // The exact shape of the workout object in JSON, confirmed from production logs:
    //   { id, name, start: "2026-06-18 06:00:26 +0200", end: "...",
    //     duration: 4715.99 (SECONDS), activeEnergyBurned: { qty: 2299.5, units: "kJ" },
    //     intensity: {...}, temperature: {...}, humidity: {...}, metadata: {} }
    // We map: activeEnergyBurned -> active_calories (after converting to kcal), and duration
    // (seconds -> minutes) -> active_minutes, assigned to the calendar day of the `start` field.
  // A workout does NOT provide basal_calories, so total_calories_burned is not computed here
    // (dashboard.js falls back to bmr + active_calories anyway when total_calories_burned is missing).
    //
  // NO RISK OF DOUBLE COUNTING: the user confirmed this is the ONLY configured Health Auto
  // Export automation - there is no parallel general-metrics automation already folding
  // workout calories into the daily active_energy - so writing activeEnergyBurned from
  // workouts as active_calories is safe.
    const rawMetrics = req.body && req.body.data && req.body.data.metrics;
    const rawWorkouts = req.body && req.body.data && req.body.data.workouts;
    const metrics = Array.isArray(rawMetrics) ? rawMetrics : null;
    const workouts = Array.isArray(rawWorkouts) ? rawWorkouts : null;

    if (!metrics && !workouts) {
      return res.status(400).json({ error: 'Nieprawidłowy format danych - oczekiwano pola data.metrics[] lub data.workouts[].' });
    }

    if (metrics) {
      console.log(`[APPLE HEALTH DEBUG] User ${user.id} sent metrics: [${metrics.filter(m => m && m.name).map(m => m.name).join(', ')}]`);
    }

    // Security audit (round 12): this webhook has NO session authentication - only the
    // sync_token in the URL, see the comment at the top of this file - and before this
    // change had NO upper limit on the number of entries in a payload. Every workout issues
    // sequential database queries (getRestingHrForDate + INSERT), and every metric entry is
    // processed in a loop, so a crafted payload with thousands of elements could occupy the
    // server for a long time (a DoS). A real Health Auto Export payload, even when sending
    // many days or automations at once, should not exceed these values.
    const totalMetricEntries = metrics
      ? metrics.reduce((sum, m) => sum + (m && Array.isArray(m.data) ? m.data.length : 0), 0)
      : 0;
    if (totalMetricEntries > MAX_METRIC_ENTRIES_PER_REQUEST) {
      return res.status(400).json({ error: `Za dużo wpisów metryk w jednym żądaniu (limit: ${MAX_METRIC_ENTRIES_PER_REQUEST}).` });
    }
    if (workouts && workouts.length > MAX_WORKOUTS_PER_REQUEST) {
      return res.status(400).json({ error: `Za dużo treningów w jednym żądaniu (limit: ${MAX_WORKOUTS_PER_REQUEST}).` });
    }

    // We sum all entries of a given metric or workout that fall on the same calendar day
    // (Health Auto Export may send data in several smaller batches, hourly for instance -
    // summing those batches gives the correct daily value for steps, calories and active
    // minutes, because those are cumulative rather than instantaneous).
    const byDate = {};
    let matchedEntries = 0;

    if (metrics) {
      for (const metric of metrics) {
        const name = metric && typeof metric.name === 'string' ? metric.name.toLowerCase() : '';
        
      // Special parser for sleep analysis (sleep_analysis), because it is a categorical metric
        if (name === 'sleep_analysis') {
          if (!Array.isArray(metric.data)) continue;
          if (metric.data.length > 0) {
            console.log(`[APPLE HEALTH DEBUG SLEEP] Pierwszy wpis: ${JSON.stringify(metric.data[0])}`);
          }
          for (const entry of metric.data) {
            const startStr = entry.startDate || entry.start_date || entry.sleepStart || entry.sleep_start || entry.inBedStart || entry.date;
            const endStr = entry.endDate || entry.end_date || entry.sleepEnd || entry.sleep_end || entry.inBedEnd;
            if (!startStr || !endStr) continue;

            const startParsed = parseHealthAutoExportDate(startStr);
            const endParsed = parseHealthAutoExportDate(endStr);
            if (!startParsed || !endParsed) continue;

        // By convention sleep duration is attributed to the day the user wakes up (endDate)
            const dateStr = dateObjToLocalDateString(endParsed);
            
            if (!byDate[dateStr]) {
              byDate[dateStr] = {
                steps: null, active_calories: null, basal_calories: null, active_minutes: null,
                wrist_temperature: null, distance_meters: null, water_ml: null,
                sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
                in_bed_duration: 0, rhr: null, hrv: null
              };
            }
            
            const bucket = byDate[dateStr];
            if (bucket.sleep_duration === null) {
              bucket.sleep_duration = 0;
              bucket.sleep_deep = 0;
              bucket.sleep_rem = 0;
            }

            const hasAggregatedFields = entry.totalSleep !== undefined || entry.total_sleep !== undefined || entry.core !== undefined;
            if (hasAggregatedFields) {
              const coreVal = numOrNull(entry.core) || 0;
              const deepVal = numOrNull(entry.deep) || 0;
              const remVal = numOrNull(entry.rem) || 0;
              const asleepVal = numOrNull(entry.asleep || entry.asleep_duration) || 0;
              const totalSleepVal = numOrNull(entry.totalSleep || entry.total_sleep);
              
              const calculatedInBed = (endParsed - startParsed) / (1000 * 60 * 60);
              const inBedVal = numOrNull(entry.inBed || entry.in_bed || entry.in_bed_duration || entry.inBedDuration) 
                || (Number.isFinite(calculatedInBed) && calculatedInBed > 0 ? calculatedInBed : 0);

              const computedSleep = totalSleepVal !== null ? totalSleepVal : (coreVal + deepVal + remVal + asleepVal);
              
              bucket.sleep_duration += computedSleep;
              bucket.sleep_deep += deepVal;
              bucket.sleep_rem += remVal;
              bucket.in_bed_duration += inBedVal;
              matchedEntries++;
            } else {
              const durationHrs = (endParsed - startParsed) / (1000 * 60 * 60);
              if (durationHrs <= 0 || durationHrs > 24) continue; // sanity check

              const val = typeof entry.value === 'string' ? entry.value.toLowerCase() : '';
              if (val.includes('deep')) {
                bucket.sleep_deep += durationHrs;
                bucket.sleep_duration += durationHrs;
              } else if (val.includes('rem')) {
                bucket.sleep_rem += durationHrs;
                bucket.sleep_duration += durationHrs;
              } else if (val.includes('core') || val.includes('asleep') || val.includes('light')) {
                bucket.sleep_duration += durationHrs;
              } else if (val.includes('in_bed') || val.includes('inbed')) {
                bucket.in_bed_duration += durationHrs;
              }
              matchedEntries++;
            }
          }
          continue;
        }

        const handler = METRIC_FIELD_MAP[name];
        if (!handler || !Array.isArray(metric.data)) continue;

        for (const entry of metric.data) {
          const rawQty = entry && entry.qty;
          const qty = typeof rawQty === 'number' ? rawQty : parseFloat(rawQty);
          if (!Number.isFinite(qty)) continue;
          if (qty < 0 && handler.mode !== 'last') continue;

          const parsedDate = parseHealthAutoExportDate(entry.date);
          if (!parsedDate) continue;

          const dateStr = dateObjToLocalDateString(parsedDate);
          if (!byDate[dateStr]) {
            byDate[dateStr] = {
              steps: null, active_calories: null, basal_calories: null, active_minutes: null,
              wrist_temperature: null, distance_meters: null, water_ml: null,
              sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
              in_bed_duration: 0, rhr: null, hrv: null
            };
          }
          const bucket = byDate[dateStr];
          const converted = handler.convert(qty, metric.units);
          if (name === 'dietary_water') {
    // Round 3 (audit): water idempotency - store the sample keyed by user_id and timestamp
            const timestamp = entry.date || parsedDate.toISOString();
            const insertResult = await db.run(`
              INSERT OR IGNORE INTO apple_health_water_samples (user_id, timestamp, date, qty)
              VALUES (?, ?, ?, ?)
            `, [user.id, timestamp, dateStr, converted]);
            if (insertResult.changes > 0) {
              bucket[handler.field] = (bucket[handler.field] || 0) + converted;
            }
          } else {
            bucket[handler.field] = handler.mode === 'last'
              ? converted
              : (bucket[handler.field] || 0) + converted;
          }
          matchedEntries++;
        }
      }
    }

    // Every workout is FIRST stored separately, identified by workout.id, in the
    // apple_health_workouts table - see the comment on that table in db.js for why (avoiding
    // double counting when the same workout is re-sent, and correctly summing several
    // workouts from one day delivered across different webhook calls). The daily total in
    // health_metrics is computed AT THE END as SUM(...) over that table for every day this
    // payload touches - we never increment it directly from the request body.
    let matchedWorkouts = 0;
    const workoutAffectedDates = new Set();
    if (workouts) {
      for (const workout of workouts) {
        if (!workout || !workout.id) continue;

        const parsedDate = parseHealthAutoExportDate(workout.start);
        if (!parsedDate) continue;
        const dateStr = dateObjToLocalDateString(parsedDate);

        let activeCaloriesKcal = 0;
        const energy = workout.activeEnergyBurned;
        if (energy && typeof energy.qty === 'number') {
          activeCaloriesKcal = toKcal(energy.qty, energy.units);
        }

        let durationMinutes = 0;
        const durationSec = typeof workout.duration === 'number' ? workout.duration : parseFloat(workout.duration);
        if (Number.isFinite(durationSec)) {
          durationMinutes = durationSec / 60;
        }

        // `workout.name` is the workout type from the app's UI (e.g. "Running", "Functional
      // Strength Training') - see the confirmed workout object shape in the comment above
      // this handler. We store it so the Dashboard can show
      // the 'Latest activity' section with a real name and icon rather than an empty list.
        const workoutType = typeof workout.name === 'string' && workout.name.trim()
          ? workout.name.trim()
          : null;

      // Cardio zones (Karvonen) per workout - see computeWorkoutHrZones above.
      // Requires the RHR from the workout's own day, not from 'today' - a workout can belong
      // to any earlier date in the payload.
        const rhrForWorkoutDate = await getRestingHrForDate(dateStr);
        const hrZones = computeWorkoutHrZones(workout, userMaxHr, rhrForWorkoutDate, durationMinutes);

        await db.run(`
          INSERT INTO apple_health_workouts (
            user_id, workout_id, date, active_calories, duration_minutes, workout_type,
            avg_heart_rate, max_heart_rate, zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
          ON CONFLICT(user_id, workout_id) DO UPDATE SET
            date = excluded.date,
            active_calories = excluded.active_calories,
            duration_minutes = excluded.duration_minutes,
            workout_type = excluded.workout_type,
            avg_heart_rate = excluded.avg_heart_rate,
            max_heart_rate = excluded.max_heart_rate,
            zone1_minutes = excluded.zone1_minutes,
            zone2_minutes = excluded.zone2_minutes,
            zone3_minutes = excluded.zone3_minutes,
            zone4_minutes = excluded.zone4_minutes,
            zone5_minutes = excluded.zone5_minutes,
            updated_at = excluded.updated_at
        `, [
          user.id, String(workout.id), dateStr, activeCaloriesKcal, durationMinutes, workoutType,
          hrZones.avgHr, hrZones.maxHr, hrZones.zones[0], hrZones.zones[1], hrZones.zones[2], hrZones.zones[3], hrZones.zones[4]
        ]);

        workoutAffectedDates.add(dateStr);
        matchedWorkouts++;
      }

      for (const dateStr of workoutAffectedDates) {
        const sums = await db.get(
          `SELECT SUM(active_calories) AS total_calories, SUM(duration_minutes) AS total_minutes
           FROM apple_health_workouts WHERE user_id = ? AND date = ?`,
          [user.id, dateStr]
        );
        if (!byDate[dateStr]) {
          byDate[dateStr] = {
            steps: null, active_calories: null, basal_calories: null, active_minutes: null,
            wrist_temperature: null, distance_meters: null, water_ml: null,
            sleep_duration: null, sleep_deep: null, sleep_rem: null, sleep_score: null,
            in_bed_duration: 0, rhr: null, hrv: null
          };
        }
        byDate[dateStr].active_calories = sums && sums.total_calories !== null ? sums.total_calories : 0;
        byDate[dateStr].active_minutes = sums && sums.total_minutes !== null ? sums.total_minutes : 0;
      }
    }

    // Post-processing of the sleep data and computing sleep_score against the user's target
    const sleepGoalRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'target_sleep_duration'", [user.id]);
    const targetSleep = sleepGoalRow ? parseFloat(sleepGoalRow.value) : 7.2;

    for (const dateStr of Object.keys(byDate)) {
      const bucket = byDate[dateStr];
      if (bucket.sleep_duration !== null) {
      // If no sleep stages were recorded but we do have time in bed (an older watch, or no sleep stages)
        if (bucket.sleep_duration === 0 && bucket.in_bed_duration > 0) {
          bucket.sleep_duration = bucket.in_bed_duration;
        }
        
      // Sanity guard (at most 24h per day)
        if (bucket.sleep_duration > 24) bucket.sleep_duration = 24;
        if (bucket.sleep_deep > 24) bucket.sleep_deep = 24;
        if (bucket.sleep_rem > 24) bucket.sleep_rem = 24;
        
        // Computing sleep_score (0-100) from the sleep goal
        bucket.sleep_score = Math.min(100, Math.round((bucket.sleep_duration / targetSleep) * 100));
      }
    }

    const dates = Object.keys(byDate);
    if (dates.length === 0) {
      // No metrics we recognise in this payload - not an error, since the app may also send
      // metrics we do not handle, such as heart rate or sleep.
      return res.json({ status: 'ok', saved_dates: [] });
    }

    const lastSyncTime = new Date().toISOString();
    const savedDates = [];

    for (const dateStr of dates) {
      const m = byDate[dateStr];
      const steps = m.steps !== null ? Math.round(m.steps) : null;
      const activeCalories = m.active_calories !== null ? Math.round(m.active_calories) : null;
      const totalCalories = (m.active_calories !== null && m.basal_calories !== null)
        ? Math.round(m.active_calories + m.basal_calories)
        : null;
      const activeMinutes = m.active_minutes !== null ? Math.round(m.active_minutes) : null;
      const wristTemperature = m.wrist_temperature !== null ? Math.round(m.wrist_temperature * 10) / 10 : null;
      const distanceMeters = m.distance_meters !== null ? Math.round(m.distance_meters) : null;
      
      const MAX_DAILY_WATER_ML = 10000;
      const waterMl = m.water_ml !== null ? Math.min(Math.round(m.water_ml), MAX_DAILY_WATER_ML) : null;

      const sleepDuration = m.sleep_duration !== null ? Math.round(m.sleep_duration * 10) / 10 : null;
      const sleepDeep = m.sleep_deep !== null ? Math.round(m.sleep_deep * 10) / 10 : null;
      const sleepRem = m.sleep_rem !== null ? Math.round(m.sleep_rem * 10) / 10 : null;
      const sleepScore = m.sleep_score !== null ? Math.round(m.sleep_score) : null;
      const rhr = m.rhr !== null ? Math.round(m.rhr) : null;
      const hrv = m.hrv !== null ? Math.round(m.hrv) : null;

      let readinessScore = null;
      if (user.has_oura !== 1) {
    // Compute a synthetic readiness_score from Apple Health (sleep + HRV + RHR) for the user.
    // Parameters missing from this particular batch are read from the database (logged earlier).
        let sleepScoreForReadiness = sleepScore;
        let hrvForReadiness = hrv;
        let rhrForReadiness = rhr;

        const existingToday = await db.get(
          'SELECT sleep_score, hrv, rhr FROM health_metrics WHERE user_id = ? AND date = ?',
          [user.id, dateStr]
        );
        if (existingToday) {
          if (sleepScoreForReadiness === null) sleepScoreForReadiness = existingToday.sleep_score;
          if (hrvForReadiness === null) hrvForReadiness = existingToday.hrv;
          if (rhrForReadiness === null) rhrForReadiness = existingToday.rhr;
        }

        if (sleepScoreForReadiness !== null || hrvForReadiness !== null || rhrForReadiness !== null) {
    // Fetch the HRV and RHR baselines from the last 30 days, excluding today
          const baselineStart = shiftDate(dateStr, -30);
          const baselineRows = await db.all(
            `SELECT hrv, rhr FROM health_metrics
             WHERE user_id = ? AND date >= ? AND date < ?
               AND (hrv IS NOT NULL AND hrv > 0 OR rhr IS NOT NULL AND rhr > 0)`,
            [user.id, baselineStart, dateStr]
          );

          let avgBaselineHrv = null;
          let avgBaselineRhr = null;
          if (baselineRows.length > 0) {
            const validHrvs = baselineRows.filter(r => r.hrv != null && r.hrv > 0);
            const validRhrs = baselineRows.filter(r => r.rhr != null && r.rhr > 0);
            if (validHrvs.length > 0) {
              avgBaselineHrv = validHrvs.reduce((s, r) => s + r.hrv, 0) / validHrvs.length;
            }
            if (validRhrs.length > 0) {
              avgBaselineRhr = validRhrs.reduce((s, r) => s + r.rhr, 0) / validRhrs.length;
            }
          }

          let scoreComp = 50; // stan neutralny
          if (sleepScoreForReadiness !== null && sleepScoreForReadiness > 0) {
            scoreComp += (sleepScoreForReadiness - 70) * 0.67;
          }
          if (hrvForReadiness !== null && hrvForReadiness > 0) {
            if (avgBaselineHrv !== null && avgBaselineHrv > 0) {
              const hrvPct = (hrvForReadiness / avgBaselineHrv - 1) * 100;
              scoreComp += hrvPct * 0.4;
            } else {
              const hrvPct = (hrvForReadiness / 50 - 1) * 100;
              scoreComp += Math.max(-20, Math.min(20, hrvPct * 0.3));
            }
          }
          if (rhrForReadiness !== null && rhrForReadiness > 0) {
            if (avgBaselineRhr !== null && avgBaselineRhr > 0) {
              const rhrPct = (avgBaselineRhr / rhrForReadiness - 1) * 100;
              scoreComp += rhrPct * 0.3;
            } else {
              const rhrPct = (65 / rhrForReadiness - 1) * 100;
              scoreComp += Math.max(-15, Math.min(15, rhrPct * 0.25));
            }
          }

          readinessScore = Math.max(30, Math.min(100, Math.round(scoreComp)));
        }
      }

    // Protecting Oura Ring data: if the user has Oura connected, sleep data from Apple Health
    // is stored only while Oura has not yet delivered its own (identified by the absence of
    // Oura fields). Otherwise - a user without an Oura ring - Apple Health is the primary
    // source. To stop a complete night's sleep being overwritten by smaller partial batches
    // later in the day, NULLIF(..., 0) turns a resulting 0 back into NULL when both sides were
    // NULL - without it MAX(COALESCE(NULL,0), COALESCE(NULL,0)) = 0, which insights would read
    // as 'slept zero hours' rather than 'no data'.
      const sleepDurationUpdate = user.has_oura === 1
        ? 'sleep_duration = CASE WHEN readiness_score IS NOT NULL THEN sleep_duration ELSE NULLIF(MAX(COALESCE(sleep_duration, 0), COALESCE(excluded.sleep_duration, 0)), 0) END'
        : 'sleep_duration = NULLIF(MAX(COALESCE(sleep_duration, 0), COALESCE(excluded.sleep_duration, 0)), 0)';
      const sleepDeepUpdate = user.has_oura === 1
        ? 'sleep_deep = CASE WHEN readiness_score IS NOT NULL THEN sleep_deep ELSE NULLIF(MAX(COALESCE(sleep_deep, 0), COALESCE(excluded.sleep_deep, 0)), 0) END'
        : 'sleep_deep = NULLIF(MAX(COALESCE(sleep_deep, 0), COALESCE(excluded.sleep_deep, 0)), 0)';
      const sleepRemUpdate = user.has_oura === 1
        ? 'sleep_rem = CASE WHEN readiness_score IS NOT NULL THEN sleep_rem ELSE NULLIF(MAX(COALESCE(sleep_rem, 0), COALESCE(excluded.sleep_rem, 0)), 0) END'
        : 'sleep_rem = NULLIF(MAX(COALESCE(sleep_rem, 0), COALESCE(excluded.sleep_rem, 0)), 0)';
      const sleepScoreUpdate = user.has_oura === 1
        ? 'sleep_score = CASE WHEN readiness_score IS NOT NULL THEN sleep_score ELSE NULLIF(MAX(COALESCE(sleep_score, 0), COALESCE(excluded.sleep_score, 0)), 0) END'
        : 'sleep_score = NULLIF(MAX(COALESCE(sleep_score, 0), COALESCE(excluded.sleep_score, 0)), 0)';

      const rhrUpdate = user.has_oura === 1
        ? 'rhr = CASE WHEN readiness_score IS NOT NULL THEN rhr ELSE COALESCE(excluded.rhr, rhr) END'
        : 'rhr = COALESCE(excluded.rhr, rhr)';
      const hrvUpdate = user.has_oura === 1
        ? 'hrv = CASE WHEN readiness_score IS NOT NULL THEN hrv ELSE COALESCE(excluded.hrv, hrv) END'
        : 'hrv = COALESCE(excluded.hrv, hrv)';
      const readinessScoreUpdate = user.has_oura === 1
        ? 'readiness_score = readiness_score'
        : 'readiness_score = COALESCE(excluded.readiness_score, readiness_score)';

      await db.run(`
        INSERT INTO health_metrics (
          user_id, date, steps, active_calories, total_calories_burned, active_minutes, wrist_temperature,
          distance_meters, water_ml, sleep_duration, sleep_deep, sleep_rem, sleep_score, rhr, hrv, readiness_score, activity_source, last_sync
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'apple', ?)
        ON CONFLICT(user_id, date) DO UPDATE SET
          steps = COALESCE(excluded.steps, steps),
          active_calories = COALESCE(excluded.active_calories, active_calories),
          total_calories_burned = COALESCE(excluded.total_calories_burned, total_calories_burned),
          active_minutes = COALESCE(excluded.active_minutes, active_minutes),
          wrist_temperature = COALESCE(excluded.wrist_temperature, wrist_temperature),
          distance_meters = COALESCE(excluded.distance_meters, distance_meters),
          water_ml = CASE WHEN excluded.water_ml IS NOT NULL THEN COALESCE(water_ml, 0) + excluded.water_ml ELSE water_ml END,
          ${sleepDurationUpdate},
          ${sleepDeepUpdate},
          ${sleepRemUpdate},
          ${sleepScoreUpdate},
          ${rhrUpdate},
          ${hrvUpdate},
          ${readinessScoreUpdate},
          activity_source = 'apple',
          last_sync = excluded.last_sync
      `, [
        user.id, dateStr, steps, activeCalories, totalCalories, activeMinutes, wristTemperature,
        distanceMeters, waterMl, sleepDuration, sleepDeep, sleepRem, sleepScore, rhr, hrv, readinessScore, lastSyncTime
      ]);

      savedDates.push(dateStr);
    }

    console.log(`[APPLE HEALTH] User ${user.id}: saved data for dates [${savedDates.join(', ')}] (${matchedEntries} metric entries, ${matchedWorkouts} workouts z payloadu).`);
    res.json({ status: 'ok', saved_dates: savedDates, workouts_received: workouts ? workouts.length : 0 });
  } catch (err) {
    console.error('[APPLE HEALTH ERROR]', err.message);
    res.status(500).json({ error: 'Błąd przetwarzania danych Apple Health.' });
  }
});

module.exports = router;
