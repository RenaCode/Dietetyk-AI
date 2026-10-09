// Fibre, sugar and sodium are AI ESTIMATES, and an estimate that is missing is missing - not 0.
//
// Gemini returns these three only when it is willing to guess them (the prompt in
// utils/mealPrompts.js asks for them "szacunkowo"), and routes/meals.js stores NULL when it
// does not. SQLite's SUM() skips NULLs, so a day with three meals of which ONE had a sodium
// estimate summed to that one meal's value: 1500 mg, filed under "sodium within the norm" in
// the sodium -> blood pressure comparison, next to real Withings readings (audit 2026-10-09,
// W3). The same partial sums reached the AI prompts as "Sód: 0mg" on days nothing was
// estimated at all.
//
// The rule used everywhere instead: a day's total of an estimated nutrient exists only when
// EVERY meal of that day carries an estimate; otherwise the day's value is NULL and the day is
// left out of comparisons, and counted as such so the UI can say how many days were excluded.

const ESTIMATED_NUTRIENTS = ['fiber', 'sugar', 'sodium'];

// SQL for one column of a per-day (GROUP BY date) or per-day-filtered meals query. Only the
// three known column names are accepted - the name is interpolated into SQL.
function completeDaySumSql(column, alias = column) {
  if (!ESTIMATED_NUTRIENTS.includes(column) || !/^[a-z_]+$/.test(alias)) {
    throw new Error(`completeDaySumSql: not an estimated nutrient column: ${column}`);
  }
  return `CASE WHEN COUNT(${column}) = COUNT(*) THEN SUM(${column}) END AS ${alias}`;
}

// The same rule over already-fetched meal rows: the sum, or null when any row lacks a value.
function sumIfComplete(rows, column) {
  if (!rows || rows.length === 0) return null;
  let total = 0;
  for (const r of rows) {
    if (r[column] === null || r[column] === undefined) return null;
    total += r[column];
  }
  return total;
}

// How an estimate is quoted in the Polish / English AI prompts: marked as an estimate, and
// "brak szacunku" / "no estimate" rather than a number when there is none.
function formatEstimateForPrompt(value, unit, language) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return language === 'en' ? 'no estimate' : 'brak szacunku';
  }
  return language === 'en' ? `~${value}${unit} (AI estimate)` : `~${value}${unit} (szacunek AI)`;
}

module.exports = { ESTIMATED_NUTRIENTS, completeDaySumSql, sumIfComplete, formatEstimateForPrompt };
