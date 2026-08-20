const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLocalDateString, getWarsawWallClock } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');
const { DEFAULT_TARGET_WATER_ML, getTargetCalories, getBmr, getTargetWaterMl } = require('../utils/defaultSettings');
const { genAI, generateContentWithFallback } = require('../config');
const { buildGoalPaceAnalysis } = require('../services/summaries');
const { getDayEventsInRange, formatDayEventsForPrompt } = require('../utils/dayEvents');
const { decrypt } = require('../utils/encryption');
const { getWeatherAndTimeContext, getUserLocationOverride } = require('../utils/weatherContext');

// --- INSIGHT REGISTRY (backing the batched /api/dashboard/insights) ---
//
// The dashboard renders several dozen independent cards, each of which used to have its
// own useEffect and its own fetch - a single visit to the screen meant ~60 HTTP
// round-trips and just as many separate series of SQLite queries. Rather than adding a
// hand-maintained list of routes (which would have drifted from reality immediately), we
// intercept the router.get() registrations and store the handler under its identifier.
// That way every NEW insight added in future joins the batch automatically, with no
// second place to remember to update.
const insightHandlers = new Map();
const INSIGHT_PATH_PREFIX = '/api/dashboard/';
const registerRoute = router.get.bind(router);

router.get = function registerAndIndex(path, ...handlers) {
  if (typeof path === 'string' && path.startsWith(INSIGHT_PATH_PREFIX)) {
    const id = path.slice(INSIGHT_PATH_PREFIX.length);
    // We skip parameterised and nested routes - the batch handles only
    // proste, bezparametrowe endpointy odczytowe.
    if (id && !id.includes('/') && !id.includes(':')) {
      insightHandlers.set(id, handlers[handlers.length - 1]);
    }
  }
  return registerRoute(path, ...handlers);
};

// A lock against generating AI advice for the same (user, date) in parallel - without it
// several dashboard refreshes in quick succession (opening a few tabs, say, or refreshing
// rapidly after a failed load) would fire N parallel requests to Gemini for an identical
// prompt, needlessly multiplying the API cost and quota usage.
const pendingAdviceGeneration = new Set();

// A lock against generating the SHORT AI explanation in parallel (ai-explanation-insight,
// round 11) - a separate Set from pendingAdviceGeneration, because it is a different cache
// (the ai_explanation/ai_explanation_generated_at columns) and a different, much shorter
// and cheaper prompt.
const pendingExplanationGeneration = new Set();

// Shifts a date (a YYYY-MM-DD string) by N days - pure calendar arithmetic through Date.UTC
// (as in the existing subtractDay), to avoid timezone errors. deltaDays may be negative
// (backwards) or positive (forwards).
const shiftDate = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Validation of the ?date= format from the query string (round 14, a fix from the audit) -
// an invalid string ("abc", or a different format) turns shiftDate/Date.UTC into an
// Invalid Date -> toISOString() throws a RangeError -> a 500 instead of readable
// behaviour. On a bad format we simply fall back to today's date, exactly as when the
// parameter is missing, rather than returning an error - less surprising for frontend calls,
// which always send a correct format.
const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;
const resolveQueryDate = (req) => {
  const raw = req.query.date;
  return typeof raw === 'string' && DATE_STRING_RE.test(raw) ? raw : getLocalDateString();
};

// --- BATCHED INSIGHT FETCH ---
//
// GET /api/dashboard/insights?ids=sleep-insight,recovery-insight&date=YYYY-MM-DD
//
// Runs the registered insight handlers in a single request and returns a map of results.
// Each insight is isolated: an error, a timeout or an unknown identifier in one does not
// bring down the whole response - the client gets a per-item status and renders the
// remaining cards normally.
//
// We register this route via registerRoute (rather than through the wrapped router.get) so
// that it does not enter the insight registry itself.

// How many handlers we run in parallel. SQLite serves a single write connection, and the
// insights are mostly reads over the same tables - full parallelism across several dozen
// handlers saturates the pool and lengthens the slowest queries instead of speeding them
// up. 6 is a compromise chosen so as not to trade one bottleneck (the network) for another
// (the database).
const INSIGHT_BATCH_CONCURRENCY = 6;

// Upper bound on the number of items in a batch - the dashboard asks for about 48 today.
// The headroom exists so new insights do not require touching this constant, but the limit
// exists because without it a single request could force arbitrarily long server work.
const INSIGHT_BATCH_MAX_IDS = 100;

// A single insight must not block the whole batch. Most are pure SQL queries
// (milliseconds), but ai-explanation-insight can call Gemini - in that case the client gets
// a 'timeout' status for that one card and can fetch it with a separate request, rather
// than waiting for everything.
const INSIGHT_BATCH_TIMEOUT_MS = 15000;

// Runs an Express handler outside the request cycle, capturing what it would have written
// to the response. The insight handlers use only res.json() and res.status().json(), so the
// stub implements exactly that contract - if someone adds an insight that uses
// res.send()/res.end(), they get a readable error rather than a silent hang.
function runInsightHandler(handler, req, dateParam) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(
      () => finish({ status: 'timeout' }),
      INSIGHT_BATCH_TIMEOUT_MS
    );

    // Prototypal inheritance from the real req - the handlers read req.user, req.ip and the
    // headers, and we substitute only query.date. Copying just a few selected fields would
    // risk silent drift if a handler reached for anything else.
    const scopedReq = Object.create(req);
    scopedReq.query = dateParam ? { date: dateParam } : {};

    let statusCode = 200;
    const scopedRes = {
      status(code) { statusCode = code; return scopedRes; },
      json(payload) {
        finish(statusCode >= 400
          ? { status: 'error', statusCode, data: payload }
          : { status: 'ok', data: payload });
      },
      send() { finish({ status: 'error', statusCode: 500, data: { error: 'Insight użył res.send() - wsad obsługuje tylko res.json().' } }); },
      end() { finish({ status: 'error', statusCode: 500, data: { error: 'Insight użył res.end() - wsad obsługuje tylko res.json().' } }); }
    };

    Promise.resolve()
      .then(() => handler(scopedReq, scopedRes))
      .catch((err) => {
        console.error('[INSIGHTS BATCH] The handler threw:', err);
        finish({ status: 'error', statusCode: 500, data: { error: 'Błąd insightu.' } });
      });
  });
}

registerRoute('/api/dashboard/insights', async (req, res) => {
  try {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const requestedIds = [...new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean)
    )];

    if (requestedIds.length === 0) {
      return res.status(400).json({
        error: 'Brak parametru ids.',
        available: [...insightHandlers.keys()].sort()
      });
    }
    if (requestedIds.length > INSIGHT_BATCH_MAX_IDS) {
      return res.status(400).json({
        error: `Zbyt wiele insightów w jednym żądaniu (limit ${INSIGHT_BATCH_MAX_IDS}).`
      });
    }

    const dateParam = typeof req.query.date === 'string' && DATE_STRING_RE.test(req.query.date)
      ? req.query.date
      : null;

    const results = {};
    // A simple worker pool: N parallel "workers" take the next item from a shared cursor.
    // Without it, Promise.all over 48 items would fire them all
    // handlery naraz.
    let cursor = 0;
    const worker = async () => {
      while (cursor < requestedIds.length) {
        const id = requestedIds[cursor++];
        const handler = insightHandlers.get(id);
        if (!handler) {
          results[id] = { status: 'unknown' };
          continue;
        }
        results[id] = await runInsightHandler(handler, req, dateParam);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(INSIGHT_BATCH_CONCURRENCY, requestedIds.length) },
        worker
      )
    );

    res.json({ date: dateParam || getLocalDateString(), results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zbiorczego pobierania insightów.' });
  }
});

