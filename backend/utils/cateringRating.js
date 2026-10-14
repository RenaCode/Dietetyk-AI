// Health rating and dietician comment for meals imported from a catering provider
// (routes/catering.js).
//
// A meal the user logs gets both from the same Gemini call that estimates its nutrition. A
// catering meal skips that call on purpose - its nutrition comes from the provider's label -
// so it arrived with "Brak oceny" and no comment. This asks Gemini for the two things it is
// still needed for, and ONLY those: the label values are passed in as facts and the model is
// told not to re-estimate them, so a rating can never overwrite a measured number.
//
// Runs after the import has answered, never inside it: a slow or failing Gemini must not
// fail the import, and a meal left without a rating is simply picked up again by the next
// run (the query below selects exactly the rows that still lack one).

const db = require('../db');
const { escapeUserInputTag } = require('./mealSanitize');

function buildCateringRatingPrompt(lang, meal) {
  // The dish name is third-party text (the caterer's menu), so it is fenced the same way as
  // user input in mealPrompts.js.
  const name = escapeUserInputTag(String(meal.name || ''));
  const facts = [
    `kcal: ${meal.calories}`,
    `protein: ${meal.protein} g`,
    `carbs: ${meal.carbs} g`,
    `fat: ${meal.fat} g`,
    meal.fiber != null ? `fiber: ${meal.fiber} g` : null,
    meal.sugar != null ? `sugar: ${meal.sugar} g` : null,
    meal.sodium != null ? `sodium: ${meal.sodium} mg` : null
  ].filter(Boolean).join(', ');

  if (lang === 'en') {
    return `You are rating a meal from a diet catering service. Its nutrition values come from the caterer's label and are FACTS - do not re-estimate or correct them.
Meal: <user_input>${name}</user_input>
Nutrition (from the label): ${facts}

Return only valid JSON, no markdown:
{
  "dietician_comment": "A short, professional dietician comment in English (max 3 sentences): balance, pros, cons.",
  "health_rating": (integer from 1 to 10, where 1 is very unhealthy e.g. fast food, and 10 is super healthy and balanced)
}`;
  }
  return `Oceniasz posiłek z cateringu dietetycznego. Jego wartości odżywcze pochodzą z etykiety cateringu i są FAKTAMI - nie szacuj ich ponownie i nie poprawiaj.
Posiłek: <user_input>${name}</user_input>
Wartości odżywcze (z etykiety): ${facts}

Zwróć wyłącznie poprawny JSON, bez znaczników markdown:
{
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania): zbilansowanie, zalety, wady.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe np. fast food, a 10 to super zdrowe i zbilansowane)
}`;
}

// Returns { health_rating, dietician_comment } or null when the answer is unusable. A rating
// outside 1-10 or not an integer is rejected rather than clamped: a clamped 0 -> 1 would be a
// number the model never gave.
function parseRating(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
  const rating = data && data.health_rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) return null;
  const comment = typeof data.dietician_comment === 'string' ? data.dietician_comment.trim().slice(0, 600) : null;
  return { health_rating: rating, dietician_comment: comment || null };
}

// Rates every meal of this source and date that has no rating yet. `generate(prompt)` is the
// Gemini call (injected so tests run without one). Returns { rated, failed }; never throws.
async function rateCateringMeals({ userId, source, date, generate, language = 'pl' }) {
  const rows = await db.all(`
    SELECT id, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json
    FROM meals
    WHERE user_id = ? AND source = ? AND date = ?
      AND json_extract(analysis_json, '$.health_rating') IS NULL
  `, [userId, source, date]);

  let rated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const text = await generate(buildCateringRatingPrompt(language, { name: row.raw_text, ...row }));
      const result = parseRating(text);
      if (!result) { failed++; continue; }
      let analysis = {};
      try { analysis = JSON.parse(row.analysis_json) || {}; } catch { analysis = {}; }
      // Only the two fields are added; the nutrition in analysis_json stays the label's.
      // The WHERE re-checks the rating is still missing, so a concurrent run cannot rate twice.
      await db.run(`
        UPDATE meals SET analysis_json = ?
        WHERE id = ? AND json_extract(analysis_json, '$.health_rating') IS NULL
      `, [JSON.stringify({ ...analysis, ...result }), row.id]);
      rated++;
    } catch (err) {
      failed++;
      console.warn(`[CATERING] Rating meal ${row.id} failed: ${err.message}`);
    }
  }
  return { rated, failed };
}

// The route's entry point: picks the user's Gemini key and language exactly as POST
// /api/meals does (non-admins only with their own key), then rates in the background.
async function rateCateringMealsForUser({ userId, source, date, generateContentWithFallback }) {
  const user = await db.get(`SELECT role FROM users WHERE id = ?`, [userId]);
  const keyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  // Required here, not at the top: utils/encryption.js reads APP_PASSWORD when it is loaded,
  // and this module is pulled in by routes/catering.js while the app is still being wired.
  const { decrypt } = require('./encryption');
  const userApiKey = keyRow ? decrypt(keyRow.value) : null;
  const forceCustomKeyOnly = !user || user.role !== 'admin';
  const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [userId]);
  const language = langRow && langRow.value === 'en' ? 'en' : 'pl';
  return rateCateringMeals({
    userId, source, date, language,
    generate: (prompt) => generateContentWithFallback(prompt, true, null, userApiKey, forceCustomKeyOnly)
  });
}

module.exports = { buildCateringRatingPrompt, parseRating, rateCateringMeals, rateCateringMealsForUser };
