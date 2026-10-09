// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentMetricValue, barHeight } from './chart.js';

// --- the bug this file exists for (audit 2026-09-23, finding 5) ---------------------
// Trends.renderBarChart called calculateStats(key, true) unconditionally, so the "daily
// counter starts at zero" rule was applied to EVERY selected date, not just today. A past
// day with no row in health_metrics rendered as a measured "0h 0m" of sleep and "0 steps".

test('a daily counter with no reading on a PAST day is unknown, not zero', () => {
  // Oura ring flat on 18.09: no row in the database for that day.
  const value = resolveCurrentMetricValue(undefined, {
    isDailyCounter: true,
    isSelectedDateToday: false,
    priorValues: [7.2, 6.8, 7.5]
  });
  // Before the fix this returned 0 and the chart announced zero hours of sleep.
  assert.equal(value, null);
});

test('a daily counter with no reading on TODAY is zero (the counter really starts there)', () => {
  const value = resolveCurrentMetricValue(null, {
    isDailyCounter: true,
    isSelectedDateToday: true,
    priorValues: [9000, 11000]
  });
  assert.equal(value, 0);
  // ...and it must never be the previous day's steps carried forward.
  assert.notEqual(value, 11000);
});

test('a real zero reading is preserved and is distinguishable from no reading', () => {
  assert.equal(resolveCurrentMetricValue(0, { isDailyCounter: true, isSelectedDateToday: false }), 0);
  assert.equal(resolveCurrentMetricValue(undefined, { isDailyCounter: true, isSelectedDateToday: false }), null);
});

test('a state metric (weight, RHR) carries the last known reading forward', () => {
  assert.equal(
    resolveCurrentMetricValue(undefined, { isDailyCounter: false, priorValues: [82.4, 82.1, 81.9] }),
    81.9
  );
  // With nothing to carry forward there is still no answer.
  assert.equal(resolveCurrentMetricValue(undefined, { isDailyCounter: false, priorValues: [] }), null);
});

// --- bar geometry -------------------------------------------------------------------

test('a missing reading has no bar height, so it cannot be drawn as a zero-height bar', () => {
  assert.equal(barHeight(null, 20000, 65), null);
  assert.equal(barHeight(undefined, 20000, 65), null);
  assert.equal(barHeight(0, 20000, 65), 0);
});

test('bar height scales linearly and never divides by zero', () => {
  assert.equal(barHeight(10000, 20000, 65), 32.5);
  // maxVal of 0 would otherwise produce Infinity/NaN in the SVG geometry.
  assert.equal(barHeight(0, 0, 65), 0);
  assert.ok(Number.isFinite(barHeight(5, 0, 65)));
});

// S5 (audit 2026-10-09): the weight chart's scale started at 1, so 81-83 kg was a flat line.
import { lineChartScale } from './chart.js';

test('a weight scale spans the data, not 1..110', () => {
  const { min, max, ticks } = lineChartScale([81.2, 82.0, 82.9], [80, 95, 110], { fromData: true });
  assert.ok(min > 79 && min < 81.2, `min ${min}`);
  assert.ok(max > 82.9 && max < 85, `max ${max}`);
  assert.ok(ticks.every(t => t >= min && t <= max), 'ticks lie inside the scale');
  // A 1.7 kg range now fills most of the chart height instead of ~2% of it.
  assert.ok((82.9 - 81.2) / (max - min) > 0.5);
});

test('a perfectly flat week still has a usable range', () => {
  const { min, max } = lineChartScale([80, 80, 80], [80, 95, 110], { fromData: true });
  assert.ok(max - min >= 2);
});

test('0-100 scores keep their fixed axis', () => {
  const { min, max, ticks } = lineChartScale([72, 80], [0, 50, 100]);
  assert.equal(min, 0);
  assert.equal(max, 100);
  assert.deepEqual(ticks, [0, 50, 100]);
});

test('no data falls back to the fixed ticks', () => {
  assert.deepEqual(lineChartScale([null, undefined], [80, 95, 110], { fromData: true }).ticks, [80, 95, 110]);
});
