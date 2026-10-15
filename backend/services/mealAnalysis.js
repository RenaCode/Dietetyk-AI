// Gemini analysis of a meal, shared by POST /api/meals and the pending-meal retry below.
//
// Production, 15.10.2026: the Gemini prepayment ran out (402 Payment Required) at 10:00, and
// from then on every POST /api/meals answered 500 - the meal was analysed BEFORE anything was
// written, so an AI failure discarded the user's entry entirely. A user tried the same meal
// eight times in two minutes and nothing reached the database; the text survived only in
// the user's browser tab. Logging a meal must not depend on a paid third party being up.
//
// Now a meal whose analysis fails is saved anyway, with analysis_status = 'pending' and zero
// macros, and retryPendingMeals() (scheduled in server.js) re-runs the analysis until the AI
// answers. Zeros rather than NULL: calories/protein/carbs/fat are NOT NULL in the schema and
// every aggregation sums them, so a pending meal briefly under-counts the day - that is the
// accepted trade-off against losing the meal. fiber/sugar/sodium stay NULL, which already
// marks the day's estimate as incomplete (utils/estimatedNutrients.js).

const db = require('../db');
const { generateContentWithFallback } = require('../config');
const { decrypt } = require('../utils/encryption');
const { buildMealPrompt } = require('../utils/mealPrompts');
const {
  sanitizeNumber,
  sanitizeNullableNumber,
  sanitizeMealText
} = require('../utils/mealSanitize');
const { invalidateAiExplanationCache } = require('../utils/aiExplanationCache');

const PHOTO_MEAL_FALLBACK_NAME = 'Posiłek ze zdjęcia';

// A retry per pending meal every RETRY_INTERVAL_MS, at most MAX_RETRY_ATTEMPTS times (~2 days).
// Judgement calls, not derived: an outage like the 402 above lasts until someone tops up the
// account, which can take a day; a failed call on a dead key costs nothing, but a meal whose
// analysis fails for its own reasons (the model keeps returning broken JSON) would otherwise
// be retried - and billed - forever. Past the cap the meal is marked 'failed' and the user
// sees that it needs to be entered again.
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 96;
// Pending meals handled per tick, so a backlog after a long outage spreads over several ticks
// instead of firing every queued photo at Gemini at once.
const RETRY_BATCH_SIZE = 20;

async function getUserAiContext(userId, role) {
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [userId]);
  return {
    userApiKey: apiKeyRow ? decrypt(apiKeyRow.value) : null,
    forceCustomKeyOnly: role !== 'admin',
    language: langRow ? langRow.value : 'pl'
  };
}

// Returns the list of meals to store - with a photo the AI may split it into several (see
// the prompt in utils/mealPrompts.js). Throws when the AI call fails or returns no JSON.
async function analyzeMeal({ userId, role, userText, imagePart }) {
  const { userApiKey, forceCustomKeyOnly, language } = await getUserAiContext(userId, role);

  // The prompt is built in utils/mealPrompts.js - see the comment in that module about the
  // user description taking precedence over what the model reads from the photo.
  const prompt = buildMealPrompt({ hasImage: Boolean(imagePart), userText, language });

  const responseText = await generateContentWithFallback(prompt, true, imagePart, userApiKey, forceCustomKeyOnly);
  let analysis;
  try {
    analysis = JSON.parse(responseText);
  } catch (err) {
    console.error('[API ERROR] Failed to parse the AI response:', responseText);
    throw new Error('AI nie zwróciło poprawnego formatu JSON.', { cause: err });
  }

  // With a photo the AI may return several separate meals (analysis.meals, e.g. a screenshot
  // from a calorie tracking app split into breakfast/lunch/dinner). Each detected meal is
  // stored as its OWN row, with its own macros and its own name taken from the AI detection
  // rather than from the text the user typed.
  if (imagePart) {
    if (analysis && Array.isArray(analysis.meals) && analysis.meals.length > 0) {
      return analysis.meals;
    }
    // Fallback: the AI returned a flat object despite the prompt (an older format) - we
    // treat it as a single meal rather than failing the whole request.
    return [{ ...analysis, name: analysis?.name || userText || PHOTO_MEAL_FALLBACK_NAME }];
  }
  // No photo - one row, name = the user's (capped and escaped) text.
  return [{ ...analysis, name: userText }];
}

// The values written to the database for one analysed meal. `m.name` comes from the Gemini
// response, but it is derived from the user's own description, so it is user-controlled text
// that merely took a detour through the model - it gets the same treatment as typed text.
// The AI numbers are clamped to a sensible range; fiber/sugar/sodium stay NULL when the AI
// did not estimate them (no fabricated zeros).
function sanitizeAnalysedMeal(m, { userText, hasImage }) {
  return {
    rawText: sanitizeMealText(m.name) || userText || (hasImage ? PHOTO_MEAL_FALLBACK_NAME : ''),
    calories: sanitizeNumber(m.calories, 0, 5000, 0),
    protein: sanitizeNumber(m.protein, 0, 500, 0),
    carbs: sanitizeNumber(m.carbs, 0, 500, 0),
    fat: sanitizeNumber(m.fat, 0, 500, 0),
    fiber: sanitizeNullableNumber(m.fiber, 0, 100),
    sugar: sanitizeNullableNumber(m.sugar, 0, 300),
    sodium: sanitizeNullableNumber(m.sodium, 0, 15000)
  };
}

// The analysis_json of a pending meal keeps the exact text the user typed: for a photo meal
// without a description raw_text is only the placeholder name, and the retry must build the
// same prompt the original request would have.
function pendingAnalysisJson(userText) {
  return JSON.stringify({ analysis_pending: true, user_text: userText || '', food_items: [] });
}