// Nutrition aggregation (calories/macros) for a date range - used for the week/month
// comparisons (point 10 of the dashboard analysis). The averages are computed EXCLUSIVELY
// over days on which meals were actually logged (days_logged) - dividing by the full length
// of the period would understate the average when logging is irregular.
async function aggregateNutrition(userId, startDate, endDate) {
  const rows = await db.all(
    `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, SUM(fiber) AS fiber, SUM(sugar) AS sugar, SUM(sodium) AS sodium
     FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const daysLogged = rows.length;
  const totals = rows.reduce((acc, r) => {
    acc.calories += r.calories || 0;
    acc.protein += r.protein || 0;
    acc.carbs += r.carbs || 0;
    acc.fat += r.fat || 0;
    acc.fiber += r.fiber || 0;
    acc.sugar += r.sugar || 0;
    acc.sodium += r.sodium || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  const avg = daysLogged > 0 ? {
    calories: Math.round(totals.calories / daysLogged),
    protein: Math.round((totals.protein / daysLogged) * 10) / 10,
    carbs: Math.round((totals.carbs / daysLogged) * 10) / 10,
    fat: Math.round((totals.fat / daysLogged) * 10) / 10,
    fiber: Math.round((totals.fiber / daysLogged) * 10) / 10,
    sugar: Math.round((totals.sugar / daysLogged) * 10) / 10,
    sodium: Math.round(totals.sodium / daysLogged)
  } : null;
  return { start: startDate, end: endDate, days_logged: daysLogged, totals, avg };
}

// Cumulative calorie balance for a date range (point 11 of the dashboard analysis).
// Computed only over days with logged meals - days without logs do not spoil
// bilansu zerami.
async function aggregateCalorieBalance(userId, startDate, endDate, targetCalories, bmr) {
  const mealRows = await db.all(
    `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const healthRows = await db.all(
    `SELECT date, active_calories FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ?`,
    [userId, startDate, endDate]
  );
  const activeByDate = new Map(healthRows.map(r => [r.date, r.active_calories || 0]));

  const daysWithData = mealRows.length;
  let totalEaten = 0;
  let totalBurned = 0;
  mealRows.forEach(r => {
    totalEaten += r.calories || 0;
    totalBurned += bmr + (activeByDate.get(r.date) || 0);
  });

  return {
    start: startDate,
    end: endDate,
    days_with_data: daysWithData,
    target_calories: targetCalories,
    total_eaten: totalEaten,
    total_burned: daysWithData > 0 ? totalBurned : 0,
    balance_vs_burned: daysWithData > 0 ? totalEaten - totalBurned : null,
    balance_vs_target: daysWithData > 0 ? totalEaten - (targetCalories * daysWithData) : null
  };
}

router.get('/api/dashboard', async (req, res) => {
  const date = resolveQueryDate(req);
  try {
    // Goal settings
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    // The real HRmax based on the user's year of birth (the 220 - age formula) - previously
    // the heart-rate zones (Karvonen) computed on the frontend always assumed HRmax=190
    // (an age of ~30) regardless of the user's real age. The field is optional - if the user
    // has not given a year of birth in the profile we return null, and the frontend
    // sam wraca do fallbacku 190.
    const userRow = await db.get('SELECT birth_year FROM users WHERE id = ?', [req.user.id]);
    // Bug fix: the year is computed through getWarsawWallClock (not a bare `new Date()`,
    // which takes the Node process's timezone) - on UTC hosting, in the 00:00-01:59 window
    // on 1 January Warsaw time (which is still 31 December in UTC),
    // `new Date().getFullYear()` returned the PREVIOUS year, so HRmax (Karvonen) was
    // computed a year "too young" for the user for about 2 hours on New Year's Eve - the
    // same bug pattern as with getLocalDateString (see
    // komentarz w utils/dates.js).
    const currentYear = getWarsawWallClock().getUTCFullYear();
    const userMaxHr = userRow && userRow.birth_year ? (220 - (currentYear - userRow.birth_year)) : null;

    // Today's meals
    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    // Anomaly detector (see utils/mealAnomaly.js) - the baseline calorie distribution is
    // computed ONCE for the whole day, from the history BEFORE `date`, not per meal.
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
    const meals = mealRows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
      totalEaten.fiber += r.fiber || 0;
      totalEaten.sugar += r.sugar || 0;
      totalEaten.sodium += r.sodium || 0;
      // The database columns (sanitised on save) must override the spread from `analysis`
      // (unsanitised JSON from the AI) - otherwise the meal card would show different values
      // from the ones used just above for totalEaten.
      return {
        id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis,
        calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
        anomalies: detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
      };
    });

    // Rounding of the macros eaten
    totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
    totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
    totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;
    totalEaten.fiber = Math.round(totalEaten.fiber * 10) / 10;
    totalEaten.sugar = Math.round(totalEaten.sugar * 10) / 10;
    totalEaten.sodium = Math.round(totalEaten.sodium);

    // Health data from Oura & Withings for the selected day
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]) || getDefaultHealthMetrics();

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    // Fetch the freshest non-null/non-zero values for every health metric (if the selected ones are empty)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;
    let displayBpSystolic = health.blood_pressure_systolic;
    let displayBpDiastolic = health.blood_pressure_diastolic;
    let displaySteps = health.steps;
    let displayActiveCalories = health.active_calories;
    let displayTotalCaloriesBurned = health.total_calories_burned;
    let displaySleepScore = health.sleep_score;
    let displaySleepDuration = health.sleep_duration;
    let displaySleepDeep = health.sleep_deep;
    let displaySleepRem = health.sleep_rem;
    let displayReadinessScore = health.readiness_score;
    let displayHrv = health.hrv;
    let displayRhr = health.rhr;
    let displayTempDev = health.temperature_deviation;
    let displayRespiratoryRate = health.respiratory_rate;
    let displaySpo2 = health.spo2_percentage;
    let displayWristTemperature = health.wrist_temperature;
    let displayActiveMinutes = health.active_minutes;
    // Distance and the activity breakdown (sedentary/low) are daily counters like steps -
    // they are deliberately NOT carried over from previous days (see the comment above).
    let displayDistanceMeters = health.distance_meters;
    let displaySedentaryMinutes = health.sedentary_minutes;
    let displayLowActivityMinutes = health.low_activity_minutes;
    // Stress (Oura daily_stress) is a score computed once a day, like readiness and sleep -
    // we carry over the last available value if today's sync has not arrived yet (see the
    // analogous logic for displayReadinessScore below).
    let displayStressHighMinutes = health.stress_high_minutes;
    let displayStressRecoveryMinutes = health.stress_recovery_minutes;
    let displayStressSummary = health.stress_summary;

    if (displayWeight === null) {
      const row = await db.get(`SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWeight = row.weight;
    }
    if (displayFatRatio === null) {
      const row = await db.get(`SELECT fat_ratio FROM health_metrics WHERE user_id = ? AND fat_ratio IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayFatRatio = row.fat_ratio;
    }
    if (displayMuscleMass === null) {
      const row = await db.get(`SELECT muscle_mass FROM health_metrics WHERE user_id = ? AND muscle_mass IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayMuscleMass = row.muscle_mass;
    }
    // Blood pressure (Withings BPM) - carried over like weight and body composition, because
    // the measurement is not taken every day.
    if (displayBpSystolic === null) {
      const row = await db.get(`SELECT blood_pressure_systolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpSystolic = row.blood_pressure_systolic;
    }
    if (displayBpDiastolic === null) {
      const row = await db.get(`SELECT blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_diastolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpDiastolic = row.blood_pressure_diastolic;
    }
    // Note: the daily counters (steps, active calories, calories burned, activity minutes)
    // are deliberately NOT carried over from previous days - they are meant to reset each day
    // until that day's first sync writes new values into health_metrics.
    // (Otherwise a dashboard opened in the morning before the first sync would show
    // yesterday's steps and calories, which is wrong.)
    if (displaySleepScore === null || displaySleepScore === 0) {
      const row = await db.get(`SELECT sleep_score FROM health_metrics WHERE user_id = ? AND sleep_score IS NOT NULL AND sleep_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepScore = row.sleep_score;
    }
    if (displaySleepDuration === null || displaySleepDuration === 0) {
      const row = await db.get(`SELECT sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL AND sleep_duration > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDuration = row.sleep_duration;
    }
    if (displaySleepDeep === null || displaySleepDeep === 0) {
      const row = await db.get(`SELECT sleep_deep FROM health_metrics WHERE user_id = ? AND sleep_deep IS NOT NULL AND sleep_deep > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDeep = row.sleep_deep;
    }
    if (displaySleepRem === null || displaySleepRem === 0) {
      const row = await db.get(`SELECT sleep_rem FROM health_metrics WHERE user_id = ? AND sleep_rem IS NOT NULL AND sleep_rem > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepRem = row.sleep_rem;
    }
    if (displayReadinessScore === null || displayReadinessScore === 0) {
      const row = await db.get(`SELECT readiness_score FROM health_metrics WHERE user_id = ? AND readiness_score IS NOT NULL AND readiness_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayReadinessScore = row.readiness_score;
    }
    if (displayHrv === null || displayHrv === 0) {
      const row = await db.get(`SELECT hrv FROM health_metrics WHERE user_id = ? AND hrv IS NOT NULL AND hrv > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayHrv = row.hrv;
    }
    if (displayRhr === null || displayRhr === 0) {
      const row = await db.get(`SELECT rhr FROM health_metrics WHERE user_id = ? AND rhr IS NOT NULL AND rhr > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRhr = row.rhr;
    }
    if (displayTempDev === null) {
      const row = await db.get(`SELECT temperature_deviation FROM health_metrics WHERE user_id = ? AND temperature_deviation IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayTempDev = row.temperature_deviation;
    }
    if (displayRespiratoryRate === null) {
      const row = await db.get(`SELECT respiratory_rate FROM health_metrics WHERE user_id = ? AND respiratory_rate IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRespiratoryRate = row.respiratory_rate;
    }
    if (displaySpo2 === null) {
      const row = await db.get(`SELECT spo2_percentage FROM health_metrics WHERE user_id = ? AND spo2_percentage IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySpo2 = row.spo2_percentage;
    }
    if (displayWristTemperature === null) {
      const row = await db.get(`SELECT wrist_temperature FROM health_metrics WHERE user_id = ? AND wrist_temperature IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWristTemperature = row.wrist_temperature;
    }
    // displayActiveMinutes / displayDistanceMeters / displaySedentaryMinutes /
    // displayLowActivityMinutes: no carry-over from previous days - see the comment above.
    if (displayStressHighMinutes === null) {
      const row = await db.get(`SELECT stress_high_minutes FROM health_metrics WHERE user_id = ? AND stress_high_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressHighMinutes = row.stress_high_minutes;
    }
    if (displayStressRecoveryMinutes === null) {
      const row = await db.get(`SELECT stress_recovery_minutes FROM health_metrics WHERE user_id = ? AND stress_recovery_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressRecoveryMinutes = row.stress_recovery_minutes;
    }
    if (displayStressSummary === null) {
      const row = await db.get(`SELECT stress_summary FROM health_metrics WHERE user_id = ? AND stress_summary IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressSummary = row.stress_summary;
    }

    // The last saved body measurement (independent of the dashboard's selected day) - the
    // main Dashboard previously did not even show the latest value, even though the full CRUD
    // and the trend chart already exist in ActivityTracker.jsx.
    const latestBodyMeasurement = await db.get(
      `SELECT date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Real workouts for the given day (synced through the Apple Health webhook, see
    // routes/appleHealth.js). Computed here (before the AI prompt) so that today's workouts
    // can be passed into advicePrompt, not only into the JSON response.
    const workoutRows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories,
              avg_heart_rate, max_heart_rate, zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date = ? ORDER BY updated_at DESC`,
      [req.user.id, date]
    );
    const workouts = workoutRows.map(w => ({
      type: w.workout_type || 'Trening',
      duration_mins: Math.round(w.duration_minutes || 0),
      calories: Math.round(w.active_calories || 0),
      // Real cardio zones (Karvonen) measured on the watch during THIS workout - see
      // routes/appleHealth.js (computeWorkoutHrZones). null when the Health Auto Export
      // payload carried no heart rate (the "Include Workout Metrics" switch was off) or the
      // user has not given a year of birth (HRmax unknown).
      avg_hr: w.avg_heart_rate != null ? Math.round(w.avg_heart_rate) : null,
      max_hr: w.max_heart_rate != null ? Math.round(w.max_heart_rate) : null,
      zone_minutes: [w.zone1_minutes, w.zone2_minutes, w.zone3_minutes, w.zone4_minutes, w.zone5_minutes]
    }));

    const activeCalories = displayActiveCalories || 0;
    const bmr = getBmr(settings);
    const totalBurned = displayTotalCaloriesBurned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Goal streaks (calories, sleep) - computed exclusively from the history already stored
    // in the database (meals + health_metrics), with zero new integrations (point 9 of the
    // dashboard analysis). We count from YESTERDAY downwards relative to the date being
    // viewed (today's or the viewed day may still be unfinished - not every meal or the
    // sleep need be recorded yet), stopping at the first day that misses the goal, or at the
    // first "hole" in the data (no entry = a broken streak).
    const subtractDay = (dateStr) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().split('T')[0];
    };
    const computeStreak = (valuesByDate, referenceDateStr, meetsGoal, maxDays = 90) => {
      let streak = 0;
      let cursor = subtractDay(referenceDateStr);
      for (let i = 0; i < maxDays; i++) {
        if (!valuesByDate.has(cursor) || !meetsGoal(valuesByDate.get(cursor))) break;
        streak++;
        cursor = subtractDay(cursor);
      }
      return streak;
    };

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const calorieMap = new Map(calorieRows.map(r => [r.date, r.total_calories]));
    // "Hitting" the calorie goal = a balance within a reasonable band around the goal
    // (+/-15%), not to the exact calorie - otherwise the streak would be practically
    // impossible to keep.
    const targetCaloriesForStreak = getTargetCalories(settings);
    const calorieStreakDays = computeStreak(calorieMap, date, (total) =>
      total >= targetCaloriesForStreak * 0.85 && total <= targetCaloriesForStreak * 1.15
    );

    const sleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const sleepMap = new Map(sleepRows.map(r => [r.date, r.sleep_duration]));
    // FIX (audit round 4): !settings.target_sleep_duration treated a real 0 saved by the user
    // (the sleep goal switched off) the same as "no goal set"
    // (settings.target_sleep_duration === undefined, when there is no row in the settings
    // table). Now the 7.2h fallback kicks in only when the value is genuinely absent or NaN.
    const targetSleepForStreak = (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration;
    const sleepStreakDays = computeStreak(sleepMap, date, (duration) => duration >= targetSleepForStreak);

    // Generating the Dietetyk AI advice from today's data (optional/throttled to every 4h, or immediately after a meal change)
    let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
    let hasValidCache = false;

    if (health && health.ai_advice) {
      aiAdvice = health.ai_advice;
      if (health.ai_advice_generated_at) {
        const lastGenerated = new Date(health.ai_advice_generated_at).getTime();
        const lastModified = health.last_meal_modified_at ? new Date(health.last_meal_modified_at).getTime() : 0;
        
        // The cache is valid when the advice was generated after the last meal modification
        // AND less than 4 hours have passed since it was generated (4 * 60 * 60 * 1000)
        if (lastGenerated > lastModified && (Date.now() - lastGenerated < 4 * 60 * 60 * 1000)) {
          hasValidCache = true;
        }
      }
    }

    if (!hasValidCache) {
      // IMPORTANT: the dashboard must be generated EXCLUSIVELY from data already stored in
      // the database - the same report that made us remove the demo data from the frontend
      // applies here too. Previously this block did "await generateContentWithFallback(...)"
      // while handling the GET /api/dashboard request, which meant the ENTIRE response
      // (including steps, calories and sleep - data that was already sitting ready in the
      // database) waited on a live network call to Gemini. Hence the impression that "the
      // dashboard is still loading" when opening the page.
      // Now: if the advice cache has expired we return what we already have in the database
      // (the old advice or a default placeholder) immediately, and generate the new advice in
      // the background (fire-and-forget) - it lands in the database and appears on the next
      // refresh or sync, without blocking this response.
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));

      // The (user, date) key for the parallel-generation lock (see the definition of
      // pendingAdviceGeneration at the top of the file) - if generation for this (user, date)
      // is already in progress (another browser tab refreshed the dashboard a moment earlier,
      // for instance), we do NOT fire another Gemini request and leave the old cache or
      // placeholder in place.
      const adviceLockKey = `${req.user.id}:${date}`;

      if (canUseAI && !pendingAdviceGeneration.has(adviceLockKey) && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
        // The first name (if set in Settings) takes priority over the technical login - this
        // is what the user asked for: the AI should address them by name, not by account name.
        const displayName = req.user.first_name || req.user.username;

        // Yesterday's measurements and meals, as comparative context for the AI
        const yesterdayDate = shiftDate(date, -1);
        const yesterdayMealRows = await db.all(
          `SELECT calories, protein, carbs, fat, raw_text FROM meals WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        );
        let yesterdayTotalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        yesterdayMealRows.forEach(r => {
          yesterdayTotalEaten.calories += r.calories || 0;
          yesterdayTotalEaten.protein += r.protein || 0;
          yesterdayTotalEaten.carbs += r.carbs || 0;
          yesterdayTotalEaten.fat += r.fat || 0;
        });
        yesterdayTotalEaten.protein = Math.round(yesterdayTotalEaten.protein * 10) / 10;
        yesterdayTotalEaten.carbs = Math.round(yesterdayTotalEaten.carbs * 10) / 10;
        yesterdayTotalEaten.fat = Math.round(yesterdayTotalEaten.fat * 10) / 10;

        const yesterdayHealth = await db.get(
          `SELECT active_calories, steps, supplements FROM health_metrics WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        ) || { active_calories: 0, steps: 0, supplements: null };

        // Fetching the historical trends from the database for the AI
        const last7DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -7), shiftDate(date, -1));
        const last30DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -30), shiftDate(date, -1));
        
        const weightHistory = await db.all(
          `SELECT date, weight, fat_ratio, muscle_mass FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const sleepHistory = await db.all(
          `SELECT date, sleep_score, readiness_score FROM health_metrics WHERE user_id = ? AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL) ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const bpHistory = await db.all(
          `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        // The full supplement history (the last 7 days with an entry, not just today and
        // yesterday) - the user explicitly asked that the AI summary take in EVERYTHING
        // entered in the app, supplements included, not only the last two days.
        const supplementsHistory = await db.all(
          `SELECT date, supplements FROM health_metrics WHERE user_id = ? AND supplements IS NOT NULL AND supplements != '' ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );

        // "Day tag" (day_events) from the last 30 days (the same window as last30DaysNutrition) -
        // so that the AI knows about days marked as illness/holiday/a late bedtime and does
        // not build recommendations on the unusual data from those days (see utils/dayEvents.js).
        const dayEventsInWindow = await getDayEventsInRange(req.user.id, shiftDate(date, -30), date);
        const dayEventsContext = formatDayEventsForPrompt(dayEventsInWindow);

        // The body goal (a text description plus an optional reference photo, set in
        // Settings - see routes/account.js and the migration in db.js). We do not keep this
        // in req.user (middleware/auth.js), because a base64 photo could be large and would
        // needlessly weigh down EVERY authenticated request - we fetch it only here, once per
        // actual AI advice generation.
        const bodyGoalRow = await db.get(`SELECT body_goal_text, body_goal_photo_base64 FROM users WHERE id = ?`, [req.user.id]);
        const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;
        let bodyGoalImagePart = null;
        if (bodyGoalRow && bodyGoalRow.body_goal_photo_base64) {
          const goalPhotoMatch = bodyGoalRow.body_goal_photo_base64.match(/^data:([^;]+);base64,(.+)$/);
          if (goalPhotoMatch) {
            bodyGoalImagePart = {
              inlineData: {
                data: goalPhotoMatch[2],
                mimeType: goalPhotoMatch[1]
              }
            };
          }
        }

        const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
        const language = langRow ? langRow.value : 'pl';

        // The current weather and time of day (task: the algorithm must know and take the
        // current weather and time into account in its analysis - see utils/weatherContext.js).
        // This advice is cached for up to 4h (see hasValidCache above), so the "currentness"
        // of the weather has the same resolution as the rest of the advice - consistent with
        // the rest of this function, not a live reading on every GET /api/dashboard.
        // Location: the user's own (Settings -> Location) if set, otherwise the deployment's
        // default location.
        const userLocation = await getUserLocationOverride(req.user.id);
        const weatherTimeContext = await getWeatherAndTimeContext(language, userLocation?.lat, userLocation?.lon);

        let advicePrompt = '';
        if (language === 'en') {
          advicePrompt = `
You are a professional, friendly AI sports dietician working in the "Dietetyk AI" app.
Analyze today's balance for user ${displayName} on date ${date}:
User Goals:
- Target daily calorie intake: ${getTargetCalories(settings)} kcal
- Target Protein: ${settings.target_protein}g, Carbs: ${settings.target_carbs}g, Fat: ${settings.target_fat}g
- BMR (Basal Metabolic Rate): ${bmr} kcal
- User body goal description: ${bodyGoalText || 'not described in Settings'}${bodyGoalImagePart ? '\n- The user also attached a reference photo of their body goal (see the attached image) - analyze it visually and relate recommendations to the body shape shown in the photo (e.g., muscle level, fat tissue, proportions), in the context of other data.' : ''}

Today's Balance:
- Total eaten: ${totalEaten.calories} kcal (Protein: ${totalEaten.protein}g, Carbs: ${totalEaten.carbs}g, Fat: ${totalEaten.fat}g, Fiber: ${totalEaten.fiber}g, Sugar: ${totalEaten.sugar}g, Sodium: ${totalEaten.sodium}mg)
- Active calories burned: ${activeCalories} kcal
- Total calories burned (BMR + Active): ${totalBurned} kcal
- Net balance (eaten - burned): ${netCalories} kcal
- Steps today: ${displaySteps || 0}
- Activity today: ${displayActiveMinutes || 0} min active, Distance: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Sedentary time: ${displaySedentaryMinutes || 0} min, Light activity: ${displayLowActivityMinutes || 0} min
- Water intake today: ${health.water_ml || 0}ml (target: ${getTargetWaterMl(settings)}ml)
- Supplements taken today: ${health.supplements || 'none (user did not save any supplements today)'}
- Subjective state (user rating, scale 1-5): Energy: ${health.energy_level != null ? health.energy_level + '/5' : 'not rated'}, Mood: ${health.mood != null ? health.mood + '/5' : 'not rated'}
- Workouts registered today (Apple Health): ${workouts.length > 0 ? workouts.map(w => {
    const base = `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`;
    if (w.avg_hr != null && w.zone_minutes.some(z => z != null)) {
      const zonesStr = w.zone_minutes.map((z, i) => `Z${i + 1}: ${Math.round(z || 0)}min`).join(', ');
      return `${base}, avg HR ${w.avg_hr} bpm (max ${w.max_hr} bpm) - heart rate zones: ${zonesStr}`;
    }
    return base;
  }).join(', ') : 'no registered workouts'}
- Calorie target streak: ${calorieStreakDays} days, Sleep target streak: ${sleepStreakDays} days

Current time and weather (context, not a user-logged metric):
${weatherTimeContext}

Oura Sleep/Readiness & Withings Body Composition:
- Sleep Score: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'no data'} (Duration: ${displaySleepDuration || 0}h, Deep: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Heart & Temp parameters: Resting HR (RHR): ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Wrist temperature deviation: ${displayTempDev !== null ? displayTempDev + ' °C' : 'N/A'}
- Respiration & SpO2: Respiratory rate: ${displayRespiratoryRate !== null ? displayRespiratoryRate + '/min' : 'N/A'}, SpO2: ${displaySpo2 !== null ? displaySpo2 + '%' : 'N/A'}, Wrist temperature: ${displayWristTemperature !== null ? displayWristTemperature + ' °C' : 'N/A'}
- Stress (Oura): High stress: ${displayStressHighMinutes !== null ? displayStressHighMinutes + ' min' : 'no data'}, Recovery: ${displayStressRecoveryMinutes !== null ? displayStressRecoveryMinutes + ' min' : 'no data'}, Stress summary: ${displayStressSummary || 'N/A'}
- Readiness Score: ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'no data'}
- Body Composition: Weight: ${displayWeight !== null ? displayWeight + ' kg' : 'no data'}, Body fat percentage: ${displayFatRatio !== null ? displayFatRatio + '%' : 'no data'}, Muscle mass: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'no data'}
- Blood Pressure (Withings): ${displayBpSystolic !== null && displayBpDiastolic !== null ? `${displayBpSystolic}/${displayBpDiastolic} mmHg` : 'no data'}
- Body measurements (latest from ${latestBodyMeasurement ? latestBodyMeasurement.date : 'N/A'}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Waist: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Waist +2cm: ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Waist -2cm: ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Chest: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Shoulders: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Hips: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps Left: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps Right: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Thigh: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'no fields filled' : 'no data in database'}

Today's meals list:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fat}g)`).join('\n') || 'No meals logged'}

Yesterday's context (${yesterdayDate}):
- Yesterday total eaten: ${yesterdayTotalEaten.calories} kcal (P: ${yesterdayTotalEaten.protein}g, C: ${yesterdayTotalEaten.carbs}g, F: ${yesterdayTotalEaten.fat}g)
- Yesterday active calories: ${yesterdayHealth.active_calories || 0} kcal
- Yesterday steps: ${yesterdayHealth.steps || 0}
- Yesterday supplements: ${yesterdayHealth.supplements || 'none'}
- Yesterday meals list:
${yesterdayMealRows.map(m => `- ${m.raw_text} (${m.calories} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fat}g)`).join('\n') || 'No meals logged yesterday'}

Trends and database history:
- Average nutrition (last 7 days): ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (P: ${last7DaysNutrition.avg.protein}g, C: ${last7DaysNutrition.avg.carbs}g, F: ${last7DaysNutrition.avg.fat}g, Fiber: ${last7DaysNutrition.avg.fiber}g, Sugar: ${last7DaysNutrition.avg.sugar}g, Sodium: ${last7DaysNutrition.avg.sodium}mg) over ${last7DaysNutrition.days_logged} logged days` : 'no data'}
- Average nutrition (last 30 days): ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (P: ${last30DaysNutrition.avg.protein}g, C: ${last30DaysNutrition.avg.carbs}g, F: ${last30DaysNutrition.avg.fat}g, Fiber: ${last30DaysNutrition.avg.fiber}g, Sugar: ${last30DaysNutrition.avg.sugar}g, Sodium: ${last30DaysNutrition.avg.sodium}mg) over ${last30DaysNutrition.days_logged} logged days` : 'no data'}
- Weight & body composition history:
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (fat: ${w.fat_ratio || '-'}%, muscle: ${w.muscle_mass || '-'} kg)`).join('\n') || 'no data'}
- Supplements history (latest):
${supplementsHistory.map(s => `- ${s.date}: ${s.supplements}`).join('\n') || 'no data'}
- Latest Oura sleep/readiness history:
${sleepHistory.map(s => `- ${s.date}: Sleep ${s.sleep_score || '-'}, Readiness ${s.readiness_score || '-'}`).join('\n') || 'no data'}
- Blood pressure history (Withings):
${bpHistory.map(b => `- ${b.date}: ${b.blood_pressure_systolic}/${b.blood_pressure_diastolic} mmHg`).join('\n') || 'no data'}
${dayEventsContext}

Your analysis MUST consider ALL data above (today's meals & micronutrients, activity, workouts, supplements, yesterday's comparison, 7/30-day trends, weight/body composition/circumference history, blood pressure, sleep, readiness, stress, respiration). Make sure to address:
1. Workout intensity and cardio zones: if "heart rate zones" are provided (Z1-Z5 based on Karvonen), base your evaluation on these real zones. Relate minutes in zones to the user's body goal.
2. Precise dietary adjustments based on today's meals and workout, including fiber, simple sugars, and sodium quality.
3. Comparison with yesterday and the 7/30-day trend.
4. Insights from weight, body composition, and circumference trends.
5. Supplement intake: analyze supplement history and comment on regularity, timing, and usefulness.
6. Blood pressure: evaluate if values are within range, and advise consulting a doctor if values are elevated (do not diagnose).
7. Recovery and stress (Oura): SpO2, respiratory rate, wrist temperature, stress minutes.
8. Calorie/sleep streaks: highlight consistency or suggest how to return to track.
9. Body goal: assess if current trend, diet, and training are leading towards it.
10. Days with a Day Tag (if any): adjust recommendations and do not count deviations from these days as normal.

Format the response STRICTLY in this Markdown structure:
1. One short, personalized introductory sentence addressing the user by name (${displayName}).
2. Header "## Analysis" followed by 2-3 concise sentences synthesizing today's data against historical trends.
3. Header "## Recommendations" followed by a bullet list (3-5 points, each starting with "- ") detailing concrete, actionable recommendations.

Use **bolding** for key numbers and phrases in the Analysis and Recommendations. Write in English, directly to the user, concisely and factually.
`;
        } else {
          advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${displayName} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${getTargetCalories(settings)} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanych: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal
- Cel sylwetki opisany przez użytkownika: ${bodyGoalText || 'użytkownik nie opisał celu sylwetki w Ustawieniach'}${bodyGoalImagePart ? '\n- Użytkownik dołączył też zdjęcie referencyjne celu sylwetki (patrz załączony obraz) - przeanalizuj je wizualnie i odnieś rekomendacje do tego, jak wygląda sylwetka na zdjęciu (np. poziom umięśnienia, tkanki tłuszczowej, proporcje), w kontekście pozostałych danych.' : ''}

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g, Błonnik: ${totalEaten.fiber}g, Cukry: ${totalEaten.sugar}g, Sód: ${totalEaten.sodium}mg)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}
- Aktywność dzisiaj: ${displayActiveMinutes || 0} min aktywności, Dystans: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Czas siedzący: ${displaySedentaryMinutes || 0} min, Niska intensywność: ${displayLowActivityMinutes || 0} min
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${getTargetWaterMl(settings)}ml)
- Przyjęte suplementy dzisiaj: ${health.supplements || 'brak (użytkownik nie zapisał dzisiaj żadnych suplementów)'}
- Samopoczucie (ręczna ocena użytkownika, skala 1-5): Energia: ${health.energy_level != null ? health.energy_level + '/5' : 'nie oceniono'}, Nastrój: ${health.mood != null ? health.mood + '/5' : 'nie oceniono'}
- Treningi zarejestrowane dzisiaj (Apple Health): ${workouts.length > 0 ? workouts.map(w => {
    const base = `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`;
    if (w.avg_hr != null && w.zone_minutes.some(z => z != null)) {
      const zonesStr = w.zone_minutes.map((z, i) => `Z${i + 1}: ${Math.round(z || 0)}min`).join(', ');
      return `${base}, śr. tętno ${w.avg_hr} bpm (max ${w.max_hr} bpm) - realny rozkład stref kardio: ${zonesStr}`;
    }
    return base;
  }).join(', ') : 'brak zarejestrowanych treningów'}
- Passa (streak) trafiania w cel kaloryczny: ${calorieStreakDays} dni, Passa snu wg celu: ${sleepStreakDays} dni

Aktualny czas i pogoda (kontekst, nie metryka zapisana przez użytkownika):
${weatherTimeContext}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Oddech i utlenowanie krwi: Częstość oddechów: ${displayRespiratoryRate !== null ? displayRespiratoryRate + '/min' : 'brak'}, SpO2: ${displaySpo2 !== null ? displaySpo2 + '%' : 'brak'}, Temperatura nadgarstka: ${displayWristTemperature !== null ? displayWristTemperature + ' °C' : 'brak'}
- Stres (Oura): Wysoki stres: ${displayStressHighMinutes !== null ? displayStressHighMinutes + ' min' : 'brak danych'}, Regeneracja: ${displayStressRecoveryMinutes !== null ? displayStressRecoveryMinutes + ' min' : 'brak danych'}, Podsumowanie: ${displayStressSummary || 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}
- Ciśnienie tętnicze (Withings): ${displayBpSystolic !== null && displayBpDiastolic !== null ? `${displayBpSystolic}/${displayBpDiastolic} mmHg` : 'brak danych'}
- Obwody ciała (ostatni zapisany pomiar${latestBodyMeasurement ? ', ' + latestBodyMeasurement.date : ''}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Pas +2cm: ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Pas -2cm: ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Barki: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps lewy: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps prawy: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'brak wypełnionych pól' : 'brak danych w bazie'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Dla kontekstu historycznego, oto dane z wczoraj (${yesterdayDate}):
- Łącznie zjedzone wczoraj: ${yesterdayTotalEaten.calories} kcal (Białko: ${yesterdayTotalEaten.protein}g, Węgle: ${yesterdayTotalEaten.carbs}g, Tłuszcz: ${yesterdayTotalEaten.fat}g)
- Aktywne kalorie spalone wczoraj: ${yesterdayHealth.active_calories || 0} kcal
- Wykonane kroki wczoraj: ${yesterdayHealth.steps || 0}
- Przyjęte suplementy wczoraj: ${yesterdayHealth.supplements || 'brak'}
- Lista wczorajszych posiłków:
${yesterdayMealRows.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak posiłków wczoraj'}

Trendy i historia z bazy danych użytkownika:
- Średnie odżywianie z ostatnich 7 dni: ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (B: ${last7DaysNutrition.avg.protein}g, W: ${last7DaysNutrition.avg.carbs}g, T: ${last7DaysNutrition.avg.fat}g, Błonnik: ${last7DaysNutrition.avg.fiber}g, Cukry: ${last7DaysNutrition.avg.sugar}g, Sód: ${last7DaysNutrition.avg.sodium}mg) na ${last7DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Średnie odżywianie z ostatnich 30 dni: ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (B: ${last30DaysNutrition.avg.protein}g, W: ${last30DaysNutrition.avg.carbs}g, T: ${last30DaysNutrition.avg.fat}g, Błonnik: ${last30DaysNutrition.avg.fiber}g, Cukry: ${last30DaysNutrition.avg.sugar}g, Sód: ${last30DaysNutrition.avg.sodium}mg) na ${last30DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Historia pomiarów wagi i składu ciała (ostatnie wpisy):
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (tłuszcz: ${w.fat_ratio || '-'}%, mięśnie: ${w.muscle_mass || '-'} kg)`).join('\n') || 'brak danych w bazie'}
- Historia suplementów (ostatnie wpisy, nie tylko dziś/wczoraj):
${supplementsHistory.map(s => `- ${s.date}: ${s.supplements}`).join('\n') || 'brak zapisanych suplementów w bazie'}
- Ostatnia jakość snu i gotowości Oura:
${sleepHistory.map(s => `- ${s.date}: Sen ${s.sleep_score || '-'}, Gotowość ${s.readiness_score || '-'}`).join('\n') || 'brak danych w bazie'}
- Historia ciśnienia tętniczego (Withings, ostatnie pomiary):
${bpHistory.map(b => `- ${b.date}: ${b.blood_pressure_systolic}/${b.blood_pressure_diastolic} mmHg`).join('\n') || 'brak danych w bazie'}
${dayEventsContext}
Twoja analiza MUSI uwzględniać WSZYSTKIE dane podane powyżej (dzisiejsze posiłki i mikroelementy, aktywność, treningi, suplementy, porównanie z wczoraj, trendy 7/30-dniowe, historię wagi/składu ciała/obwodów, ciśnienia tętniczego, snu, gotowości, stresu i parametrów oddechowych) - to jest kluczowa funkcja tej aplikacji, użytkownik oczekuje analizy na bazie CAŁEJ historii i wszystkich dostępnych metryk, nie tylko jednego dnia czy wybranych wskaźników. Weź pod uwagę przy analizie i rekomendacjach:
1. Intensywność wysiłku i strefy kardio: jeśli przy treningu podano "realny rozkład stref kardio" (zmierzony tętnem podczas treningu, strefy Z1-Z5 metodą Karvonena: Z1 regeneracja, Z2 spalanie tłuszczu/baza tlenowa, Z3 tempo, Z4-Z5 wysoka intensywność beztlenowa), PRIORYTETOWO oprzyj ocenę na tych realnych minutach w strefach, nie na szacowaniu - i odnieś ten rozkład wprost do celu sylwetki użytkownika (np. przy celu redukcji/spalania tłuszczu doceń czas w Z2, przy celu budowy wydolności/masy zwróć uwagę na czas w Z3-Z4, a nadmiar minut w Z1 przy intensywnym typie treningu skomentuj jako niewykorzystany potencjał). Jeśli realnych stref nie podano (brak danych z zegarka), oceń intensywność orientacyjnie na bazie aktywnych kalorii, typu/czasu trwania treningu oraz RHR/HRV, zaznaczając że to oszacowanie.
2. Precyzyjne zmiany w diecie na bazie dzisiejszych posiłków i treningu, w tym jakość diety pod kątem błonnika, cukrów prostych i sodu (np. zbyt mało błonnika w stosunku do kalorii, zbyt dużo cukrów prostych lub sodu w ostatnich dniach) - nie tylko makra, ale pełny obraz odżywiania.
3. Porównanie dzisiejszego odżywiania i aktywności z wczorajszymi oraz z trendem 7/30-dniowym - jeśli dieta z ostatnich dni nie była optymalna (np. za mało białka w stosunku do celu, zbyt mało kcal po dużym treningu lub nadmiar kalorii przy braku ruchu), wskaż to konstruktywnie i doradź konkretną korektę.
4. Wnioski z trendu wagi, składu ciała i obwodów ciała z ostatnich pomiarów Withings oraz jakości snu, regeneracji i poziomu stresu z Oura (zwróć uwagę, czy obecny trend przybliża użytkownika do celu w dłuższej perspektywie 7/30 dni).
5. Przyjęte suplementy: przeanalizuj CAŁĄ historię suplementów (nie tylko dziś/wczoraj, ale wszystkie dostępne wpisy z ostatnich dni) i skomentuj krótko ich przydatność, regularność przyjmowania i czas przyjmowania w odniesieniu do treningu i samopoczucia użytkownika.
6. Ciśnienie tętnicze: jeśli dostępne są pomiary ciśnienia, oceń czy wartości są w normie (orientacyjnie <120/80 mmHg optymalnie, 120-129/<80 podwyższone prawidłowe, ≥130/80 nadciśnienie) i czy trend z ostatnich pomiarów jest stabilny, rosnący czy spadkowy - jeśli widzisz niepokojący trend lub wartości podwyższone, zalecaj konsultację lekarską (nie diagnozuj).
7. Regeneracja i stres: jeśli dostępne są dane o stresie (Oura), SpO2, częstości oddechów czy temperaturze nadgarstka, skomentuj ogólny stan regeneracji organizmu i zasugeruj, czy potrzebny jest dzień odpoczynku.
8. Konsekwencja (streaki): jeśli użytkownik ma passę trafiania w cel kaloryczny lub cel snu, doceń to krótko - jeśli passa jest przerwana lub bliska zera, zachęcająco zasugeruj, jak wrócić na właściwe tory.
9. Cel sylwetki: jeśli użytkownik opisał swój cel sylwetki (i/lub dołączył zdjęcie referencyjne), odnieś dzisiejsze i historyczne dane DO TEGO CELU - oceń, czy obecne tempo, dieta i trening realnie do niego prowadzą, i jeśli nie, zaproponuj konkretną korektę. Jeśli cel nie został opisany, pomiń ten punkt bez komentowania jego braku.
10. Dni oznaczone "Tagiem dnia" (jeśli podane powyżej): jeśli dzisiejsza data lub dni z analizowanej historii pokrywają się z oznaczonym okresem (choroba, wakacje/urlop, późne zaśnięcie), uwzględnij ten kontekst i NIE buduj korygujących rekomendacji na bazie odchyleń z tych dni - są one już wyjaśnione i oczekiwane.

Sformatuj odpowiedź WYŁĄCZNIE w tej strukturze Markdown (frontend renderuje nagłówki, pogrubienia i listy punktowane):
1. Jedno krótkie, spersonalizowane zdanie wstępu, zwracające się do użytkownika po imieniu (${displayName}).
2. Nagłówek "## Analiza" a pod nim 2-3 zwięzłe zdania syntetyzujące dzisiejsze dane NA TLE trendu historycznego (wczoraj + 7/30 dni) - to ma być realna analiza porównawcza, nie powtórzenie samych liczb.
3. Nagłówek "## Rekomendacje" a pod nim lista punktowana (3-5 punktów, każdy zaczynający się od "- ") z konkretnymi, wykonalnymi działaniami wynikającymi z analizy (dieta i mikroelementy, trening, regeneracja i stres, suplementy, ciśnienie - tylko te obszary, które mają pokrycie w danych).
Używaj **pogrubienia** dla kluczowych liczb i fraz w Analizie i Rekomendacjach. Pisz w języku polskim, bezpośrednio do użytkownika, konkretnie i merytorycznie, bez lania wody.
`;
        }

        // We mark (user, date) as "generation in progress" BEFORE starting the Gemini request,
        // so that a subsequent, nearly simultaneous GET /api/dashboard (see the
        // pendingAdviceGeneration.has(...) condition above) does not fire a duplicate.
        pendingAdviceGeneration.add(adviceLockKey);

        // Fire-and-forget: we do NOT await the result in this request (see the comment above).
        generateContentWithFallback(advicePrompt, false, bodyGoalImagePart, userApiKey, forceCustomKeyOnly)
          .then(async (text) => {
            const trimmed = text.trim();
            const nowStr = new Date().toISOString();
            await db.run(`
              INSERT INTO health_metrics (user_id, date, ai_advice, ai_advice_generated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET
                ai_advice = excluded.ai_advice,
                ai_advice_generated_at = excluded.ai_advice_generated_at
            `, [req.user.id, date, trimmed, nowStr]);
          })
          .catch((aiErr) => {
            console.error('[API ERROR] Failed to generate the AI advice (in the background):', aiErr);
          })
          .finally(() => {
            // We clear the lock both on success and on failure - otherwise an error (a
            // temporary Gemini outage, say) would block advice generation for this
            // (user, date) forever, until the server restarted.
            pendingAdviceGeneration.delete(adviceLockKey);
          });
      }
    }

    res.json({
      date,
      summary: {
        target_calories: settings.target_calories,
        target_protein: settings.target_protein,
        target_carbs: settings.target_carbs,
        target_fat: settings.target_fat,
        // FIX (audit round 4): these fields are activity goals editable in
        // ActivityTracker/Settings with a min="0" attribute - the user may deliberately save 0
        // (switching off step-goal tracking, for instance). The previous `!value` condition
        // treated that stored 0 identically to "no row in settings" (undefined) and
        // irrecoverably overwrote it with the default value on every dashboard refresh - the 0
        // never made it back to the frontend. Now the fallback applies only to a genuinely
        // missing (undefined) or invalid (NaN) value.
        target_steps: (settings.target_steps === undefined || isNaN(settings.target_steps)) ? 10000 : settings.target_steps,
        target_active_calories: (settings.target_active_calories === undefined || isNaN(settings.target_active_calories)) ? 500 : settings.target_active_calories,
        target_sleep_duration: (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration,
        target_active_minutes: (settings.target_active_minutes === undefined || isNaN(settings.target_active_minutes)) ? 30 : settings.target_active_minutes,
        target_water_ml: getTargetWaterMl(settings),
        // Weight goal (kg) - an optional field (0 = no goal set), used by ActivityTracker.jsx
        // for the "to goal" forecast (linear regression). Without listing it here it would not
        // come back from /api/dashboard despite being saved in the settings table by
        // POST /api/settings (see account.js).
        target_weight_kg: (settings.target_weight_kg === undefined || isNaN(settings.target_weight_kg)) ? 0 : settings.target_weight_kg,
        height_cm: isNaN(settings.height_cm) || !settings.height_cm || settings.height_cm <= 0 ? null : settings.height_cm,
        bmr,
        calories_eaten: totalEaten.calories,
        calories_burned_active: activeCalories,
        calories_burned_total: totalBurned,
        net_calories: netCalories,
        eaten_protein: totalEaten.protein,
        eaten_carbs: totalEaten.carbs,
        eaten_fat: totalEaten.fat,
        steps: displaySteps || 0,
        workouts,
        last_sync: health.last_sync,
        sleep_score: displaySleepScore,
        sleep_duration: displaySleepDuration,
        sleep_deep: displaySleepDeep,
        sleep_rem: displaySleepRem,
        readiness_score: displayReadinessScore,
        hrv: displayHrv,
        rhr: displayRhr,
        temperature_deviation: displayTempDev,
        respiratory_rate: displayRespiratoryRate,
        spo2_percentage: displaySpo2,
        wrist_temperature: displayWristTemperature,
        weight: displayWeight,
        fat_ratio: displayFatRatio,
        muscle_mass: displayMuscleMass,
        blood_pressure_systolic: displayBpSystolic,
        blood_pressure_diastolic: displayBpDiastolic,
        active_minutes: displayActiveMinutes || 0,
        distance_meters: displayDistanceMeters || 0,
        sedentary_minutes: displaySedentaryMinutes || 0,
        low_activity_minutes: displayLowActivityMinutes || 0,
        stress_high_minutes: displayStressHighMinutes,
        stress_recovery_minutes: displayStressRecoveryMinutes,
        stress_summary: displayStressSummary,
        water_ml: health.water_ml || 0,
        supplements: health.supplements || null,
        energy_level: health.energy_level ?? null,
        mood: health.mood ?? null,
        has_oura: !!hasOuraRow,
        has_withings: !!hasWithingsRow,
        activity_source: health.activity_source || null,
        latest_body_measurement: latestBodyMeasurement || null,
        calorie_streak_days: calorieStreakDays,
        sleep_streak_days: sleepStreakDays,
        user_max_hr: userMaxHr
      },
      meals,
      aiAdvice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych dashboardu.' });
  }
});

// Week/month nutrition comparison - the current period (the last 7/30 days counting back
// from the selected date) vs the previous period of the same length.
router.get('/api/dashboard/nutrition-comparison', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const weekCurrentStart = shiftDate(today, -6);
    const weekPreviousEnd = shiftDate(weekCurrentStart, -1);
    const weekPreviousStart = shiftDate(weekPreviousEnd, -6);

    const monthCurrentStart = shiftDate(today, -29);
    const monthPreviousEnd = shiftDate(monthCurrentStart, -1);
    const monthPreviousStart = shiftDate(monthPreviousEnd, -29);

    const [weekCurrent, weekPrevious, monthCurrent, monthPrevious] = await Promise.all([
      aggregateNutrition(req.user.id, weekCurrentStart, today),
      aggregateNutrition(req.user.id, weekPreviousStart, weekPreviousEnd),
      aggregateNutrition(req.user.id, monthCurrentStart, today),
      aggregateNutrition(req.user.id, monthPreviousStart, monthPreviousEnd)
    ]);

    const pctChange = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    res.json({
      date: today,
      week: {
        current: weekCurrent,
        previous: weekPrevious,
        calories_change_pct: pctChange(weekCurrent.avg?.calories, weekPrevious.avg?.calories)
      },
      month: {
        current: monthCurrent,
        previous: monthPrevious,
        calories_change_pct: pctChange(monthCurrent.avg?.calories, monthPrevious.avg?.calories)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania porównania odżywiania.' });
  }
});

// Cumulative calorie balance for the last 7 and 30 days relative to the goal.
router.get('/api/dashboard/calorie-balance', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const [week, month] = await Promise.all([
      aggregateCalorieBalance(req.user.id, shiftDate(today, -6), today, targetCalories, bmr),
      aggregateCalorieBalance(req.user.id, shiftDate(today, -29), today, targetCalories, bmr)
    ]);

    res.json({ date: today, week, month });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania bilansu kalorycznego.' });
  }
});

// Insight: the effect of sleep on the NEXT day's nutrition (calories/sugar). We split the
// nights with sleep data (Oura) into "short sleep" and "sufficient sleep" relative to the
// user's goal (target_sleep_duration, 7.2h by default - the same goal as on the "Czas snu"
// card), and then compare the average calorie/sugar intake on the following day across the
// two groups. This is not a statistical test - it is a descriptive comparison of two averages
// over the user's real data, so we require a minimum number of days in EACH group
// (MIN_NIGHTS_PER_GROUP), otherwise the result would be accidental (one short night that
// happened to be followed by a filling dinner, say).
const MIN_NIGHTS_PER_GROUP = 5;
const SLEEP_INSIGHT_LOOKBACK_DAYS = 90;

router.get('/api/dashboard/sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SLEEP_INSIGHT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const sleepThreshold = settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)
      ? 7.2
      : settings.target_sleep_duration;

    // Nights with a known sleep duration - the date of that night is the day Oura assigns the
    // sleep to (the morning after waking), so the "next day" in the nutrition sense is simply
    // date+1.
    const rawSleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_duration IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    // Day tag: nights marked as "a late bedtime" are excluded from computing the
    // short-sleep -> next-day eating effect - that is a known, documented exception and should
    // not shape the baseline of the user's "typical" short night.
    const lateSleepExcluded = await getExcludedDates(req.user.id, ['late_sleep'], startDate, today);
    const sleepRows = rawSleepRows.filter(r => !lateSleepExcluded.has(r.date));

    if (sleepRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_sleep_data', sleepThreshold });
    }

    // Meals grouped by day - we need the calorie/sugar totals for EVERY day in the window
    // (+1 day beyond the sleep range, to cover the "next day" after
    // ostatniej nocy z danymi).
    const mealRows = await db.all(
      `SELECT date, SUM(calories) AS calories, SUM(sugar) AS sugar
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const mealsByDate = new Map(mealRows.map(r => [r.date, { calories: r.calories || 0, sugar: r.sugar || 0 }]));

    const shortSleepNext = [];
    const goodSleepNext = [];

    sleepRows.forEach(row => {
      const nextDay = shiftDate(row.date, 1);
      const nextMeals = mealsByDate.get(nextDay);
      // A day with NO logged meal at all (no entry in mealsByDate) does not enter the
      // comparison - "0 kcal the next day" would mean no logging here, not the real fact that
      // nothing was eaten, which would falsely drag that group's average down.
      if (!nextMeals) return;
      const bucket = row.sleep_duration < sleepThreshold ? shortSleepNext : goodSleepNext;
      bucket.push(nextMeals);
    });

    if (shortSleepNext.length < MIN_NIGHTS_PER_GROUP || goodSleepNext.length < MIN_NIGHTS_PER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_nights',
        sleepThreshold,
        shortSleepNights: shortSleepNext.length,
        goodSleepNights: goodSleepNext.length,
        minNightsRequired: MIN_NIGHTS_PER_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;

    const avgCaloriesShort = avg(shortSleepNext, 'calories');
    const avgCaloriesGood = avg(goodSleepNext, 'calories');
    const avgSugarShort = avg(shortSleepNext, 'sugar');
    const avgSugarGood = avg(goodSleepNext, 'sugar');

    res.json({
      hasEnoughData: true,
      sleepThreshold,
      shortSleepNights: shortSleepNext.length,
      goodSleepNights: goodSleepNext.length,
      avgCaloriesAfterShortSleep: avgCaloriesShort,
      avgCaloriesAfterGoodSleep: avgCaloriesGood,
      caloriesDiff: Math.round((avgCaloriesShort - avgCaloriesGood) * 10) / 10,
      avgSugarAfterShortSleep: avgSugarShort,
      avgSugarAfterGoodSleep: avgSugarGood,
      sugarDiff: Math.round((avgSugarShort - avgSugarGood) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sen-odżywianie.' });
  }
});

// The "high sodium" threshold from the WHO/AHA guidelines (the upper limit of daily intake
// for the general population) - deliberately NOT a user setting, because it is an established
// clinical reference point rather than a personal goal like target_calories.
const SODIUM_HIGH_THRESHOLD_MG = 2300;
const MIN_DAYS_PER_SODIUM_GROUP = 5;
const SODIUM_BP_LOOKBACK_DAYS = 90;

// Alert/insight: sodium -> next day's blood pressure. Two independent parts:
// 1) "today" - whether TODAY's sodium intake has already crossed the WHO/AHA threshold
//    (this works straight away, independently of the history - it is a guideline-based
//    warning, not a discovery from the user's data).
// 2) "insight" - a comparison of the average blood pressure on the day AFTER high-sodium days
//    vs days with normal sodium, based on the user's real history (Withings) - as with the
//    sleep->nutrition insight, it requires a minimum number of days in each group.
router.get('/api/dashboard/sodium-bp-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SODIUM_BP_LOOKBACK_DAYS);

    // Part 1: the sodium eaten today (regardless of whether we already have enough history).
    const todayRow = await db.get(
      `SELECT SUM(sodium) AS sodium FROM meals WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    const todaySodium = todayRow && todayRow.sodium != null ? Math.round(todayRow.sodium) : null;
    const todayHighSodium = todaySodium != null && todaySodium >= SODIUM_HIGH_THRESHOLD_MG;

    // Part 2: the history of sodium (day) -> blood pressure (day+1).
    const sodiumRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const bpRows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const bpByDate = new Map(bpRows.map(r => [r.date, { sys: r.blood_pressure_systolic, dia: r.blood_pressure_diastolic }]));

    const highSodiumNext = [];
    const normalSodiumNext = [];

    sodiumRows.forEach(row => {
      if (row.sodium == null) return;
      const nextDay = shiftDate(row.date, 1);
      const nextBp = bpByDate.get(nextDay);
      if (!nextBp) return;
      const bucket = row.sodium >= SODIUM_HIGH_THRESHOLD_MG ? highSodiumNext : normalSodiumNext;
      bucket.push(nextBp);
    });

    let insight;
    if (highSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP || normalSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP) {
      insight = {
        hasEnoughData: false,
        reason: 'not_enough_days',
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        minDaysRequired: MIN_DAYS_PER_SODIUM_GROUP
      };
    } else {
      const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
      const avgSysHigh = avg(highSodiumNext, 'sys');
      const avgSysNormal = avg(normalSodiumNext, 'sys');
      const avgDiaHigh = avg(highSodiumNext, 'dia');
      const avgDiaNormal = avg(normalSodiumNext, 'dia');
      insight = {
        hasEnoughData: true,
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        avgSystolicAfterHighSodium: avgSysHigh,
        avgSystolicAfterNormalSodium: avgSysNormal,
        systolicDiff: Math.round((avgSysHigh - avgSysNormal) * 10) / 10,
        avgDiastolicAfterHighSodium: avgDiaHigh,
        avgDiastolicAfterNormalSodium: avgDiaNormal,
        diastolicDiff: Math.round((avgDiaHigh - avgDiaNormal) * 10) / 10
      };
    }

    res.json({
      sodiumThresholdMg: SODIUM_HIGH_THRESHOLD_MG,
      today: { sodium: todaySodium, isHigh: todayHighSodium },
      insight
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sód-ciśnienie.' });
  }
});

// We consider a workout "significant" (rather than incidental activity for the day) from
// this many minutes in total on a given day (apple_health_workouts.duration_minutes) - the
// threshold that tells a real workout apart from, say, a short walk the watch recorded as a
// "workout".
const SIGNIFICANT_WORKOUT_MIN_MINUTES = 20;
const MIN_DAYS_PER_RECOVERY_GROUP = 5;
const RECOVERY_LOOKBACK_DAYS = 90;
// The minimum number of days required on EACH side of the "intense vs easy workout" split
// (by the share of Z4+Z5 in the day's total zone minutes) - separate from
// MIN_DAYS_PER_RECOVERY_GROUP, because it is an additional, more demanding split (it needs
// real heart-rate data from the workout, not just its duration).
const MIN_DAYS_PER_INTENSITY_GROUP = 4;

// Recovery indicator: how the HRV/RHR on the day AFTER a significant workout compare with the
// user's "normal" days (no workout the day before). HRV lower and/or RHR higher than the
// baseline after a workout = a sign of insufficient recovery (typically after training that
// is too intense or too frequent); the reverse = good adaptation. This is a descriptive
// comparison of two averages from the user's Oura data, not a medical diagnosis.
router.get('/api/dashboard/recovery-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -RECOVERY_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, SUM(duration_minutes) AS total_minutes,
              SUM(zone1_minutes) AS z1, SUM(zone2_minutes) AS z2, SUM(zone3_minutes) AS z3,
              SUM(zone4_minutes) AS z4, SUM(zone5_minutes) AS z5
       FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date HAVING total_minutes >= ?`,
      [req.user.id, startDate, today, SIGNIFICANT_WORKOUT_MIN_MINUTES]
    );

    if (workoutRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_significant_workouts' });
    }

    // The share of Z4+Z5 (high intensity) in the total measured zone minutes of a given
    // training day - available only for workouts with "Include Workout Metrics" enabled in
    // Health Auto Export (see hr-zones-insight); days without that data
    // (totalZoneMinutes === 0) are left out of the intensity split rather than being pushed
    // artificially into one of the groups.
    const zoneShareByWorkoutDate = new Map();
    workoutRows.forEach(r => {
      const z1 = r.z1 || 0, z2 = r.z2 || 0, z3 = r.z3 || 0, z4 = r.z4 || 0, z5 = r.z5 || 0;
      const totalZoneMinutes = z1 + z2 + z3 + z4 + z5;
      if (totalZoneMinutes > 0) {
        zoneShareByWorkoutDate.set(r.date, (z4 + z5) / totalZoneMinutes);
      }
    });

    const rawHrvRhrRows = await db.all(
      `SELECT date, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND hrv IS NOT NULL AND hrv > 0 AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    // Day tag: illness days and days after a late bedtime are excluded from computing the
    // recovery baseline - these are known, documented exceptions (HRV/RHR naturally come out
    // differently), and they should not distort the "workout vs rest" comparison for a
    // healthy, normally rested user.
    const recoveryExcluded = await getExcludedDates(req.user.id, ['illness', 'late_sleep'], startDate, shiftDate(today, 1));
    const hrvRhrRows = rawHrvRhrRows.filter(r => !recoveryExcluded.has(r.date));
    const metricsByDate = new Map(hrvRhrRows.map(r => [r.date, { hrv: r.hrv, rhr: r.rhr }]));

    const postWorkoutDates = new Set(workoutRows.map(r => shiftDate(r.date, 1)));
    // shiftDate(+1) is injective (different workout dates -> different recovery dates), so a
    // 1:1 mapping is safe.
    const workoutDateByRecoveryDate = new Map(workoutRows.map(r => [shiftDate(r.date, 1), r.date]));
    const postWorkout = [];
    const otherDays = [];
    const intensityCandidates = [];

    hrvRhrRows.forEach(r => {
      if (postWorkoutDates.has(r.date)) {
        postWorkout.push(metricsByDate.get(r.date));
        const workoutDate = workoutDateByRecoveryDate.get(r.date);
        const zoneShare = zoneShareByWorkoutDate.get(workoutDate);
        if (zoneShare !== undefined) {
          intensityCandidates.push({ hrv: r.hrv, rhr: r.rhr, zoneShare });
        }
      } else {
        otherDays.push(metricsByDate.get(r.date));
      }
    });

    if (postWorkout.length < MIN_DAYS_PER_RECOVERY_GROUP || otherDays.length < MIN_DAYS_PER_RECOVERY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        postWorkoutDays: postWorkout.length,
        otherDays: otherDays.length,
        minDaysRequired: MIN_DAYS_PER_RECOVERY_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgHrvPostWorkout = avg(postWorkout, 'hrv');
    const avgHrvOther = avg(otherDays, 'hrv');
    const avgRhrPostWorkout = avg(postWorkout, 'rhr');
    const avgRhrOther = avg(otherDays, 'rhr');

    // The most recent workout with a known next-day recovery - a concrete, current reference
    // point shown alongside the general statistic.
    const latestWorkout = [...workoutRows].sort((a, b) => (a.date < b.date ? 1 : -1))
      .find(w => metricsByDate.has(shiftDate(w.date, 1)));
    let latest = null;
    if (latestWorkout) {
      const nextDate = shiftDate(latestWorkout.date, 1);
      const m = metricsByDate.get(nextDate);
      latest = { workoutDate: latestWorkout.date, recoveryDate: nextDate, hrv: m.hrv, rhr: m.rhr };
    }

    // An additional split: whether recovery depends not only on THE FACT that there was a
    // workout, but on HOW INTENSE it was (the share of Z4+Z5). The median of the user's own
    // training days - as in the other insights in this round, not a fixed threshold.
    let intensitySplit = null;
    if (intensityCandidates.length >= MIN_DAYS_PER_INTENSITY_GROUP * 2) {
      const medianShare = median(intensityCandidates.map(c => c.zoneShare));
      const highIntensity = intensityCandidates.filter(c => c.zoneShare > medianShare);
      const lowIntensity = intensityCandidates.filter(c => c.zoneShare <= medianShare);
      if (highIntensity.length >= MIN_DAYS_PER_INTENSITY_GROUP && lowIntensity.length >= MIN_DAYS_PER_INTENSITY_GROUP) {
        const avgHrvHighIntensity = avg(highIntensity, 'hrv');
        const avgHrvLowIntensity = avg(lowIntensity, 'hrv');
        const avgRhrHighIntensity = avg(highIntensity, 'rhr');
        const avgRhrLowIntensity = avg(lowIntensity, 'rhr');
        intensitySplit = {
          hasEnoughData: true,
          highIntensityDays: highIntensity.length,
          lowIntensityDays: lowIntensity.length,
          avgHrvHighIntensity,
          avgHrvLowIntensity,
          hrvDiff: Math.round((avgHrvHighIntensity - avgHrvLowIntensity) * 10) / 10,
          avgRhrHighIntensity,
          avgRhrLowIntensity,
          rhrDiff: Math.round((avgRhrHighIntensity - avgRhrLowIntensity) * 10) / 10
        };
      }
    }

    res.json({
      hasEnoughData: true,
      postWorkoutDays: postWorkout.length,
      otherDays: otherDays.length,
      avgHrvPostWorkout,
      avgHrvOtherDays: avgHrvOther,
      hrvDiff: Math.round((avgHrvPostWorkout - avgHrvOther) * 10) / 10,
      avgRhrPostWorkout,
      avgRhrOtherDays: avgRhrOther,
      rhrDiff: Math.round((avgRhrPostWorkout - avgRhrOther) * 10) / 10,
      latest,
      intensitySplit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania wskaźnika regeneracji.' });
  }
});

// The minimum number of days with/without a given supplement before we show it in the results
// at all - as in the other insights (sleep-nutrition, sodium-blood pressure, recovery);
// without it, a single day with a supplement and good sleep would generate a falsely strong
// conclusion ("supplement X = +2 sleep points!").
const MIN_DAYS_PER_SUPPLEMENT_GROUP = 3;
const SUPPLEMENTS_SLEEP_LOOKBACK_DAYS = 90;
// The maximum number of supplements shown in the result - only those with the largest
// difference (by absolute value), so the user is not buried under dozens of marginal
// comparisons.
const MAX_SUPPLEMENT_FINDINGS = 5;

// Insight: suplementy (wolny tekst, pole health_metrics.supplements) vs sen/
// recovery on THE SAME day. Pairing on "the same day" (not day+1) is deliberate and follows
// the existing convention already established in this file (the dashboard AI prompt, around
// lines 456-519) and in services/summaries.js - supplements logged for day D are matched
// there with the sleep_score/readiness_score from day D, not D+1. We copy no mechanism from
// competing apps here - this is exclusively our own analysis of data Dietetyk-AI already
// collects
// (suplementy z routes/health.js + sleep_score/readiness_score z Oura).
//
// Parsing the supplements text: split on the comma + trim, exactly as in the existing
// frontend logic (Dashboard.jsx, handleSaveSupplements) - the only separator convention
// established in the code; we do not introduce a new one here.
router.get('/api/dashboard/supplements-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SUPPLEMENTS_SLEEP_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND supplements IS NOT NULL AND TRIM(supplements) != ''
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    if (rows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_supplement_data' });
    }

    // All days in the window with at least one known sleep/recovery metric - needed as the
    // "universe" for computing the "WITHOUT" group for a given supplement (a day with no
    // supplements entered counts as "without" EACH of them; an empty supplements field is
    // treated as the real fact "did not take any", not as missing data - unlike, say, missing
    // meal logging in the other insights).
    const allDaysRows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    const parseSupplements = (text) =>
      (text || '').split(',').map((s) => s.trim()).filter(Boolean);

    // The set of unique supplements (compared case-insensitively, but for display we use the
    // first spelling encountered, so we do not mangle proper names).
    const displayNameByKey = new Map();
    rows.forEach((r) => {
      parseSupplements(r.supplements).forEach((s) => {
        const key = s.toLowerCase();
        if (!displayNameByKey.has(key)) displayNameByKey.set(key, s);
      });
    });

    const avg = (arr, key) => {
      const vals = arr.map((x) => x[key]).filter((v) => v != null);
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    };

    const findings = [];
    for (const [key, displayName] of displayNameByKey.entries()) {
      const withDays = [];
      const withoutDays = [];
      allDaysRows.forEach((r) => {
        const tokens = parseSupplements(r.supplements).map((s) => s.toLowerCase());
        (tokens.includes(key) ? withDays : withoutDays).push(r);
      });

      if (withDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP || withoutDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP) {
        continue;
      }

      const avgSleepWith = avg(withDays, 'sleep_score');
      const avgSleepWithout = avg(withoutDays, 'sleep_score');
      const avgReadinessWith = avg(withDays, 'readiness_score');
      const avgReadinessWithout = avg(withoutDays, 'readiness_score');
      const sleepDiff = avgSleepWith != null && avgSleepWithout != null
        ? Math.round((avgSleepWith - avgSleepWithout) * 10) / 10
        : null;
      const readinessDiff = avgReadinessWith != null && avgReadinessWithout != null
        ? Math.round((avgReadinessWith - avgReadinessWithout) * 10) / 10
        : null;

      // A supplement with no computable difference at all (no sleep_score NOR readiness_score
      // data in either group) contributes nothing to the result.
      if (sleepDiff == null && readinessDiff == null) continue;

      findings.push({
        supplement: displayName,
        daysWith: withDays.length,
        daysWithout: withoutDays.length,
        avgSleepScoreWith: avgSleepWith,
        avgSleepScoreWithout: avgSleepWithout,
        sleepScoreDiff: sleepDiff,
        avgReadinessScoreWith: avgReadinessWith,
        avgReadinessScoreWithout: avgReadinessWithout,
        readinessScoreDiff: readinessDiff
      });
    }

    if (findings.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_supplement',
        minDaysRequired: MIN_DAYS_PER_SUPPLEMENT_GROUP
      });
    }

    // Sorted by the largest sleep difference (by absolute value), falling back to recovery
    // when there is none. The most "noticeable" results come first.
    findings.sort((a, b) => {
      const scoreOf = (f) => Math.max(Math.abs(f.sleepScoreDiff || 0), Math.abs(f.readinessScoreDiff || 0));
      return scoreOf(b) - scoreOf(a);
    });

    res.json({
      hasEnoughData: true,
      lookbackDays: SUPPLEMENTS_SLEEP_LOOKBACK_DAYS,
      findings: findings.slice(0, MAX_SUPPLEMENT_FINDINGS)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu suplementy-sen.' });
  }
});

// Adaptive calorie goal correction: it compares the DECLARED calorie balance (from the logged
// meals: eaten - (BMR + active calories)) with the balance IMPLIED BY THE REAL weight change
// (a linear regression over the weight measurements, the slope in kg/day times the 7700
// kcal/kg approximation). A divergence between those two numbers (the gap) usually means
// under- or over-estimated portions, unlogged snacking or an imprecise BMR - not that the
// calorie goal itself is set wrong. So we suggest correcting the GOAL such that, with the
// user's existing logging habits, the real effect moves closer to the originally intended
// rate. We require a solid sample in both dimensions (days with meals and weight measurements
// spread over a sensible period) - otherwise measurement noise (water fluctuations, say)
// would produce a false suggestion.
const CALORIE_RECAL_LOOKBACK_DAYS = 21;
const KCAL_PER_KG = 7700; // the estimated energy content of 1 kg of tissue - a widely used approximation
const MIN_LOGGED_DAYS = 10;
const MIN_WEIGHT_MEASUREMENTS = 4;
const MIN_WEIGHT_SPAN_DAYS = 10;
const MIN_MEANINGFUL_GAP_KCAL = 100;

router.get('/api/dashboard/calorie-target-suggestion', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -(CALORIE_RECAL_LOOKBACK_DAYS - 1));

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const currentTargetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const balance = await aggregateCalorieBalance(req.user.id, startDate, today, currentTargetCalories, bmr);
    if (balance.days_with_data < MIN_LOGGED_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_logged_days', daysLogged: balance.days_with_data, minDaysRequired: MIN_LOGGED_DAYS });
    }
    const loggedDailyBalance = balance.balance_vs_burned / balance.days_with_data;

    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    if (weightRows.length < MIN_WEIGHT_MEASUREMENTS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_weight_data', weightMeasurements: weightRows.length, minWeightMeasurementsRequired: MIN_WEIGHT_MEASUREMENTS });
    }
    const baseTime = new Date(weightRows[0].date).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const points = weightRows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r.weight }));
    const spanDays = points[points.length - 1].x;
    if (spanDays < MIN_WEIGHT_SPAN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'weight_span_too_short', spanDays: Math.round(spanDays), minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS });
    }
    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) {
      return res.json({ hasEnoughData: false, reason: 'flat_weight_data' });
    }
    const slope = (n * sumXY - sumX * sumY) / denom; // kg/day
    const actualDailyBalance = slope * KCAL_PER_KG;
    const gap = actualDailyBalance - loggedDailyBalance;

    if (Math.abs(gap) < MIN_MEANINGFUL_GAP_KCAL) {
      return res.json({
        hasEnoughData: true,
        suggestionNeeded: false,
        loggedDailyBalance: Math.round(loggedDailyBalance),
        actualDailyBalance: Math.round(actualDailyBalance),
        gap: Math.round(gap)
      });
    }

    const suggestedTargetCalories = Math.round(currentTargetCalories - gap);

    res.json({
      hasEnoughData: true,
      suggestionNeeded: true,
      daysLogged: balance.days_with_data,
      weightMeasurements: weightRows.length,
      loggedDailyBalance: Math.round(loggedDailyBalance),
      actualDailyBalance: Math.round(actualDailyBalance),
      gap: Math.round(gap),
      currentTargetCalories,
      suggestedTargetCalories
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania korekty celu kalorycznego.' });
  }
});

// ============================================================================
// Round 7: new insights based EXCLUSIVELY on data the app already collects (water_ml,
// sedentary_minutes, fiber, respiratory_rate, temperature_deviation, stress_high_minutes,
// meals per day, the calorie streak history) - zero new integrations, zero copying of
// features from competing diet apps. Each insight follows the convention of the existing
// endpoints above: gating on a minimum sample, hasEnoughData, and a try/catch with an error
// message in Polish for the user.
// ============================================================================

// Median - used where there is no sensible clinical threshold or user setting to split the
// groups by ("a lot of sitting" differs for someone with a desk job vs a physical one) - so
// we compare the user against THEIR OWN median for the period, not against a fixed value.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanAndStdDev(values) {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / values.length;
  return { mean: m, stdDev: Math.sqrt(variance) };
}

