const db = require('../db');
const { formatDateString, timestampToDateString, getWarsawDayStartMillis } = require('../utils/dates');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const {
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
} = require('../utils/activitySources');

const { getOrRefreshToken } = require('./oauthHelpers');

const OURA_RANK = getActivitySourceRank('oura');
const GOOGLE_FIT_RANK = getActivitySourceRank('google_fit');

// Columns whose non-zero value means "this source really did provide activity data for
// that day" - they decide whether the activity_source label stays with the existing,
// higher-ranked source.
const ACTIVITY_LABEL_COLUMNS = [
  'steps', 'active_calories', 'total_calories_burned', 'active_minutes', 'distance_meters'
];
const GOOGLE_FIT_LABEL_COLUMNS = ['steps', 'active_calories', 'distance_meters'];

async function syncOura(userId) {
  const accessToken = await getOrRefreshToken(userId, 'oura');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Oura. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 7);

  const startDate = formatDateString(past);
  const endDate = formatDateString(now);

  console.log(`[SYNC OURA] Fetching readiness/sleep/activity data for user ${userId} from ${startDate} to ${endDate}...`);

  try {
    const sleepRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!sleepRes.ok) {
      const errText = await sleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania snu Oura (Status ${sleepRes.status}): ${detail}`);
    }
    const sleepData = await sleepRes.json();

    const dailySleepRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!dailySleepRes.ok) {
      const errText = await dailySleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania dziennego podsumowania snu Oura (Status ${dailySleepRes.status}): ${detail}`);
    }
    const dailySleepData = await dailySleepRes.json();

    const actRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!actRes.ok) {
      const errText = await actRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania aktywności Oura (Status ${actRes.status}): ${detail}`);
    }
    const actData = await actRes.json();

    const readRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!readRes.ok) {
      const errText = await readRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania gotowości Oura (Status ${readRes.status}): ${detail}`);
    }
    const readData = await readRes.json();

    // Daily SpO2 (Oura Gen 3+) - a separate endpoint, NOT part of the /sleep response.
    // For rings older than Gen 3, Oura simply returns an empty `data` array rather than a
    // 4xx error - spo2_percentage then stays null for every date.
    const spo2Res = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_spo2?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let spo2Data = null;
    if (spo2Res.ok) {
      spo2Data = await spo2Res.json();
    } else {
      // We deliberately do not fail the whole sync on an SpO2 error - it is an extra,
      // optional metric. Log it and carry on without it.
      console.warn(`[SYNC OURA] Skipped SpO2 (status ${spo2Res.status}) - continuing without that metric.`);
    }

    // Real stress level (the /v2/usercollection/daily_stress endpoint) - available only on
    // rings that support it; on older models `data` comes back empty rather than as a 4xx.
    // As with SpO2, a missing metric does not abort the sync.
    const stressRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_stress?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let stressData = null;
    if (stressRes.ok) {
      stressData = await stressRes.json();
    } else {
      console.warn(`[SYNC OURA] Skipped stress level (status ${stressRes.status}) - continuing without that metric.`);
    }

    const metricsByDate = {};
    for (let i = 0; i < 7; i++) { // B-N2: < zamiast <= (7 dni, nie 8)
      const d = new Date();
      d.setDate(now.getDate() - i);
      const dateStr = formatDateString(d);
      metricsByDate[dateStr] = {
        steps: null,
        active_calories: null,
        total_calories: null,
        sleep_score: null,
        sleep_duration: null,
        sleep_deep: null,
        sleep_rem: null,
        readiness_score: null,
        hrv: null,
        rhr: null,
        temperature_deviation: null,
        active_minutes: null,
        respiratory_rate: null,
        spo2_percentage: null,
        distance_meters: null,
        sedentary_minutes: null,
        low_activity_minutes: null,
        stress_high_minutes: null,
        stress_recovery_minutes: null,
        stress_summary: null
      };
    }

    if (sleepData && sleepData.data) {
    // Group sleep entries by day to handle multiple entries correctly, such as naps.
      const sleepByDay = {};
      sleepData.data.forEach(item => {
        const dateStr = item.day;
        if (!sleepByDay[dateStr]) {
          sleepByDay[dateStr] = [];
        }
        sleepByDay[dateStr].push(item);
      });

      for (const [dateStr, items] of Object.entries(sleepByDay)) {
        if (metricsByDate[dateStr]) {
          let totalDurationSec = 0;
          let totalDeepSec = 0;
          let totalRemSec = 0;
          let hasLongSleep = false;

      // Pick the main record (the 'long_sleep' main sleep, or the longest nap if there is
      // none) to read the remaining physiological values from - resting heart rate, HRV and so on.
          let primaryRecord = null;
          items.forEach(item => {
            totalDurationSec += item.total_sleep_duration || 0;
            totalDeepSec += item.deep_sleep_duration || 0;
            totalRemSec += item.rem_sleep_duration || 0;
            if (item.type === 'long_sleep') {
              hasLongSleep = true;
            }

            if (!primaryRecord) {
              primaryRecord = item;
            } else if (item.type === 'long_sleep' && primaryRecord.type !== 'long_sleep') {
              primaryRecord = item;
            } else if (item.type === primaryRecord.type && (item.total_sleep_duration || 0) > (primaryRecord.total_sleep_duration || 0)) {
              primaryRecord = item;
            }
          });

          metricsByDate[dateStr].sleep_duration = totalDurationSec ? Math.round((totalDurationSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_deep = totalDeepSec ? Math.round((totalDeepSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_rem = totalRemSec ? Math.round((totalRemSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].has_long_sleep = hasLongSleep;

          if (primaryRecord) {
            metricsByDate[dateStr].rhr = primaryRecord.lowest_heart_rate || null;
            metricsByDate[dateStr].hrv = primaryRecord.average_hrv || null;
        // `average_breath` - although Oura's documentation calls this field
        // "breaths/second", the real values in API responses (12.1, 12.4 and the like) are
        // obviously breaths per MINUTE, since the normal range during sleep is 12-20/min.
        // We store the value without conversion, rounded to one decimal place.
            metricsByDate[dateStr].respiratory_rate = primaryRecord.average_breath ? Math.round(primaryRecord.average_breath * 10) / 10 : null;
          }
        }
      }
    }

    if (spo2Data && spo2Data.data) {
      spo2Data.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr] && item.spo2_percentage && typeof item.spo2_percentage.average === 'number') {
          metricsByDate[dateStr].spo2_percentage = Math.round(item.spo2_percentage.average * 10) / 10;
        }
      });
    }

    if (dailySleepData && dailySleepData.data) {
      dailySleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_score = item.score || null;
        }
      });
    }

    if (actData && actData.data) {
      actData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].steps = item.steps || 0;
          metricsByDate[dateStr].active_calories = item.active_calories || 0;
          metricsByDate[dateStr].total_calories = item.total_calories || 0;
          metricsByDate[dateStr].active_minutes = Math.round(((item.medium_activity_time || 0) + (item.high_activity_time || 0)) / 60) || 0;
        // Distance - Oura returns an "equivalent walking distance" in metres, which also
        // folds in other activity converted into steps/distance rather than pure GPS
        // walking distance. It is the best real distance field this API offers.
          metricsByDate[dateStr].distance_meters = item.equivalent_walking_distance || null;
        // Day broken down by intensity (seconds -> minutes) - complements the existing
        // active_minutes (medium+high) with the rest of the day.
          metricsByDate[dateStr].sedentary_minutes = item.sedentary_time != null ? Math.round(item.sedentary_time / 60) : null;
          metricsByDate[dateStr].low_activity_minutes = item.low_activity_time != null ? Math.round(item.low_activity_time / 60) : null;
        }
      });
    }

    if (readData && readData.data) {
      readData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].readiness_score = item.score || null;
          // BUG (until 2026-06): the Oura v2 API returns "temperature_deviation" as a flat
          // field on the readiness object, NOT nested under "temperature.deviation" - that
          // nested field does not exist in the /v2/usercollection/daily_readiness response
          // at all. The old item.temperature?.deviation path was therefore always
          // undefined, so the column always fell back to null. That is why "Temperature
          // deviation" on the Oura Ring status card permanently showed "--".
          metricsByDate[dateStr].temperature_deviation = item.temperature_deviation ?? null;
        }
      });
    }

    if (stressData && stressData.data) {
      stressData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].stress_high_minutes = item.stress_high != null ? Math.round((item.stress_high / 60) * 10) / 10 : null;
          metricsByDate[dateStr].stress_recovery_minutes = item.recovery_high != null ? Math.round((item.recovery_high / 60) * 10) / 10 : null;
          metricsByDate[dateStr].stress_summary = item.day_summary || null;
        }
      });
    }

    const lastSyncTime = new Date().toISOString();
    for (const [dateStr, metrics] of Object.entries(metricsByDate)) {
      if (metrics.steps !== null || metrics.sleep_score !== null || metrics.readiness_score !== null) {
        // Check whether a row with a non-null sleep duration already exists
        const existing = await db.get(
          'SELECT sleep_duration, sleep_score, sleep_deep, sleep_rem, rhr, hrv, readiness_score FROM health_metrics WHERE user_id = ? AND date = ?',
          [userId, dateStr]
        );

        if (existing && existing.sleep_duration !== null && !metrics.has_long_sleep) {
        // If the database already holds a sleep duration and Oura has no main sleep
        // (long_sleep) for that day - only naps, or no sleep data at all - we leave the
        // existing sleep duration and the derived metrics alone.
          metrics.sleep_duration = existing.sleep_duration;
          metrics.sleep_score = existing.sleep_score;
          metrics.sleep_deep = existing.sleep_deep;
          metrics.sleep_rem = existing.sleep_rem;
          metrics.rhr = existing.rhr;
          metrics.hrv = existing.hrv;
          metrics.readiness_score = existing.readiness_score;
        }

        // PRIORITY: see utils/activitySources.js - the hierarchy apple > google_fit > oura
        // is shared by ALL activity upserts. Each upsert used to guard only against
        // overwriting 'apple' data, so Google Fit and Oura overwrote each other and the
        // result for a given day depended on the order the syncs ran in that hour.
        //
        // FIX (2026-06-19): the "activity_source = 'apple' -> do not overwrite" guard used
        // to protect a column REGARDLESS of whether Apple had actually sent real data for
        // it. If the Apple Health webhook wrote only zeros or nulls for a date - because
        // the automation fired before the watch had synced its steps, or sent only some of
        // the metrics - the day was permanently pinned at zero: no later Oura resync would
        // fix it, however real its data. The per-column guard now applies only when the
        // existing Apple value is genuinely > 0; otherwise Oura may fill it in.
        // activity_source falls back to 'oura' only when none of Apple's activity columns
        // held real data (so all of them were just filled in by Oura) - if even one Apple
        // column was real, the source label stays 'apple', matching what was actually
        // overwritten.
        // FIX (audit round 4): activitySource used to depend SOLELY on
        // metrics.steps !== null. If Oura provided only active_calories/active_minutes for
        // a date - steps delayed, or unavailable on that ring model - activitySource fell
        // to null even though real activity data had been written, and the dashboard and
        // API wrongly reported a missing or unknown activity source for that day. The
        // source is now set to 'oura' when ANY activity column holds a real value.
        const hasOuraActivityData = metrics.steps !== null || metrics.active_calories !== null
          || metrics.active_minutes !== null || metrics.distance_meters !== null
          || metrics.total_calories !== null;
        const activitySource = hasOuraActivityData ? 'oura' : null;
        await db.run(`
          INSERT INTO health_metrics (
            user_id, date, steps, active_calories, total_calories_burned,
            sleep_score, sleep_duration, sleep_deep, sleep_rem,
            readiness_score, hrv, rhr, temperature_deviation, active_minutes,
            respiratory_rate, spo2_percentage, distance_meters, sedentary_minutes,
            low_activity_minutes, stress_high_minutes, stress_recovery_minutes,
            stress_summary, activity_source, last_sync
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            ${preserveHigherPriority('steps', OURA_RANK)},
            ${preserveHigherPriority('active_calories', OURA_RANK)},
            ${preserveHigherPriority('total_calories_burned', OURA_RANK)},
            sleep_score = COALESCE(excluded.sleep_score, sleep_score),
            sleep_duration = COALESCE(excluded.sleep_duration, sleep_duration),
            sleep_deep = COALESCE(excluded.sleep_deep, sleep_deep),
            sleep_rem = COALESCE(excluded.sleep_rem, sleep_rem),
            readiness_score = COALESCE(excluded.readiness_score, readiness_score),
            hrv = COALESCE(excluded.hrv, hrv),
            rhr = COALESCE(excluded.rhr, rhr),
            temperature_deviation = COALESCE(excluded.temperature_deviation, temperature_deviation),
            ${preserveHigherPriority('active_minutes', OURA_RANK)},
            respiratory_rate = COALESCE(excluded.respiratory_rate, respiratory_rate),
            spo2_percentage = COALESCE(excluded.spo2_percentage, spo2_percentage),
            ${preserveHigherPriority('distance_meters', OURA_RANK)},
            sedentary_minutes = COALESCE(excluded.sedentary_minutes, sedentary_minutes),
            low_activity_minutes = COALESCE(excluded.low_activity_minutes, low_activity_minutes),
            stress_high_minutes = COALESCE(excluded.stress_high_minutes, stress_high_minutes),
            stress_recovery_minutes = COALESCE(excluded.stress_recovery_minutes, stress_recovery_minutes),
            stress_summary = COALESCE(excluded.stress_summary, stress_summary),
            -- Runda 12 (audyt): distance_meters MUSI być na liście kolumn decydujących
            -- o zachowaniu etykiety - bez tego dni, w których wyżej notowane źródło
            -- dostarczyło WYŁĄCZNIE dystans (bez kroków/kalorii/minut w tym imporcie),
            -- traciły ochronę i etykieta przechodziła na źródło niższego rzędu.
            ${preserveSourceLabel(OURA_RANK, ACTIVITY_LABEL_COLUMNS)},
            last_sync = excluded.last_sync
        `, [
          userId, dateStr,
          metrics.steps, metrics.active_calories, metrics.total_calories,
          metrics.sleep_score, metrics.sleep_duration, metrics.sleep_deep, metrics.sleep_rem,
          metrics.readiness_score, metrics.hrv, metrics.rhr, metrics.temperature_deviation,
          // BUG (fixed): this used to be `metrics.active_minutes || 0`. When Oura activity
          // data did not arrive for a date, metrics.active_minutes was null/undefined and
          // `|| 0` turned it into the number 0 - unlike every other field above, which
          // correctly passes through as null. Because the UPDATE uses
          // COALESCE(excluded.active_minutes, active_minutes), and COALESCE treats 0 as a
          // real value rather than NULL, EVERY sync without matching activity data for that
          // date wiped out the real active-minutes value stored by a previous sync.
          metrics.active_minutes,
          metrics.respiratory_rate, metrics.spo2_percentage,
          metrics.distance_meters, metrics.sedentary_minutes, metrics.low_activity_minutes,
          metrics.stress_high_minutes, metrics.stress_recovery_minutes, metrics.stress_summary,
          activitySource,
          lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC OURA ERROR] User ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja danych Withings
async function syncWithings(userId) {
  const accessToken = await getOrRefreshToken(userId, 'withings');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Withings. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 30);
  const startTimestamp = Math.floor(past.getTime() / 1000);

  console.log(`[SYNC WITHINGS] Fetching weight measurements for user ${userId}...`);

  try {
    const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/measure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: new URLSearchParams({
        action: 'getmeas',
      // 1: weight (kg), 6: body fat %, 76: muscle mass (kg), 9: diastolic blood pressure
      // (mmHg), 10: systolic blood pressure (mmHg) - from a blood pressure monitor
        // Withings (np. BPM Core), zapisywane w tej samej grupie pomiarowej co waga.
        meastypes: '1,6,76,9,10',
        category: '1',
        lastupdate: String(startTimestamp)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Withings: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API status: ${resJson.status}`);
    }

    const measureGrps = resJson.body?.measuregrps || [];
    const lastSyncTime = new Date().toISOString();

    for (const grp of measureGrps) {
      const dateStr = timestampToDateString(grp.date);
      let weight = null;
      let fatRatio = null;
      let muscleMass = null;
      let bpSystolic = null;
      let bpDiastolic = null;

      grp.measures.forEach(m => {
        const val = m.value * Math.pow(10, m.unit);
        // B-W3: skip the measurement when the unit is undefined, otherwise NaN propagates into SQLite
        if (isNaN(val) || !isFinite(val)) return;
        if (m.type === 1) weight = Math.round(val * 100) / 100;
        if (m.type === 6) fatRatio = Math.round(val * 100) / 100;
        if (m.type === 76) muscleMass = Math.round(val * 100) / 100;
        if (m.type === 10) bpSystolic = Math.round(val);
        if (m.type === 9) bpDiastolic = Math.round(val);
      });

      if (weight !== null || fatRatio !== null || muscleMass !== null || bpSystolic !== null || bpDiastolic !== null) {
        await db.run(`
          INSERT INTO health_metrics (user_id, date, weight, fat_ratio, muscle_mass, blood_pressure_systolic, blood_pressure_diastolic, last_sync)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            weight = COALESCE(excluded.weight, weight),
            fat_ratio = COALESCE(excluded.fat_ratio, fat_ratio),
            muscle_mass = COALESCE(excluded.muscle_mass, muscle_mass),
            blood_pressure_systolic = COALESCE(excluded.blood_pressure_systolic, blood_pressure_systolic),
            blood_pressure_diastolic = COALESCE(excluded.blood_pressure_diastolic, blood_pressure_diastolic),
            last_sync = excluded.last_sync
        `, [userId, dateStr, weight, fatRatio, muscleMass, bpSystolic, bpDiastolic, lastSyncTime]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC WITHINGS ERROR] User ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Google Fit sync (steps, active calories). Unlike Apple Health, which pushes through the
// Health Auto Export webhook, Google Fit has no push mechanism, so we pull actively over
// the REST API (dataset:aggregate), as with Oura and Withings.
async function syncGoogleFit(userId) {
  const accessToken = await getOrRefreshToken(userId, 'google_fit');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Google Fit. Połącz się ponownie w Ustawieniach.' };
  }

  // The window boundaries MUST start exactly at midnight Europe/Warsaw time.
  // bucketByTime in Google Fit splits the window into buckets of durationMillis measured
  // from startTimeMillis - so buckets are aligned to the START POINT, not to UTC.
  // The start used to be "now minus 7 days", so each bucket covered a day counted from the
  // current hour (14:00-14:00, say) rather than a calendar day. Seven-day totals came out
  // roughly right, but the attribution to a specific DAY was shifted - and the time-based
  // insights (meal-timing-sleep, sedentary-sleep, early-strain-alert) rest on exactly that,
  // where a shift changes the conclusion rather than just the number. Starting at Warsaw
  // midnight makes each bucket exactly one calendar day in the same timezone the rest of the
  // application uses (see utils/dates.js).
  const now = new Date();
  const startTimeMillis = getWarsawDayStartMillis(now, -7);
  const endTimeMillis = now.getTime();

  console.log(`[SYNC GOOGLE FIT] Fetching steps/calories for user ${userId}...`);

  try {
    const response = await fetchWithTimeout('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        aggregateBy: [
          { dataTypeName: 'com.google.step_count.delta' },
          { dataTypeName: 'com.google.calories.expended' },
          { dataTypeName: 'com.google.distance.delta' }
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: String(startTimeMillis),
        endTimeMillis: String(endTimeMillis)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Google Fit API (Status ${response.status}): ${errText}`);
    }

    const data = await response.json();
    const buckets = data.bucket || [];
    const lastSyncTime = new Date().toISOString();

    for (const bucket of buckets) {
      // The buckets are aligned to Warsaw midnight (see startTimeMillis above), but
      // durationMillis is a fixed 24h, so after a daylight-saving change the later buckets in
      // the window drift by an hour - starting at 23:00 the previous day, for instance. We
      // therefore label a bucket by its MIDPOINT rather than its start: for an aligned bucket
      // the midpoint falls at noon of the same day, and for one shifted by an hour it still
      // lands inside the correct day. That keeps the day attribution correct even in the week
      // a clock change happens.
      // (The bucket's contents are then shifted by an hour - unavoidable with a fixed
      // durationMillis, short of making seven separate API requests.)
      const bucketStartMs = Number(bucket.startTimeMillis);
      const bucketEndMs = Number(bucket.endTimeMillis) || (bucketStartMs + 86400000);
      const bucketMidpointMs = bucketStartMs + (bucketEndMs - bucketStartMs) / 2;
      const dateStr = timestampToDateString(Math.floor(bucketMidpointMs / 1000));

      let steps = 0;
      let calories = 0;
      let distance = 0;
      (bucket.dataset || []).forEach(ds => {
        (ds.point || []).forEach(point => {
          const val = point.value && point.value[0];
          if (!val) return;
          if (ds.dataSourceId && ds.dataSourceId.includes('step_count')) {
            steps += val.intVal || 0;
          } else if (ds.dataSourceId && ds.dataSourceId.includes('calories')) {
            calories += val.fpVal || 0;
          } else if (ds.dataSourceId && ds.dataSourceId.includes('distance')) {
            distance += val.fpVal || 0;
          }
        });
      });
      calories = Math.round(calories);
      distance = Math.round(distance);

      if (steps > 0 || calories > 0 || distance > 0) {
        // The same column-protection pattern as syncOura, from the one shared hierarchy in
        // utils/activitySources.js: apple > google_fit > oura. Google Fit ranks above Oura
        // because, like Apple Health, it reports continuously from the phone, whereas Oura
        // only finalises a day the following morning.
        await db.run(`
          INSERT INTO health_metrics (user_id, date, steps, active_calories, distance_meters, activity_source, last_sync)
          VALUES (?, ?, ?, ?, ?, 'google_fit', ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            ${preserveHigherPriority('steps', GOOGLE_FIT_RANK)},
            ${preserveHigherPriority('active_calories', GOOGLE_FIT_RANK)},
            ${preserveHigherPriority('distance_meters', GOOGLE_FIT_RANK)},
            ${preserveSourceLabel(GOOGLE_FIT_RANK, GOOGLE_FIT_LABEL_COLUMNS)},
            last_sync = excluded.last_sync
        `, [
          userId, dateStr,
          // Round 12 (audit): the "|| null" was removed. These values start at 0 and are
          // accumulated by summing Google Fit points - 0 is a legitimate, real value for a
          // day (genuinely zero steps) rather than "no data". Converting it to null broke
          // the ON CONFLICT pattern COALESCE(excluded.x, x): null made SQLite keep the OLD
          // value, so a day with a real zero never overwrote wrong or stale data from an
          // earlier sync.
          steps, calories, distance, lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC GOOGLE FIT ERROR] User ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Oura sync for every user (invoked by the shared hourly scheduler, 05:00-22:00)
async function syncAllOura() {
  console.log('[CRON OURA] Syncing data...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'oura'`);
    for (const t of tokens) {
      await syncOura(t.user_id);
    }
    console.log(`[CRON OURA] Synced ${tokens.length} user(s).`);
  } catch (err) {
    console.error('[CRON ERROR] Oura sync failed:', err);
  }
}

// Withings sync for every user (invoked by the shared hourly scheduler, 05:00-22:00)
async function syncAllWithings() {
  console.log('[CRON WITHINGS] Syncing data...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'withings'`);
    for (const t of tokens) {
      await syncWithings(t.user_id);
    }
    console.log(`[CRON WITHINGS] Synced ${tokens.length} user(s).`);
  } catch (err) {
    console.error('[CRON ERROR] Withings sync failed:', err);
  }
}

// Google Fit sync for every user (invoked by the shared hourly scheduler, 05:00-22:00)
async function syncAllGoogleFit() {
  console.log('[CRON GOOGLE FIT] Syncing data...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'google_fit'`);
    for (const t of tokens) {
      await syncGoogleFit(t.user_id);
    }
    console.log(`[CRON GOOGLE FIT] Synced ${tokens.length} user(s).`);
  } catch (err) {
    console.error('[CRON ERROR] Google Fit sync failed:', err);
  }
}

module.exports = {
  syncOura,
  syncWithings,
  syncGoogleFit,
  syncAllOura,
  syncAllWithings,
  syncAllGoogleFit
};