// The fields a meal response carries about a missing analysis - used by every route that
// returns meal rows (routes/meals.js, and the day view in routes/dashboard.js, which is what
// the frontend's meal list actually renders).
function pendingFlags(analysisStatus) {
  if (analysisStatus === 'pending') return { analysis_pending: true };
  if (analysisStatus === 'failed') return { analysis_failed: true };
  return {};
}

function imagePartFromDataUrl(image) {
  const match = typeof image === 'string' ? image.match(/^data:([^;]+);base64,(.+)$/) : null;
  return match ? { inlineData: { data: match[2], mimeType: match[1] } } : null;
}

async function retryPendingMeal(row) {
  let userText;
  try {
    userText = JSON.parse(row.analysis_json).user_text || '';
  } catch (e) {
    userText = row.raw_text;
  }
  const imagePart = imagePartFromDataUrl(row.image_base64);

  // Counted before the call, so a crash mid-analysis still uses up an attempt.
  await db.run(
    `UPDATE meals SET analysis_attempts = COALESCE(analysis_attempts, 0) + 1, analysis_attempted_at = datetime('now')
     WHERE id = ? AND analysis_status = 'pending'`,
    [row.id]
  );

  let analysed;
  try {
    analysed = await analyzeMeal({ userId: row.user_id, role: row.role, userText, imagePart });
  } catch (err) {
    const attempts = (row.analysis_attempts || 0) + 1;
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      await db.run(`UPDATE meals SET analysis_status = 'failed' WHERE id = ? AND analysis_status = 'pending'`, [row.id]);
      console.error(`[MEAL RETRY] Meal ${row.id}: giving up after ${attempts} attempts: ${err.message}`);
    } else {
      console.warn(`[MEAL RETRY] Meal ${row.id}: attempt ${attempts} failed: ${err.message}`);
    }
    return false;
  }

  const hasImage = Boolean(imagePart);
  const [first, ...rest] = analysed;
  const v = sanitizeAnalysedMeal(first, { userText, hasImage });
  // Conditional on the status: the user may have deleted the meal while Gemini was answering,
  // and then neither the update nor the extra rows of a split photo may appear.
  const updated = await db.run(
    `UPDATE meals SET raw_text = ?, calories = ?, protein = ?, carbs = ?, fat = ?, fiber = ?, sugar = ?, sodium = ?,
       analysis_json = ?, analysis_status = NULL
     WHERE id = ? AND analysis_status = 'pending'`,
    [v.rawText, v.calories, v.protein, v.carbs, v.fat, v.fiber, v.sugar, v.sodium, JSON.stringify(first), row.id]
  );
  if (updated.changes === 0) return false;

  for (const m of rest) {
    const e = sanitizeAnalysedMeal(m, { userText, hasImage });
    // The photo stays on the original row only - the same reasoning as in /api/meals/repeat.
    await db.run(
      `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [row.user_id, row.date, row.timestamp, e.rawText, e.calories, e.protein, e.carbs, e.fat, e.fiber, e.sugar, e.sodium, JSON.stringify(m)]
    );
  }

  await invalidateAiExplanationCache(row.user_id, row.date);
  await db.run(`
    INSERT INTO health_metrics (user_id, date, last_meal_modified_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET last_meal_modified_at = excluded.last_meal_modified_at
  `, [row.user_id, row.date, new Date().toISOString()]);

  console.log(`[MEAL RETRY] Meal ${row.id} analysed on retry ${(row.analysis_attempts || 0) + 1}: ${v.calories} kcal${rest.length ? ` (+${rest.length} split meal(s))` : ''}.`);
  return true;
}

// One tick of the retry loop (server.js runs it every RETRY_TICK_MS). Sequential on purpose:
// one Gemini call at a time is what the interactive path does too, and the tick is not on
// anyone's request path.
let retryRunning = false;
async function retryPendingMeals() {
  if (retryRunning) return { analysed: 0, skipped: true };
  retryRunning = true;
  let analysed = 0;
  try {
    const rows = await db.all(
      `SELECT m.id, m.user_id, m.date, m.timestamp, m.raw_text, m.analysis_json, m.image_base64, m.analysis_attempts, u.role
       FROM meals m JOIN users u ON u.id = m.user_id
       WHERE m.analysis_status = 'pending'
         AND (m.analysis_attempted_at IS NULL OR m.analysis_attempted_at <= datetime('now', ?))
       ORDER BY m.id
       LIMIT ?`,
      [`-${Math.round(RETRY_INTERVAL_MS / 1000)} seconds`, RETRY_BATCH_SIZE]
    );
    for (const row of rows) {
      try {
        if (await retryPendingMeal(row)) analysed++;
      } catch (err) {
        console.error(`[MEAL RETRY] Meal ${row.id}: unexpected error:`, err);
      }
    }
  } finally {
    retryRunning = false;
  }
  return { analysed };
}

// How often server.js checks for pending meals. Shorter than RETRY_INTERVAL_MS so a meal saved
// just after a tick does not wait almost two intervals; the per-meal spacing is enforced by
// analysis_attempted_at, not by this timer.
const RETRY_TICK_MS = 5 * 60 * 1000;

module.exports = {
  analyzeMeal,
  sanitizeAnalysedMeal,
  pendingAnalysisJson,
  pendingFlags,
  imagePartFromDataUrl,
  retryPendingMeals,
  PHOTO_MEAL_FALLBACK_NAME,
  RETRY_INTERVAL_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_TICK_MS
};
