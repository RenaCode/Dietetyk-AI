const db = require('../db');

// Meal anomaly detector - a product feature built entirely on data the app already
// collects, requiring no new input from the user.
// Shared by routes/meals.js (POST/GET of individual meals) and routes/dashboard.js (the
// day's meal list in /api/dashboard) - like getDefaultHealthMetrics, so the same logic is
// not duplicated in two places.
//
// Two independent signals, evaluated and surfaced SEPARATELY because they have different
// causes:
// 1) Calories inconsistent with the declared macros (protein*4 + carbs*4 + fat*9 versus
//    the stated calories) - this usually indicates an AI estimation error (a misread
//    portion size, say) rather than an unusual meal as such.
// 2) A statistical outlier in meal calories relative to the user's OWN history
//    (z-score na bazie ostatnich ANOMALY_LOOKBACK_DAYS dni) - wymaga minimalnej
//    number of earlier meals (MIN_MEALS_FOR_STATS_ANOMALY), otherwise the first few
//    entries in the app would always look like "anomalies" relative to themselves.
const ANOMALY_LOOKBACK_DAYS = 60;
const MIN_MEALS_FOR_STATS_ANOMALY = 8;
const ANOMALY_Z_SCORE_THRESHOLD = 2.5;
const MACRO_MISMATCH_MIN_KCAL_DIFF = 150;
const MACRO_MISMATCH_MIN_RATIO = 0.35;

// Shifts a date string (YYYY-MM-DD) by N days - the same proven Date.UTC arithmetic as
// shiftDate in dashboard.js, kept as a local copy to avoid a module dependency for one
// small helper.
const shiftDateForAnomaly = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Baseline distribution of calories per meal from the user's history, computed over ALL
// days BEFORE `beforeDate` (exclusive) - so the meals of the day being checked never
// influence their own point of reference.
async function getCalorieBaseline(userId, beforeDate) {
  const startDate = shiftDateForAnomaly(beforeDate, -ANOMALY_LOOKBACK_DAYS);
  const rows = await db.all(
    `SELECT calories FROM meals WHERE user_id = ? AND date >= ? AND date < ?`,
    [userId, startDate, beforeDate]
  );
  const n = rows.length;
  if (n < MIN_MEALS_FOR_STATS_ANOMALY) return { hasEnoughData: false, n };
  const mean = rows.reduce((s, r) => s + (r.calories || 0), 0) / n;
  const variance = rows.reduce((s, r) => s + Math.pow((r.calories || 0) - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);
  return { hasEnoughData: true, n, mean, stddev };
}

// Checks a single meal against the two signals described above. Returns an array, which
// may be empty - a meal can trigger 0, 1 or both signals at once, since they are
// independent and describe different problems.
function detectMealAnomalies(meal, baseline) {
  const anomalies = [];
  const reportedCalories = meal.calories || 0;

  const impliedCalories = (meal.protein || 0) * 4 + (meal.carbs || 0) * 4 + (meal.fat || 0) * 9;
  const macroDiff = Math.abs(impliedCalories - reportedCalories);
  if (reportedCalories > 0 && macroDiff >= MACRO_MISMATCH_MIN_KCAL_DIFF && (macroDiff / reportedCalories) >= MACRO_MISMATCH_MIN_RATIO) {
    anomalies.push({
      type: 'macro_mismatch',
      message: `Suma kalorii z makroskładników (~${Math.round(impliedCalories)} kcal) różni się od podanych ${Math.round(reportedCalories)} kcal - możliwy błąd oszacowania przez AI.`
    });
  }

  if (baseline && baseline.hasEnoughData && baseline.stddev > 0) {
    const z = (reportedCalories - baseline.mean) / baseline.stddev;
    if (Math.abs(z) >= ANOMALY_Z_SCORE_THRESHOLD) {
      anomalies.push({
        type: z > 0 ? 'unusually_high_calories' : 'unusually_low_calories',
        message: z > 0
          ? `Ten posiłek (${Math.round(reportedCalories)} kcal) jest znacznie większy niż Twój zwykły posiłek (śr. ~${Math.round(baseline.mean)} kcal).`
          : `Ten posiłek (${Math.round(reportedCalories)} kcal) jest znacznie mniejszy niż Twój zwykły posiłek (śr. ~${Math.round(baseline.mean)} kcal).`
      });
    }
  }

  return anomalies;
}

module.exports = { getCalorieBaseline, detectMealAnomalies };
