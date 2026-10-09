// Pure helpers for the hand-rolled SVG charts. Kept out of the components so the rules
// below can be unit-tested without mounting React.

// Decides what "the value for the selected day" is, and in particular when there is NO
// answer at all.
//
// The three-state result matters more than it looks: `null` means "we have no reading for
// this day", `0` means "the reading exists and it is zero". Rendering the second when we
// only know the first is the app inventing a measurement.
//
// Failure mode this encodes (audit 2026-09-23, finding 5): renderBarChart passed
// `noFallbackToday = true` unconditionally, while `selectedDate` can point at ANY past
// day. The comment justifying the 0 only ever applied to today, where a daily counter
// genuinely starts at zero before the first sync of the day lands. For a past day with no
// row in health_metrics the chart therefore announced "0h 0m" of sleep and "0 steps" -
// i.e. the app claimed the user had not slept and had not moved, when in truth the Oura
// ring had simply been flat that day. The existing `stats.current !== null` guards could
// never fire, because the substituted value was 0, not null.
//
// @param {number|null|undefined} rawValue the reading for the selected day, if any
// @param {boolean} isDailyCounter metric that resets each day (steps, calories, sleep
//   duration) - carrying an older day's value forward would be a lie of a different kind
// @param {boolean} isSelectedDateToday selected day is today in the backend's timezone
// @param {Array<number>} priorValues readings from the period, oldest first - used as the
//   carry-forward source for metrics that are a state rather than a counter (weight, RHR)
// @returns {number|null} the value to display, or null for "no data"
export function resolveCurrentMetricValue(rawValue, { isDailyCounter = false, isSelectedDateToday = false, priorValues = [] } = {}) {
  if (rawValue !== null && rawValue !== undefined) return rawValue;
  if (isDailyCounter) {
    // Today before the first sync: the counter really is at zero.
    // Any other day: absence of a row is absence of knowledge.
    return isSelectedDateToday ? 0 : null;
  }
  return priorValues.length > 0 ? priorValues[priorValues.length - 1] : null;
}

// Height of a bar in SVG user units. A missing reading returns null so the caller can draw
// an empty slot instead of a zero-height bar - a day with no data must not be visually
// identical to a day that measured zero.
export function barHeight(value, maxVal, chartHeight) {
  if (value === null || value === undefined) return null;
  const safeMax = maxVal > 0 ? maxVal : 1;
  return (value / safeMax) * chartHeight;
}

// Y-scale of a line chart: { min, max, ticks }.
//
// renderLineChart in Trends.jsx used to take min/max over the data, the fixed ticks AND the
// constant 1 (audit 2026-10-09, S5). For body weight that meant a scale from 1 to 110 kg: a
// week between 81 and 83 kg moved the line by about 1.4 px of a 75 px chart - a flat line -
// and the 80/95/110 labels piled up in one corner. RHR and HRV had the same problem with
// their fixed ticks.
//
// `fromData` (weight, RHR, HRV - quantities whose interesting range is a few units around
// the person's own level): the scale spans the data with a margin, never forced to include 1
// or a fixed tick. Otherwise (0-100 scores) the fixed ticks stay, because there the absolute
// position IS the information. With no data, the fixed ticks are used either way.
// `minSpan` keeps a perfectly stable week from collapsing to a zero-height range.
export function lineChartScale(values, fixedTicks, { fromData = false, minSpan = 2 } = {}) {
  const valid = (values || []).filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!fromData || valid.length === 0) {
    const all = [...valid, ...fixedTicks];
    const min = Math.min(...all);
    const max = Math.max(...all);
    return { min, max: max > min ? max : min + 1, ticks: fixedTicks };
  }
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  const span = Math.max(hi - lo, minSpan);
  const pad = span * 0.2;
  const mid = (lo + hi) / 2;
  const min = mid - span / 2 - pad;
  const max = mid + span / 2 + pad;
  const round1 = (v) => Math.round(v * 10) / 10;
  return { min, max, ticks: [round1(lo), round1(mid), round1(hi)] };
}
