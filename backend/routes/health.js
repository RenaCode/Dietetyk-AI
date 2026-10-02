const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { invalidateAiExplanationCache } = require('../utils/aiExplanationCache');
const { resolveQueryDate } = require('../utils/dates');
const { getDailyMetrics } = require('../utils/appleHealthSamples');
const { getDailyEventsView } = require('../utils/appleHealthEvents');
const { columnBackedMetrics } = require('../utils/appleHealthColumns');

router.get('/api/health/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT date, weight, fat_ratio, muscle_mass, blood_pressure_systolic, blood_pressure_diastolic, sleep_score, sleep_duration, sleep_deep, sleep_rem, readiness_score, steps, active_calories, total_calories_burned, rhr, hrv, active_minutes, supplements
      FROM health_metrics
      WHERE user_id = ? AND date >= date('now', '-90 days')
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania historii pomiarów zdrowotnych.' });
  }
});

// Every Apple Health metric stored for a day that has no dedicated card of its own - see
// utils/appleHealthSamples.js. Feeds the "Pozostałe dane z Apple Health" card on the
// Dashboard, so whatever the user ticks in Health Auto Export becomes visible without a code
// change per metric.
router.get('/api/health/apple-metrics', requireAuth, async (req, res) => {
  try {
    const date = resolveQueryDate(req.query.date);
    const metrics = await getDailyMetrics(db, req.user.id, date, {
      exclude: await columnBackedMetrics(db, req.user.id)
    });
    res.json({ date, metrics });
  } catch (err) {
    console.error('[APPLE METRICS] Failed to read daily metrics:', err.message);
    res.status(500).json({ error: 'Błąd pobierania danych z Apple Health.' });
  }
});

// Symptoms, menstrual cycle position and heart-rate notifications (last 7 days) for the
// "Objawy, cykl i serce" Dashboard card - see utils/appleHealthEvents.js.
router.get('/api/health/apple-events', requireAuth, async (req, res) => {
  try {
    const date = resolveQueryDate(req.query.date);
    const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
    const view = await getDailyEventsView(db, req.user.id, date, langRow ? langRow.value : 'pl');
    res.json({ date, ...view });
  } catch (err) {
    console.error('[APPLE EVENTS] Failed to read daily events:', err.message);
    res.status(500).json({ error: 'Błąd pobierania objawów i cyklu z Apple Health.' });
  }
});

// Body circumference history
router.get('/api/body-measurements', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below
      FROM body_measurements 
      WHERE user_id = ? 
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania obwodów ciała.' });
  }
});

// Upper and lower bounds for a physically sensible body circumference in cm - without them
// a typo (entering a weight of 95 into a circumference field, or a missing decimal point,
// '950' instead of '95.0') would be stored silently and poison the body-recomposition
// insight and the Trends charts with a phantom jump.
const MIN_MEASUREMENT_CM = 1;
const MAX_MEASUREMENT_CM = 300;

// Converts a value from the body to a number with range validation. Returns `undefined`
// when the field was not submitted (leave it untouched - see the COALESCE in the query
// below), `null` when an empty field was submitted (clearing the value), or raises a range
// error (an exception carrying a message for the user).
function parseMeasurement(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Nieprawidłowa wartość pomiaru: ${label}.`);
  }
  if (num < MIN_MEASUREMENT_CM || num > MAX_MEASUREMENT_CM) {
    throw new Error(`Obwód (${label}) musi być w zakresie ${MIN_MEASUREMENT_CM}-${MAX_MEASUREMENT_CM} cm.`);
  }
  return num;
}

// Save or update body circumferences
router.post('/api/body-measurements', requireAuth, async (req, res) => {
  const { date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });

  let parsed;
  try {
    parsed = {
      chest: parseMeasurement(chest, 'klatka piersiowa'),
      waist: parseMeasurement(waist, 'pas'),
      hips: parseMeasurement(hips, 'biodra'),
      biceps: parseMeasurement(biceps, 'biceps'),
      thigh: parseMeasurement(thigh, 'udo'),
      biceps_left: parseMeasurement(biceps_left, 'biceps lewy'),
      biceps_right: parseMeasurement(biceps_right, 'biceps prawy'),
      shoulders: parseMeasurement(shoulders, 'ramiona'),
      waist_above: parseMeasurement(waist_above, 'pas powyżej pępka'),
      waist_below: parseMeasurement(waist_below, 'pas poniżej pępka')
    };
  } catch (validationErr) {
    return res.status(400).json({ error: validationErr.message });
  }

  try {
    const fields = [
      'chest', 'waist', 'hips', 'biceps', 'thigh',
      'biceps_left', 'biceps_right', 'shoulders', 'waist_above', 'waist_below'
    ];
    const updateClauses = fields.map(field => {
      return req.body[field] !== undefined
        ? `${field} = excluded.${field}`
        : `${field} = ${field}`;
    });

    const sql = `
      INSERT INTO body_measurements (
        user_id, date, chest, waist, hips, biceps, thigh, 
        biceps_left, biceps_right, shoulders, waist_above, waist_below
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        ${updateClauses.join(',\n        ')}
    `;

    await db.run(sql, [
      req.user.id,
      date,
      parsed.chest ?? null,
      parsed.waist ?? null,
      parsed.hips ?? null,
      parsed.biceps ?? null,
      parsed.thigh ?? null,
      parsed.biceps_left ?? null,
      parsed.biceps_right ?? null,
      parsed.shoulders ?? null,
      parsed.waist_above ?? null,
      parsed.waist_below ?? null
    ]);
    res.json({ success: true, message: 'Pomiary obwodów ciała zostały zapisane.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu obwodów ciała.' });
  }
});

// Delete a body circumference measurement
router.delete('/api/body-measurements/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.run(`DELETE FROM body_measurements WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    // B-N1: check the record actually existed (guards against 200 OK for a non-existent one)
    if (result.changes === 0) return res.status(404).json({ error: 'Pomiar nie znaleziony.' });
    res.json({ success: true, message: 'Pomiar obwodu ciała został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania pomiaru obwodu ciała.' });
  }
});

