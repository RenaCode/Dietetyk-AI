// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mealFingerprint, submissionKeyFor, randomSubmissionId } from './mealSubmission.js';

let n = 0;
const makeId = () => `key-${++n}`;

test('a retry of the same meal re-uses the key of the unconfirmed attempt', () => {
  const fp = mealFingerprint('owsianka', '2026-10-08', 'data:image/jpeg;base64,AAAA');
  const first = submissionKeyFor(null, fp, makeId);
  const retry = submissionKeyFor(first, mealFingerprint(' owsianka ', '2026-10-08', 'data:image/jpeg;base64,AAAA'), makeId);
  assert.equal(retry.key, first.key);
});

test('a different meal gets a new key', () => {
  const first = submissionKeyFor(null, mealFingerprint('owsianka', '2026-10-08', null), makeId);
  const other = submissionKeyFor(first, mealFingerprint('owsianka', '2026-10-09', null), makeId);
  assert.notEqual(other.key, first.key);
});

test('generated ids satisfy the backend format', () => {
  assert.match(randomSubmissionId(), /^[A-Za-z0-9-]{16,64}$/);
});
