// How sure the calorie target suggestion is (audit 2026-10-10, U5).
//
// /api/dashboard/calorie-target-suggestion compares the logged daily balance with the balance
// implied by the weight trend (a least-squares slope times 7700 kcal/kg) and proposes moving
// the target by the gap. The slope comes from as few as 4 weigh-ins over 10+ days, and
// day-to-day weight moves by 0.5-1 kg with water and gut content alone; multiplied by 7700
// that noise is hundreds of kcal per day. The audit put the gap's uncertainty at ±314 kcal/d,
// while the card offered a one-click "Zastosuj cel" for any gap above a fixed
// 100 kcal - i.e. it routinely rewrote the user's goal on noise.
//
// Now the endpoint computes the 95% confidence half-width of the slope and:
//   - proposes nothing when the gap is inside it (the data cannot tell the gap from zero),
//   - otherwise returns the range of targets consistent with the data, which the UI shows in
//     a confirmation before anything is saved.
//
// Only the weight side is treated as uncertain. The logged side has its own error - portion
// estimates - but that error is exactly what the gap is meant to reveal, so it is not noise
// to be discounted here.
//
// The interval is still optimistic: daily weights are autocorrelated (a salty dinner shows up
// on two or three mornings), which OLS assumes away, so the true uncertainty is wider. Erring
// that way only means fewer suggestions, never more.

const KCAL_PER_KG = 7700;

// Two-sided 95% Student t quantiles for 1..30 degrees of freedom; beyond that the normal 1.96
// is within 2%. With the minimum of 4 weigh-ins there are only 2 degrees of freedom, where
// using 1.96 instead of 4.30 would halve the interval.
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
];

function tQuantile95(df) {
  if (df < 1) return Infinity;
  return df <= T_975.length ? T_975[df - 1] : 1.96;
}

// Least-squares slope (kg/day) of points {x: day offset, y: kg} and the 95% half-width of
// that slope. null when the slope is undefined (fewer than 3 points, or all on one day) - with
// 2 points the line fits exactly and says nothing about noise.
function slopeWithUncertainty(points) {
  const n = points.length;
  if (n < 3) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssr = points.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const standardError = Math.sqrt(ssr / (n - 2) / sxx);
  return { slope, halfWidth95: tQuantile95(n - 2) * standardError };
}

// The decision itself, given the logged balance (kcal/day), the weigh-in points and the
// current target. `minMeaningfulGap` keeps the old floor: even a precisely measured 60 kcal
// gap is not worth a goal change.
function evaluateCalorieGap({ loggedDailyBalance, points, currentTargetCalories, minMeaningfulGap }) {
  const fit = slopeWithUncertainty(points);
  if (!fit) return null;
  const actualDailyBalance = fit.slope * KCAL_PER_KG;
  const gap = actualDailyBalance - loggedDailyBalance;
  const gapUncertainty = fit.halfWidth95 * KCAL_PER_KG;
  const threshold = Math.max(minMeaningfulGap, gapUncertainty);
  const result = {
    actualDailyBalance,
    gap,
    gapUncertainty,
    suggestionNeeded: Math.abs(gap) >= threshold,
    withinNoise: Math.abs(gap) >= minMeaningfulGap && Math.abs(gap) < gapUncertainty
  };
  if (result.suggestionNeeded) {
    result.suggestedTargetCalories = currentTargetCalories - gap;
    // The targets consistent with the data at 95%: gap ± its uncertainty.
    result.suggestedTargetRange = {
      min: currentTargetCalories - gap - gapUncertainty,
      max: currentTargetCalories - gap + gapUncertainty
    };
  }
  return result;
}

module.exports = { KCAL_PER_KG, tQuantile95, slopeWithUncertainty, evaluateCalorieGap };
