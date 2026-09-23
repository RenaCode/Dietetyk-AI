// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHoursMins } from './format.js';

// The charts fixed in the 2026-09-23 audit rely on this contract: an absent reading must
// come out as '--', never as a number that reads like a measurement.
test('an absent value formats as "--", not as zero', () => {
  assert.equal(formatHoursMins(null), '--');
  assert.equal(formatHoursMins(undefined), '--');
  assert.equal(formatHoursMins(NaN), '--');
  assert.notEqual(formatHoursMins(null), '0h 0m');
});

test('a measured zero still formats as a measurement', () => {
  assert.equal(formatHoursMins(0), '0h 0m');
});

test('minutes carry into the next hour instead of showing "7h 60m"', () => {
  assert.equal(formatHoursMins(7.5), '7h 30m');
  assert.equal(formatHoursMins(7.995), '8h 0m');
});