// Add water intake (a daily, additive counter - repeated taps during the day
router.post('/api/water/add', requireAuth, async (req, res) => {
  const { date, amount_ml } = req.body;
  const amount = Number(amount_ml);
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Ilość wody (amount_ml) musi być liczbą większą od zera.' });
  }
// Upper limit for a single entry - without it a UI or integration bug (confusing ml with
// litres, say) could append an absurd value to the daily water counter.
  if (amount > 5000) {
    return res.status(400).json({ error: 'Nieprawidłowa ilość wody (maks. 5000 ml na wpis).' });
  }
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, water_ml)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET water_ml = COALESCE(water_ml, 0) + excluded.water_ml
    `, [req.user.id, date, Math.round(amount)]);

    const row = await db.get(`SELECT water_ml FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    await invalidateAiExplanationCache(req.user.id, date);
    res.json({ success: true, water_ml: row ? row.water_ml : amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu licznika wody.' });
  }
});

// Reset the water counter for a given day (undoing a mistaken entry, for instance)
router.post('/api/water/reset', requireAuth, async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  try {
    // water_ml_apple records how much of water_ml the Apple Health webhook contributed (see
    // buildHealthMetricsUpsertSql in routes/appleHealth.js). Resetting the counter has to
    // move that marker up to the day's current sample total as well - the webhook adds
    // `newTotal - water_ml_apple`, so leaving a stale or zero marker behind would make the
    // very next Apple sync re-add every millilitre the user has just cleared.
    const appleWater = await db.get(
      'SELECT SUM(qty) AS total FROM apple_health_water_samples WHERE user_id = ? AND date = ?',
      [req.user.id, date]
    );
    const appleShare = appleWater && appleWater.total !== null ? Math.round(appleWater.total) : 0;
    await db.run(`
      INSERT INTO health_metrics (user_id, date, water_ml, water_ml_apple)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET water_ml = 0, water_ml_apple = excluded.water_ml_apple
    `, [req.user.id, date, appleShare]);
    await invalidateAiExplanationCache(req.user.id, date);
    res.json({ success: true, water_ml: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd resetowania licznika wody.' });
  }
});

// Length limit for the supplements field - without it an arbitrarily large string (a whole
// document pasted by mistake) would go unbounded into the database and into every place
// that reads the field (Dashboard, PDF, the supplements-sleep insight).
const MAX_SUPPLEMENTS_LENGTH = 2000;

// Save or update the supplements for a given day
router.post('/api/supplements', requireAuth, async (req, res) => {
  const { date, supplements } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });
  const trimmed = supplements ? supplements.trim() : null;
  if (trimmed && trimmed.length > MAX_SUPPLEMENTS_LENGTH) {
    return res.status(400).json({ error: `Lista suplementów jest za długa (maks. ${MAX_SUPPLEMENTS_LENGTH} znaków).` });
  }
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, supplements)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET supplements = excluded.supplements
    `, [req.user.id, date, trimmed]);
    await invalidateAiExplanationCache(req.user.id, date);
    res.json({ success: true, supplements: trimmed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu suplementów.' });
  }
});

// Save or update the energy level and mood for a given day (a 1-5 scale).
// Both fields are optional - only one of them may be sent.
const FEELING_MIN = 1;
const FEELING_MAX = 5;

router.post('/api/feeling', requireAuth, async (req, res) => {
  const { date, energy_level, mood } = req.body;
  if (!date) return res.status(400).json({ error: 'Data jest wymagana.' });

  const energy = energy_level != null ? Number(energy_level) : null;
  const moodVal = mood != null ? Number(mood) : null;

  if (energy !== null && (!Number.isInteger(energy) || energy < FEELING_MIN || energy > FEELING_MAX)) {
    return res.status(400).json({ error: `Poziom energii musi być liczbą całkowitą ${FEELING_MIN}–${FEELING_MAX}.` });
  }
  if (moodVal !== null && (!Number.isInteger(moodVal) || moodVal < FEELING_MIN || moodVal > FEELING_MAX)) {
    return res.status(400).json({ error: `Nastrój musi być liczbą całkowitą ${FEELING_MIN}–${FEELING_MAX}.` });
  }
  if (energy === null && moodVal === null) {
    return res.status(400).json({ error: 'Podaj co najmniej jedno pole: energy_level lub mood.' });
  }

  try {
    // COALESCE(excluded.field, field) = keep the existing value when the new one is NULL.
    // That allows updating energy_level alone without clearing mood, and vice versa.
    await db.run(`
      INSERT INTO health_metrics (user_id, date, energy_level, mood)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        energy_level = COALESCE(excluded.energy_level, energy_level),
        mood         = COALESCE(excluded.mood, mood)
    `, [req.user.id, date, energy, moodVal]);

    await invalidateAiExplanationCache(req.user.id, date);
    const row = await db.get(`SELECT energy_level, mood FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    res.json({ success: true, energy_level: row?.energy_level ?? null, mood: row?.mood ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu samopoczucia.' });
  }
});

module.exports = router;