// "Day tag": the set of dates (as 'YYYY-MM-DD' strings) the user marked with one of the given
// event types (day_events) that intersect the window [startDate, endDate]. Insights based on
// the user's own norm or baseline (recovery-insight, self-benchmark-insight) exclude those
// days from the averages/percentiles/regressions below - an atypical period (illness/holiday/
// a late bedtime) should not distort the trend. The type->insight mapping was agreed with the
// user while designing the feature (see routes/dayEvents.js for the CRUD itself and the list
// of allowed types).
async function getExcludedDates(userId, types, startDate, endDate) {
  if (!types || types.length === 0) return new Set();
  const placeholders = types.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT start_date, end_date FROM day_events
     WHERE user_id = ? AND type IN (${placeholders}) AND end_date >= ? AND start_date <= ?`,
    [userId, ...types, startDate, endDate]
  );
  const excluded = new Set();
  rows.forEach(r => {
    // We intersect the event's range with the query window, so as not to generate dates
    // outside [startDate, endDate] (a multi-year range entered by mistake, for instance).
    let d = r.start_date > startDate ? r.start_date : startDate;
    const end = r.end_date < endDate ? r.end_date : endDate;
    while (d <= end) {
      excluded.add(d);
      d = shiftDate(d, 1);
    }
  });
  return excluded;
}

function linearRegressionSlope(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function toRegressionPoints(rows, valueKey) {
  const baseTime = new Date(rows[0].date).getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  return rows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r[valueKey] }));
}

const MIN_DAYS_PER_HYDRATION_GROUP = 5;
const HYDRATION_LOOKBACK_DAYS = 90;

// Insight: hydration (water_ml) vs readiness/HRV on THE SAME day and the NEXT day's RHR. The
// split is relative to the user's OWN hydration goal (target_water_ml from the settings,
// 2500 ml by default) - not a fixed clinical threshold, because hydration needs are highly
// individual.
router.get('/api/dashboard/hydration-readiness-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -HYDRATION_LOOKBACK_DAYS);

    const settingsRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'target_water_ml'`, [req.user.id]);
    const targetWaterMl = settingsRow && !isNaN(Number(settingsRow.value)) ? Number(settingsRow.value) : DEFAULT_TARGET_WATER_ML;

    const rows = await db.all(
      `SELECT date, water_ml, readiness_score, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND water_ml IS NOT NULL AND water_ml > 0`,
      [req.user.id, startDate, today]
    );
    const rhrByDate = new Map(rows.filter(r => r.rhr != null && r.rhr > 0).map(r => [r.date, r.rhr]));

    const hydrated = [];
    const underHydrated = [];
    rows.forEach(r => {
      if (r.readiness_score == null && r.hrv == null) return;
      const nextRhr = rhrByDate.get(shiftDate(r.date, 1));
      const entry = { readiness: r.readiness_score, hrv: r.hrv, nextRhr: nextRhr != null ? nextRhr : null };
      (r.water_ml >= targetWaterMl ? hydrated : underHydrated).push(entry);
    });

    if (hydrated.length < MIN_DAYS_PER_HYDRATION_GROUP || underHydrated.length < MIN_DAYS_PER_HYDRATION_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        hydratedDays: hydrated.length,
        underHydratedDays: underHydrated.length,
        minDaysRequired: MIN_DAYS_PER_HYDRATION_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgReadinessHydrated = avgOf(hydrated, 'readiness');
    const avgReadinessUnder = avgOf(underHydrated, 'readiness');
    const avgHrvHydrated = avgOf(hydrated, 'hrv');
    const avgHrvUnder = avgOf(underHydrated, 'hrv');
    const avgNextRhrHydrated = avgOf(hydrated, 'nextRhr');
    const avgNextRhrUnder = avgOf(underHydrated, 'nextRhr');

    res.json({
      hasEnoughData: true,
      targetWaterMl,
      hydratedDays: hydrated.length,
      underHydratedDays: underHydrated.length,
      avgReadinessHydrated,
      avgReadinessUnderHydrated: avgReadinessUnder,
      readinessDiff: avgReadinessHydrated != null && avgReadinessUnder != null ? Math.round((avgReadinessHydrated - avgReadinessUnder) * 10) / 10 : null,
      avgHrvHydrated,
      avgHrvUnderHydrated: avgHrvUnder,
      hrvDiff: avgHrvHydrated != null && avgHrvUnder != null ? Math.round((avgHrvHydrated - avgHrvUnder) * 10) / 10 : null,
      avgNextDayRhrHydrated: avgNextRhrHydrated,
      avgNextDayRhrUnderHydrated: avgNextRhrUnder,
      nextDayRhrDiff: avgNextRhrHydrated != null && avgNextRhrUnder != null ? Math.round((avgNextRhrHydrated - avgNextRhrUnder) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu nawodnienie-regeneracja.' });
  }
});

const MIN_DAYS_PER_SEDENTARY_GROUP = 5;
const SEDENTARY_LOOKBACK_DAYS = 90;

// Insight: sedentary time (sedentary_minutes) vs the quality of THAT SAME NIGHT's sleep
// (sleep_score, sleep_deep, sleep_rem). Split by the median of the user's OWN values for the
// period.
router.get('/api/dashboard/sedentary-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SEDENTARY_LOOKBACK_DAYS);

    const rawRows = await db.all(
      `SELECT date, sedentary_minutes, sleep_score, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sedentary_minutes IS NOT NULL AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    // sleep_deep/sleep_rem are stored in the database in HOURS (see services/sync.js -
    // totalDeepSec / 3600), while this endpoint's response is described in the UI as "min" -
    // we convert to minutes here so that sleepDeepDiff/sleepRemDiff really are in the unit we
    // display them in (previously "+0.3 min" instead of "+18 min", for example).
    const rows = rawRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));

    if (rows.length < MIN_DAYS_PER_SEDENTARY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP * 2
      });
    }

    const medianSedentary = median(rows.map(r => r.sedentary_minutes));
    const moreSitting = rows.filter(r => r.sedentary_minutes >= medianSedentary);
    const lessSitting = rows.filter(r => r.sedentary_minutes < medianSedentary);

    if (moreSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP || lessSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreSittingDays: moreSitting.length,
        lessSittingDays: lessSitting.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSleepScoreMore = avgOf(moreSitting, 'sleep_score');
    const avgSleepScoreLess = avgOf(lessSitting, 'sleep_score');
    const avgDeepMore = avgOf(moreSitting, 'sleep_deep');
    const avgDeepLess = avgOf(lessSitting, 'sleep_deep');
    const avgRemMore = avgOf(moreSitting, 'sleep_rem');
    const avgRemLess = avgOf(lessSitting, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianSedentaryMinutes: Math.round(medianSedentary),
      moreSittingDays: moreSitting.length,
      lessSittingDays: lessSitting.length,
      avgSleepScoreMoreSitting: avgSleepScoreMore,
      avgSleepScoreLessSitting: avgSleepScoreLess,
      sleepScoreDiff: avgSleepScoreMore != null && avgSleepScoreLess != null ? Math.round((avgSleepScoreMore - avgSleepScoreLess) * 10) / 10 : null,
      avgSleepDeepMoreSitting: avgDeepMore,
      avgSleepDeepLessSitting: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreSitting: avgRemMore,
      avgSleepRemLessSitting: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu siedzenie-sen.' });
  }
});

const MIN_DAYS_PER_FIBER_GROUP = 5;
const FIBER_SLEEP_LOOKBACK_DAYS = 90;

// Insight: fibre (the daily total from meals) vs deep/REM sleep THAT SAME NIGHT. Different
// from the existing sleep-insight (there: sleep -> the NEXT day's calories/sugar) - here the
// direction is reversed (nutrition -> that night's sleep) and the sleep-stage fields differ.
// Split by the median of the user's OWN fibre intake.
router.get('/api/dashboard/fiber-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -FIBER_SLEEP_LOOKBACK_DAYS);

    const fiberRows = await db.all(
      `SELECT date, SUM(fiber) AS fiber FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? AND fiber IS NOT NULL GROUP BY date HAVING fiber > 0`,
      [req.user.id, startDate, today]
    );
    const rawSleepRows = await db.all(
      `SELECT date, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (sleep_deep IS NOT NULL OR sleep_rem IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    // Hours -> minutes conversion (see the analogous comment in sedentary-sleep-insight) -
    // the field is described in the UI as "min", while sleep_deep/sleep_rem are in hours.
    const sleepRows = rawSleepRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    const combined = fiberRows
      .filter(r => sleepByDate.has(r.date))
      .map(r => ({ fiber: r.fiber, ...sleepByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_FIBER_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP * 2
      });
    }

    const medianFiber = median(combined.map(r => r.fiber));
    const moreFiber = combined.filter(r => r.fiber >= medianFiber);
    const lessFiber = combined.filter(r => r.fiber < medianFiber);

    if (moreFiber.length < MIN_DAYS_PER_FIBER_GROUP || lessFiber.length < MIN_DAYS_PER_FIBER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreFiberDays: moreFiber.length,
        lessFiberDays: lessFiber.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgDeepMore = avgOf(moreFiber, 'sleep_deep');
    const avgDeepLess = avgOf(lessFiber, 'sleep_deep');
    const avgRemMore = avgOf(moreFiber, 'sleep_rem');
    const avgRemLess = avgOf(lessFiber, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianFiberGrams: Math.round(medianFiber * 10) / 10,
      moreFiberDays: moreFiber.length,
      lessFiberDays: lessFiber.length,
      avgSleepDeepMoreFiber: avgDeepMore,
      avgSleepDeepLessFiber: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreFiber: avgRemMore,
      avgSleepRemLessFiber: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu błonnik-sen.' });
  }
});

const MIN_RECOMP_MEASUREMENTS = 4;
const MIN_RECOMP_SPAN_DAYS = 14;
const RECOMP_LOOKBACK_DAYS = 180;

// "Body recomposition" detector: whether the WAIST CIRCUMFERENCE trend and the WEIGHT trend
// diverge (weight stable or rising while the waist shrinks - a classic sign of muscle gain
// alongside fat loss, or the reverse). Two INDEPENDENT linear regressions (as in
// calorie-target-suggestion) - weight and circumference measurements are usually not taken on
// the same day, so joining them by date would discard data.
router.get('/api/dashboard/body-recomposition-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -RECOMP_LOOKBACK_DAYS);

    const waistRows = await db.all(
      `SELECT date, waist FROM body_measurements WHERE user_id = ? AND date >= ? AND date <= ? AND waist IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (waistRows.length < MIN_RECOMP_MEASUREMENTS || weightRows.length < MIN_RECOMP_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_measurements',
        waistMeasurements: waistRows.length,
        weightMeasurements: weightRows.length,
        minMeasurementsRequired: MIN_RECOMP_MEASUREMENTS
      });
    }

    const waistPoints = toRegressionPoints(waistRows, 'waist');
    const weightPoints = toRegressionPoints(weightRows, 'weight');
    const waistSpanDays = waistPoints[waistPoints.length - 1].x;
    const weightSpanDays = weightPoints[weightPoints.length - 1].x;

    if (waistSpanDays < MIN_RECOMP_SPAN_DAYS || weightSpanDays < MIN_RECOMP_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        waistSpanDays: Math.round(waistSpanDays),
        weightSpanDays: Math.round(weightSpanDays),
        minSpanDaysRequired: MIN_RECOMP_SPAN_DAYS
      });
    }

    const waistSlopePerDay = linearRegressionSlope(waistPoints);
    const weightSlopePerDay = linearRegressionSlope(weightPoints);
    if (waistSlopePerDay === null || weightSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    // Divergence: the waist is shrinking while the weight rises or holds (or the reverse) - a
    // sign of recomposition rather than plain "losing/gaining" visible in both measures at
    // once.
    const waistTrend = waistSlopePerDay < -0.02 ? 'down' : waistSlopePerDay > 0.02 ? 'up' : 'flat';
    const weightTrend = weightSlopePerDay < -0.02 ? 'down' : weightSlopePerDay > 0.02 ? 'up' : 'flat';
    const divergentTrend = waistTrend !== 'flat' && weightTrend !== 'flat' && waistTrend !== weightTrend;

    res.json({
      hasEnoughData: true,
      waistMeasurements: waistRows.length,
      weightMeasurements: weightRows.length,
      waistSlopeCmPerWeek: Math.round(waistSlopePerDay * 7 * 100) / 100,
      weightSlopeKgPerWeek: Math.round(weightSlopePerDay * 7 * 100) / 100,
      waistTrend,
      weightTrend,
      divergentTrend
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wykrywania rekompozycji ciała.' });
  }
});

const STRAIN_BASELINE_LOOKBACK_DAYS = 30;
const MIN_DAYS_FOR_STRAIN_BASELINE = 14;
const STRAIN_STD_DEV_THRESHOLD = 1; // standard deviations from the user's own mean

// Early "overload / possible infection" alert: the deviation of TODAY's
// values (respiratory rate, wrist temperature deviation, readiness) from the user's OWN mean
// over the recent days (a z-score - the statistical approach used for meal anomaly detection
// in utils/mealAnomaly.js, applied here to the Oura data). A descriptive signal from the
// user's own history, NOT a medical diagnosis.
router.get('/api/dashboard/early-strain-alert', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -STRAIN_BASELINE_LOOKBACK_DAYS);
    const baselineEnd = shiftDate(today, -1);

    const todayRow = await db.get(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    // Round 12 (audit): "readiness_score <= 0" added - aligning with the dominant pattern in
    // this file (lines ~223, ~239, ~3017), where a 0 for sleep_score/readiness_score is
    // treated as the sentinel "no measurement" rather than a real Oura result (unlike
    // temperature_deviation, where 0 is a real, meaningful value - "no deviation" - and which
    // this change does NOT affect).
    if (!todayRow || todayRow.respiratory_rate == null || todayRow.temperature_deviation == null
      || todayRow.readiness_score == null || todayRow.readiness_score <= 0) {
      return res.json({ hasEnoughData: false, reason: 'no_today_data' });
    }

    const baselineRows = await db.all(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND respiratory_rate IS NOT NULL AND temperature_deviation IS NOT NULL
       AND readiness_score IS NOT NULL AND readiness_score > 0`,
      [req.user.id, baselineStart, baselineEnd]
    );

    if (baselineRows.length < MIN_DAYS_FOR_STRAIN_BASELINE) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_baseline_days',
        baselineDays: baselineRows.length,
        minDaysRequired: MIN_DAYS_FOR_STRAIN_BASELINE
      });
    }

    const respStats = meanAndStdDev(baselineRows.map(r => r.respiratory_rate));
    const tempStats = meanAndStdDev(baselineRows.map(r => r.temperature_deviation));
    const readinessStats = meanAndStdDev(baselineRows.map(r => r.readiness_score));

    const respZ = respStats.stdDev > 0 ? (todayRow.respiratory_rate - respStats.mean) / respStats.stdDev : 0;
    const tempZ = tempStats.stdDev > 0 ? (todayRow.temperature_deviation - tempStats.mean) / tempStats.stdDev : 0;
    const readinessZ = readinessStats.stdDev > 0 ? (todayRow.readiness_score - readinessStats.mean) / readinessStats.stdDev : 0;

    // We alert only when ALL THREE metrics deviate in a worrying direction at once - a single
    // outlying metric is ordinary daily noise, not a signal.
    const alert = respZ >= STRAIN_STD_DEV_THRESHOLD && tempZ >= STRAIN_STD_DEV_THRESHOLD && readinessZ <= -STRAIN_STD_DEV_THRESHOLD;

    res.json({
      hasEnoughData: true,
      baselineDays: baselineRows.length,
      today: {
        respiratoryRate: todayRow.respiratory_rate,
        temperatureDeviation: todayRow.temperature_deviation,
        readinessScore: todayRow.readiness_score
      },
      baseline: {
        avgRespiratoryRate: Math.round(respStats.mean * 10) / 10,
        avgTemperatureDeviation: Math.round(tempStats.mean * 100) / 100,
        avgReadinessScore: Math.round(readinessStats.mean * 10) / 10
      },
      respiratoryRateZScore: Math.round(respZ * 100) / 100,
      temperatureDeviationZScore: Math.round(tempZ * 100) / 100,
      readinessScoreZScore: Math.round(readinessZ * 100) / 100,
      alert
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania wczesnego alertu przeciążenia.' });
  }
});

