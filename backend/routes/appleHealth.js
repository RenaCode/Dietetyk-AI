const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseHealthAutoExportDate, dateObjToLocalDateString, getWarsawWallClock, shiftDate } = require('../utils/dates');
const {
  ACTIVITY_METRIC_COLUMNS,
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel,
  activitySourceColumns,
  activitySourceValues
} = require('../utils/activitySources');
const { extractSamples, storeSamples } = require('../utils/appleHealthSamples');
const { extractEvents, storeEvents, EVENT_KINDS, syncMedicationSupplements } = require('../utils/appleHealthEvents');
const { syncAppleColumns } = require('../utils/appleHealthColumns');

// Webhook receiving data from the "Health Auto Export" iOS app - a bridge between Apple
// Health and this backend. HealthKit has no public cloud API, so an intermediary running
// on the phone is required (see https://github.com/Lybron/health-auto-export).
//
// AUTHORISATION: this endpoint does NOT use sessions or cookies - the phone app sends the
// request in the background, with no browser. We identify the user by their unique
// `sync_token` (the users.sync_token column, long present in the database and visible in
// Settings) written directly into the webhook URL. This router MUST therefore be mounted
// in app.js BEFORE
// `app.use('/api', requireAuth)` - tak samo jak routes/healthcheck.js.
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
//   - This webhook sits at the top of the hierarchy, so its activity values always win.
//     It used to hand-write `activity_source = 'apple'` unconditionally, on the reasoning
//     that "Apple is top of the hierarchy, so it needs no protective clause". That is true
//     of the WRITE and false of everything that comes after it (audit 2026-09-23). The
//     label was stamped on even when the payload carried no activity at all: a Health Auto
//     Export automation sending only Dietary Water, or only sleep, or only wrist
//     temperature, still creates a byDate entry and still reaches this upsert, and the
//     activity columns are then all NULL, so COALESCE keeps whatever was there. From that
//     moment the row reads as "owned by apple with real steps in it", and
//     preserveHigherPriority() in sync.js correctly refuses to let Google Fit or Oura
//     touch those columns again - for a day Apple will never send activity for. Steps
//     frozen at the value they happened to have, for good.
//     So this upsert builds its clauses from the same helpers as every other writer, and
//     passes activity_source = 'apple' only when the payload actually brought activity.
//   - syncOura and syncGoogleFit (services/sync.js) build their ON CONFLICT clauses from
//     that same hierarchy via preserveHigherPriority()/preserveSourceLabel(), so they will
//     not overwrite a column holding real data from a higher-ranked source. Previously the
//     only thing guarded against was overwriting 'apple', while Google Fit and Oura
//     overwrote each other - the result for a given day then depended on sync order.
//
// FORMAT PAYLOADU (Health Auto Export, "Automatyzacja typu REST API"):
//   { "data": { "metrics": [ { "name": "step_count", "units": "steps",
//       "data": [ { "date": "2026-06-18 14:00:00 +0200", "qty": 1234 }, ... ] }, ... ] } }
// The "name" field is always a snake_case metric identifier ("step_count",
// "active_energy", "basal_energy_burned", "apple_exercise_time") - NOT the display name
// from the app's UI ("Step Count"). Confirmed against sample payloads from the
// documentation and community (ladvien.com, irvinlim/apple-health-ingester among others).
//
// We handle only the metrics needed for the calorie balance (steps, calories, active
// minutes), wrist temperature, distance and water ("Dietary Water" - see METRIC_FIELD_MAP
// below) from data.metrics[] into health_metrics columns. Since 2026-10-02 every numeric
// sample of every metric - including ones with no column and ones this code has never heard
// of - is also stored, as hourly buckets in apple_health_hourly (utils/appleHealthSamples.js),
// so the user can tick everything in the phone automation and nothing is silently dropped.
// Per-workout heart rate from data.workouts[] (avgHeartRate/maxHeartRate/heartRateData) is
// handled too - see the "CARDIO ZONES" section below - provided the user enabled the
// "Include Workout Metrics" toggle in the Health Auto Export automation on their phone. It is off by default, and without it
// the workout payload carries no heart-rate fields at all.

