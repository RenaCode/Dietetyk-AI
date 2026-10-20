// config FIRST: it is what loads .env (APP_PASSWORD and the rest) into process.env. Anything
// that reads the environment at require time - utils/encryption.js throws when APP_PASSWORD
// is missing - must come after it. #86 required utils/cateringRating.js above this line and
// the production backend crash-looped on start (2026-10-14); CI did not see it because the
// test jobs set APP_PASSWORD in the real environment, not through .env.
const config = require('../config');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { isCalendarDateString } = require('../utils/dates');
const { invalidateAiExplanationCache } = require('../utils/aiExplanationCache');
const { sanitizeNumber, sanitizeNullableNumber, sanitizeMealText } = require('../utils/mealSanitize');
const { rateCateringMealsForUser } = require('../utils/cateringRating');

// Import of a catering provider's daily menu as meals (the sync job in catering/sync.js).
//
// AUTHORISATION: the same model as the Apple Health webhook (routes/appleHealth.js) - the
// caller is a CronJob with no browser and no session, so it identifies the user by their
// `sync_token` in the URL. This router is therefore mounted in app.js BEFORE requireAuth,
// AFTER the rate limiter, and the token is redacted from the access log there.
//
// A DAY IS IMPORTED ONCE. The payload is the provider's full menu for one date; the first
// accepted import stores it and records the day in `catering_imports`. Every later run for
// that day (a retry, a manual --date run) is a no-op: from then on the meals are the user's,
// and a meal they deleted because they did not eat it must stay deleted. A dish swapped in
// the provider's panel after the import is therefore NOT picked up - the job runs in the
// morning, before the day's meals, which is when the menu is final.
//
// NO GEMINI CALL. The values are the provider's own nutrition table - closer to a label than
// to anything the model estimates from a description - so they are stored as given (clamped
// to the same ranges as estimated meals) and marked with `source`, which is how the rest of
// the app can tell them apart from estimates.

// Providers this endpoint accepts. A closed list, because `source` ends up in a unique index
// and in what the user sees: a typo in the CronJob's config must be a 400, not a second
// "provider" whose rows the first one never replaces.
const CATERING_SOURCES = new Set(['betterlife']);

// A catering day is 3-6 meals; 20 leaves room for add-ons and still rejects a payload that is
// clearly something else.
const MAX_MEALS_PER_DAY = 20;
const MAX_EXTERNAL_ID_LENGTH = 64;