const MIN_DAYS_PER_STRESS_GROUP = 5;
const STRESS_NUTRITION_LOOKBACK_DAYS = 90;

// Insight: high-stress minutes (stress_high_minutes, until now only displayed and used in no
// insight at all) vs the sodium/sugar intake on THE SAME day - it tests the common hypothesis
// "stress -> reaching for sweet or salty food" against the user's own data. Split by the
// median of the user's OWN stress minutes for the period.
router.get('/api/dashboard/stress-nutrition-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STRESS_NUTRITION_LOOKBACK_DAYS);

    const stressRows = await db.all(
      `SELECT date, stress_high_minutes FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND stress_high_minutes IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const nutritionRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium, SUM(sugar) AS sugar FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const nutritionByDate = new Map(nutritionRows.map(r => [r.date, r]));

    const combined = stressRows
      .filter(r => nutritionByDate.has(r.date))
      .map(r => ({ stressMinutes: r.stress_high_minutes, ...nutritionByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_STRESS_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP * 2
      });
    }

    const medianStress = median(combined.map(r => r.stressMinutes));
    const highStress = combined.filter(r => r.stressMinutes >= medianStress);
    const lowStress = combined.filter(r => r.stressMinutes < medianStress);

    if (highStress.length < MIN_DAYS_PER_STRESS_GROUP || lowStress.length < MIN_DAYS_PER_STRESS_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        highStressDays: highStress.length,
        lowStressDays: lowStress.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSodiumHigh = avgOf(highStress, 'sodium');
    const avgSodiumLow = avgOf(lowStress, 'sodium');
    const avgSugarHigh = avgOf(highStress, 'sugar');
    const avgSugarLow = avgOf(lowStress, 'sugar');

    res.json({
      hasEnoughData: true,
      medianStressMinutes: Math.round(medianStress),
      highStressDays: highStress.length,
      lowStressDays: lowStress.length,
      avgSodiumHighStress: avgSodiumHigh,
      avgSodiumLowStress: avgSodiumLow,
      sodiumDiff: avgSodiumHigh != null && avgSodiumLow != null ? Math.round((avgSodiumHigh - avgSodiumLow) * 10) / 10 : null,
      avgSugarHighStress: avgSugarHigh,
      avgSugarLowStress: avgSugarLow,
      sugarDiff: avgSugarHigh != null && avgSugarLow != null ? Math.round((avgSugarHigh - avgSugarLow) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stres-odżywianie.' });
  }
});

const MIN_DAYS_PER_MEAL_FREQ_GROUP = 5;
const MEAL_FREQ_LOOKBACK_DAYS = 90;
// The +/-15% band for hitting the calorie goal - identical to the existing calorie streak
// (computeStreak in the main /api/dashboard handler).
const CALORIE_TARGET_BAND = 0.15;

// Insight: the number of meals logged during the day (meals.date, COUNT) vs hitting the
// calorie goal that day - it checks whether more, smaller meals per day correlates with
// sticking to the goal better ("controlled snacking" vs 1-2 large meals).
router.get('/api/dashboard/meal-frequency-adherence-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MEAL_FREQ_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const rows = await db.all(
      `SELECT date, COUNT(*) AS meal_count, SUM(calories) AS total_calories
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_DAYS_PER_MEAL_FREQ_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP * 2
      });
    }

    const onTarget = [];
    const offTarget = [];
    rows.forEach(r => {
      if (r.total_calories == null) return;
      const hit = r.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) && r.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      (hit ? onTarget : offTarget).push(r);
    });

    if (onTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP || offTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        onTargetDays: onTarget.length,
        offTargetDays: offTarget.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP
      });
    }

    const avgOf = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgMealCountOnTarget = avgOf(onTarget, 'meal_count');
    const avgMealCountOffTarget = avgOf(offTarget, 'meal_count');

    res.json({
      hasEnoughData: true,
      targetCalories,
      onTargetDays: onTarget.length,
      offTargetDays: offTarget.length,
      avgMealCountOnTarget,
      avgMealCountOffTarget,
      mealCountDiff: Math.round((avgMealCountOnTarget - avgMealCountOffTarget) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu częstość posiłków-cel kaloryczny.' });
  }
});

const MIN_DAYS_PER_STREAK_GROUP = 5;
const STREAK_DRIFT_LOOKBACK_DAYS = 120;
const STREAK_MIN_LENGTH = 3; // how many consecutive days within the goal band count as a "streak"

// Insight: HRV/readiness on days that are PART of a calorie-goal streak (3+ consecutive days
// within the +/-15% band) vs on the day IMMEDIATELY AFTER such a streak was broken. Its own
// standalone streak detection (NOT computeStreak from the main dashboard handler, which only
// computes the length of the CURRENT streak relative to one reference date and is not
// exported) - here we need the history of all past streaks and where they ended.
router.get('/api/dashboard/streak-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STREAK_DRIFT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const metricsRows = await db.all(
      `SELECT date, hrv, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (hrv IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    const metricsByDate = new Map(metricsRows.map(r => [r.date, r]));

    // We require CONSECUTIVE calendar days (with no gaps) to count a streak - a gap in
    // logging breaks the streak just as a day outside the goal band does.
    let prevDate = null;
    let currentStreak = 0;
    const streakDayMetrics = [];
    const breakDayMetrics = [];

    calorieRows.forEach(row => {
      const inBand = row.total_calories != null &&
        row.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) &&
        row.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      const isConsecutive = prevDate !== null && shiftDate(prevDate, 1) === row.date;

      if (inBand) {
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
        if (currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) streakDayMetrics.push(m);
        }
      } else {
        // We count "the day after the break" only if YESTERDAY was an established streak
        // (>= STREAK_MIN_LENGTH) and today is the next calendar day after it.
        if (isConsecutive && currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) breakDayMetrics.push(m);
        }
        currentStreak = 0;
      }
      prevDate = row.date;
    });

    if (streakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP || breakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        streakDays: streakDayMetrics.length,
        breakDays: breakDayMetrics.length,
        minDaysRequired: MIN_DAYS_PER_STREAK_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgHrvStreak = avgOf(streakDayMetrics, 'hrv');
    const avgHrvBreak = avgOf(breakDayMetrics, 'hrv');
    const avgReadinessStreak = avgOf(streakDayMetrics, 'readiness_score');
    const avgReadinessBreak = avgOf(breakDayMetrics, 'readiness_score');

    res.json({
      hasEnoughData: true,
      targetCalories,
      streakMinLength: STREAK_MIN_LENGTH,
      streakDays: streakDayMetrics.length,
      breakDays: breakDayMetrics.length,
      avgHrvDuringStreak: avgHrvStreak,
      avgHrvAfterBreak: avgHrvBreak,
      hrvDiff: avgHrvStreak != null && avgHrvBreak != null ? Math.round((avgHrvStreak - avgHrvBreak) * 10) / 10 : null,
      avgReadinessDuringStreak: avgReadinessStreak,
      avgReadinessAfterBreak: avgReadinessBreak,
      readinessDiff: avgReadinessStreak != null && avgReadinessBreak != null ? Math.round((avgReadinessStreak - avgReadinessBreak) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu passa-regeneracja.' });
  }
});

const RHR_RECENT_WINDOW_DAYS = 7;
const RHR_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_RHR_DAYS = 4;
const MIN_BASELINE_RHR_DAYS = 14;

// Insight (round 8): resting heart rate trend (rhr) - the average over the last 7 days vs the
// user's own baseline from the preceding 28 days. Independent of early-strain-alert (which
// keys on workout intensity) and of recovery-insight (which compares HRV/RHR AFTER a workout
// vs at rest) - this is the pure RHR trend over time, useful as an early sign of fatigue,
// illness or excessive stress, REGARDLESS of activity. The "elevated" RHR threshold is
// computed against the user's OWN standard deviation (meanAndStdDev), not a fixed number of
// beats per minute - the natural spread of RHR varies greatly between people.
router.get('/api/dashboard/rhr-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(RHR_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(RHR_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );
    // Tag dnia: dni choroby wykluczamy z liczenia baseline i odczytu trendu - RHR
    // is elevated for an already known reason, and including those days would falsely
    // "explain" the trend as illness rather than real fatigue or stress.
    const rhrIllnessExcluded = await getExcludedDates(req.user.id, ['illness'], baselineStart, today);
    const rows = rawRows.filter(r => !rhrIllnessExcluded.has(r.date));

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.rhr);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd).map(r => r.rhr);

    if (recent.length < MIN_RECENT_RHR_DAYS || baseline.length < MIN_BASELINE_RHR_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_RHR_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_RHR_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
    const avgRecentRhr = avg(recent);
    const avgBaselineRhr = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const rhrDiff = Math.round((avgRecentRhr - avgBaselineRhr) * 10) / 10;
    const isElevated = baselineStdDev > 0 ? rhrDiff > baselineStdDev : rhrDiff > 2;

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentRhr,
      avgBaselineRhr,
      rhrDiff,
      baselineStdDev: Math.round(baselineStdDev * 10) / 10,
      isElevated
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu tętna spoczynkowego.' });
  }
});

const MIN_DAYS_PER_MEAL_TIMING_GROUP = 5;
const MEAL_TIMING_LOOKBACK_DAYS = 90;

// Insight (round 8): the time of the last meal of the day (MAX(timestamp) from meals) vs the
// quality of THAT SAME NIGHT's sleep (sleep_score, sleep_deep). Split by the median of the
// user's OWN last-meal times for the period - not a fixed threshold ("after 20:00", say),
// because eating and circadian habits are highly individual. A different direction from the
// existing sleep-insight (there: sleep -> the NEXT day's nutrition).
router.get('/api/dashboard/meal-timing-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MEAL_TIMING_LOOKBACK_DAYS);

    const mealRows = await db.all(
      `SELECT date, MAX(timestamp) AS last_meal_timestamp FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const sleepRows = await db.all(
      `SELECT date, sleep_score, sleep_deep FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    // The time of the last meal as a decimal number (21:30 -> 21.5, for instance) - for
    // computing the median and splitting into groups.
    const toHourFraction = (ts) => {
      const match = /\s(\d{2}):(\d{2})/.exec(ts || '');
      if (!match) return null;
      return Number(match[1]) + Number(match[2]) / 60;
    };

    const entries = [];
    mealRows.forEach(r => {
      const hour = toHourFraction(r.last_meal_timestamp);
      const sleep = sleepByDate.get(r.date);
      if (hour == null || !sleep) return;
      // sleep_deep is stored in the database in HOURS (services/sync.js: totalDeepSec / 3600) -
      // we convert to minutes, because avgSleepDeepLaterEating/sleepDeepDiff in the response
      // are described in the UI as "min" (see the analogous fix in sedentary-sleep-insight
      // i fiber-sleep-insight).
      entries.push({ hour, sleep_score: sleep.sleep_score, sleep_deep: sleep.sleep_deep != null ? sleep.sleep_deep * 60 : sleep.sleep_deep });
    });

    if (entries.length < MIN_DAYS_PER_MEAL_TIMING_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: entries.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP * 2
      });
    }

    const medianHour = median(entries.map(e => e.hour));
    const laterEaters = entries.filter(e => e.hour >= medianHour);
    const earlierEaters = entries.filter(e => e.hour < medianHour);

    if (laterEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP || earlierEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        laterDays: laterEaters.length,
        earlierDays: earlierEaters.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgScoreLater = avgOf(laterEaters, 'sleep_score');
    const avgScoreEarlier = avgOf(earlierEaters, 'sleep_score');
    const avgDeepLater = avgOf(laterEaters, 'sleep_deep');
    const avgDeepEarlier = avgOf(earlierEaters, 'sleep_deep');

    const formatHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

    res.json({
      hasEnoughData: true,
      medianLastMealHour: formatHour(medianHour),
      laterEatingDays: laterEaters.length,
      earlierEatingDays: earlierEaters.length,
      avgSleepScoreLaterEating: avgScoreLater,
      avgSleepScoreEarlierEating: avgScoreEarlier,
      sleepScoreDiff: avgScoreLater != null && avgScoreEarlier != null ? Math.round((avgScoreLater - avgScoreEarlier) * 10) / 10 : null,
      avgSleepDeepLaterEating: avgDeepLater,
      avgSleepDeepEarlierEating: avgDeepEarlier,
      sleepDeepDiff: avgDeepLater != null && avgDeepEarlier != null ? Math.round((avgDeepLater - avgDeepEarlier) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu godzina posiłku-sen.' });
  }
});

// Insight (round 9): a standalone blood pressure trend (the last 7 days vs the preceding 28
// days) - unlike the existing sodium-bp-insight (sodium as the explanatory variable), what
// matters here is the pure trend over time, whatever the cause. The category classification
// uses simplified AHA (American Heart Association) thresholds - an indicative label, not a
// medical diagnosis.
const BP_RECENT_WINDOW_DAYS = 7;
const BP_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_BP_DAYS = 3;
const MIN_BASELINE_BP_DAYS = 7;

function classifyBloodPressure(systolic, diastolic) {
  if (systolic == null || diastolic == null) return null;
  if (systolic >= 180 || diastolic >= 120) return 'Przełom nadciśnieniowy';
  if (systolic >= 140 || diastolic >= 90) return 'Nadciśnienie 2. stopnia';
  if (systolic >= 130 || diastolic >= 80) return 'Nadciśnienie 1. stopnia';
  if (systolic >= 120) return 'Podwyższone';
  return 'Prawidłowe';
}

router.get('/api/dashboard/bp-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(BP_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(BP_BASELINE_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL
       AND blood_pressure_systolic > 0 AND blood_pressure_diastolic > 0`,
      [req.user.id, baselineStart, today]
    );

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd);

    if (recent.length < MIN_RECENT_BP_DAYS || baseline.length < MIN_BASELINE_BP_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_BP_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_BP_DAYS
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, r) => s + r[key], 0) / arr.length) * 10) / 10;
    const avgRecentSystolic = avg(recent, 'blood_pressure_systolic');
    const avgRecentDiastolic = avg(recent, 'blood_pressure_diastolic');
    const avgBaselineSystolic = avg(baseline, 'blood_pressure_systolic');
    const avgBaselineDiastolic = avg(baseline, 'blood_pressure_diastolic');

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentSystolic,
      avgRecentDiastolic,
      avgBaselineSystolic,
      avgBaselineDiastolic,
      systolicDiff: Math.round((avgRecentSystolic - avgBaselineSystolic) * 10) / 10,
      diastolicDiff: Math.round((avgRecentDiastolic - avgBaselineDiastolic) * 10) / 10,
      recentCategory: classifyBloodPressure(avgRecentSystolic, avgRecentDiastolic),
      baselineCategory: classifyBloodPressure(avgBaselineSystolic, avgBaselineDiastolic)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu ciśnienia krwi.' });
  }
});

// Insight: real cardio zones (Karvonen) summed from the Apple Health workouts of the last 14
// days. Unlike the static "Strefy Tętna" reference table (based on a formula, not a
// measurement), what counts here are the REAL minutes measured by heart rate during workouts -
// see computeWorkoutHrZones in routes/appleHealth.js. It requires the "Include Workout
// Metrics" switch enabled in Health Auto Export; without it, workouts carry nothing but NULLs
// in the zoneN_minutes columns and do not enter the sum (the zone1_minutes IS NOT NULL
// condition).
const HR_ZONES_INSIGHT_WINDOW_DAYS = 14;
const MIN_WORKOUTS_WITH_ZONES = 2;

router.get('/api/dashboard/hr-zones-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const windowStart = shiftDate(today, -(HR_ZONES_INSIGHT_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND zone1_minutes IS NOT NULL`,
      [req.user.id, windowStart, today]
    );

    if (rows.length < MIN_WORKOUTS_WITH_ZONES) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_with_zones',
        workoutsWithZoneData: rows.length,
        minWorkoutsRequired: MIN_WORKOUTS_WITH_ZONES
      });
    }

    const zoneMinutes = { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };
    for (const r of rows) {
      zoneMinutes.zone1 += r.zone1_minutes || 0;
      zoneMinutes.zone2 += r.zone2_minutes || 0;
      zoneMinutes.zone3 += r.zone3_minutes || 0;
      zoneMinutes.zone4 += r.zone4_minutes || 0;
      zoneMinutes.zone5 += r.zone5_minutes || 0;
    }
    Object.keys(zoneMinutes).forEach(k => { zoneMinutes[k] = Math.round(zoneMinutes[k]); });

    const totalMinutes = Object.values(zoneMinutes).reduce((s, v) => s + v, 0);
    let dominantZone = null;
    let dominantMax = -1;
    Object.entries(zoneMinutes).forEach(([, mins], idx) => {
      if (mins > dominantMax) { dominantMax = mins; dominantZone = idx + 1; }
    });

    res.json({
      hasEnoughData: true,
      windowDays: HR_ZONES_INSIGHT_WINDOW_DAYS,
      workoutsWithZoneData: rows.length,
      zoneMinutes,
      totalMinutes,
      dominantZone
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stref kardio.' });
  }
});

// ============================================================================
// Round 10: further insights based EXCLUSIVELY on data the app already collects (the meals'
// health_rating from analysis_json, the day of the week, workout cardio zones,
// target_weight_kg from the settings, repeated meals) - zero new
// integracji, zero kopiowania funkcji z konkurencyjnych aplikacji dietetycznych.
// ============================================================================

const MEAL_QUALITY_RECENT_WINDOW_DAYS = 14;
const MEAL_QUALITY_BASELINE_WINDOW_DAYS = 30;
const MIN_RECENT_RATED_MEALS = 3;
const MIN_BASELINE_RATED_MEALS = 5;

// Insight: the meal quality trend based on health_rating (1-10) - the healthiness rating of
// EVERY meal, which Gemini already returns during the analysis (routes/meals.js) but which
// had never been aggregated over time (visible only per meal in the day view). health_rating
// has no column of its own in the meals table - it lives inside analysis_json, so we parse it
// here with the same try/catch pattern as GET /api/meals. The comparison: the last 14 days vs
// the preceding 30 days.
router.get('/api/dashboard/meal-quality-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(MEAL_QUALITY_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(MEAL_QUALITY_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, analysis_json FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, baselineStart, today]
    );
    // Day tag: holiday days are excluded from the meal quality trend - eating away from home
    // (restaurants, a different rhythm) is not representative of the normal quality of the
    // diet and would falsely distort the "recently vs before" comparison.
    const mealQualityVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], baselineStart, today);
    const rows = rawRows.filter(r => !mealQualityVacationExcluded.has(r.date));

    const ratedMeals = [];
    rows.forEach(r => {
      try {
        const analysis = JSON.parse(r.analysis_json);
        const rating = Number(analysis.health_rating);
        if (Number.isFinite(rating) && rating >= 1 && rating <= 10) {
          ratedMeals.push({ date: r.date, rating });
        }
      } catch (e) {
        // An older meal / a missing or corrupt analysis_json - no health_rating, so we skip it.
      }
    });

    const recent = ratedMeals.filter(m => m.date >= recentStart && m.date <= today);
    const baseline = ratedMeals.filter(m => m.date >= baselineStart && m.date <= baselineEnd);

    if (recent.length < MIN_RECENT_RATED_MEALS || baseline.length < MIN_BASELINE_RATED_MEALS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_rated_meals',
        recentRatedMeals: recent.length,
        baselineRatedMeals: baseline.length,
        minRecentRequired: MIN_RECENT_RATED_MEALS,
        minBaselineRequired: MIN_BASELINE_RATED_MEALS
      });
    }

    const avgRating = arr => Math.round((arr.reduce((s, m) => s + m.rating, 0) / arr.length) * 10) / 10;
    const avgRecentRating = avgRating(recent);
    const avgBaselineRating = avgRating(baseline);

    res.json({
      hasEnoughData: true,
      recentRatedMeals: recent.length,
      baselineRatedMeals: baseline.length,
      avgRecentRating,
      avgBaselineRating,
      ratingDiff: Math.round((avgRecentRating - avgBaselineRating) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania trendu jakości posiłków.' });
  }
});

const WEEKEND_EFFECT_LOOKBACK_DAYS = 28;
const MIN_WEEKDAY_DAYS_WITH_DATA = 8;
const MIN_WEEKEND_DAYS_WITH_DATA = 4;

// The day of the week from a 'YYYY-MM-DD' date - through Date.UTC (like shiftDate above), to
// avoid depending on the Node process's timezone (see utils/dates.js).
function isWeekendDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = niedziela, 6 = sobota
  return dow === 0 || dow === 6;
}

