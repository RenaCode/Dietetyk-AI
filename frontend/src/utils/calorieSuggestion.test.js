// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { canApplyCalorieSuggestion, calorieSuggestionConfirmText } from './calorieSuggestion.js';

const identity = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

const suggestion = {
  hasEnoughData: true,
  suggestionNeeded: true,
  currentTargetCalories: 2000,
  suggestedTargetCalories: 1700,
  gap: 300,
  gapUncertainty: 120,
  suggestedTargetRange: { min: 1580, max: 1820 }
};

// Audit 2026-10-10, U5: the target was applied in one click with no word about how uncertain it was.
test('the confirmation shows the target range and the uncertainty', () => {
  const text = calorieSuggestionConfirmText(suggestion, identity);
  assert.match(text, /2000/);
  assert.match(text, /1700/);
  assert.match(text, /1580/);
  assert.match(text, /1820/);
  assert.match(text, /±120/);
});

test('a suggestion inside the noise cannot be applied', () => {
  assert.equal(canApplyCalorieSuggestion({ hasEnoughData: true, suggestionNeeded: false, withinNoise: true, gap: 280, gapUncertainty: 1450 }), false);
});

test('a target without its range (an older backend that skipped the noise test) cannot be applied', () => {
  const { suggestedTargetRange, ...withoutRange } = suggestion;
  assert.ok(suggestedTargetRange);
  assert.equal(canApplyCalorieSuggestion(withoutRange), false);
});

test('a checked suggestion can be applied', () => {
  assert.equal(canApplyCalorieSuggestion(suggestion), true);
  assert.equal(canApplyCalorieSuggestion(null), false);
});
