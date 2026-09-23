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