// Insight: the "weekend effect" - a comparison of calories/activity/sleep on weekdays vs the
// weekend over the last 4 weeks. The first insight that groups data by day of the week (all
// the others compare two periods of time or two groups by a metric's value) - it checks
// whether the typical "weekend drift" actually exists for THIS user rather than assuming it.
router.get('/api/dashboard/weekend-effect-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -(WEEKEND_EFFECT_LOOKBACK_DAYS - 1));

    const rawMealRows = await db.all(
      `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const rawHealthRows = await db.all(
      `SELECT date, active_calories, steps, sleep_score FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, startDate, today]
    );
    // Day tag: holiday days are excluded from the weekend effect - away from home "the
    // weekend" loses its usual meaning (every day can feel like one), and including those days
    // would distort the weekday vs weekend comparison in normal life.
    const weekendVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const mealRows = rawMealRows.filter(r => !weekendVacationExcluded.has(r.date));
    const healthRows = rawHealthRows.filter(r => !weekendVacationExcluded.has(r.date));

    const weekdayCalories = [], weekendCalories = [];
    mealRows.forEach(r => {
      if (r.calories == null) return;
      (isWeekendDateStr(r.date) ? weekendCalories : weekdayCalories).push(r.calories);
    });

    if (weekdayCalories.length < MIN_WEEKDAY_DAYS_WITH_DATA || weekendCalories.length < MIN_WEEKEND_DAYS_WITH_DATA) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        weekdayDaysLogged: weekdayCalories.length,
        weekendDaysLogged: weekendCalories.length,
        minWeekdayDaysRequired: MIN_WEEKDAY_DAYS_WITH_DATA,
        minWeekendDaysRequired: MIN_WEEKEND_DAYS_WITH_DATA
      });
    }

    const weekdaySteps = [], weekendSteps = [];
    const weekdayActiveCal = [], weekendActiveCal = [];
    const weekdaySleep = [], weekendSleep = [];
    healthRows.forEach(r => {
      const weekend = isWeekendDateStr(r.date);
      if (r.steps != null && r.steps > 0) (weekend ? weekendSteps : weekdaySteps).push(r.steps);
      if (r.active_calories != null && r.active_calories > 0) (weekend ? weekendActiveCal : weekdayActiveCal).push(r.active_calories);
      if (r.sleep_score != null) (weekend ? weekendSleep : weekdaySleep).push(r.sleep_score);
    });

    const avg = arr => (arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null);
    const avgWeekdayCalories = avg(weekdayCalories);
    const avgWeekendCalories = avg(weekendCalories);

    res.json({
      hasEnoughData: true,
      weekdayDaysLogged: weekdayCalories.length,
      weekendDaysLogged: weekendCalories.length,
      avgWeekdayCalories,
      avgWeekendCalories,
      // B-S4: Zabezpieczenie przed NaN gdy avg() zwraca null (brak danych w jednej grupie)
      caloriesDiff: (avgWeekendCalories != null && avgWeekdayCalories != null) ? avgWeekendCalories - avgWeekdayCalories : null,
      avgWeekdaySteps: avg(weekdaySteps),
      avgWeekendSteps: avg(weekendSteps),
      avgWeekdayActiveCalories: avg(weekdayActiveCal),
      avgWeekendActiveCalories: avg(weekendActiveCal),
      avgWeekdaySleepScore: avg(weekdaySleep),
      avgWeekendSleepScore: avg(weekendSleep)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy efektu weekendu.' });
  }
});

const WORKOUT_EFFICIENCY_LOOKBACK_DAYS = 90;
const MIN_WORKOUTS_PER_TYPE = 3;

// Insight: calorie efficiency per workout type (kcal/min) based on
// apple_health_workouts.active_calories and duration_minutes over the last 90 days - a ranking
// of workout types by the calories actually burned per minute, showing which kind of activity
// gives THIS user the best calorie effect per unit of time (rather than the general stereotype
// that "running burns more than yoga").
router.get('/api/dashboard/workout-efficiency-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_EFFICIENCY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND duration_minutes >= 5 AND active_calories IS NOT NULL AND active_calories > 0`,
      [req.user.id, startDate, today]
    );

    const byType = new Map();
    rows.forEach(r => {
      const type = r.workout_type || 'Inny';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(r);
    });

    const types = [];
    byType.forEach((workouts, type) => {
      if (workouts.length < MIN_WORKOUTS_PER_TYPE) return;
      const avgKcalPerMin = workouts.reduce((s, w) => s + w.active_calories / w.duration_minutes, 0) / workouts.length;
      const avgDurationMin = workouts.reduce((s, w) => s + w.duration_minutes, 0) / workouts.length;
      const totalCalories = workouts.reduce((s, w) => s + w.active_calories, 0);
      types.push({
        type,
        count: workouts.length,
        avgKcalPerMin: Math.round(avgKcalPerMin * 10) / 10,
        avgDurationMin: Math.round(avgDurationMin),
        totalCalories: Math.round(totalCalories)
      });
    });

    if (types.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_per_type',
        minWorkoutsPerTypeRequired: MIN_WORKOUTS_PER_TYPE
      });
    }

    types.sort((a, b) => b.avgKcalPerMin - a.avgKcalPerMin);

    res.json({
      hasEnoughData: true,
      windowDays: WORKOUT_EFFICIENCY_LOOKBACK_DAYS,
      types
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy efektywności treningów.' });
  }
});

const WEIGHT_FORECAST_LOOKBACK_DAYS = 60;
const MIN_WEIGHT_FORECAST_MEASUREMENTS = 4;
const MIN_WEIGHT_FORECAST_SPAN_DAYS = 14;

// Insight: a forecast of the date the numeric weight goal (target_weight_kg) will be reached,
// based on a linear regression of the weight over the last 60 days. The same status and pace
// logic as in the weekly e-mail (buildGoalPaceAnalysis in services/summaries.js, reused here
// to avoid duplication) - until now that forecast was visible ONLY in the periodic e-mails;
// here it is exposed as a permanent card on the dashboard. weeklyWeightChange is computed here
// from a regression over a longer window (60 days) rather than from the simple
// first-minus-last measurement of the week as in the e-mail - more stable when the
// measurements are irregular.
router.get('/api/dashboard/weight-goal-forecast', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WEIGHT_FORECAST_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetWeightKg = settings.target_weight_kg || 0;
    if (!targetWeightKg) {
      return res.json({ hasEnoughData: false, reason: 'no_target_weight_set' });
    }

    const rawWeightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    // Day tag: holiday days are excluded from the regression - weight fluctuations away from
    // home do not reflect the real rate of change under a normal routine and would falsely
    // shift the forecast date for reaching the goal.
    const forecastVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const weightRows = rawWeightRows.filter(r => !forecastVacationExcluded.has(r.date));
    if (weightRows.length < MIN_WEIGHT_FORECAST_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_weight_data',
        weightMeasurements: weightRows.length,
        minWeightMeasurementsRequired: MIN_WEIGHT_FORECAST_MEASUREMENTS
      });
    }

    const points = toRegressionPoints(weightRows, 'weight');
    const spanDays = points[points.length - 1].x;
    if (spanDays < MIN_WEIGHT_FORECAST_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        spanDays: Math.round(spanDays),
        minSpanDaysRequired: MIN_WEIGHT_FORECAST_SPAN_DAYS
      });
    }

    const slopePerDay = linearRegressionSlope(points);
    if (slopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_weight_data' });
    }
    const currentWeight = weightRows[weightRows.length - 1].weight;
    const weeklyWeightChange = Math.round(slopePerDay * 7 * 100) / 100;

    const pace = buildGoalPaceAnalysis(targetWeightKg, currentWeight, weeklyWeightChange);
    if (!pace) {
      return res.json({ hasEnoughData: false, reason: 'cannot_evaluate_pace' });
    }

    const projectedDate = pace.weeksToGoal != null ? shiftDate(today, Math.round(pace.weeksToGoal * 7)) : null;

    res.json({
      hasEnoughData: true,
      weightMeasurements: weightRows.length,
      spanDays: Math.round(spanDays),
      ...pace,
      projectedDate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd prognozy celu wagi.' });
  }
});

const FAVORITE_MEAL_DRIFT_LOOKBACK_DAYS = 180;
const MIN_OCCURRENCES_FOR_DRIFT = 4;
const DRIFT_THRESHOLD_PERCENT = 20;
const MAX_DRIFT_FINDINGS = 5;

// Insight: the stability of favourite (repeated) meals over time. It extends the grouping
// pattern from /api/meals/frequent (LOWER(TRIM(raw_text)), repetitions) with a comparison of
// the OLDER vs the NEWER half of a given meal's occurrences - detecting "portion drift" (the
// same logged meal growing or shrinking in calories over time, through slowly increasing
// portions without changing the description) - invisible until now, because
// /api/meals/frequent computes only one averaged value over the whole period.
router.get('/api/dashboard/favorite-meal-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -FAVORITE_MEAL_DRIFT_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT LOWER(TRIM(raw_text)) AS meal_key, raw_text, date, calories
       FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? AND raw_text IS NOT NULL AND TRIM(raw_text) != '' AND calories IS NOT NULL
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    const grouped = new Map();
    rows.forEach(r => {
      if (!grouped.has(r.meal_key)) grouped.set(r.meal_key, []);
      grouped.get(r.meal_key).push(r);
    });

    const eligibleGroups = [...grouped.values()].filter(occ => occ.length >= MIN_OCCURRENCES_FOR_DRIFT);
    if (eligibleGroups.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_repeated_meals',
        minOccurrencesRequired: MIN_OCCURRENCES_FOR_DRIFT
      });
    }

    const avgCal = arr => arr.reduce((s, x) => s + x.calories, 0) / arr.length;
    const findings = [];
    eligibleGroups.forEach(occurrences => {
      const mid = Math.floor(occurrences.length / 2);
      const olderAvg = avgCal(occurrences.slice(0, mid));
      const newerAvg = avgCal(occurrences.slice(mid));
      if (olderAvg <= 0) return;
      const diffPercent = Math.round(((newerAvg - olderAvg) / olderAvg) * 100);
      if (Math.abs(diffPercent) >= DRIFT_THRESHOLD_PERCENT) {
        findings.push({
          rawText: occurrences[occurrences.length - 1].raw_text,
          occurrences: occurrences.length,
          olderAvgCalories: Math.round(olderAvg),
          newerAvgCalories: Math.round(newerAvg),
          diffPercent,
          firstDate: occurrences[0].date,
          lastDate: occurrences[occurrences.length - 1].date
        });
      }
    });

    findings.sort((a, b) => Math.abs(b.diffPercent) - Math.abs(a.diffPercent));

    res.json({
      hasEnoughData: true,
      mealsAnalyzed: eligibleGroups.length,
      findings: findings.slice(0, MAX_DRIFT_FINDINGS)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy dryfu ulubionych posiłków.' });
  }
});

const SPO2_RECENT_WINDOW_DAYS = 7;
const SPO2_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_SPO2_DAYS = 4;
const MIN_BASELINE_SPO2_DAYS = 14;

// SpO2 (blood oxygen saturation) trend: a window of recent days vs the preceding baseline -
// the same pattern as rhr-drift-insight, but here we care about a DROP (an SpO2 lower than the
// user's own baseline can signal breathing problems during sleep, an infection or being at
// altitude), not a rise.
router.get('/api/dashboard/spo2-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(SPO2_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(SPO2_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, spo2_percentage FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND spo2_percentage IS NOT NULL AND spo2_percentage > 0`,
      [req.user.id, baselineStart, today]
    );
    // Day tag: illness days are excluded - a lowered SpO2 then has an already known cause (an
    // infection) and should not enter the baseline of "normal" resting SpO2.
    const spo2IllnessExcluded = await getExcludedDates(req.user.id, ['illness'], baselineStart, today);
    const rows = rawRows.filter(r => !spo2IllnessExcluded.has(r.date));

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.spo2_percentage);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd).map(r => r.spo2_percentage);

    if (recent.length < MIN_RECENT_SPO2_DAYS || baseline.length < MIN_BASELINE_SPO2_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_days',
        recentDays: recent.length, baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_SPO2_DAYS, minBaselineDaysRequired: MIN_BASELINE_SPO2_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
    const avgRecentSpo2 = avg(recent);
    const avgBaselineSpo2 = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const spo2Diff = Math.round((avgRecentSpo2 - avgBaselineSpo2) * 10) / 10;
    // SpO2 naturally has a very small spread (usually 95-99%), so with stdDev=0 (when only a
    // single repeated reading exists, say) the fallback is small - 1pp.
    const isLow = baselineStdDev > 0 ? spo2Diff < -baselineStdDev : spo2Diff < -1;

    res.json({
      hasEnoughData: true, recentDays: recent.length, baselineDays: baseline.length,
      avgRecentSpo2, avgBaselineSpo2, spo2Diff,
      baselineStdDev: Math.round(baselineStdDev * 10) / 10, isLow
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu SpO2.' });
  }
});

const MIN_WHR_MEASUREMENTS = 4;
const MIN_WHR_SPAN_DAYS = 14;
const WHR_LOOKBACK_DAYS = 365;

// WHR (waist-to-hip ratio = waist circumference / hip circumference) - a cardiovascular risk
// indicator established in the clinical literature (WHO), independent of weight or BMI itself.
// Computed only from measurements where the waist and the hips were recorded on THE SAME day
// (otherwise joining by date would distort the ratio). WHO thresholds: women >0.85, men >0.90
// = elevated risk. The app does not collect a "sex" field in the settings, so we return both
// thresholds and let the frontend or the user interpret the result against their own threshold.
router.get('/api/dashboard/whr-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WHR_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, waist, hips FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND waist IS NOT NULL AND hips IS NOT NULL AND hips > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_WHR_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_measurements',
        measurements: rows.length, minMeasurementsRequired: MIN_WHR_MEASUREMENTS
      });
    }

    const whrRows = rows.map(r => ({ date: r.date, whr: r.waist / r.hips }));
    const spanDays = (new Date(whrRows[whrRows.length - 1].date).getTime() - new Date(whrRows[0].date).getTime()) / (24 * 60 * 60 * 1000);

    if (spanDays < MIN_WHR_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'span_too_short',
        spanDays: Math.round(spanDays), minSpanDaysRequired: MIN_WHR_SPAN_DAYS
      });
    }

    const latestWhr = Math.round(whrRows[whrRows.length - 1].whr * 1000) / 1000;
    const whrPoints = toRegressionPoints(whrRows, 'whr');
    const whrSlopePerDay = linearRegressionSlope(whrPoints);
    const whrTrend = whrSlopePerDay === null ? 'flat' : (whrSlopePerDay < -0.0002 ? 'down' : whrSlopePerDay > 0.0002 ? 'up' : 'flat');

    res.json({
      hasEnoughData: true,
      measurements: rows.length,
      spanDays: Math.round(spanDays),
      latestWhr,
      latestDate: whrRows[whrRows.length - 1].date,
      whrTrend,
      whrSlopePerMonth: whrSlopePerDay !== null ? Math.round(whrSlopePerDay * 30 * 1000) / 1000 : null,
      whoThresholdFemale: 0.85,
      whoThresholdMale: 0.90,
      isAboveFemaleThreshold: latestWhr > 0.85,
      isAboveMaleThreshold: latestWhr > 0.90
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu WHR.' });
  }
});

const MIN_SYMMETRY_MEASUREMENTS = 4;
const SYMMETRY_LOOKBACK_DAYS = 365;
const SYMMETRY_ASYMMETRY_THRESHOLD_CM = 0.5;

// Biceps symmetry (biceps_left vs biceps_right) - never compared in the app before. A
// persistent difference of >0.5cm between sides is a common sign of uneven training or one
// side of the body dominating (typical for right- or left-handed people training without
// consciously correcting for it).
router.get('/api/dashboard/body-symmetry-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SYMMETRY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, biceps_left, biceps_right FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND biceps_left IS NOT NULL AND biceps_right IS NOT NULL
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_SYMMETRY_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_measurements',
        measurements: rows.length, minMeasurementsRequired: MIN_SYMMETRY_MEASUREMENTS
      });
    }

    const diffRows = rows.map(r => ({ date: r.date, diff: r.biceps_left - r.biceps_right }));
    const avgDiffCm = Math.round((diffRows.reduce((s, r) => s + r.diff, 0) / diffRows.length) * 100) / 100;
    const latestDiffCm = Math.round(diffRows[diffRows.length - 1].diff * 100) / 100;
    const diffPoints = toRegressionPoints(diffRows, 'diff');
    const diffSlopePerDay = linearRegressionSlope(diffPoints);

    res.json({
      hasEnoughData: true,
      measurements: rows.length,
      avgDiffCm,
      latestDiffCm,
      latestDate: diffRows[diffRows.length - 1].date,
      dominantSide: Math.abs(avgDiffCm) < 0.05 ? null : (avgDiffCm > 0 ? 'left' : 'right'),
      isAsymmetric: Math.abs(avgDiffCm) >= SYMMETRY_ASYMMETRY_THRESHOLD_CM,
      asymmetryThresholdCm: SYMMETRY_ASYMMETRY_THRESHOLD_CM,
      diffTrendCmPerMonth: diffSlopePerDay !== null ? Math.round(diffSlopePerDay * 30 * 100) / 100 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu symetrii bicepsów.' });
  }
});

const PACE_LOOKBACK_DAYS = 120;
const PACE_RECENT_WINDOW_DAYS = 14;
const PACE_BASELINE_WINDOW_DAYS = 90;
const MIN_RECENT_PACE_DAYS = 3;
const MIN_BASELINE_PACE_DAYS = 5;
const PACE_WORKOUT_TYPE_REGEX = /run|bieg|walk|marsz|spacer|hik|trek/i;

// Running/walking pace (min/km) - APPROXIMATE, because apple_health_workouts HAS NO per-workout
// distance column. So we combine the daily distance (health_metrics.distance_meters) with the
// workout's duration, but ONLY for days on which EXACTLY ONE workout was recorded (whatever
// the type) - otherwise the daily distance could be the sum of, say, a run and a separate
// walk, which would falsify the pace. See workout-efficiency-insight - here, instead of
// kcal/min, we compute
// czas/km, i dodatkowo wymagamy typu run/walk/hike.
router.get('/api/dashboard/pace-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -PACE_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, workout_type, duration_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND duration_minutes IS NOT NULL AND duration_minutes > 0`,
      [req.user.id, startDate, today]
    );

    const byDate = new Map();
    workoutRows.forEach(w => {
      if (!byDate.has(w.date)) byDate.set(w.date, []);
      byDate.get(w.date).push(w);
    });

    const singleWorkoutDates = [...byDate.entries()]
      .filter(([, workouts]) => workouts.length === 1 && PACE_WORKOUT_TYPE_REGEX.test(workouts[0].workout_type || ''))
      .map(([date, workouts]) => ({ date, durationMinutes: workouts[0].duration_minutes }));

    if (singleWorkoutDates.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_eligible_single_workout_days' });
    }

    const dates = singleWorkoutDates.map(d => d.date);
    const distRows = await db.all(
      `SELECT date, distance_meters FROM health_metrics
       WHERE user_id = ? AND date IN (${dates.map(() => '?').join(',')}) AND distance_meters IS NOT NULL AND distance_meters > 0`,
      [req.user.id, ...dates]
    );
    const distanceByDate = new Map(distRows.map(r => [r.date, r.distance_meters]));

    const paceRows = singleWorkoutDates
      .filter(d => distanceByDate.has(d.date))
      .map(d => ({
        date: d.date,
        paceMinPerKm: d.durationMinutes / (distanceByDate.get(d.date) / 1000)
      }))
      .filter(r => r.paceMinPerKm > 0 && isFinite(r.paceMinPerKm))
      .sort((a, b) => a.date.localeCompare(b.date));

    const recentStart = shiftDate(today, -(PACE_RECENT_WINDOW_DAYS - 1));
    const recent = paceRows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.paceMinPerKm);
    const baseline = paceRows.filter(r => r.date < recentStart && r.date >= shiftDate(today, -PACE_BASELINE_WINDOW_DAYS)).map(r => r.paceMinPerKm);

    if (recent.length < MIN_RECENT_PACE_DAYS || baseline.length < MIN_BASELINE_PACE_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_days',
        eligibleDays: paceRows.length, recentDays: recent.length, baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_PACE_DAYS, minBaselineDaysRequired: MIN_BASELINE_PACE_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
    const avgRecentPace = avg(recent);
    const avgBaselinePace = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const paceDiffMinPerKm = Math.round((avgRecentPace - avgBaselinePace) * 100) / 100;
    // A lower pace (min/km) = faster = better, so an "improvement" is a NEGATIVE difference.
    const isImproving = baselineStdDev > 0 ? paceDiffMinPerKm < -baselineStdDev : paceDiffMinPerKm < -0.5;
    const isSlower = baselineStdDev > 0 ? paceDiffMinPerKm > baselineStdDev : paceDiffMinPerKm > 0.5;

    res.json({
      hasEnoughData: true, recentDays: recent.length, baselineDays: baseline.length,
      avgRecentPaceMinPerKm: avgRecentPace, avgBaselinePaceMinPerKm: avgBaselinePace,
      paceDiffMinPerKm, baselineStdDev: Math.round(baselineStdDev * 100) / 100,
      isImproving, isSlower
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu tempa.' });
  }
});

const VARIETY_LOOKBACK_DAYS = 60;
const MIN_TOTAL_WORKOUTS_FOR_VARIETY = 6;
const VARIETY_DOMINANCE_THRESHOLD_PERCENT = 70;