// Upper size limits for the webhook payload (round 12, security audit) - see the comment
// where they are used in the POST handler below.
// Raised from 20 000 on 2026-10-02: the intended setup is now "tick EVERYTHING in Health
// Auto Export and let the server pick what it can use" (see utils/appleHealthSamples.js), and
// a week of minute-grouped data runs past 20 000 entries. Capped at 100 000 rather than
// "whatever fits in the body" after the 2026-10-02 audit measured a production-shaped pod
// (512 Mi, 0.5 CPU): an 18 MB / 250 000-entry body peaked at 550 MB RSS and held the event
// loop for ~96 s - past nginx's 60 s timeout, the readiness probe, and the memory limit. The
// JSON body limit deliberately stays 20 MB (appleHealthJsonParser below); with hourly grouping, which is what
// the user is told to use, a week of every metric is a few thousand entries.
const MAX_METRIC_ENTRIES_PER_REQUEST = 100000;
const MAX_WORKOUTS_PER_REQUEST = 500;
// Symptoms, heart-rate notifications and cycle entries are a handful a day; a year of all
// three for one person stays far below this.
const MAX_EVENTS_PER_REQUEST = 10000;

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

// Mapowanie nazw metryk Health Auto Export -> nasze pola w health_metrics.
// `field` is our internal bucket (see `byDate` below), not a 1:1 SQL column name -
// total_calories_burned is computed as active_calories + basal_calories.
// `mode: 'last'` (as opposed to the default summing): for wrist temperature we do NOT add
// up successive entries from the same day. It is a single overnight measurement, not a
// cumulative value like steps or calories - so we take the last value
// z paczki danych.
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
  // nazwa faktycznie przychodzi w payloadzie, i popraw klucz w tej mapie.
  dietary_water: { field: 'water_ml', convert: toMilliliters },
  resting_heart_rate: { field: 'rhr', convert: (qty) => qty, mode: 'last' },
  heart_rate_variability: { field: 'hrv', convert: (qty) => qty, mode: 'last' },
  heart_rate_variability_sdnn: { field: 'hrv', convert: (qty) => qty, mode: 'last' }
};

const APPLE_RANK = getActivitySourceRank('apple');

// APPLE ACTIVITY LABEL: the columns the source hierarchy governs, taken from
// utils/activitySources.js rather than repeated here. services/sync.js used to keep its own
// copy of the same list; two writers working from two lists would disagree about who owns a
// day and the label would flip back and forth between syncs.
// The values are bound in this order, so the `<column>_source` parameters built from
// activitySourceValues() line up with them.
const ACTIVITY_LABEL_COLUMNS = ACTIVITY_METRIC_COLUMNS;

/**
 * Builds the health_metrics upsert this webhook executes.
 *
 * It is a named function (and exported) so tests can run the REAL statement rather than a
 * reconstruction of it. tests/test-activity-sources.js used to rebuild "the Apple write"
 * out of preserveHigherPriority()/preserveSourceLabel() - i.e. out of the sync.js pattern -
 * and passed happily for months while this file hand-wrote `activity_source = 'apple'` and
 * broke the very rule the test claimed to protect.
 *
 * @param {boolean} hasOura whether the user has an Oura ring connected, which decides
 *   whether Apple sleep data may overwrite Oura's own
 */
