// A meal whose calories are unknown is unknown - not a 0 kcal meal (audit 2026-10-10, N7).
//
// meals.calories/protein/carbs/fat are NOT NULL in the schema, and dropping that constraint in
// SQLite means rebuilding the table that holds every meal photo. So the database keeps a
// placeholder 0 and analysis_status says whether the number is real: NULL = analysed (the
// value is a measurement, a real 0 included - black coffee, water), 'pending'/'failed' = the
// value is a placeholder. Everything that reads meals must honour that flag; the helpers below
// are the one place the rule lives.
//
// Two ways a placeholder 0 used to pass for a measurement:
//   1. Gemini answered without a usable `calories` field and sanitizeNumber() fell back to 0,
//      so the meal was stored as analysed with 0 kcal. That day's total, the 7/30-day
//      averages, the calorie balance behind the "Zastosuj cel" suggestion and the per-meal
//      anomaly baseline all counted a meal the user ate as zero energy.
//   2. A meal saved while the AI was down (services/mealAnalysis.js, 15.10.2026) carries
//      zeros until the retry fills it in - and every multi-day aggregate summed those zeros.

// Whether the AI response carries a calorie figure at all. Mirrors what sanitizeNumber() would
// accept, minus its silent fallbacks: Number('') and Number(null) are both 0, which is exactly
// how an absent value turned into a measured zero.
function hasCalorieValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return false;
}

// SQL condition for a meals query (the table must be referred to as `meals`, unaliased): keep
// only rows from days on which EVERY meal has real values. A day with a pending or failed meal
// is left out of multi-day aggregates entirely, the same rule as for the estimated nutrients
// (utils/estimatedNutrients.js) - dropping only the placeholder meal would still leave that
// day's total short by a whole meal, and summing it as 0 is the bug itself.
const COMPLETE_MEAL_DAY_SQL = `NOT EXISTS (
  SELECT 1 FROM meals unanalysed
  WHERE unanalysed.user_id = meals.user_id AND unanalysed.date = meals.date
    AND unanalysed.analysis_status IS NOT NULL
)`;

module.exports = { hasCalorieValue, COMPLETE_MEAL_DAY_SQL };