// Workout variety - the distribution of workout_type over the last 60 days. Unlike
// workout-efficiency-insight (kcal/min per type), what interests us here is purely the
// FREQUENCY of the individual disciplines - one dominant discipline making up >70% of all
// workouts can signal a risk of one-sided overtraining (only running, no strength or mobility
// work).
router.get('/api/dashboard/workout-variety-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -VARIETY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT workout_type FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ? AND workout_type IS NOT NULL`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_TOTAL_WORKOUTS_FOR_VARIETY) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_workouts',
        totalWorkouts: rows.length, minWorkoutsRequired: MIN_TOTAL_WORKOUTS_FOR_VARIETY
      });
    }

    const counts = new Map();
    rows.forEach(r => {
      const key = r.workout_type.trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const breakdown = [...counts.entries()]
      .map(([type, count]) => ({ type, count, pct: Math.round((count / rows.length) * 1000) / 10 }))
      .sort((a, b) => b.count - a.count);

    const dominant = breakdown[0];

    res.json({
      hasEnoughData: true,
      totalWorkouts: rows.length,
      distinctTypes: breakdown.length,
      breakdown,
      dominantType: dominant.type,
      dominantPct: dominant.pct,
      isImbalanced: dominant.pct >= VARIETY_DOMINANCE_THRESHOLD_PERCENT
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu różnorodności treningów.' });
  }
});

const WELLNESS_SCORE_RHR_BASELINE_DAYS = 28;
const MIN_WELLNESS_COMPONENTS = 3;
// The weights of the five components - they sum to 1.0 when ALL of them are available. When
// some signals are missing on a given day (no HRV/RHR because the user has no watch, or no
// meals because nothing has been eaten yet), the weights of the available components are
// renormalised proportionally - see below.
// CONTRACT: the weights must sum to 1.0 (0.25+0.25+0.15+0.20+0.15=1.0) - if you edit these
// values in future, preserve that sum, otherwise the renormalisation below (weightSum) will
// "fix" it on the fly, but each component's share relative to the others will stop matching
// the intended proportions.
console.assert(
  Math.abs(Object.values({ sleep: 0.25, readiness: 0.25, rhrRecovery: 0.15, nutritionAdherence: 0.20, hydration: 0.15 }).reduce((a, b) => a + b, 0) - 1) < 1e-9,
  'WELLNESS_WEIGHTS musi sumować się do 1.0'
);
const WELLNESS_WEIGHTS = { sleep: 0.25, readiness: 0.25, rhrRecovery: 0.15, nutritionAdherence: 0.20, hydration: 0.15 };

// A composite "Wellness Score" (0-100) - it synthesises sleep, readiness, RHR relative to the
// user's own baseline, sticking to the calorie goal and hydration into ONE headline indicator
// for the day. It does not replace the other insights (those analyse CAUSES and correlations
// over time) - this is "the state of the day" in a single number, so the user does not have to
// scroll the whole dashboard to judge "how am I doing today".
router.get('/api/dashboard/wellness-score', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const health = await db.get(
      `SELECT sleep_score, readiness_score, rhr, water_ml FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // Audit fix (round 17): we convert to a number ONLY the keys actually read as numbers
    // below (target_calories, target_water_ml) - previously `Number(r.value)` was applied to
    // ALL settings rows, which would break on any future text key (gemini_api_key, for
    // instance) stored in the same table. The remaining keys are left unchanged (strings).
    const NUMERIC_SETTINGS_KEYS = ['target_calories', 'target_water_ml'];
    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = NUMERIC_SETTINGS_KEYS.includes(r.key) ? Number(r.value) : r.value;
    });
    const targetCalories = getTargetCalories(settings);
    const targetWaterMl = getTargetWaterMl(settings);

    const mealRow = await db.get(
      `SELECT SUM(calories) AS calories FROM meals WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    const caloriesToday = mealRow && mealRow.calories != null ? mealRow.calories : null;

    const baselineStart = shiftDate(today, -WELLNESS_SCORE_RHR_BASELINE_DAYS);
    const baselineRhrRows = await db.all(
      `SELECT rhr FROM health_metrics WHERE user_id = ? AND date >= ? AND date < ? AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );

    const components = {};

    if (health && health.sleep_score != null && health.sleep_score > 0) {
      components.sleep = Math.max(0, Math.min(100, health.sleep_score));
    }
    if (health && health.readiness_score != null && health.readiness_score > 0) {
      components.readiness = Math.max(0, Math.min(100, health.readiness_score));
    }
    if (health && health.rhr != null && health.rhr > 0 && baselineRhrRows.length >= 5) {
      const { mean, stdDev } = meanAndStdDev(baselineRhrRows.map(r => r.rhr));
      // A lower RHR than the user's own baseline = better recovery. z>0 means an RHR HIGHER
      // than usual (worse), hence we subtract z*15 from 100 (an empirical scale, not a
      // clinical one - 1 standard deviation corresponds to -15 points).
      const z = stdDev > 0 ? (health.rhr - mean) / stdDev : 0;
      components.rhrRecovery = Math.max(0, Math.min(100, 100 - z * 15));
    }
    if (caloriesToday != null && caloriesToday > 0 && targetCalories > 0) {
      const deviationRatio = Math.abs(caloriesToday - targetCalories) / targetCalories;
      components.nutritionAdherence = Math.max(0, Math.min(100, 100 - deviationRatio * 100));
    }
    if (health && health.water_ml != null && health.water_ml > 0 && targetWaterMl > 0) {
      components.hydration = Math.max(0, Math.min(100, (health.water_ml / targetWaterMl) * 100));
    }

    const availableKeys = Object.keys(components);
    if (availableKeys.length < MIN_WELLNESS_COMPONENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_components',
        availableComponents: availableKeys, minComponentsRequired: MIN_WELLNESS_COMPONENTS
      });
    }

    const weightSum = availableKeys.reduce((s, k) => s + WELLNESS_WEIGHTS[k], 0);
    const wellnessScore = Math.round(
      availableKeys.reduce((s, k) => s + components[k] * (WELLNESS_WEIGHTS[k] / weightSum), 0)
    );

    const label = wellnessScore >= 80 ? 'Świetnie' : wellnessScore >= 60 ? 'Dobrze' : wellnessScore >= 40 ? 'Przeciętnie' : 'Słabo';

    res.json({
      hasEnoughData: true,
      date: today,
      wellnessScore,
      label,
      components: Object.fromEntries(availableKeys.map(k => [k, Math.round(components[k])])),
      componentsUsed: availableKeys.length,
      componentsTotal: Object.keys(WELLNESS_WEIGHTS).length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania Wellness Score.' });
  }
});

// --- BATERIA ENERGII ---
//
// A single 0-100 number at the top of the dashboard, answering the question "how much fuel do
// I have today", instead of several dozen separate cards in which that answer gets lost.
//
// How it differs from the Wellness Score: the Wellness Score rates how GOOD the day was
// (sleep, readiness, sticking to the calorie goal, hydration) - it is a judgement of
// behaviour. The battery answers a different question: how much of the resource is LEFT right
// now. It charges overnight, discharges during the day in proportion to the load and the time
// of day, and remembers the accumulated sleep debt. That is why a day with a perfect diet but
// following three short nights has a high Wellness Score and a low battery - and that is
// intended, because they are two different pieces of information.
//
// NOTE on the scale: the weights and conversion factors below are EMPIRICAL, chosen so that a
// typical day lands sensibly on the 0-100 scale. This is not a clinical measure nor a
// reconstruction of the Garmin/Whoop algorithm - it is a descriptive model over the user's own
// data, built in the same convention as the other insights in this file (a comparison against
// the user's OWN baseline, not against population norms).

const BATTERY_SLEEP_DEBT_DAYS = 14;
const BATTERY_STRAIN_BASELINE_DAYS = 30;
const MIN_DAYS_FOR_BATTERY_STRAIN_BASELINE = 7;

// How many battery points a full, typical day takes (at a load equal to the user's own
// baseline). 45 points means that after an ordinary day about half is left from a full charge -
// and a day noticeably harder than usual can go considerably lower.
const BATTERY_FULL_DAY_DRAIN = 45;

// The discharge is split into two independent parts.
//
// Why not a single one scaled by the clock: the first version computed discharge as "the
// fraction of the day that has passed" times "the load relative to a baseline scaled by that
// same fraction". That assumed activity is spread evenly across the whole day - but at 8:00 in
// the morning nobody has a third of their daily calories behind them. The effect: a morning
// workout ate half the battery, and a quiet evening understated the load.
//
// Now the discharge is the sum of:
//   - an ACTIVITY part, proportional to the work actually done relative to a typical full day
//     (with no reference to the clock),
//   - a TIME part, proportional to how long the user has been awake (simply functioning costs
//     energy, even on a day with no workout).
// This way a rest day ends with a high battery, and a hard workout lowers it immediately,
// whatever time it took place.
const BATTERY_ACTIVITY_DRAIN_SHARE = 0.7;
const BATTERY_TIME_DRAIN_SHARE = 0.3;

// The waking window used for the time part (Warsaw wall-clock hours). An approximation, not a
// user setting - for a discharge component worth 13 points, a more precise model (from Oura's
// wake time, say) would not change the result enough to justify the extra complexity and yet
// another source of "no data".
const BATTERY_WAKING_START_MINUTE = 7 * 60;
const BATTERY_WAKING_END_MINUTE = 23 * 60;

// The penalty for accumulated sleep debt. 2 points for every missing hour over the last 14
// nights, but no more than 15 points - sleep debt should lower the battery's ceiling, not
// drive it to zero on its own.
const BATTERY_DEBT_PENALTY_PER_HOUR = 2;
const BATTERY_MAX_DEBT_PENALTY = 15;

const BATTERY_MAX_STRESS_DRAIN = 15;
const BATTERY_MAX_STRESS_RECOVERY = 10;

// The weights for the overnight charge. sleep_score is the closest thing to "how well did I
// recover", readiness_score is Oura's readiness, and the sleep duration relative to the user's
// own goal completes the picture (one can score highly on quality across too short a night).
const BATTERY_CHARGE_WEIGHTS = {
  sleepScore: 0.45,
  readiness: 0.35,
  sleepDuration: 0.20
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// How much of the waking window has already passed (0-1) in the Europe/Warsaw timezone. Used
// ONLY for the time part of the discharge. For historical dates we return 1, because those
// days are already closed.
function getWakingProgress(dateStr) {
  if (dateStr !== getLocalDateString()) return 1;
  const wall = getWarsawWallClock();
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const span = BATTERY_WAKING_END_MINUTE - BATTERY_WAKING_START_MINUTE;
  return clamp((minutes - BATTERY_WAKING_START_MINUTE) / span, 0, 1);
}

router.get('/api/dashboard/energy-battery', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
    const targetSleep = settings.target_sleep_duration === undefined
      || isNaN(Number(settings.target_sleep_duration))
      ? 7.2
      : Number(settings.target_sleep_duration);

    const health = await db.get(
      `SELECT sleep_score, sleep_duration, readiness_score, hrv, rhr,
              active_calories, active_minutes, steps,
              stress_high_minutes, stress_recovery_minutes
       FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // With no data about the night there is nothing to compute the charge from - better to say
    // "no data" outright than to show a number built out of nothing.
    const hasSleepSignal = health && (
      (health.sleep_score != null && health.sleep_score > 0) ||
      (health.sleep_duration != null && health.sleep_duration > 0) ||
      (health.readiness_score != null && health.readiness_score > 0)
    );
    if (!hasSleepSignal) {
      return res.json({ hasEnoughData: false, reason: 'no_sleep_data', date: today });
    }

    // --- 1. Overnight charge ---
    const chargeParts = {};
    if (health.sleep_score != null && health.sleep_score > 0) {
      chargeParts.sleepScore = clamp(health.sleep_score, 0, 100);
    }
    if (health.readiness_score != null && health.readiness_score > 0) {
      chargeParts.readiness = clamp(health.readiness_score, 0, 100);
    }
    if (health.sleep_duration != null && health.sleep_duration > 0 && targetSleep > 0) {
      chargeParts.sleepDuration = clamp((health.sleep_duration / targetSleep) * 100, 0, 100);
    }
    const chargeKeys = Object.keys(chargeParts);
    const chargeWeightSum = chargeKeys.reduce((s, k) => s + BATTERY_CHARGE_WEIGHTS[k], 0);
    const nightCharge = chargeKeys.reduce(
      (s, k) => s + chargeParts[k] * (BATTERY_CHARGE_WEIGHTS[k] / chargeWeightSum), 0
    );

    // --- 2. Sleep debt over the last 14 nights ---
    const debtRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date > ? AND date <= ? AND sleep_duration IS NOT NULL AND sleep_duration > 0`,
      [req.user.id, shiftDate(today, -BATTERY_SLEEP_DEBT_DAYS), today]
    );
    // We count ONLY shortfalls. A longer night does not "repay" the debt linearly - a
    // simplifying assumption, but a more cautious one than summing surpluses, which could
    // zero out a real, multi-day deficit.
    const sleepDebtHours = debtRows.reduce(
      (sum, row) => sum + Math.max(0, targetSleep - row.sleep_duration), 0
    );
    const debtPenalty = Math.min(
      BATTERY_MAX_DEBT_PENALTY,
      sleepDebtHours * BATTERY_DEBT_PENALTY_PER_HOUR
    );

    // --- 3. Daily discharge relative to the user's OWN load baseline ---
    // The order of the metrics is the order of trustworthiness: active calories reflect the
    // load best, activity minutes are a substitute, steps a last resort.
    const strainRows = await db.all(
      `SELECT active_calories, active_minutes, steps FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, shiftDate(today, -BATTERY_STRAIN_BASELINE_DAYS), today]
    );

    const strainMetric = ['active_calories', 'active_minutes', 'steps'].find(key => {
      const todayValue = health[key];
      const history = strainRows.filter(r => r[key] != null && r[key] > 0);
      return todayValue != null && todayValue > 0 && history.length >= MIN_DAYS_FOR_BATTERY_STRAIN_BASELINE;
    });

    let strainRatio = 1;
    let strainBaseline = null;
    if (strainMetric) {
      const values = strainRows.map(r => r[strainMetric]).filter(v => v != null && v > 0);
      strainBaseline = median(values);
      if (strainBaseline > 0) {
        // A comparison against a WHOLE typical day, with no clock scaling - this number means
        // "how much of a typical day's work is already behind me", so in the morning it is
        // simply low, rather than artificially inflated by a short reference window.
        strainRatio = health[strainMetric] / strainBaseline;
      }
    }
    // An upper bound: an extremely hard day does not zero the battery instantly. There is no
    // lower bound - zero activity should mean zero activity discharge, because "merely
    // existing" has its own separate time part.
    const boundedStrainRatio = clamp(strainRatio, 0, 2);
    const activityDrain = boundedStrainRatio * BATTERY_FULL_DAY_DRAIN * BATTERY_ACTIVITY_DRAIN_SHARE;
    const timeDrain = getWakingProgress(today) * BATTERY_FULL_DAY_DRAIN * BATTERY_TIME_DRAIN_SHARE;
    const dayDrain = activityDrain + timeDrain;

    // --- 4. Stress: load and recovery during the day (Oura data) ---
    const stressDrain = health.stress_high_minutes != null && health.stress_high_minutes > 0
      ? Math.min(BATTERY_MAX_STRESS_DRAIN, health.stress_high_minutes / 10)
      : 0;
    const stressRecovery = health.stress_recovery_minutes != null && health.stress_recovery_minutes > 0
      ? Math.min(BATTERY_MAX_STRESS_RECOVERY, health.stress_recovery_minutes / 20)
      : 0;

    const battery = Math.round(
      clamp(nightCharge - debtPenalty - dayDrain - stressDrain + stressRecovery, 0, 100)
    );

    // The label thresholds. The recommendation below uses THE SAME thresholds - otherwise the
    // card could show the "Niska" label next to the sentence "Bateria w normie" (at values just
    // below the boundary), which reads like two contradictory diagnoses.
    const BATTERY_LABEL_BANDS = [
      { min: 75, label: 'Naładowana' },
      { min: 50, label: 'Dobra' },
      { min: 30, label: 'Niska' },
      { min: 0, label: 'Na rezerwie' }
    ];
    const label = BATTERY_LABEL_BANDS.find(b => battery >= b.min).label;

    // One concrete recommendation instead of a bare description of the state. The order of the
    // conditions is the order of importance: first whatever pulls the battery down hardest.
    let recommendation;
    if (debtPenalty >= BATTERY_MAX_DEBT_PENALTY * 0.6) {
      recommendation = `Dług snu z ostatnich ${BATTERY_SLEEP_DEBT_DAYS} dni to ok. ${sleepDebtHours.toFixed(1)} h. Dziś połóż się o godzinę wcześniej niż zwykle.`;
    } else if (boundedStrainRatio >= 1.6) {
      recommendation = 'Obciążenie wyraźnie powyżej Twojej normy. Zaplanuj lżejszy wieczór i nie dokładaj treningu.';
    } else if (battery < 30) {
      recommendation = 'Bateria na rezerwie. Dziś priorytetem jest sen i jedzenie w okolicach celu, nie trening.';
    } else if (battery < 50) {
      recommendation = 'Bateria niska. Zejdź z intensywności i pilnuj wcześniejszego wieczoru.';
    } else if (battery >= 75 && boundedStrainRatio <= 1) {
      recommendation = 'Zapas energii jest wysoki, a obciążenie poniżej normy - dobry dzień na mocniejszy trening.';
    } else {
      recommendation = 'Bateria w normie. Trzymaj zwykły plan dnia.';
    }

    res.json({
      hasEnoughData: true,
      date: today,
      battery,
      label,
      recommendation,
      components: {
        nightCharge: Math.round(nightCharge),
        debtPenalty: Math.round(debtPenalty * 10) / 10,
        dayDrain: Math.round(dayDrain * 10) / 10,
        activityDrain: Math.round(activityDrain * 10) / 10,
        timeDrain: Math.round(timeDrain * 10) / 10,
        stressDrain: Math.round(stressDrain * 10) / 10,
        stressRecovery: Math.round(stressRecovery * 10) / 10
      },
      sleepDebt: {
        hours: Math.round(sleepDebtHours * 10) / 10,
        nights: debtRows.length,
        windowDays: BATTERY_SLEEP_DEBT_DAYS,
        targetSleepHours: targetSleep
      },
      strain: {
        metric: strainMetric || null,
        today: strainMetric ? health[strainMetric] : null,
        baselineMedian: strainBaseline != null ? Math.round(strainBaseline) : null,
        ratioToBaseline: strainMetric ? Math.round(boundedStrainRatio * 100) / 100 : null
      },
      // The client draws an "as of now" indicator, so it has to know that for a historical day
      // the value is the end of that day rather than the current state.
      isLive: today === getLocalDateString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania baterii energii.' });
  }
});

const EXPLANATION_BASELINE_DAYS = 28;
const MIN_BASELINE_DAYS_FOR_EXPLANATION = 14;
// The "significant" deviation threshold, expressed in the user's own standard deviations (as
// in rhr-drift-insight/spo2-trend-insight) - 1 stdDev is a moderate but real signal, not
// day-to-day noise.
const EXPLANATION_ZSCORE_THRESHOLD = 1.0;
const EXPLANATION_CACHE_FRESH_MS = 30 * 60 * 1000;

// The metrics analysed for the largest daily deviation from the user's own baseline.
// higherIsWorse: true for rhr (an elevated resting heart rate = worse), false for the rest (a
// lower sleep/readiness/HRV than usual = worse).
const EXPLANATION_METRICS = [
  { key: 'sleep_score', label: 'jakość snu', higherIsWorse: false },
  { key: 'readiness_score', label: 'gotowość/regeneracja', higherIsWorse: false },
  { key: 'hrv', label: 'HRV', higherIsWorse: false },
  { key: 'rhr', label: 'tętno spoczynkowe', higherIsWorse: true }
];

// Gathers the MINIMAL, already collected context (today's and yesterday's nutrition,
// hydration, activity, workouts, supplements) needed to explain ONE specific deviation -
// deliberately a much smaller scope than the full ai_advice prompt in /api/dashboard, so that
// the Gemini request is short, fast and cheap.
async function buildExplanationContext(userId, today) {
  const yesterday = shiftDate(today, -1);

  const [todayNutrition, yesterdayNutrition, todayHealth, todayWorkouts, supplementsRow] = await Promise.all([
    db.get(
      `SELECT SUM(calories) AS calories, SUM(sodium) AS sodium, SUM(sugar) AS sugar, SUM(fiber) AS fiber, MAX(timestamp) AS last_meal_timestamp
       FROM meals WHERE user_id = ? AND date = ?`,
      [userId, today]
    ),
    db.get(
      `SELECT SUM(calories) AS calories, SUM(sodium) AS sodium, SUM(sugar) AS sugar, SUM(fiber) AS fiber
       FROM meals WHERE user_id = ? AND date = ?`,
      [userId, yesterday]
    ),
    db.get(
      `SELECT steps, active_calories, sedentary_minutes, water_ml FROM health_metrics WHERE user_id = ? AND date = ?`,
      [userId, today]
    ),
    db.all(
      `SELECT workout_type, duration_minutes FROM apple_health_workouts WHERE user_id = ? AND date IN (?, ?)`,
      [userId, today, yesterday]
    ),
    db.get(`SELECT supplements FROM health_metrics WHERE user_id = ? AND date = ?`, [userId, today])
  ]);

  const lastMealHour = todayNutrition && todayNutrition.last_meal_timestamp
    ? new Date(todayNutrition.last_meal_timestamp).getUTCHours() // B-S3: UTC to avoid a timezone error
    : null;

  return {
    todayNutrition: todayNutrition || null,
    yesterdayNutrition: yesterdayNutrition || null,
    lastMealHour,
    steps: todayHealth ? todayHealth.steps : null,
    activeCalories: todayHealth ? todayHealth.active_calories : null,
    sedentaryMinutes: todayHealth ? todayHealth.sedentary_minutes : null,
    waterMl: todayHealth ? todayHealth.water_ml : null,
    workouts: todayWorkouts || [],
    supplements: supplementsRow ? supplementsRow.supplements : null
  };
}

// A short, focused prompt - in the style of Oura Advisor / Whoop Coach ("your sleep dropped
// because...") - it ties a SPECIFIC metric to a SPECIFIC day, not to generic advice.
function buildExplanationPrompt(finding, context, language) {
  let label = finding.label;
  if (language === 'en') {
    if (finding.metric === 'sleep_score') label = 'sleep quality';
    else if (finding.metric === 'readiness_score') label = 'readiness/recovery';
    else if (finding.metric === 'hrv') label = 'HRV';
    else if (finding.metric === 'rhr') label = 'resting heart rate';
    
    return `You are a health analyst. Today's value for the metric "${label}" is significantly worse than the user's own 28-day baseline (deviation of ${finding.z.toFixed(1)} standard deviations, mean for the last 28 days: ${finding.mean}, today: ${finding.todayValue}).

Available data from the last 24 hours (may or may not explain this deviation - ONLY use what actually points to the cause, do not guess):
- Nutrition today: ${JSON.stringify(context.todayNutrition)}
- Nutrition yesterday: ${JSON.stringify(context.yesterdayNutrition)}
- Hour of last meal: ${context.lastMealHour !== null ? context.lastMealHour + ':00' : 'no data'}
- Steps today: ${context.steps ?? 'no data'}, active calories: ${context.activeCalories ?? 'no data'}, sedentary minutes: ${context.sedentaryMinutes ?? 'no data'}
- Water today: ${context.waterMl ?? 'no data'} ml
- Workouts (today/yesterday): ${JSON.stringify(context.workouts)}
- Supplements today: ${context.supplements || 'no data'}

Write ONE to TWO concise sentences in English directly to the user, in the style "Your [metric] [dropped/increased] because [specific cause from data above]". If the data does not clearly point to a cause, write it openly (e.g., "Your [X] is lower than usual - today's data doesn't point to a clear cause, you might want to focus on recovery"). No headers, no lists, no generalities like "take care of your health".`;
  }

  return `Jesteś analitykiem zdrowia. Dzisiejsza wartość metryki "${finding.label}" jest znacząco gorsza niż własny 28-dniowy wzorzec użytkownika (odchylenie ${finding.z.toFixed(1)} odchylenia standardowego, średnia z ostatnich 28 dni: ${finding.mean}, dziś: ${finding.todayValue}).

Dostępne dane z ostatniej doby (mogą, ale nie muszą wyjaśniać to odchylenie - użyj TYLKO tego, co faktycznie wskazuje na przyczynę, nie zgaduj na siłę):
- Odżywianie dziś: ${JSON.stringify(context.todayNutrition)}
- Odżywianie wczoraj: ${JSON.stringify(context.yesterdayNutrition)}
- Godzina ostatniego posiłku: ${context.lastMealHour !== null ? context.lastMealHour + ':00' : 'brak danych'}
- Kroki dziś: ${context.steps ?? 'brak danych'}, kalorie aktywne: ${context.activeCalories ?? 'brak danych'}, minuty siedzące: ${context.sedentaryMinutes ?? 'brak danych'}
- Woda dziś: ${context.waterMl ?? 'brak danych'} ml
- Treningi (dziś/wczoraj): ${JSON.stringify(context.workouts)}
- Suplementy dziś: ${context.supplements || 'brak danych'}

Napisz JEDNO do DWÓCH zwięzłych zdań po polsku, bezpośrednio do użytkownika, w stylu "Twoja/Twój [metryka] [spadła/wzrosła], bo [konkretna przyczyna z danych powyżej]". Jeśli dane NIE wskazują jednoznacznie na przyczynę, napisz to otwarcie (np. "Twój [X] jest niższy niż zwykle - dane z dzisiaj nie wskazują jednoznacznej przyczyny, warto zwrócić uwagę na regenerację"). Bez nagłówków, bez list, bez ogólników typu "dbaj o zdrowie".`;
}

// Insight (Runda 11, na bazie researchu konkurencji - styl Oura Advisor/Whoop Coach):
// detects TODAY's LARGEST sleep/readiness/HRV/RHR deviation from the user's own 28-day
// baseline (a z-score, as in rhr-drift-insight/spo2-trend-insight) and asks the AI for ONE
// concrete, short explanation of the CAUSE from the data already collected
// (nutrition/hydration/activity/workouts/supplements) - an extension of the existing AI
// mechanism (ai_advice), but with a separate, much smaller prompt and cache (see the migration
// ai_explanation/ai_explanation_generated_at w db.js).
router.get('/api/dashboard/ai-explanation-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -EXPLANATION_BASELINE_DAYS);

    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, today]);
    if (!health) {
      return res.json({ hasEnoughData: false, reason: 'no_data_for_date' });
    }

    const baselineRows = await db.all(
      `SELECT sleep_score, readiness_score, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, baselineStart, today]
    );

    let bestFinding = null;
    for (const metric of EXPLANATION_METRICS) {
      const todayValue = health[metric.key];
      if (todayValue == null || todayValue <= 0) continue;
      const baselineValues = baselineRows.map(r => r[metric.key]).filter(v => v != null && v > 0);
      if (baselineValues.length < MIN_BASELINE_DAYS_FOR_EXPLANATION) continue;
      const { mean, stdDev } = meanAndStdDev(baselineValues);
      if (stdDev <= 0) continue;
      const rawZ = (todayValue - mean) / stdDev;
      // a positive z ALWAYS means "worse than usual", whichever direction the metric runs in
      const z = metric.higherIsWorse ? rawZ : -rawZ;
      if (z >= EXPLANATION_ZSCORE_THRESHOLD && (!bestFinding || z > bestFinding.z)) {
        bestFinding = {
          metric: metric.key,
          label: metric.label,
          z,
          todayValue,
          mean: Math.round(mean * 10) / 10
        };
      }
    }

    if (!bestFinding) {
      return res.json({ hasEnoughData: true, hasFinding: false });
    }

    // Cached per (user, date) in health_metrics - for PAST days the data is immutable, so an
    // explanation generated once is fresh forever; for TODAY we refresh every 30 min (like
    // ai_advice), because new data can arrive during the day.
    const isPastDay = today < getLocalDateString();
    const generatedAtMs = health.ai_explanation_generated_at ? new Date(health.ai_explanation_generated_at).getTime() : 0;
    const isFresh = isPastDay
      ? !!health.ai_explanation
      : (!!health.ai_explanation && Date.now() - generatedAtMs < EXPLANATION_CACHE_FRESH_MS);

    if (!isFresh) {
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));
      const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
      const language = langRow ? langRow.value : 'pl';

      const explanationLockKey = `${req.user.id}:${today}`;
      if (canUseAI && !pendingExplanationGeneration.has(explanationLockKey)) {
        pendingExplanationGeneration.add(explanationLockKey);

        buildExplanationContext(req.user.id, today)
          .then(context => generateContentWithFallback(buildExplanationPrompt(bestFinding, context, language), false, null, userApiKey, forceCustomKeyOnly))
          .then(async (text) => {
            const trimmed = text.trim();
            const nowStr = new Date().toISOString();
            await db.run(`
              INSERT INTO health_metrics (user_id, date, ai_explanation, ai_explanation_generated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET
                ai_explanation = excluded.ai_explanation,
                ai_explanation_generated_at = excluded.ai_explanation_generated_at
            `, [req.user.id, today, trimmed, nowStr]);
          })
          .catch((aiErr) => {
            console.error('[API ERROR] Failed to generate the AI explanation (in the background):', aiErr);
          })
          .finally(() => {
            pendingExplanationGeneration.delete(explanationLockKey);
          });
      }
    }

    res.json({
      hasEnoughData: true,
      hasFinding: true,
      metric: bestFinding.metric,
      label: bestFinding.label,
      zScore: Math.round(bestFinding.z * 100) / 100,
      explanation: health.ai_explanation || null,
      generating: !isFresh
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania wyjaśnienia AI.' });
  }
});

const SELF_BENCHMARK_LOOKBACK_DAYS = 90;
const MIN_SELF_BENCHMARK_DAYS = 14;

// The metrics compared as "you today vs you in the past" - EXCLUSIVELY the user's own history
// (90 days), with no comparison whatsoever against other users (unlike Whoop's "people like
// you"). higherIsBetter controls the direction of the percentile.
const SELF_BENCHMARK_METRICS = [
  { key: 'sleep_score', label: 'Sen', source: 'health', higherIsBetter: true, unit: 'pkt' },
  { key: 'readiness_score', label: 'Gotowość', source: 'health', higherIsBetter: true, unit: 'pkt' },
  { key: 'hrv', label: 'HRV', source: 'health', higherIsBetter: true, unit: 'ms' },
  { key: 'rhr', label: 'Tętno spoczynkowe', source: 'health', higherIsBetter: false, unit: 'bpm' },
  { key: 'steps', label: 'Kroki', source: 'health', higherIsBetter: true, unit: 'kroków' },
  { key: 'active_calories', label: 'Kalorie aktywne', source: 'health', higherIsBetter: true, unit: 'kcal' }
];

// The percentile of "value" against an array of historical values (the % of historical days
// that value exceeds or matches) - a simple, readable measure of "how many days were worse",
// with no assumption of a normal distribution (unlike the z-score used in the other insights) -
// the goal here is precisely the intuitive "better than X% of days".
function percentileRank(value, historicalValues) {
  if (historicalValues.length === 0) return null;
  const countAtOrBelow = historicalValues.filter(v => v <= value).length;
  return Math.round((countAtOrBelow / historicalValues.length) * 100);
}

// Insight (Runda 11, na bazie researchu konkurencji - prywatna wersja Whoop "people
// like you", but WITHOUT any comparison between people): for each available metric it computes
// the percentile of today's value against the user's own last 90 days, and then picks the most
// DISTINCTIVE day (the highest and the lowest percentile) as the day's "best" and "weakest"
// signal.
router.get('/api/dashboard/self-benchmark-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SELF_BENCHMARK_LOOKBACK_DAYS);

    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, today]);
    const mealRow = await db.get(`SELECT SUM(calories) AS calories FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, today]);

    // Round 12 (audit): previously a missing health/meal entry for TODAY ended in the same
    // reason: 'not_enough_days' as a genuine lack of sufficient history - misleading, because
    // those are two different problems (as ai-explanation-insight already distinguishes via
    // no_data_for_date). We distinguish them here in the same way.
    if (!health && (!mealRow || mealRow.calories == null)) {
      return res.json({ hasEnoughData: false, reason: 'no_data_for_date' });
    }

    const rawHistoryRows = await db.all(
      `SELECT date, sleep_score, readiness_score, hrv, rhr, steps, active_calories FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, startDate, today]
    );
    // Day tag: illness days are excluded from the "you in the past" baseline - a sick day is
    // not representative of normal form and would falsely lower or raise the percentile of
    // today's value depending on the metric.
    const benchmarkIllnessExcluded = await getExcludedDates(req.user.id, ['illness'], startDate, today);
    const historyRows = rawHistoryRows.filter(r => !benchmarkIllnessExcluded.has(r.date));

    const todayValues = { ...(health || {}) };
    if (mealRow && mealRow.calories != null) todayValues.calories = mealRow.calories;

    const results = [];
    for (const metric of SELF_BENCHMARK_METRICS) {
      const todayValue = todayValues[metric.key];
      if (todayValue == null || todayValue <= 0) continue;
      const historicalValues = historyRows.map(r => r[metric.key]).filter(v => v != null && v > 0);
      if (historicalValues.length < MIN_SELF_BENCHMARK_DAYS) continue;

      const rawPercentile = percentileRank(todayValue, historicalValues);
      // For metrics where LOWER is better (RHR, for instance) we invert the percentile, so
      // that "100" always means "one of your best days", whatever the metric.
      const percentile = metric.higherIsBetter ? rawPercentile : 100 - rawPercentile;

      results.push({
        metric: metric.key,
        label: metric.label,
        // Round 12 (audit): we also return todayValue/unit/higherIsBetter (not just the
        // normalised percentile) - this lets the frontend show the raw value and state the
        // "what is good" direction unambiguously for metrics such as RHR, where a LOWER value =
        // a better result (unlike steps, say). The percentile is already normalised in itself
        // (100 = the best day, whatever the metric's direction), but without that context a raw
        // RHR=92 with a percentile of 90 could suggest to the user that "more = better".
        todayValue,
        unit: metric.unit,
        higherIsBetter: metric.higherIsBetter,
        percentile,
        historyDays: historicalValues.length
      });
    }

    if (results.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        minDaysRequired: MIN_SELF_BENCHMARK_DAYS
      });
    }

    const best = results.reduce((a, b) => (b.percentile > a.percentile ? b : a));
    const worst = results.reduce((a, b) => (b.percentile < a.percentile ? b : a));

    res.json({
      hasEnoughData: true,
      lookbackDays: SELF_BENCHMARK_LOOKBACK_DAYS,
      metrics: results,
      best,
      worst: worst.metric !== best.metric ? worst : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania benchmarku "Ty dziś vs Ty w przeszłości".' });
  }
});

const WORKOUT_SLEEP_LOOKBACK_DAYS = 120;
const MIN_WORKOUTS_PER_TYPE_FOR_SLEEP = 3;
const MIN_REST_DAYS_FOR_SLEEP = 5;

// Runda 13, nowa funkcja 1: typ treningu (workout_type) wykonanego danego dnia vs
// the quality of THAT SAME NIGHT's sleep (sleep_score). Joined on THE SAME date - the
// convention from fiber-sleep-insight ("the day's nutrition/activity -> that night's sleep"),
// different from sleep-insight (there: sleep -> the NEXT day's nutrition). Days with no
// workout (but with a sleep_score) form the "days without a workout" baseline group for the
// per-type comparison.
router.get('/api/dashboard/workout-type-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_SLEEP_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, workout_type FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND workout_type IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepRows = await db.all(
      `SELECT date, sleep_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r.sleep_score]));

    const workoutDatesByType = new Map();
    const allWorkoutDates = new Set();
    workoutRows.forEach(w => {
      allWorkoutDates.add(w.date);
      if (!workoutDatesByType.has(w.workout_type)) workoutDatesByType.set(w.workout_type, new Set());
      workoutDatesByType.get(w.workout_type).add(w.date);
    });

    const restDaySleepScores = sleepRows
      .filter(r => !allWorkoutDates.has(r.date))
      .map(r => r.sleep_score);

    if (restDaySleepScores.length < MIN_REST_DAYS_FOR_SLEEP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_rest_days',
        restDays: restDaySleepScores.length,
        minRestDaysRequired: MIN_REST_DAYS_FOR_SLEEP
      });
    }

    const avgRestSleepScore = Math.round((restDaySleepScores.reduce((s, v) => s + v, 0) / restDaySleepScores.length) * 10) / 10;

    const types = [];
    workoutDatesByType.forEach((dates, type) => {
      const scores = [...dates].filter(d => sleepByDate.has(d)).map(d => sleepByDate.get(d));
      if (scores.length < MIN_WORKOUTS_PER_TYPE_FOR_SLEEP) return;
      const avgScore = Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10;
      types.push({
        type,
        nights: scores.length,
        avgSleepScore: avgScore,
        diffVsRestDays: Math.round((avgScore - avgRestSleepScore) * 10) / 10
      });
    });

    if (types.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_per_type',
        minWorkoutsPerTypeRequired: MIN_WORKOUTS_PER_TYPE_FOR_SLEEP,
        avgRestDaySleepScore: avgRestSleepScore,
        restDays: restDaySleepScores.length
      });
    }

    types.sort((a, b) => b.diffVsRestDays - a.diffVsRestDays);

    res.json({
      hasEnoughData: true,
      lookbackDays: WORKOUT_SLEEP_LOOKBACK_DAYS,
      restDays: restDaySleepScores.length,
      avgRestDaySleepScore: avgRestSleepScore,
      types,
      best: types[0],
      worst: (types[types.length - 1].type !== types[0].type && types[types.length - 1].diffVsRestDays !== types[0].diffVsRestDays)
        ? types[types.length - 1] : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu typ treningu-sen.' });
  }
});