function buildHealthMetricsUpsertSql(hasOura) {
  const sleepDurationUpdate = hasOura
    ? 'sleep_duration = CASE WHEN readiness_score IS NOT NULL THEN sleep_duration ELSE NULLIF(MAX(COALESCE(sleep_duration, 0), COALESCE(excluded.sleep_duration, 0)), 0) END'
    : 'sleep_duration = NULLIF(MAX(COALESCE(sleep_duration, 0), COALESCE(excluded.sleep_duration, 0)), 0)';
  const sleepDeepUpdate = hasOura
    ? 'sleep_deep = CASE WHEN readiness_score IS NOT NULL THEN sleep_deep ELSE NULLIF(MAX(COALESCE(sleep_deep, 0), COALESCE(excluded.sleep_deep, 0)), 0) END'
    : 'sleep_deep = NULLIF(MAX(COALESCE(sleep_deep, 0), COALESCE(excluded.sleep_deep, 0)), 0)';
  const sleepRemUpdate = hasOura
    ? 'sleep_rem = CASE WHEN readiness_score IS NOT NULL THEN sleep_rem ELSE NULLIF(MAX(COALESCE(sleep_rem, 0), COALESCE(excluded.sleep_rem, 0)), 0) END'
    : 'sleep_rem = NULLIF(MAX(COALESCE(sleep_rem, 0), COALESCE(excluded.sleep_rem, 0)), 0)';
  const sleepScoreUpdate = hasOura
    ? 'sleep_score = CASE WHEN readiness_score IS NOT NULL THEN sleep_score ELSE NULLIF(MAX(COALESCE(sleep_score, 0), COALESCE(excluded.sleep_score, 0)), 0) END'
    : 'sleep_score = NULLIF(MAX(COALESCE(sleep_score, 0), COALESCE(excluded.sleep_score, 0)), 0)';

  const rhrUpdate = hasOura
    ? 'rhr = CASE WHEN readiness_score IS NOT NULL THEN rhr ELSE COALESCE(excluded.rhr, rhr) END'
    : 'rhr = COALESCE(excluded.rhr, rhr)';
  const hrvUpdate = hasOura
    ? 'hrv = CASE WHEN readiness_score IS NOT NULL THEN hrv ELSE COALESCE(excluded.hrv, hrv) END'
    : 'hrv = COALESCE(excluded.hrv, hrv)';
  const readinessScoreUpdate = hasOura
    ? 'readiness_score = readiness_score'
    : 'readiness_score = COALESCE(excluded.readiness_score, readiness_score)';

  // WATER: water_ml is a MIXED counter - manual taps from POST /api/water/add plus whatever
  // Apple Health forwards from the smart bottle. It used to be incremented here
  // (water_ml = water_ml + excluded.water_ml) with double counting prevented by the
  // INSERT OR IGNORE into apple_health_water_samples: only samples that were new got added.
  // Those two writes are in different transactions, hundreds of lines apart, so any failure
  // of THIS statement (SQLITE_BUSY during the VACUUM in cleanupOldImages, for instance)
  // lost the water permanently: the sample row was already committed, the retry from Health
  // Auto Export got changes = 0 for it, and the millilitres were never added to any counter.
  // Now the webhook passes the day's FULL total recomputed from apple_health_water_samples
  // and we replace Apple's previous contribution with it, which makes a retry idempotent and
  // a lost write self-healing. water_ml_apple exists exactly to remember how much of
  // water_ml came from Apple; without it we could only overwrite the column and would throw
  // away the user's manual entries.
  // Subtracting the old share also keeps POST /api/water/reset working the way it always
  // has: reset zeroes water_ml but records the day's sample total in water_ml_apple, so the
  // next webhook contributes only the samples that arrived AFTER the reset instead of
  // resurrecting the whole day (see routes/health.js).
  // MAX(0, ...) wraps the final result purely as a floor; with samples only ever
  // accumulating, the expression cannot go negative on its own.
  const waterUpdate = `
          water_ml = CASE WHEN excluded.water_ml_apple IS NOT NULL
            THEN MAX(0, COALESCE(water_ml, 0) - COALESCE(water_ml_apple, 0) + excluded.water_ml_apple)
            ELSE water_ml END,
          water_ml_apple = COALESCE(excluded.water_ml_apple, water_ml_apple)`;

  // The `<column>_source` columns have to be in the INSERT too, not just in the conflict
  // clause: a date the webhook is the first to write has no conflict to resolve, and a row
  // left with NULL provenance is unowned - Google Fit's next hourly sync would overwrite
  // Apple's step count an hour after it landed.
  const sourceColumns = activitySourceColumns(ACTIVITY_LABEL_COLUMNS);

  return `
        INSERT INTO health_metrics (
          user_id, date, steps, active_calories, total_calories_burned, active_minutes, wrist_temperature,
          distance_meters, water_ml, water_ml_apple, sleep_duration, sleep_deep, sleep_rem, sleep_score,
          rhr, hrv, readiness_score, activity_source, ${sourceColumns.join(', ')}, last_sync
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${sourceColumns.map(() => '?').join(', ')}, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET
          ${preserveHigherPriority('steps', APPLE_RANK)},
          ${preserveHigherPriority('active_calories', APPLE_RANK)},
          ${preserveHigherPriority('total_calories_burned', APPLE_RANK)},
          ${preserveHigherPriority('active_minutes', APPLE_RANK)},
          wrist_temperature = COALESCE(excluded.wrist_temperature, wrist_temperature),
          ${preserveHigherPriority('distance_meters', APPLE_RANK)},
          ${waterUpdate},
          ${sleepDurationUpdate},
          ${sleepDeepUpdate},
          ${sleepRemUpdate},
          ${sleepScoreUpdate},
          ${rhrUpdate},
          ${hrvUpdate},
          ${readinessScoreUpdate},
          ${preserveSourceLabel(APPLE_RANK, ACTIVITY_LABEL_COLUMNS)},
          last_sync = excluded.last_sync
  `;
}