async function requireKnownSyncToken(req, res, next) {
  try {
    const syncToken = (req.params.syncToken || '').trim();
    if (!syncToken) {
      return res.status(401).json({ error: 'Brak tokenu synchronizacji w adresie.' });
    }
    const user = await db.get(`SELECT id FROM users WHERE sync_token = ?`, [syncToken]);
    if (!user) {
      return res.status(404).json({ error: 'Nieznany token synchronizacji.' });
    }
    req.syncUserId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

// Returns the cleaned meal, or a string describing why it was rejected.
function normaliseMeal(raw) {
  if (!raw || typeof raw !== 'object') return 'meal is not an object';
  const externalId = typeof raw.externalId === 'string' || typeof raw.externalId === 'number'
    ? String(raw.externalId).trim()
    : '';
  if (!externalId || externalId.length > MAX_EXTERNAL_ID_LENGTH) return 'missing or too long externalId';
  const name = sanitizeMealText(raw.name);
  if (!name) return `meal ${externalId} has no name`;
  // Calories are the one value this import exists for. A meal without them is rejected
  // rather than stored as 0 kcal - a zero would read as "ate nothing" in every daily total.
  if (!Number.isFinite(raw.calories)) return `meal ${externalId} has no calories`;
  return {
    externalId,
    name,
    calories: sanitizeNumber(raw.calories, 0, 5000, 0),
    protein: sanitizeNumber(raw.protein, 0, 500, 0),
    carbs: sanitizeNumber(raw.carbs, 0, 500, 0),
    fat: sanitizeNumber(raw.fat, 0, 500, 0),
    fiber: sanitizeNullableNumber(raw.fiber, 0, 100),
    sugar: sanitizeNullableNumber(raw.sugar, 0, 300),
    sodium: sanitizeNullableNumber(raw.sodium, 0, 15000)
  };
}

router.post('/api/integrations/catering/:syncToken', requireKnownSyncToken, async (req, res) => {
  try {
    const { source, date, meals } = req.body || {};
    if (!CATERING_SOURCES.has(source)) {
      return res.status(400).json({ error: 'Nieznany dostawca cateringu.' });
    }
    if (!isCalendarDateString(date)) {
      return res.status(400).json({ error: 'Nieprawidłowa data (oczekiwano RRRR-MM-DD).' });
    }
    if (!Array.isArray(meals) || meals.length > MAX_MEALS_PER_DAY) {
      return res.status(400).json({ error: 'Nieprawidłowa lista posiłków.' });
    }

    const cleaned = [];
    for (const raw of meals) {
      const meal = normaliseMeal(raw);
      if (typeof meal === 'string') {
        return res.status(400).json({ error: `Nieprawidłowy posiłek: ${meal}.` });
      }
      cleaned.push(meal);
    }
    // external_id is unique per (user, source), not per day - a provider reusing an id on
    // another date would otherwise move that meal between days. Prefix it with the date.
    const keyed = cleaned.map(m => ({ ...m, key: `${date}:${m.externalId}` }));
    if (new Set(keyed.map(m => m.key)).size !== keyed.length) {
      return res.status(400).json({ error: 'Powtórzony identyfikator posiłku.' });
    }

    const userId = req.syncUserId;
    const total = keyed.reduce((sum, m) => sum + m.calories, 0);

    const alreadyImported = Boolean(await db.get(
      `SELECT 1 FROM catering_imports WHERE user_id = ? AND source = ? AND date = ?`,
      [userId, source, date]
    ));

    let changes = 0;
    if (!alreadyImported) {
      for (const m of keyed) {
        const analysis = JSON.stringify({
          name: m.name, calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat,
          fiber: m.fiber, sugar: m.sugar, sodium: m.sodium, source
        });
        // DO NOTHING on a conflict: a row with this key can only come from a concurrent run of
        // the same day, and the first one's row is as good as ours.
        const result = await db.run(`
          INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium,
                             analysis_json, source, external_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
        `, [userId, date, m.name, m.calories, m.protein, m.carbs, m.fat, m.fiber, m.sugar, m.sodium,
          analysis, source, m.key]);
        changes += result.changes;
      }
      // The marker goes in AFTER the meals: a crash between the two leaves the day unmarked and
      // the next run fills in what is missing, instead of a marked day with no meals.
      await db.run(
        `INSERT OR IGNORE INTO catering_imports (user_id, source, date) VALUES (?, ?, ?)`,
        [userId, source, date]
      );
    }

    if (changes > 0) {
      await invalidateAiExplanationCache(userId, date);
      await db.run(`
        INSERT INTO health_metrics (user_id, date, last_meal_modified_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET last_meal_modified_at = excluded.last_meal_modified_at
      `, [userId, date, new Date().toISOString()]);
    }

    res.json({ date, source, meals: keyed.length, calories: total, changed: changes > 0, alreadyImported });

    // Health rating and comment, AFTER the response: Gemini must not slow down or fail the
    // import. Meals still unrated (Gemini down, no key) are retried by the next run - also on
    // an already imported day, which is why that case does not return early.
    rateCateringMealsForUser({
      userId, source, date,
      generateContentWithFallback: (...args) => config.generateContentWithFallback(...args)
    }).then(
      ({ rated, failed }) => { if (rated || failed) console.log(`[CATERING] ${date}: rated ${rated}, failed ${failed}`); },
      (err) => console.warn(`[CATERING] Rating skipped: ${err.message}`)
    );
  } catch (err) {
    console.error('[CATERING] Import failed:', err.message);
    res.status(500).json({ error: 'Nie udało się zapisać posiłków z cateringu.' });
  }
});

module.exports = router;
module.exports.CATERING_SOURCES = CATERING_SOURCES;