const MUSCLE_PROTEIN_LOOKBACK_DAYS = 120;
const MIN_MUSCLE_MEASUREMENTS = 4;
const MIN_MUSCLE_SPAN_DAYS = 21;
const MIN_PROTEIN_DAYS_LOGGED = 14;
const MUSCLE_TREND_THRESHOLD_KG_PER_DAY = 0.005; // about 0.035 kg/week
const ADEQUATE_PROTEIN_G_PER_KG = 1.6; // a widely accepted threshold for building/maintaining muscle mass

// Round 13, new feature 2: the muscle mass trend (a linear regression, as in
// body-recomposition-insight) vs the AVERAGE daily protein intake over the same window.
// Two INDEPENDENT measures (body composition measurements and meal logging rarely coincide day
// for day) - we compare FACTS from the same period rather than computing a correlation
// point by point (as in body-recomposition-insight).
router.get('/api/dashboard/muscle-protein-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MUSCLE_PROTEIN_LOOKBACK_DAYS);

    const muscleRows = await db.all(
      `SELECT date, muscle_mass FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND muscle_mass IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const proteinRows = await db.all(
      `SELECT date, SUM(protein) AS protein FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date HAVING protein > 0`,
      [req.user.id, startDate, today]
    );
    const weightRow = await db.get(
      `SELECT weight FROM health_metrics WHERE user_id = ? AND date <= ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`,
      [req.user.id, today]
    );

    if (muscleRows.length < MIN_MUSCLE_MEASUREMENTS || proteinRows.length < MIN_PROTEIN_DAYS_LOGGED) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data',
        muscleMeasurements: muscleRows.length,
        proteinLoggedDays: proteinRows.length,
        minMuscleMeasurementsRequired: MIN_MUSCLE_MEASUREMENTS,
        minProteinDaysRequired: MIN_PROTEIN_DAYS_LOGGED
      });
    }

    const musclePoints = toRegressionPoints(muscleRows, 'muscle_mass');
    const muscleSpanDays = musclePoints[musclePoints.length - 1].x;
    if (muscleSpanDays < MIN_MUSCLE_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        muscleSpanDays: Math.round(muscleSpanDays),
        minSpanDaysRequired: MIN_MUSCLE_SPAN_DAYS
      });
    }

    const muscleSlopePerDay = linearRegressionSlope(musclePoints);
    if (muscleSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    const avgProteinGramsPerDay = Math.round((proteinRows.reduce((s, r) => s + r.protein, 0) / proteinRows.length) * 10) / 10;
    const proteinPerKg = weightRow && weightRow.weight ? Math.round((avgProteinGramsPerDay / weightRow.weight) * 100) / 100 : null;

    const muscleTrend = muscleSlopePerDay > MUSCLE_TREND_THRESHOLD_KG_PER_DAY ? 'up'
      : muscleSlopePerDay < -MUSCLE_TREND_THRESHOLD_KG_PER_DAY ? 'down' : 'flat';
    const proteinAdequate = proteinPerKg !== null ? proteinPerKg >= ADEQUATE_PROTEIN_G_PER_KG : null;

    res.json({
      hasEnoughData: true,
      muscleMeasurements: muscleRows.length,
      muscleSpanDays: Math.round(muscleSpanDays),
      muscleSlopeKgPerWeek: Math.round(muscleSlopePerDay * 7 * 1000) / 1000,
      muscleTrend,
      proteinLoggedDays: proteinRows.length,
      avgProteinGramsPerDay,
      proteinPerKgBodyweight: proteinPerKg,
      adequateProteinThresholdGPerKg: ADEQUATE_PROTEIN_G_PER_KG,
      proteinAdequate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu masa mięśniowa-białko.' });
  }
});

const TEMP_DIVERGENCE_LOOKBACK_DAYS = 90;
const MIN_TEMP_DIVERGENCE_DAYS = 10;
const TEMP_DIVERGENCE_NOISE_THRESHOLD_C = 0.15; // below this we treat the reading as measurement noise, not a real swing

// Round 13, new feature 3: the divergence between two DIRECTLY INCOMPARABLE temperature
// sources - Oura's `temperature_deviation` (already a RELATIVE deviation from Oura's own
// baseline) vs the Apple Watch `wrist_temperature` (an ABSOLUTE value in °C, Series 8+/Ultra
// only). They cannot simply be subtracted - we normalise the Apple Watch value to its own
// deviation from ITS OWN mean over the window, and then check whether the two sources AGREE on
// the DIRECTION of the swing on the same day, or diverge.
router.get('/api/dashboard/temperature-divergence-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -TEMP_DIVERGENCE_LOOKBACK_DAYS);

    const wristRows = await db.all(
      `SELECT date, wrist_temperature FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND wrist_temperature IS NOT NULL`,
      [req.user.id, startDate, today]
    );

    if (wristRows.length < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'no_wrist_temperature_data',
        wristTemperatureDays: wristRows.length,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    const baselineWrist = wristRows.reduce((s, r) => s + r.wrist_temperature, 0) / wristRows.length;

    const ouraRows = await db.all(
      `SELECT date, temperature_deviation FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND temperature_deviation IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const ouraByDate = new Map(ouraRows.map(r => [r.date, r.temperature_deviation]));

    const combined = wristRows
      .filter(r => ouraByDate.has(r.date))
      .map(r => ({
        date: r.date,
        wristDeviation: Math.round((r.wrist_temperature - baselineWrist) * 100) / 100,
        ouraDeviation: ouraByDate.get(r.date)
      }));

    if (combined.length < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_overlapping_days',
        overlappingDays: combined.length,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    const signOf = (v) => (Math.abs(v) < TEMP_DIVERGENCE_NOISE_THRESHOLD_C ? 0 : (v > 0 ? 1 : -1));
    let agreeDays = 0;
    let divergeDays = 0;
    const divergentDates = [];
    combined.forEach(r => {
      const wSign = signOf(r.wristDeviation);
      const oSign = signOf(r.ouraDeviation);
      if (wSign === 0 || oSign === 0) return; // ambiguous (noise) - not counted as agreement or divergence
      if (wSign === oSign) agreeDays++;
      else { divergeDays++; divergentDates.push(r.date); }
    });

    const decisiveDays = agreeDays + divergeDays;
    if (decisiveDays < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_decisive_days',
        decisiveDays,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    res.json({
      hasEnoughData: true,
      overlappingDays: combined.length,
      decisiveDays,
      agreeDays,
      divergeDays,
      agreementRatePercent: Math.round((agreeDays / decisiveDays) * 1000) / 10,
      baselineWristTemperatureC: Math.round(baselineWrist * 100) / 100,
      recentDivergentDates: divergentDates.slice(-5)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu rozjazdu temperatur.' });
  }
});

const PROPORTIONS_LOOKBACK_DAYS = 365;
const MIN_PROPORTIONS_MEASUREMENTS = 2;

// Round 13, new feature 4: body circumference proportions - shoulders/waist and chest/waist -
// from body_measurements (shoulders, chest, waist). A comparison of the FIRST and the LAST
// available measurement of each ratio in the window (as in body-symmetry-insight, but here we
// care about the change in the proportion over time, not left/right symmetry). The "golden
// ratio" for shoulders to waist (~1.618, the Adonis Index) is given SOLELY as a widely known
// reference point from sports physiology, not as a goal imposed on the user.
router.get('/api/dashboard/body-proportions-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -PROPORTIONS_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, shoulders, chest, waist FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND waist > 0 AND (shoulders IS NOT NULL OR chest IS NOT NULL)
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    const shoulderRows = rows.filter(r => r.shoulders != null);
    const chestRows = rows.filter(r => r.chest != null);

    if (shoulderRows.length < MIN_PROPORTIONS_MEASUREMENTS && chestRows.length < MIN_PROPORTIONS_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_measurements',
        shoulderMeasurements: shoulderRows.length,
        chestMeasurements: chestRows.length,
        minMeasurementsRequired: MIN_PROPORTIONS_MEASUREMENTS
      });
    }

    const buildRatio = (arr, key) => {
      if (arr.length < MIN_PROPORTIONS_MEASUREMENTS) return null;
      const first = arr[0];
      const last = arr[arr.length - 1];
      const firstRatio = Math.round((first[key] / first.waist) * 1000) / 1000;
      const lastRatio = Math.round((last[key] / last.waist) * 1000) / 1000;
      return {
        firstDate: first.date,
        lastDate: last.date,
        firstRatio,
        lastRatio,
        ratioDiff: Math.round((lastRatio - firstRatio) * 1000) / 1000,
        measurements: arr.length
      };
    };

    const shoulderToWaist = buildRatio(shoulderRows, 'shoulders');
    const chestToWaist = buildRatio(chestRows, 'chest');

    res.json({
      hasEnoughData: true,
      shoulderToWaist,
      chestToWaist,
      referenceGoldenRatio: 1.618
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu proporcji obwodów ciała.' });
  }
});

const ACTIVITY_APPETITE_LOOKBACK_DAYS = 90;
const MIN_DAYS_PER_ACTIVITY_GROUP = 7;

// Round 13, new feature 5: the day's activity (active_calories) vs appetite on THE SAME day
// (the calorie total from meals). Split by the median of the user's OWN activity - analogous
// to sedentary-sleep-insight/fiber-sleep-insight (a median split, not
// regresja - interesuje nas prosty kontrast "dni bardziej aktywne" vs "mniej aktywne").
router.get('/api/dashboard/activity-appetite-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -ACTIVITY_APPETITE_LOOKBACK_DAYS);

    const activityRows = await db.all(
      `SELECT date, active_calories FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND active_calories IS NOT NULL AND active_calories > 0`,
      [req.user.id, startDate, today]
    );
    const mealRows = await db.all(
      `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date HAVING calories > 0`,
      [req.user.id, startDate, today]
    );
    const caloriesByDate = new Map(mealRows.map(r => [r.date, r.calories]));

    const combined = activityRows
      .filter(r => caloriesByDate.has(r.date))
      .map(r => ({ date: r.date, activeCalories: r.active_calories, calories: caloriesByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_ACTIVITY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_ACTIVITY_GROUP * 2
      });
    }

    const medianActive = median(combined.map(r => r.activeCalories));
    const moreActive = combined.filter(r => r.activeCalories >= medianActive);
    const lessActive = combined.filter(r => r.activeCalories < medianActive);

    if (moreActive.length < MIN_DAYS_PER_ACTIVITY_GROUP || lessActive.length < MIN_DAYS_PER_ACTIVITY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreActiveDays: moreActive.length,
        lessActiveDays: lessActive.length,
        minDaysRequired: MIN_DAYS_PER_ACTIVITY_GROUP
      });
    }

    const avgOf = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgCaloriesMoreActive = avgOf(moreActive, 'calories');
    const avgCaloriesLessActive = avgOf(lessActive, 'calories');

    res.json({
      hasEnoughData: true,
      medianActiveCalories: Math.round(medianActive),
      moreActiveDays: moreActive.length,
      lessActiveDays: lessActive.length,
      avgCaloriesMoreActiveDays: avgCaloriesMoreActive,
      avgCaloriesLessActiveDays: avgCaloriesLessActive,
      caloriesDiff: Math.round((avgCaloriesMoreActive - avgCaloriesLessActive) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu aktywność-apetyt.' });
  }
});

const DIET_QUALITY_WEIGHT_LOOKBACK_DAYS = 90;
const MIN_RATED_MEALS_FOR_DIET_QUALITY = 10;
const MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY = 4;
const MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY = 21;
const WEIGHT_TREND_THRESHOLD_KG_PER_DAY = 0.01; // about 0.07 kg/week
const HIGH_DIET_QUALITY_RATING = 7;
const LOW_DIET_QUALITY_RATING = 5;

// Round 13, new feature 6: the AVERAGE meal quality (health_rating from analysis_json, as in
// meal-quality-trend-insight) as context for the rate of weight change (a linear regression,
// as in weight-goal-forecast/body-recomposition-insight) over the same window. This is NOT a
// point-by-point correlation (the diet quality of a given day cannot sensibly be paired with
// one-off weight measurements) - it is a JUXTAPOSITION of two independent facts from the same
// period, much as in body-recomposition-insight.
router.get('/api/dashboard/diet-quality-weight-pace-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -DIET_QUALITY_WEIGHT_LOOKBACK_DAYS);

    const mealRows = await db.all(
      `SELECT analysis_json FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, startDate, today]
    );
    const ratings = [];
    mealRows.forEach(r => {
      try {
        const analysis = JSON.parse(r.analysis_json);
        const rating = Number(analysis.health_rating);
        if (Number.isFinite(rating) && rating >= 1 && rating <= 10) ratings.push(rating);
      } catch (e) {
        // Brak/uszkodzony analysis_json - pomijamy (jak w meal-quality-trend-insight).
      }
    });

    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (ratings.length < MIN_RATED_MEALS_FOR_DIET_QUALITY || weightRows.length < MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data',
        ratedMeals: ratings.length,
        weightMeasurements: weightRows.length,
        minRatedMealsRequired: MIN_RATED_MEALS_FOR_DIET_QUALITY,
        minWeightMeasurementsRequired: MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY
      });
    }

    const weightPoints = toRegressionPoints(weightRows, 'weight');
    const weightSpanDays = weightPoints[weightPoints.length - 1].x;
    if (weightSpanDays < MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        weightSpanDays: Math.round(weightSpanDays),
        minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY
      });
    }

    const weightSlopePerDay = linearRegressionSlope(weightPoints);
    if (weightSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    const avgRating = Math.round((ratings.reduce((s, v) => s + v, 0) / ratings.length) * 10) / 10;
    const dietQuality = avgRating >= HIGH_DIET_QUALITY_RATING ? 'high' : avgRating <= LOW_DIET_QUALITY_RATING ? 'low' : 'medium';
    const weightTrend = weightSlopePerDay > WEIGHT_TREND_THRESHOLD_KG_PER_DAY ? 'up'
      : weightSlopePerDay < -WEIGHT_TREND_THRESHOLD_KG_PER_DAY ? 'down' : 'flat';

    res.json({
      hasEnoughData: true,
      ratedMeals: ratings.length,
      avgMealRating: avgRating,
      dietQuality,
      weightMeasurements: weightRows.length,
      weightSpanDays: Math.round(weightSpanDays),
      weightSlopeKgPerWeek: Math.round(weightSlopePerDay * 7 * 100) / 100,
      weightTrend
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu jakość diety-tempo wagi.' });
  }
});

const STREAK_WEIGHT_LOOKBACK_DAYS = 180;
const STREAK_WEIGHT_MIN_LENGTH = 3; // jak STREAK_MIN_LENGTH w streak-drift-insight
const MIN_WEIGHT_POINTS_PER_STREAK_GROUP = 5;
const MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP = 14;

// Round 13, new feature 7: whether days that are PART of a calorie-goal streak (3+ consecutive
// days within the +/-15% band, the same streak detection logic as in streak-drift-insight)
// show a DIFFERENT rate of weight change from days with NO active streak. We assign each date
// with a weight measurement a "during a streak"/"no streak" status based on the calorie logging
// history UP TO THAT DATE, and then compute an INDEPENDENT weight-over-time regression for each
// of the two groups (x = days since the start of the window, so both regressions share the same
// time scale).
router.get('/api/dashboard/streak-weight-effect-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STREAK_WEIGHT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const rawWeightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    // Day tag: holiday days are excluded from the weight measurements - weight changes away
    // from home (a different diet, travel, water retention) are not the effect of sticking to
    // the calorie goal or not, and would falsely distort the comparison of the two groups' rates.
    const streakVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const weightRows = rawWeightRows.filter(r => !streakVacationExcluded.has(r.date));

    let prevDate = null;
    let currentStreak = 0;
    const streakStatusByDate = new Map();

    calorieRows.forEach(row => {
      const inBand = row.total_calories != null &&
        row.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) &&
        row.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      const isConsecutive = prevDate !== null && shiftDate(prevDate, 1) === row.date;

      if (inBand) {
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
      } else {
        currentStreak = 0;
      }
      streakStatusByDate.set(row.date, currentStreak >= STREAK_WEIGHT_MIN_LENGTH);
      prevDate = row.date;
    });

    const baseTime = weightRows.length > 0 ? new Date(weightRows[0].date).getTime() : null;
    const msPerDay = 24 * 60 * 60 * 1000;
    const streakWeightPoints = [];
    const noStreakWeightPoints = [];

    weightRows.forEach(r => {
      const isStreakDay = streakStatusByDate.get(r.date);
      if (isStreakDay === undefined) return; // no calorie data for this date - we do not know which group to assign it to
      const point = { x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r.weight };
      (isStreakDay ? streakWeightPoints : noStreakWeightPoints).push(point);
    });

    const spanOf = (points) => (points.length > 0 ? points[points.length - 1].x - points[0].x : 0);

    if (
      streakWeightPoints.length < MIN_WEIGHT_POINTS_PER_STREAK_GROUP ||
      noStreakWeightPoints.length < MIN_WEIGHT_POINTS_PER_STREAK_GROUP ||
      spanOf(streakWeightPoints) < MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP ||
      spanOf(noStreakWeightPoints) < MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP
    ) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data_per_group',
        streakWeightPoints: streakWeightPoints.length,
        noStreakWeightPoints: noStreakWeightPoints.length,
        minPointsRequired: MIN_WEIGHT_POINTS_PER_STREAK_GROUP,
        minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP
      });
    }

    const streakSlope = linearRegressionSlope(streakWeightPoints);
    const noStreakSlope = linearRegressionSlope(noStreakWeightPoints);
    if (streakSlope === null || noStreakSlope === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    res.json({
      hasEnoughData: true,
      streakMinLength: STREAK_WEIGHT_MIN_LENGTH,
      targetCalories,
      streakWeightPoints: streakWeightPoints.length,
      noStreakWeightPoints: noStreakWeightPoints.length,
      weightSlopeKgPerWeekDuringStreak: Math.round(streakSlope * 7 * 100) / 100,
      weightSlopeKgPerWeekWithoutStreak: Math.round(noStreakSlope * 7 * 100) / 100,
      slopeDiffKgPerWeek: Math.round((streakSlope - noStreakSlope) * 7 * 100) / 100
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu passa-efekt na wadze.' });
  }
});

const SEDENTARY_PERFORMANCE_LOOKBACK_DAYS = 90;
const MIN_WORKOUTS_PER_SEDENTARY_GROUP = 4;

// Round 13, new feature 8: sitting time (sedentary_minutes, Oura) on THE SAME day vs the
// performance of the workout done that day (kcal/min, as in workout-efficiency-insight - a
// simpler and more widely available proxy for "performance" than the Z4+Z5 zone share from
// recovery-insight, because it does not require the extra zone metrics enabled in Health Auto
// Export). Split by the median of the user's OWN sitting time on training days.
router.get('/api/dashboard/sedentary-performance-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SEDENTARY_PERFORMANCE_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, COALESCE(SUM(active_calories), 0) AS active_calories, COALESCE(SUM(duration_minutes), 0) AS duration_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date HAVING duration_minutes >= 5 AND active_calories > 0`,
      [req.user.id, startDate, today]
    );
    const sedentaryRows = await db.all(
      `SELECT date, sedentary_minutes FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND sedentary_minutes IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sedentaryByDate = new Map(sedentaryRows.map(r => [r.date, r.sedentary_minutes]));

    const combined = workoutRows
      .filter(r => sedentaryByDate.has(r.date))
      .map(r => ({
        date: r.date,
        sedentaryMinutes: sedentaryByDate.get(r.date),
        kcalPerMin: r.active_calories / r.duration_minutes
      }));

    if (combined.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workout_days',
        workoutDays: combined.length,
        minWorkoutDaysRequired: MIN_WORKOUTS_PER_SEDENTARY_GROUP * 2
      });
    }

    const medianSedentary = median(combined.map(r => r.sedentaryMinutes));
    const moreSitting = combined.filter(r => r.sedentaryMinutes >= medianSedentary);
    const lessSitting = combined.filter(r => r.sedentaryMinutes < medianSedentary);

    if (moreSitting.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP || lessSitting.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workout_days_per_group',
        moreSittingWorkoutDays: moreSitting.length,
        lessSittingWorkoutDays: lessSitting.length,
        minWorkoutDaysRequired: MIN_WORKOUTS_PER_SEDENTARY_GROUP
      });
    }

    const avgOf = (arr) => Math.round((arr.reduce((s, x) => s + x.kcalPerMin, 0) / arr.length) * 10) / 10;
    const avgPerformanceMoreSitting = avgOf(moreSitting);
    const avgPerformanceLessSitting = avgOf(lessSitting);

    res.json({
      hasEnoughData: true,
      medianSedentaryMinutes: Math.round(medianSedentary),
      moreSittingWorkoutDays: moreSitting.length,
      lessSittingWorkoutDays: lessSitting.length,
      avgKcalPerMinMoreSitting: avgPerformanceMoreSitting,
      avgKcalPerMinLessSitting: avgPerformanceLessSitting,
      performanceDiffKcalPerMin: Math.round((avgPerformanceMoreSitting - avgPerformanceLessSitting) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu siedzenie-wydajność treningu.' });
  }
});

// Insight: hydration and sleep quality
// Checks the correlation between the amount of water drunk (water_ml) and sleep_score.
// The same pattern as hydration-readiness-insight, but measured against sleep (not readiness),
// because readiness and sleep are different dimensions of recovery.
// Minimalna liczba dni z oboma polami: MIN_WATER_SLEEP_DAYS.
const MIN_WATER_SLEEP_DAYS = 14;
const WATER_SLEEP_LOOKBACK_DAYS = 60;

router.get('/api/dashboard/water-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WATER_SLEEP_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, water_ml, sleep_score, sleep_deep
       FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND water_ml IS NOT NULL AND water_ml > 0
         AND sleep_score IS NOT NULL AND sleep_score > 0`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_WATER_SLEEP_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_WATER_SLEEP_DAYS
      });
    }

    // Split into groups by the median hydration: well hydrated vs less well hydrated.
    const waterValues = rows.map(r => r.water_ml).sort((a, b) => a - b);
    const medianWater = waterValues[Math.floor(waterValues.length / 2)];

    const wellHydrated = rows.filter(r => r.water_ml >= medianWater);
    const lessHydrated = rows.filter(r => r.water_ml < medianWater);

    if (wellHydrated.length < 5 || lessHydrated.length < 5) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        totalDays: rows.length,
        minDaysRequired: MIN_WATER_SLEEP_DAYS
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };

    const avgSleepWell = avgOf(wellHydrated, 'sleep_score');
    const avgSleepLess = avgOf(lessHydrated, 'sleep_score');
    // sleep_deep in health_metrics is in hours (sync.js: totalDeepSec / 3600)
    // - we convert to minutes for consistency with the other sleep insights.
    const avgDeepWell = wellHydrated.filter(r => r.sleep_deep != null).length > 0
      ? Math.round(avgOf(wellHydrated, 'sleep_deep') * 60 * 10) / 10
      : null;
    const avgDeepLess = lessHydrated.filter(r => r.sleep_deep != null).length > 0
      ? Math.round(avgOf(lessHydrated, 'sleep_deep') * 60 * 10) / 10
      : null;

    res.json({
      hasEnoughData: true,
      totalDays: rows.length,
      medianWaterMl: Math.round(medianWater),
      wellHydratedDays: wellHydrated.length,
      lessHydratedDays: lessHydrated.length,
      avgWaterWell: Math.round(avgOf(wellHydrated, 'water_ml')),
      avgWaterLess: Math.round(avgOf(lessHydrated, 'water_ml')),
      avgSleepScoreWellHydrated: avgSleepWell,
      avgSleepScoreLessHydrated: avgSleepLess,
      sleepScoreDiff: avgSleepWell != null && avgSleepLess != null
        ? Math.round((avgSleepWell - avgSleepLess) * 10) / 10
        : null,
      avgSleepDeepWellHydrated: avgDeepWell,
      avgSleepDeepLessHydrated: avgDeepLess,
      sleepDeepDiff: avgDeepWell != null && avgDeepLess != null
        ? Math.round((avgDeepWell - avgDeepLess) * 10) / 10
        : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu hydratacja-sen.' });
  }
});

// ============================================================================
// Runda 23: Training Readiness + Training Plan Analysis
// Data from our own database (apple_health_workouts, health_metrics, users, settings)
// - no external APIs. The first endpoint is deterministic (no AI, no token cost, an
// immediate response). The second uses Gemini with a 7-day cache in the settings table
// (key-value), so the prompt is not sent every time the dashboard is opened.
// ============================================================================

const READINESS_LOOKBACK_HRV_RHR = 30;   // dni do baseline HRV/RHR
const READINESS_RECENT_WORKOUTS_DAYS = 3; // the "a lot of workouts recently" window