// The body of this webhook is the one large payload the application accepts from outside
// (Health Auto Export with workout route/GPS data runs to megabytes), so it gets its own
// 20 MB parser - and gets it only AFTER the token is known to be real. The 20 MB limit used to
// be global (express.json in server.js, before the rate limiter and requireAuth), so any
// anonymous POST to any /api path was parsed in full: ~150 MB of RSS per 19.5 MB body against
// a 512Mi container, and three or four parallel requests to /api/login were an OOM kill.
// The global parser is now small (see app.js) and skips this path; an unknown token is
// answered from the URL alone, before a byte of the body is read.
const appleHealthJsonParser = express.json({ limit: '20mb' });

async function requireKnownSyncToken(req, res, next) {
  try {
    const syncToken = (req.params.syncToken || '').trim();
    if (!syncToken) {
      return res.status(401).json({ error: 'Brak tokenu synchronizacji w adresie webhooka.' });
    }
    const user = await db.get(`SELECT id FROM users WHERE sync_token = ?`, [syncToken]);
    if (!user) {
      return res.status(404).json({ error: 'Nieznany token synchronizacji.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/api/integrations/apple-health/:syncToken', requireKnownSyncToken, appleHealthJsonParser, async (req, res) => {
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
    // kolumny Workout Type/Start/End/Aktywna Energia (kJ)/Energia Spoczynkowa (kJ)/...).
  // The exact shape of the workout object in JSON, confirmed from production logs:
    //   { id, name, start: "2026-06-18 06:00:26 +0200", end: "...",
    //     duration: 4715.99 (SEKUNDY), activeEnergyBurned: { qty: 2299.5, units: "kJ" },
    //     intensity: {...}, temperature: {...}, humidity: {...}, metadata: {} }
    // Mapujemy: activeEnergyBurned -> active_calories (po konwersji do kcal), duration
    // (sekundy -> minuty) -> active_minutes, przypisane do dnia kalendarzowego pola `start`.
  // A workout does NOT provide basal_calories, so total_calories_burned is not computed here
    // (dashboard.js i tak ma fallback bmr + active_calories, gdy total_calories_burned brak).
    //
  // DOUBLE COUNTING: this used to be waved off with "the user confirmed this is the ONLY
  // configured Health Auto Export automation", which is a statement about the settings on
  // one phone, not a property of this code - and the general-metrics automation IS handled
  // here as well. The daily totals are therefore combined with Math.max rather than
  // assigned (see workoutAffectedDates below): workouts are a subset of the day, so their
  // sum is a lower bound on it, never the whole of it.
    const rawMetrics = req.body && req.body.data && req.body.data.metrics;
    const rawWorkouts = req.body && req.body.data && req.body.data.workouts;
    const metrics = Array.isArray(rawMetrics) ? rawMetrics : null;
    const workouts = Array.isArray(rawWorkouts) ? rawWorkouts : null;

    // Symptoms / heart-rate notifications / cycle tracking each come from their OWN Health
    // Auto Export automation, as the only array in the payload (see utils/appleHealthEvents.js).
    // The same goes for kinds not processed yet (ecg, stateOfMind, medications): answering
    // those with a 400 makes the phone report "export failed" for an export that did nothing
    // wrong, so any payload that carries at least one array is acknowledged. Only a body with
    // no array at all is malformed.
    const data = req.body && req.body.data;
    const hasAnyArray = data && typeof data === 'object'
      && Object.values(data).some((v) => Array.isArray(v));
    if (!hasAnyArray) {
      return res.status(400).json({ error: 'Nieprawidłowy format danych - oczekiwano tablicy w polu data (np. data.metrics[]).' });
    }
    const unhandledKinds = Object.keys(data).filter((k) => Array.isArray(data[k])
      && k !== 'metrics' && k !== 'workouts' && !EVENT_KINDS[k]);
    if (unhandledKinds.length > 0) {
      console.log(`[APPLE HEALTH] User ${user.id} sent data kinds that are not processed yet: [${unhandledKinds.join(', ')}]`);
    }
    const eventEntries = Object.keys(EVENT_KINDS)
      .reduce((sum, k) => sum + (Array.isArray(data[k]) ? data[k].length : 0), 0);
    if (eventEntries > MAX_EVENTS_PER_REQUEST) {
      return res.status(400).json({ error: `Za dużo zdarzeń w jednym żądaniu (limit: ${MAX_EVENTS_PER_REQUEST}).` });
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
    // Days whose water samples this payload touched - re-summed from
    // apple_health_water_samples after the loop, see the dietary_water branch below.
    const waterAffectedDates = new Set();

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
            // A null entry used to throw on `entry.startDate` and fail the whole request with a
            // 500, which the phone answers by retrying the same payload for ever.
            if (!entry || typeof entry !== 'object') continue;
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
    // Round 3 (audit): water idempotency - store the sample keyed by user_id and timestamp.
    // Audit 2026-09-23: the daily total is NOT accumulated from insertResult.changes any
    // more. That made the sample table the sole record of "already counted" while the
    // millilitres themselves were added in a separate statement far below - so a webhook
    // that stored the samples and then failed on the health_metrics upsert lost that water
    // for good (the client's retry saw changes = 0). The sample table is now the single
    // source of truth and the day is re-summed from it after the loop, exactly the way
    // workouts are already re-summed from apple_health_workouts.
    // Audit 2026-10-02: a repeated timestamp REPLACES the stored qty instead of being ignored.
    // Health Auto Export groups samples into buckets (hour / day) and re-exports the CURRENT
    // bucket with a growing total, under the same timestamp, on every run. INSERT OR IGNORE
    // kept the first partial value - 250 ml at 14:10 - and dropped the 500 ml the same 14:00
    // bucket carried at 14:50; with day grouping the whole day froze at the first export of
    // the morning. Replacing keeps a resend idempotent (same value in, same value stored).
            const timestamp = entry.date || parsedDate.toISOString();
            await db.run(`
              INSERT INTO apple_health_water_samples (user_id, timestamp, date, qty)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, timestamp) DO UPDATE SET qty = excluded.qty, date = excluded.date
            `, [user.id, timestamp, dateStr, converted]);
            waterAffectedDates.add(dateStr);
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

        // `workout.name` to typ treningu z UI apki (np. "Running", "Functional
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
        // The workout totals are a LOWER BOUND on the day, never its replacement (audit
        // 2026-09-23). This used to assign them unconditionally, and it runs AFTER the
        // data.metrics[] loop, so on a payload carrying both (one automation exporting
        // metrics and workouts, or two automations firing into the same webhook - a
        // supported path, handled explicitly further up) it erased the day's totals
        // summed from active_energy and apple_exercise_time. A day with 750 kcal active,
        // 320 of them from one run, was written as 320: the run overwrote the day. That
        // then propagated into total_calories_burned (active + basal) and understated the
        // calorie balance on the Dashboard by 430 kcal, permanently, because the upsert
        // preserves a real incoming value over the stored one.
        //
        // The bound must also hold against what an EARLIER request stored (audit 2026-10-02).
        // The Math.max above only saw this payload's metrics, but two automations - one for
        // metrics, one for workouts - arrive as two separate requests, so a workouts-only
        // request still replaced the stored 750 kcal with the run's 320. When this payload has
        // no daily figure of its own, the workout sum is sent only if it EXCEEDS the stored
        // value; otherwise the column is left NULL, and the upsert's COALESCE keeps the stored
        // value together with whichever source wrote it.
        const workoutCalories = sums && sums.total_calories !== null ? sums.total_calories : 0;
        const workoutMinutes = sums && sums.total_minutes !== null ? sums.total_minutes : 0;
        const stored = (byDate[dateStr].active_calories === null || byDate[dateStr].active_minutes === null)
          ? await db.get('SELECT active_calories, active_minutes FROM health_metrics WHERE user_id = ? AND date = ?', [user.id, dateStr])
          : null;
        const lowerBound = (fromPayload, fromWorkouts, storedValue) => {
          if (fromPayload !== null) return Math.max(fromPayload, fromWorkouts);
          if (storedValue != null && storedValue >= Math.round(fromWorkouts)) return null;
          return fromWorkouts;
        };
        byDate[dateStr].active_calories = lowerBound(byDate[dateStr].active_calories, workoutCalories, stored && stored.active_calories);
        byDate[dateStr].active_minutes = lowerBound(byDate[dateStr].active_minutes, workoutMinutes, stored && stored.active_minutes);
      }
    }

    // Water: re-sum every affected day from apple_health_water_samples. See the
    // dietary_water branch above and the WATER comment in buildHealthMetricsUpsertSql -
    // the sample table, not this request body, decides the daily total.
    for (const dateStr of waterAffectedDates) {
      const waterSum = await db.get(
        'SELECT SUM(qty) AS total FROM apple_health_water_samples WHERE user_id = ? AND date = ?',
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
      byDate[dateStr].water_ml = waterSum && waterSum.total !== null ? waterSum.total : 0;
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
        
        // Obliczanie sleep_score (0-100) na podstawie celu snu
        bucket.sleep_score = Math.min(100, Math.round((bucket.sleep_duration / targetSleep) * 100));
      }
    }

    // Everything beyond the classic columns (all metrics as hourly buckets, symptoms, heart
    // rate notifications, cycle tracking) - see utils/appleHealthSamples.js and
    // utils/appleHealthEvents.js. It is stored AFTER the health_metrics upsert below and in its
    // own try/catch (audit 2026-10-02): steps, calories and sleep worked long before this
    // storage existed, and a failure in it - a full disk, a lock timeout - must not take them
    // down with it. Only when the payload carries nothing else (an events-only or
    // unknown-metrics-only export) does a failure here fail the request, so the phone retries.
    const extras = { samples: 0, events: 0 };
    const storeExtras = async () => {
      if (metrics) {
        const touchedDates = new Set();
        for (const metric of metrics) {
          // One metric at a time keeps memory bounded by the largest single series rather
          // than the whole payload, and yields the event loop between metrics.
          const samples = extractSamples(metric);
          if (samples.length > 0) {
            await storeSamples(db, user.id, samples);
            for (const x of samples) touchedDates.add(x.date);
            extras.samples += samples.length;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        // Fill the health_metrics columns the existing cards and insights read (SpO2,
        // respiratory rate, blood pressure, weight...) for users with no other source.
        await syncAppleColumns(db, user.id, [...touchedDates]);
      }
      const events = extractEvents(data);
      if (events.length > 0) await storeEvents(db, user.id, events);
      extras.events = events.length;
      // Medications ticked "Taken" in Health feed the day's supplements list, which the
      // advice, insights, summaries and PDF already read - see utils/supplementsMerge.js.
      const medicationDates = [...new Set(events.filter((e) => e.kind === 'medication').map((e) => e.date))];
      if (medicationDates.length > 0) await syncMedicationSupplements(db, user.id, medicationDates);
    };

    const dates = Object.keys(byDate);
    if (dates.length === 0) {
      // No metrics we recognise in this payload - not an error, since the app may also send
      // metrics we do not handle, such as heart rate or sleep.
      await storeExtras();
      return res.json({ status: 'ok', saved_dates: [], samples_stored: extras.samples, events_stored: extras.events });
    }

    const lastSyncTime = new Date().toISOString();
    const savedDates = [];
    // The statement depends only on whether the user has Oura connected, so it is built
    // once per request rather than per date.
    const healthMetricsUpsertSql = buildHealthMetricsUpsertSql(user.has_oura === 1);

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
      // activity_source = 'apple' only when this payload really carried activity - see the
      // APPLE ACTIVITY LABEL comment above buildHealthMetricsUpsertSql.
      const hasAppleActivityData = steps !== null || activeCalories !== null
        || activeMinutes !== null || distanceMeters !== null || totalCalories !== null;
      const activitySource = hasAppleActivityData ? 'apple' : null;
      // Per-column provenance: 'apple' for the columns THIS payload actually carried, NULL
      // for the rest. Order must match ACTIVITY_LABEL_COLUMNS, which is what
      // buildHealthMetricsUpsertSql lists in the INSERT.
      const activityColumnSources = activitySourceValues(
        [steps, activeCalories, totalCalories, activeMinutes, distanceMeters],
        activitySource
      );

      await db.run(healthMetricsUpsertSql, [
        user.id, dateStr, steps, activeCalories, totalCalories, activeMinutes, wristTemperature,
        distanceMeters, waterMl, waterMl, sleepDuration, sleepDeep, sleepRem, sleepScore, rhr, hrv,
        readinessScore, activitySource, ...activityColumnSources, lastSyncTime
      ]);

      savedDates.push(dateStr);
    }

    try {
      await storeExtras();
    } catch (extrasErr) {
      console.error(`[APPLE HEALTH ERROR] User ${user.id}: core data saved, but storing the extra metrics/events failed:`, extrasErr.message);
    }

    console.log(`[APPLE HEALTH] User ${user.id}: saved data for dates [${savedDates.join(', ')}] (${matchedEntries} metric entries, ${matchedWorkouts} workouts, ${extras.samples} samples bucketed, ${extras.events} events).`);
    res.json({
      status: 'ok',
      saved_dates: savedDates,
      workouts_received: workouts ? workouts.length : 0,
      samples_stored: extras.samples,
      events_stored: extras.events
    });
  } catch (err) {
    console.error('[APPLE HEALTH ERROR]', err.message);
    res.status(500).json({ error: 'Błąd przetwarzania danych Apple Health.' });
  }
});

module.exports = router;
// Exported for tests/test-apple-health-upsert.js, which must exercise the statement this
// webhook really runs - see the comment on the function.
module.exports.buildHealthMetricsUpsertSql = buildHealthMetricsUpsertSql;
