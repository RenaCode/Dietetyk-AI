// Sanitisation of the AI (Gemini) response and validation of the meal photo
// (routes/meals.js) - extracted into its own module (like utils/mealAnomaly.js) so it
// can be unit tested without booting the whole Express server and database.

// The AI model (Gemini) sometimes returns unrealistic or negative calorie/macro values
// (a misparsed portion size, a hallucinated number). Without this guard such a value
// would go straight into the database and corrupt the aggregations (daily totals,
// calorie balance, streaks) on the dashboard and in the summaries. We clamp to a
// sensible range, and fall back (0 by default) when the value cannot be parsed as a
// number at all.
function sanitizeNumber(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

// Variant for fields that can genuinely be unknown (fiber/sugar/sodium - the AI cannot
// always estimate them). Unlike sanitizeNumber this does NOT fabricate a zero when the
// AI omitted the value, but when a value IS given it is still clamped to a sensible
// range. Without this, a negative/unrealistic/non-numeric value from the Gemini
// response went straight into the database (unlike calories/protein/carbs/fat, which
// were already sanitised) and corrupted the aggregations in summaries.js/dashboard.js
// (fiber/sugar/sodium totals and averages, now used in the full AI summary).
function sanitizeNullableNumber(val, min, max) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.min(Math.max(num, min), max);
}

// Whitelist of MIME types accepted for a meal photo (B-S5) - without it, any
// content-type encoded in the data URL would be passed straight to Gemini as inlineData.
const ALLOWED_MEAL_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Size limit for a single meal photo stored in SQLite as base64. Without this limit the
// only boundary was the global express.json({limit:'20mb'}) in server.js (meant for
// webhooks, not for individual photos) - a user could add photos at full phone
// resolution (10-20 MB), which at a few meals a day would quickly bloat the SQLite file
// (a single file, with no separate image storage). 7 MB of base64 corresponds to roughly
// 5.25 MB of binary data once decoded - enough for a food photo at reasonable quality,
// while still guarding against extremely large files.
const MAX_MEAL_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;

module.exports = {
  sanitizeNumber,
  sanitizeNullableNumber,
  ALLOWED_MEAL_IMAGE_MIME_TYPES,
  MAX_MEAL_IMAGE_BASE64_CHARS
};
