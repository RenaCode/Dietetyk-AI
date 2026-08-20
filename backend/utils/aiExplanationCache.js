const db = require('../db');

// Round 12 (audit): ai-explanation-insight (see routes/dashboard.js) caches the
// AI-generated explanation in health_metrics.ai_explanation, and for PAST days treats
// that cache as "fresh forever" (historical data is assumed immutable). The problem: the
// app DOES allow editing past days after the fact - adding or deleting a meal
// (routes/meals.js), changing water or supplements (routes/health.js) for a past date.
// Without invalidation, an explanation generated BEFORE the edit stayed in the cache and
// could contradict the data actually in the database - for example still saying "you
// skipped breakfast today" after the meal was added retroactively.
//
// We clear ONLY the cache (ai_explanation/ai_explanation_generated_at). The next visit to
// the dashboard for that date regenerates the explanation from current data (see the
// isFresh logic in ai-explanation-insight).
async function invalidateAiExplanationCache(userId, date) {
  if (!date) return;
  try {
    await db.run(
      `UPDATE health_metrics SET ai_explanation = NULL, ai_explanation_generated_at = NULL
       WHERE user_id = ? AND date = ?`,
      [userId, date]
    );
  } catch (err) {
    // A failed cache invalidation must not break the main operation (saving a meal,
    // water or supplements) - at worst the user sees a stale explanation until the next
    // natural refresh (30 min) or until the day rolls over.
    console.error('[AI EXPLANATION CACHE] Cache invalidation failed:', err);
  }
}

module.exports = { invalidateAiExplanationCache };
