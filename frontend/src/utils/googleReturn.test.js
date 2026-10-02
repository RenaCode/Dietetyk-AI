// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleReturn } from './googleReturn.js';

// The 2026-10 audit (H2): a URL must never be able to set the session on its own.
test('a session token in the fragment is ignored', () => {
  assert.equal(parseGoogleReturn('#google_token=sess_attacker', ''), null);
  assert.equal(parseGoogleReturn('#google_temp_token=temp_attacker', ''), null);
});

test('the one-time exchange code is picked up', () => {
  assert.deepEqual(parseGoogleReturn('#google_code=gx_abc', ''), { code: 'gx_abc' });
});

test('an error in the query string is reported', () => {
  assert.deepEqual(parseGoogleReturn('', '?google_error=registration_closed'), { error: 'registration_closed' });
});

test('an ordinary page load does nothing', () => {
  assert.equal(parseGoogleReturn('', ''), null);
  assert.equal(parseGoogleReturn('#', '?tab=settings'), null);
});