// Produces a readable training-readiness signal without AI - based on:
// 1) readiness_score from Oura (the best signal, when available)
// 2) HRV today vs the 30d average (a percentage deviation)
// 3) RHR today vs the 30d average
// 4) Oura's sleep_score
// 5) the number of workouts in the last READINESS_RECENT_WORKOUTS_DAYS days
//
// The logic: each signal votes for or against a hard workout.
// Oura's readinessScore (0-100) is a ready-made composite - when we have it, it carries 60%
// of the weight. Without it (a user with no Oura), we fall back to our own composite from
// HRV/RHR/sleep.
router.get('/api/dashboard/training-readiness', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -READINESS_LOOKBACK_HRV_RHR);

    const health = await db.get(
      `SELECT readiness_score, hrv, rhr, sleep_score, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // The HRV/RHR baseline from the last 30 days (excluding today)
    const baselineRows = await db.all(
      `SELECT hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?
         AND hrv IS NOT NULL AND hrv > 0 AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );
    const avgBaselineHrv = baselineRows.length > 0
      ? baselineRows.reduce((s, r) => s + r.hrv, 0) / baselineRows.length
      : null;
    const avgBaselineRhr = baselineRows.length > 0
      ? baselineRows.reduce((s, r) => s + r.rhr, 0) / baselineRows.length
      : null;

    // Treningi z ostatnich READINESS_RECENT_WORKOUTS_DAYS dni
    const recentWorkoutRows = await db.all(
      `SELECT date, SUM(duration_minutes) AS total_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date < ?
       GROUP BY date HAVING total_minutes >= 20`,
      [req.user.id, shiftDate(today, -READINESS_RECENT_WORKOUTS_DAYS), today]
    );
    const recentWorkoutDays = recentWorkoutRows.length;

    // Workouts from the last 7 days (the weekly load)
    const weekWorkoutRows = await db.all(
      `SELECT COUNT(DISTINCT date) AS cnt FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, shiftDate(today, -7), today]
    );
    const weekWorkoutDays = weekWorkoutRows[0]?.cnt || 0;

    // Budujemy composite score 0-100:
    // Base: if we have Oura's readiness_score -> weight 60%; the rest 40%.
    // Without Oura: HRV 40%, RHR 30%, sleep 30%.
    const signals = [];
    let compositeScore = 50; // neutral start

    if (health?.readiness_score != null && health.readiness_score > 0) {
      // Oura readiness: 0-100, mapped directly as 60% of the weight
      compositeScore = health.readiness_score * 0.6 + 20; // a 0-80 scale -> 20-80 after the shift
      signals.push({
        label: 'Gotowość Oura',
        value: health.readiness_score,
        unit: 'pkt',
        status: health.readiness_score >= 70 ? 'good' : health.readiness_score >= 50 ? 'ok' : 'low'
      });
    }

    // HRV vs baseline
    if (health?.hrv != null && health.hrv > 0 && avgBaselineHrv != null) {
      const hrvPct = (health.hrv / avgBaselineHrv - 1) * 100;
      const hrvScore = health.readiness_score != null
        ? hrvPct * 0.2  // a smaller weight when we have Oura
        : hrvPct * 0.4;
      compositeScore += hrvScore;
      signals.push({
        label: 'HRV dziś',
        value: Math.round(health.hrv),
        unit: 'ms',
        baseline: Math.round(avgBaselineHrv),
        diff: Math.round(hrvPct),
        status: hrvPct >= 5 ? 'good' : hrvPct >= -5 ? 'ok' : 'low'
      });
    }

    // RHR vs baseline
    if (health?.rhr != null && health.rhr > 0 && avgBaselineRhr != null) {
      const rhrPct = (avgBaselineRhr / health.rhr - 1) * 100; // a higher RHR = worse -> we invert it
      const rhrScore = health.readiness_score != null
        ? rhrPct * 0.1
        : rhrPct * 0.3;
      compositeScore += rhrScore;
      signals.push({
        label: 'Tętno spoczynkowe',
        value: Math.round(health.rhr),
        unit: 'bpm',
        baseline: Math.round(avgBaselineRhr),
        diff: Math.round((health.rhr - avgBaselineRhr) * 10) / 10,
        status: health.rhr <= avgBaselineRhr + 2 ? 'good' : health.rhr <= avgBaselineRhr + 5 ? 'ok' : 'low'
      });
    }

    // Sen
    if (health?.sleep_score != null && health.sleep_score > 0) {
      const sleepScore = health.readiness_score != null ? 0 : (health.sleep_score - 50) * 0.3;
      compositeScore += sleepScore;
      signals.push({
        label: 'Jakość snu',
        value: health.sleep_score,
        unit: 'pkt',
        status: health.sleep_score >= 75 ? 'good' : health.sleep_score >= 60 ? 'ok' : 'low'
      });
    }

    // A penalty for workout overload over the last 3 days
    const overloadPenalty = Math.min(recentWorkoutDays * 8, 20);
    compositeScore -= overloadPenalty;
    if (recentWorkoutDays >= 2) {
      signals.push({
        label: `Treningi (ostatnie ${READINESS_RECENT_WORKOUTS_DAYS} dni)`,
        value: recentWorkoutDays,
        unit: 'dni',
        status: recentWorkoutDays >= 3 ? 'low' : recentWorkoutDays >= 2 ? 'ok' : 'good'
      });
    }

    compositeScore = Math.max(0, Math.min(100, compositeScore));

    let status, label, emoji, advice;
    if (compositeScore >= 67) {
      status = 'TRAIN_HARD';
      label = 'Trenuj mocno';
      emoji = '🟢';
      advice = 'Twoje sygnały wskazują na dobrą gotowość. Dobry dzień na intensywny trening.';
    } else if (compositeScore >= 34) {
      status = 'TRAIN_LIGHT';
      label = 'Lekki trening';
      emoji = '🟡';
      advice = 'Umiarkowana gotowość. Sprawdzi się lżejszy trening lub technika zamiast maksymalnego wysiłku.';
    } else {
      status = 'RECOVER';
      label = 'Odpoczynek';
      emoji = '🔴';
      advice = 'Niskie sygnały regeneracji. Rozważ dzień odpoczynku lub aktywną regenerację (spacer, stretching).';
    }

    const hasSignificantData = health != null && (
      health.readiness_score != null || health.hrv != null || health.sleep_score != null
    );

    res.json({
      hasEnoughData: hasSignificantData,
      status,
      label,
      emoji,
      compositeScore: Math.round(compositeScore),
      advice,
      signals,
      weekWorkoutDays,
      recentWorkoutDays
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania gotowości do treningu.' });
  }
});

const TRAINING_PLAN_LOOKBACK_WEEKS = 4;
const TRAINING_PLAN_CACHE_DAYS = 7;

// Normalises overallRating to a number in 1-10 - old cached values may hold a string
// ("good"/"needs_improvement"/"poor") from a previous version of the prompt.
function sanitizeTrainingRating(obj) {
  if (!obj || obj.overallRating == null) return obj;
  const stringMap = { good: 8, needs_improvement: 5, poor: 2 };
  if (typeof obj.overallRating === 'string') {
    obj.overallRating = stringMap[obj.overallRating] ?? 5;
  } else {
    const n = Math.round(Number(obj.overallRating));
    obj.overallRating = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : null;
  }
  return obj;
}

// AI training plan analysis - it assesses whether the user's workout history fits their body
// goal and suggests what to add. Cached for 7 days in settings (the keys
// training_plan_insight_json / training_plan_insight_at), forced refresh: ?refresh=1.
//
// Input for the AI: 4 weeks of workouts (type/duration), the body goal (body_goal_text,
// target_weight_kg, target_body_fat_pct), recovery signals (HRV, RHR, readiness - a 7d
// average), the current body composition (weight, body fat %, muscle mass). The response:
// JSON with a rating, the missing elements and suggestions.
router.get('/api/dashboard/training-plan-insight', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';

    // Cache z settings
    const cachedJsonRow = await db.get(
      `SELECT value FROM settings WHERE user_id = ? AND key = 'training_plan_insight_json'`,
      [req.user.id]
    );
    const cachedAtRow = await db.get(
      `SELECT value FROM settings WHERE user_id = ? AND key = 'training_plan_insight_at'`,
      [req.user.id]
    );

    const cachedAt = cachedAtRow ? new Date(cachedAtRow.value).getTime() : 0;
    const cacheAgeDays = (Date.now() - cachedAt) / (1000 * 60 * 60 * 24);
    const isCacheFresh = !!cachedJsonRow && cacheAgeDays < TRAINING_PLAN_CACHE_DAYS;

    if (isCacheFresh && !forceRefresh) {
      let parsed;
      try { parsed = JSON.parse(cachedJsonRow.value); } catch (e) { parsed = null; }
      if (parsed) {
        // Sanitising overallRating - an old cache may hold a string ("good"/"needs_improvement"/"poor")
        parsed = sanitizeTrainingRating(parsed);
        return res.json({ hasEnoughData: true, cached: true, generatedAt: cachedAtRow.value, ...parsed });
      }
    }

    // Collecting the data
    const today = resolveQueryDate(req);
    const lookbackStart = shiftDate(today, -(TRAINING_PLAN_LOOKBACK_WEEKS * 7));

    // Treningi z ostatnich 4 tygodni
    const workoutRows = await db.all(
      `SELECT date, workout_type, duration_minutes, active_calories
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
       ORDER BY date DESC`,
      [req.user.id, lookbackStart, today]
    );

    // Agregat per typ treningu
    const byType = {};
    workoutRows.forEach(w => {
      const t = (w.workout_type || 'Nieznany').trim();
      if (!byType[t]) byType[t] = { count: 0, totalMinutes: 0, totalCalories: 0 };
      byType[t].count++;
      byType[t].totalMinutes += w.duration_minutes || 0;
      byType[t].totalCalories += w.active_calories || 0;
    });

    // The body goal and body data
    const userRow = await db.get(
      `SELECT body_goal_text FROM users WHERE id = ?`,
      [req.user.id]
    );
    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
    const targetBodyFatPct = settings.target_body_fat_pct ? parseFloat(settings.target_body_fat_pct) : null;
    const targetWeightKg = settings.target_weight_kg ? parseFloat(settings.target_weight_kg) : null;

    // The current body composition (the latest measurement)
    const latestBody = await db.get(
      `SELECT weight, fat_ratio, muscle_mass FROM health_metrics
       WHERE user_id = ? AND date <= ? AND (weight IS NOT NULL OR fat_ratio IS NOT NULL)
       ORDER BY date DESC LIMIT 1`,
      [req.user.id, today]
    );

    // 7d average regeneracji
    const recoveryRows = await db.all(
      `SELECT hrv, rhr, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND (hrv IS NOT NULL OR rhr IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, shiftDate(today, -7), today]
    );
    const avgOf7d = (key) => {
      const vals = recoveryRows.map(r => r[key]).filter(v => v != null && v > 0);
      return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null;
    };
    const avg7dHrv = avgOf7d('hrv');
    const avg7dRhr = avgOf7d('rhr');
    const avg7dReadiness = avgOf7d('readiness_score');

    // Checking access to the AI
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
    const forceCustomKeyOnly = req.user.role !== 'admin';
    const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));
    const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
    const language = langRow ? langRow.value : 'pl';

    if (!canUseAI) {
      return res.json({ hasEnoughData: false, reason: 'no_ai_key' });
    }

    // Building the workout description for the prompt
    const workoutSummaryLines = Object.entries(byType).map(([type, stats]) => {
      const avgMin = stats.count > 0 ? Math.round(stats.totalMinutes / stats.count) : 0;
      if (language === 'en') {
        return `- ${type}: ${stats.count}x, avg ${avgMin} min/session${stats.totalCalories > 0 ? `, total ~${stats.totalCalories} kcal` : ''}`;
      }
      return `- ${type}: ${stats.count}x, śr. ${avgMin} min/sesja${stats.totalCalories > 0 ? `, łącznie ~${stats.totalCalories} kcal` : ''}`;
    });
    const totalWorkouts = workoutRows.length;
    const avgPerWeek = Math.round(totalWorkouts / TRAINING_PLAN_LOOKBACK_WEEKS * 10) / 10;

    const bodyLines = [];
    if (latestBody?.weight) bodyLines.push(language === 'en' ? `Weight: ${latestBody.weight} kg` : `Waga: ${latestBody.weight} kg`);
    if (latestBody?.fat_ratio) bodyLines.push(language === 'en' ? `Body fat: ${Math.round(latestBody.fat_ratio * 10) / 10}%` : `Tkanka tłuszczowa: ${Math.round(latestBody.fat_ratio * 10) / 10}%`);
    if (latestBody?.muscle_mass) bodyLines.push(language === 'en' ? `Muscle mass: ${Math.round(latestBody.muscle_mass * 10) / 10} kg` : `Masa mięśniowa: ${Math.round(latestBody.muscle_mass * 10) / 10} kg`);

    const goalLines = [];
    if (userRow?.body_goal_text) goalLines.push(language === 'en' ? `Body goal: ${userRow.body_goal_text}` : `Cel sylwetki: ${userRow.body_goal_text}`);
    if (targetWeightKg) goalLines.push(language === 'en' ? `Weight target: ${targetWeightKg} kg` : `Cel wagowy: ${targetWeightKg} kg`);
    if (targetBodyFatPct) goalLines.push(language === 'en' ? `Target % body fat: ${targetBodyFatPct}%` : `Docelowy % tkanki tłuszczowej: ${targetBodyFatPct}%`);

    const recoveryLines = [];
    if (avg7dReadiness != null) recoveryLines.push(language === 'en' ? `Oura Readiness (7d avg): ${avg7dReadiness} pts` : `Gotowość Oura (7d śr.): ${avg7dReadiness} pkt`);
    if (avg7dHrv != null) recoveryLines.push(language === 'en' ? `HRV (7d avg): ${avg7dHrv} ms` : `HRV (7d śr.): ${avg7dHrv} ms`);
    if (avg7dRhr != null) recoveryLines.push(language === 'en' ? `Resting HR (7d avg): ${avg7dRhr} bpm` : `Tętno spoczynkowe (7d śr.): ${avg7dRhr} bpm`);

    let prompt = '';
    if (language === 'en') {
      prompt = `You are an experienced personal trainer specializing in body recomposition and fat loss. Analyze the following data and evaluate the user's training plan.

=== GOAL ===
${goalLines.length > 0 ? goalLines.join('\n') : 'No goal data'}

=== BODY COMPOSITION ===
${bodyLines.length > 0 ? bodyLines.join('\n') : 'No data'}

=== WORKOUTS (last ${TRAINING_PLAN_LOOKBACK_WEEKS} weeks) ===
Total: ${totalWorkouts} workouts (avg ${avgPerWeek}/week)
${workoutSummaryLines.length > 0 ? workoutSummaryLines.join('\n') : '- No workouts in this period'}

=== RECOVERY SIGNALS ===
${recoveryLines.length > 0 ? recoveryLines.join('\n') : 'No recovery data'}

Respond EXCLUSIVELY in JSON format (no markdown, no explanation outside JSON):
{
  "assessment": "Short assessment of the current plan (1-2 sentences in English)",
  "missing": ["Element1 that is missing", "Element2"],
  "suggestions": [
    {"title": "Suggestion Title", "description": "Specific description of what to do and why (in English)"},
    {"title": "Title", "description": "Description"}
  ],
  "overallRating": 7
}

overallRating is an integer from 1 to 10 (1=very bad plan, 10=ideal). DO NOT use strings like "good" - only a number.
Be specific and practical. Max 3 suggestions. Respond only in English.`;
    } else {
      prompt = `Jesteś doświadczonym trenerem personalnym specjalizującym się w rekomozycji ciała i redukcji tkanki tłuszczowej. Przeanalizuj poniższe dane i oceń plan treningowy użytkownika.

=== CEL ===
${goalLines.length > 0 ? goalLines.join('\n') : 'Brak danych o celu'}

=== SKŁAD CIAŁA ===
${bodyLines.length > 0 ? bodyLines.join('\n') : 'Brak danych'}

=== TRENINGI (ostatnie ${TRAINING_PLAN_LOOKBACK_WEEKS} tygodnie) ===
Łącznie: ${totalWorkouts} treningów (śr. ${avgPerWeek}/tydzień)
${workoutSummaryLines.length > 0 ? workoutSummaryLines.join('\n') : '- Brak treningów w tym okresie'}

=== SYGNAŁY REGENERACJI ===
${recoveryLines.length > 0 ? recoveryLines.join('\n') : 'Brak danych regeneracji'}

Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown, bez objaśnień poza JSON):
{
  "assessment": "Krótka ocena obecnego planu (1-2 zdania po polsku)",
  "missing": ["Element1 którego brakuje", "Element2"],
  "suggestions": [
    {"title": "Tytuł sugestii", "description": "Konkretny opis co zrobić i dlaczego (po polsku)"},
    {"title": "Tytuł", "description": "Opis"}
  ],
  "overallRating": 7
}

overallRating to liczba całkowita od 1 do 10 (1=bardzo zły plan, 10=idealny). NIE używaj stringów jak "good" - tylko liczba.
Bądź konkretny i praktyczny. Maks. 3 sugestie. Odpowiadaj tylko po polsku.`;
    }

    let insightJson = null;
    try {
      const rawText = await generateContentWithFallback(prompt, false, null, userApiKey, forceCustomKeyOnly);
      // Extract the JSON from the response (the AI may add markdown ```json ... ```)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        insightJson = JSON.parse(jsonMatch[0]);
      }
    } catch (aiErr) {
      console.error('[TRAINING PLAN] Gemini error:', aiErr);
      return res.status(500).json({ error: 'Błąd generowania analizy AI.' });
    }

    if (!insightJson) {
      return res.status(500).json({ error: 'Nieprawidłowa odpowiedź AI.' });
    }

    // Normalising overallRating (the AI may return a string despite the instruction)
    insightJson = sanitizeTrainingRating(insightJson);

    // Zapisz cache
    const nowStr = new Date().toISOString();
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'training_plan_insight_json', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [req.user.id, JSON.stringify(insightJson)]
    );
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'training_plan_insight_at', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [req.user.id, nowStr]
    );

    res.json({
      hasEnoughData: true,
      cached: false,
      generatedAt: nowStr,
      ...insightJson
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania analizy planu treningowego.' });
  }
});

// =============================================================================
// INSIGHTY TRENINGOWE (Runda 25): Oura + Apple Watch cross-device analytics
// =============================================================================

// The "good sleep" threshold - the same as in sleep-insight, kept locally here.
const SLEEP_SCORE_GOOD_THRESHOLD = 75;
// The "poor sleep" threshold (for grouping: poor vs good)
const SLEEP_SCORE_POOR_THRESHOLD = 65;
// The minimum number of days in each group
const WORKOUT_INSIGHT_MIN_DAYS = 5;
// The lookback for the workout insights (days)
const WORKOUT_INSIGHT_LOOKBACK = 60;
// The "heavy workout" threshold in minutes
const HEAVY_WORKOUT_MIN_MINUTES = 30;
// The "high readiness" threshold from Oura
const HIGH_READINESS_THRESHOLD = 70;
// The "low readiness" threshold from Oura
const LOW_READINESS_THRESHOLD = 55;

// Helper: kcal/min from a workout record (returns null when data is missing)
function kcalPerMin(row) {
  if (!row || !row.active_calories || !row.duration_minutes || row.duration_minutes < 5) return null;
  return Math.round((row.active_calories / row.duration_minutes) * 10) / 10;
}

// Helper: the average of an array of numbers (skips null/undefined)
function avgNonNull(arr) {
  const vals = arr.filter(v => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10;
}

// INSIGHT: OURA SLEEP -> APPLE WATCH WORKOUT PERFORMANCE (the following day)
// The question: does a night with a good sleep score translate into a better workout the next day?
router.get('/api/dashboard/sleep-workout-performance-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Fetch every day with sleep data
    const sleepRows = await db.all(
      `SELECT date, sleep_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND sleep_score IS NOT NULL AND sleep_score > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (sleepRows.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_sleep_days', minRequired: WORKOUT_INSIGHT_MIN_DAYS * 2, available: sleepRows.length });
    }

    // For each day with sleep, check the workout one day later
    const goodSleepPerf = [];
    const poorSleepPerf = [];

    for (const sleepRow of sleepRows) {
      const nextDay = shiftDate(sleepRow.date, 1);
      if (nextDay > today) continue;

      const workouts = await db.all(
        `SELECT active_calories, duration_minutes FROM apple_health_workouts
         WHERE user_id = ? AND date = ? AND duration_minutes >= 10 AND active_calories > 0`,
        [req.user.id, nextDay]
      );
      if (workouts.length === 0) continue;

      // Take the longest workout of that day
      const best = workouts.sort((a, b) => b.duration_minutes - a.duration_minutes)[0];
      const kpm = kcalPerMin(best);
      if (kpm == null) continue;

      if (sleepRow.sleep_score >= SLEEP_SCORE_GOOD_THRESHOLD) {
        goodSleepPerf.push(kpm);
      } else if (sleepRow.sleep_score <= SLEEP_SCORE_POOR_THRESHOLD) {
        poorSleepPerf.push(kpm);
      }
    }

    if (goodSleepPerf.length < WORKOUT_INSIGHT_MIN_DAYS || poorSleepPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        goodSleepDays: goodSleepPerf.length,
        poorSleepDays: poorSleepPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgGood = avgNonNull(goodSleepPerf);
    const avgPoor = avgNonNull(poorSleepPerf);
    const diff = avgGood != null && avgPoor != null ? Math.round((avgGood - avgPoor) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      goodSleepThreshold: SLEEP_SCORE_GOOD_THRESHOLD,
      poorSleepThreshold: SLEEP_SCORE_POOR_THRESHOLD,
      avgKcalPerMinAfterGoodSleep: avgGood,
      avgKcalPerMinAfterPoorSleep: avgPoor,
      diff,
      goodSleepDays: goodSleepPerf.length,
      poorSleepDays: poorSleepPerf.length,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sen-trening.' });
  }
});

// INSIGHT: OURA READINESS -> APPLE WATCH WORKOUT PERFORMANCE (the same day)
// The question: does Oura's readiness score translate into real workout performance?
router.get('/api/dashboard/readiness-workout-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Days with an Oura readiness score
    const readinessRows = await db.all(
      `SELECT hm.date, hm.readiness_score
       FROM health_metrics hm
       WHERE hm.user_id = ? AND hm.date >= ? AND hm.date <= ?
         AND hm.readiness_score IS NOT NULL AND hm.readiness_score > 0
       ORDER BY hm.date ASC`,
      [req.user.id, startDate, today]
    );

    if (readinessRows.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_readiness_days', available: readinessRows.length });
    }

    const highReadinessPerf = [];
    const lowReadinessPerf = [];

    for (const rRow of readinessRows) {
      const workouts = await db.all(
        `SELECT active_calories, duration_minutes FROM apple_health_workouts
         WHERE user_id = ? AND date = ? AND duration_minutes >= 10 AND active_calories > 0`,
        [req.user.id, rRow.date]
      );
      if (workouts.length === 0) continue;

      const best = workouts.sort((a, b) => b.duration_minutes - a.duration_minutes)[0];
      const kpm = kcalPerMin(best);
      if (kpm == null) continue;

      if (rRow.readiness_score >= HIGH_READINESS_THRESHOLD) {
        highReadinessPerf.push(kpm);
      } else if (rRow.readiness_score <= LOW_READINESS_THRESHOLD) {
        lowReadinessPerf.push(kpm);
      }
    }

    if (highReadinessPerf.length < WORKOUT_INSIGHT_MIN_DAYS || lowReadinessPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        highReadinessDays: highReadinessPerf.length,
        lowReadinessDays: lowReadinessPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgHigh = avgNonNull(highReadinessPerf);
    const avgLow = avgNonNull(lowReadinessPerf);
    const diff = avgHigh != null && avgLow != null ? Math.round((avgHigh - avgLow) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      highReadinessThreshold: HIGH_READINESS_THRESHOLD,
      lowReadinessThreshold: LOW_READINESS_THRESHOLD,
      avgKcalPerMinHighReadiness: avgHigh,
      avgKcalPerMinLowReadiness: avgLow,
      diff,
      highReadinessDays: highReadinessPerf.length,
      lowReadinessDays: lowReadinessPerf.length,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu gotowość-trening.' });
  }
});

// INSIGHT: 80/20 HEART-RATE ZONE POLARISATION (Apple Watch only)
// The question: are the workouts polarised appropriately (80% aerobic / 20% intense)?
// The 80/20 theory: the optimal split for endurance and recovery.
router.get('/api/dashboard/hr-polarization-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    const workoutRows = await db.all(
      `SELECT zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes,
              duration_minutes
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= 10
         AND (zone1_minutes IS NOT NULL OR zone2_minutes IS NOT NULL
              OR zone3_minutes IS NOT NULL OR zone4_minutes IS NOT NULL OR zone5_minutes IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    if (workoutRows.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_workouts', available: workoutRows.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS });
    }

    let totalZ1 = 0, totalZ2 = 0, totalZ3 = 0, totalZ4 = 0, totalZ5 = 0;
    for (const w of workoutRows) {
      totalZ1 += w.zone1_minutes ?? 0;
      totalZ2 += w.zone2_minutes ?? 0;
      totalZ3 += w.zone3_minutes ?? 0;
      totalZ4 += w.zone4_minutes ?? 0;
      totalZ5 += w.zone5_minutes ?? 0;
    }

    const totalZone = totalZ1 + totalZ2 + totalZ3 + totalZ4 + totalZ5;
    if (totalZone < 60) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_zone_data', totalMinutes: totalZone });
    }

    const pct = (v) => Math.round(v / totalZone * 100);
    const easyPct = pct(totalZ1 + totalZ2);   // Zones 1-2 = easy aerobic effort
    const hardPct = pct(totalZ4 + totalZ5);   // Zones 4-5 = intense/anaerobic
    const midPct  = pct(totalZ3);             // Zone 3 = the "grey zone" (avoided in 80/20)

    // The ideal split: >=80% easy, <=10% middle, >=15% intense
    const isWellPolarized = easyPct >= 75 && hardPct >= 10 && midPct <= 15;
    const tooMuchGrayZone = midPct > 25;

    res.json({
      hasEnoughData: true,
      totalZoneMinutes: Math.round(totalZone),
      workoutsAnalyzed: workoutRows.length,
      zone1Pct: pct(totalZ1),
      zone2Pct: pct(totalZ2),
      zone3Pct: midPct,
      zone4Pct: pct(totalZ4),
      zone5Pct: pct(totalZ5),
      easyPct,
      hardPct,
      midPct,
      isWellPolarized,
      tooMuchGrayZone,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu polaryzacji stref.' });
  }
});

// INSIGHT: A HEAVY APPLE WATCH WORKOUT -> OURA HRV/RHR ON DAY +1/+2
// The question: how long after an intense workout do HRV/RHR stay disturbed?
router.get('/api/dashboard/workout-recovery-hrv-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Find the heavy workouts (>=30 min)
    const heavyWorkouts = await db.all(
      `SELECT DISTINCT date FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= ? AND active_calories > 100`,
      [req.user.id, startDate, shiftDate(today, -2), HEAVY_WORKOUT_MIN_MINUTES]
    );

    if (heavyWorkouts.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_heavy_workouts', available: heavyWorkouts.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS });
    }

    // Baseline days (no workout, and not the day or two after a heavy workout)
    const heavyDates = new Set(heavyWorkouts.map(r => r.date));
    const post1Hrv = [], post1Rhr = [];
    const post2Hrv = [], post2Rhr = [];

    for (const w of heavyWorkouts) {
      const day1 = shiftDate(w.date, 1);
      const day2 = shiftDate(w.date, 2);
      if (day1 > today || day2 > today) continue;

      const m1 = await db.get(
        `SELECT hrv, rhr FROM health_metrics WHERE user_id = ? AND date = ? AND (hrv IS NOT NULL OR rhr IS NOT NULL)`,
        [req.user.id, day1]
      );
      if (m1) {
        if (m1.hrv > 0) post1Hrv.push(m1.hrv);
        if (m1.rhr > 0) post1Rhr.push(m1.rhr);
      }

      const m2 = await db.get(
        `SELECT hrv, rhr FROM health_metrics WHERE user_id = ? AND date = ? AND (hrv IS NOT NULL OR rhr IS NOT NULL)`,
        [req.user.id, day2]
      );
      if (m2) {
        if (m2.hrv > 0) post2Hrv.push(m2.hrv);
        if (m2.rhr > 0) post2Rhr.push(m2.rhr);
      }
    }

    // The HRV/RHR baseline (days with no heavy workout and no day after a heavy workout)
    const baselineRows = await db.all(
      `SELECT date, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND (hrv > 0 OR rhr > 0)`,
      [req.user.id, startDate, today]
    );

    const baselineHrv = [], baselineRhr = [];
    for (const b of baselineRows) {
      const isPostHeavy = heavyDates.has(shiftDate(b.date, -1)) || heavyDates.has(shiftDate(b.date, -2)) || heavyDates.has(b.date);
      if (!isPostHeavy) {
        if (b.hrv > 0) baselineHrv.push(b.hrv);
        if (b.rhr > 0) baselineRhr.push(b.rhr);
      }
    }

    if (post1Hrv.length < 3 && post1Rhr.length < 3) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_recovery_data' });
    }

    const avgPost1Hrv = avgNonNull(post1Hrv);
    const avgPost2Hrv = avgNonNull(post2Hrv);
    const avgBaseHrv  = avgNonNull(baselineHrv);
    const avgPost1Rhr = avgNonNull(post1Rhr);
    const avgPost2Rhr = avgNonNull(post2Rhr);
    const avgBaseRhr  = avgNonNull(baselineRhr);

    res.json({
      hasEnoughData: true,
      heavyWorkoutDays: heavyWorkouts.length,
      heavyWorkoutMinMinutes: HEAVY_WORKOUT_MIN_MINUTES,
      avgHrvDay1: avgPost1Hrv,
      avgHrvDay2: avgPost2Hrv,
      avgHrvBaseline: avgBaseHrv,
      avgRhrDay1: avgPost1Rhr,
      avgRhrDay2: avgPost2Rhr,
      avgRhrBaseline: avgBaseRhr,
      hrvDiff1: avgPost1Hrv != null && avgBaseHrv != null ? Math.round((avgPost1Hrv - avgBaseHrv) * 10) / 10 : null,
      hrvDiff2: avgPost2Hrv != null && avgBaseHrv != null ? Math.round((avgPost2Hrv - avgBaseHrv) * 10) / 10 : null,
      rhrDiff1: avgPost1Rhr != null && avgBaseRhr != null ? Math.round((avgPost1Rhr - avgBaseRhr) * 10) / 10 : null,
      rhrDiff2: avgPost2Rhr != null && avgBaseRhr != null ? Math.round((avgPost2Rhr - avgBaseRhr) * 10) / 10 : null,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu regeneracja HRV po treningu.' });
  }
});

// INSIGHT: THE GAP BETWEEN WORKOUTS -> PERFORMANCE (Apple Watch only)
// The question: do more rest days translate into better workout performance?
router.get('/api/dashboard/workout-rest-performance-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Fetch every training day, sorted
    const workoutDays = await db.all(
      `SELECT date, active_calories, duration_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= 10 AND active_calories > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (workoutDays.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_workouts', available: workoutDays.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS * 2 });
    }

    // For each workout (except the first), compute how many days passed since the previous one
    const fewRestPerf = [];   // 0-1 dni przerwy
    const moreRestPerf = [];  // 2+ dni przerwy

    // Group by date (one result per day - the longest workout)
    const byDate = {};
    for (const w of workoutDays) {
      if (!byDate[w.date] || w.duration_minutes > byDate[w.date].duration_minutes) {
        byDate[w.date] = w;
      }
    }
    const sortedDates = Object.keys(byDate).sort();

    for (let i = 1; i < sortedDates.length; i++) {
      const curr = byDate[sortedDates[i]];
      const prev = byDate[sortedDates[i - 1]];
      const kpm = kcalPerMin(curr);
      if (kpm == null) continue;

    // How many days between the previous workout and this one
      const [py, pm, pd] = prev.date.split('-').map(Number);
      const [cy, cm, cd] = curr.date.split('-').map(Number);
      const daysDiff = Math.round(
        (Date.UTC(cy, cm - 1, cd) - Date.UTC(py, pm - 1, pd)) / 86400000
      ) - 1; // -1 because we count the days BETWEEN, not from the day of the workout

      if (daysDiff <= 1) {
        fewRestPerf.push(kpm);
      } else {
        moreRestPerf.push(kpm);
      }
    }

    if (fewRestPerf.length < WORKOUT_INSIGHT_MIN_DAYS || moreRestPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        fewRestDays: fewRestPerf.length,
        moreRestDays: moreRestPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgFew  = avgNonNull(fewRestPerf);
    const avgMore = avgNonNull(moreRestPerf);
    const diff = avgMore != null && avgFew != null ? Math.round((avgMore - avgFew) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      avgKcalPerMinFewRest: avgFew,
      avgKcalPerMinMoreRest: avgMore,
      diff,
      fewRestDays: fewRestPerf.length,
      moreRestDays: moreRestPerf.length,
      restThreshold: 2,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu przerwa-wydajność.' });
  }
});

module.exports = router;
