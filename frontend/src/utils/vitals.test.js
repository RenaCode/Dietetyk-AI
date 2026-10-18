// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { getHrvCardState, getRhrCardState, trendStatusIcon } from './vitals.js';

// Audit 2026-10-10, U6: both cards passed a fixed status="success", so low HRV and a high
// resting heart rate were shown with the same green check as good readings.
test('low HRV is a warning, not a green check', () => {
  const s = getHrvCardState(30);
  assert.equal(s.status, 'warning');
  assert.notEqual(trendStatusIcon(s.status), '✓');
});

test('high resting heart rate is a warning, not a green check', () => {
  const s = getRhrCardState(72);
  assert.equal(s.status, 'warning');
  assert.notEqual(trendStatusIcon(s.status), '✓');
});

test('the threshold values themselves fall on the side their labels say', () => {
  assert.equal(getHrvCardState(48).status, 'success');
  assert.equal(getHrvCardState(47).status, 'warning');
  assert.equal(getRhrCardState(60).status, 'success');
  assert.equal(getRhrCardState(61).status, 'warning');
});

test('good readings keep the check', () => {
  assert.equal(trendStatusIcon(getHrvCardState(65).status), '✓');
  assert.equal(trendStatusIcon(getRhrCardState(52).status), '✓');
});

test('a missing reading is neutral - neither a check nor a warning', () => {
  for (const state of [getHrvCardState(null), getRhrCardState(undefined), getHrvCardState(NaN)]) {
    assert.equal(state.status, 'neutral');
    assert.equal(state.footerText, 'Brak danych');
    assert.equal(trendStatusIcon(state.status), '–');
  }
});
