// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { newMealSubmission, retryMealSubmission, randomSubmissionId } from './mealSubmission.js';

// Audit round 2: the same content sent again after an unconfirmed attempt reused the key, so a
// deliberately repeated meal was answered "replayed" and never saved.
test('two deliberate submissions of the same meal get different keys', () => {
  const a = newMealSubmission('owsianka', '2026-10-08', 'data:image/jpeg;base64,AAAA');
  const b = newMealSubmission('owsianka', '2026-10-08', 'data:image/jpeg;base64,AAAA');
  assert.notEqual(a.key, b.key);
});

test('an explicit retry re-sends the same key and content', () => {
  const a = newMealSubmission('owsianka', '2026-10-08', null);
  const r = retryMealSubmission(a);
  assert.equal(r.key, a.key);
  assert.equal(r.rawText, 'owsianka');
  assert.equal(r.date, '2026-10-08');
});

test('there is no retry without an earlier submission', () => {
  assert.throws(() => retryMealSubmission(null));
});

test('generated ids satisfy the backend format', () => {
  assert.match(randomSubmissionId(), /^[A-Za-z0-9-]{16,64}$/);
});
