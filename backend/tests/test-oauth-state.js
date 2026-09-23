// Tests for the OAuth `state` secret (services/oauthHelpers.js).
//
// The bug these guard against: OAUTH_STATE_SECRET used to fall back to APP_PASSWORD, and
// backend/.env.example shipped a concrete APP_PASSWORD value committed to the repository. A
// deployment that never set OAUTH_STATE_SECRET therefore signed OAuth state with a publicly known
// string, so anyone could mint `<victimId>:google_link:<salt>:<hmac>`, approve Google consent on
// their own account and have routes/auth.js bind that Google account to the victim's user row -
// after which "Sign in with Google" logs the attacker into the victim's account.
//
// The first test spawns a CHILD process, because the check runs when the module loads: once
// oauthHelpers has been required in this process the environment can no longer be varied.
// The child gets an explicit env (not process.env), so the result does not depend on what
// happens to sit in backend/.env on the machine running the tests.
//
// Run with: node tests/test-oauth-state.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Order matters: DATABASE_DIR must be set BEFORE db.js is imported (through oauthHelpers), and
// both secrets before oauthHelpers itself - they are read when the module loads, not when it is
// called. Fixed values rather than `||` defaults: these tests rely on the two secrets being
// DIFFERENT from each other.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-oauth-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-not-a-signing-key';
process.env.OAUTH_STATE_SECRET = 'test-dedicated-oauth-state-secret';

const BACKEND_DIR = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// Builds a state string the way an attacker would, using whichever secret they are guessing
// at. It follows the CURRENT payload shape (userId:service:issuedAt:salt:hmac) on purpose: a
// forgery rejected merely for having the wrong number of fields would prove nothing about the
// signature, which is what these assertions are actually about.
function forgeState(secret, userId, service, issuedAt = Date.now()) {
  const salt = crypto.randomBytes(16).toString('hex');
  const data = `${userId}:${service}:${issuedAt}:${salt}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}:${hmac}`;
}

// A state signed with the REAL secret but stamped at an arbitrary moment - used to show that
// a correctly signed state still ages out. Only the test knows the secret, which is the point:
// this is the strongest state an attacker who somehow obtained one could ever hold.
function genuinelySignedStateAt(userId, service, issuedAt) {
  return forgeState(process.env.OAUTH_STATE_SECRET, userId, service, issuedAt);
}

// Runs a snippet in a child process with a hand-built environment. PATH is passed through so
// node can find itself; nothing else from the parent leaks in.
function runChild(snippet, env) {
  return spawnSync(process.execPath, ['-e', snippet], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: Object.assign({ PATH: process.env.PATH, DATABASE_DIR: tmpDir }, env)
  });
}

function testStartupFailsWithoutSecret() {
  // The child both loads the module AND tries to use a state forged with APP_PASSWORD. Before the
  // fix it printed FORGED_STATE_ACCEPTED and exited 0; the module must now refuse to load at all.
  const snippet = `
    const crypto = require('crypto');
    const { verifyOAuthState } = require('./services/oauthHelpers');
    const data = '1:google_link:' + crypto.randomBytes(16).toString('hex');
    const hmac = crypto.createHmac('sha256', process.env.APP_PASSWORD).update(data).digest('hex');
    console.log(verifyOAuthState(data + ':' + hmac) ? 'FORGED_STATE_ACCEPTED' : 'FORGED_STATE_REJECTED');
    process.exit(0);
  `;
  const child = runChild(snippet, { APP_PASSWORD: 'known-committed-value' });

  assert(child.status !== 0, 'the backend refuses to start when OAUTH_STATE_SECRET is missing (non-zero exit)');
  assert(
    child.stderr.includes('OAUTH_STATE_SECRET'),
    'the startup error names the variable to set (OAUTH_STATE_SECRET)'
  );
  assert(
    /openssl rand|generate/i.test(child.stderr),
    'the startup error says how to produce a value, not just that one is missing'
  );
  assert(
    !child.stdout.includes('FORGED_STATE_ACCEPTED'),
    'a state signed with APP_PASSWORD is never accepted - there is no silent fallback to it'
  );
}

function testStateVerification() {
  const { generateOAuthState, verifyOAuthState } = require('../services/oauthHelpers');

  const genuine = generateOAuthState(7, 'google_link');
  const verified = verifyOAuthState(genuine);
  assert(verified && verified.userId === 7 && verified.service === 'google_link', 'a state produced by generateOAuthState verifies and round-trips userId + service');

  assert(
    verifyOAuthState(forgeState(process.env.APP_PASSWORD, 42, 'google_link')) === null,
    'a state signed with APP_PASSWORD is rejected (APP_PASSWORD is not a signing key any more)'
  );

  assert(
    verifyOAuthState(forgeState('some-other-secret', 42, 'google_link')) === null,
    'a state signed with an unrelated secret is rejected'
  );

  // The victim id is the part an attacker controls in the account-takeover path (routes/auth.js
  // writes google_id onto whatever user id the state names), so a valid state with a swapped id
  // must not survive.
  const tampered = genuine.replace(/^7:/, '42:');
  assert(verifyOAuthState(tampered) === null, 'a genuine state with the user id swapped is rejected (HMAC covers the id)');

  assert(verifyOAuthState('') === null, 'an empty state is rejected');
  assert(verifyOAuthState('7:google_link:abc') === null, 'a malformed state (wrong number of parts) is rejected');
}

// The state used to carry no timestamp, so a signature was valid for ever. GET /api/auth/google
// is a PUBLIC route: anyone could call it, read the state out of the 302 Location header and
// keep that string as a working login-CSRF ingredient indefinitely, handing it to a victim
// weeks later. These assertions are what stops that from coming back.
function testStateExpiry() {
  const { generateOAuthState, verifyOAuthState, OAUTH_STATE_MAX_AGE_MS } = require('../services/oauthHelpers');

  assert(
    typeof OAUTH_STATE_MAX_AGE_MS === 'number' && OAUTH_STATE_MAX_AGE_MS > 0 && OAUTH_STATE_MAX_AGE_MS <= 30 * 60 * 1000,
    `states expire, and the window is minutes rather than hours (got ${OAUTH_STATE_MAX_AGE_MS} ms)`
  );

  // Fresh: the ordinary case must keep working, or the assertions below would also pass
  // against a verifier that rejects everything.
  assert(verifyOAuthState(generateOAuthState(7, 'google_link')) !== null, 'a state minted right now still verifies');

  const oneSecondPastTheWindow = Date.now() - OAUTH_STATE_MAX_AGE_MS - 1000;
  assert(
    verifyOAuthState(genuinelySignedStateAt(7, 'google_link', oneSecondPastTheWindow)) === null,
    'a CORRECTLY SIGNED state older than the window is rejected - the signature alone no longer buys eternal validity'
  );

  // Just inside the window has to pass, otherwise the check is really "reject everything older
  // than a moment" and a user who takes 30 seconds over Google's consent screen is locked out.
  assert(
    verifyOAuthState(genuinelySignedStateAt(7, 'google_link', Date.now() - (OAUTH_STATE_MAX_AGE_MS - 30 * 1000))) !== null,
    'a state just inside the window still verifies'
  );

  // The timestamp is inside the signed payload, so rewriting it must break the HMAC. A
  // timestamp the caller could edit would be the same as no timestamp at all.
  const stale = genuinelySignedStateAt(7, 'google_link', oneSecondPastTheWindow);
  const staleParts = stale.split(':');
  const refreshed = `${staleParts[0]}:${staleParts[1]}:${Date.now()}:${staleParts[3]}:${staleParts[4]}`;
  assert(
    verifyOAuthState(refreshed) === null,
    'rewriting the timestamp on an expired state invalidates it (the HMAC covers issuedAt)'
  );

  // The previous format (userId:service:salt:hmac) carried no timestamp. Accepting it "for
  // compatibility" would leave the eternal-state hole open for as long as anyone held one -
  // which is for ever, since nothing expired them.
  const legacySalt = crypto.randomBytes(16).toString('hex');
  const legacyData = `7:google_link:${legacySalt}`;
  const legacyState = `${legacyData}:${crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET).update(legacyData).digest('hex')}`;
  assert(
    verifyOAuthState(legacyState) === null,
    'a state in the OLD unstamped format is rejected even when correctly signed - there is no compatibility path back to eternal states'
  );
}

// The regression that made "Sign in with Google" unusable: routes/auth.js binds the sign-in
// state to the client with `google_login:<sha256 fingerprint>` as the service, which adds a
// colon and therefore a fifth field to the state. verifyOAuthState only accepted exactly four
// fields, so every genuine sign-in callback was rejected as CSRF and redirected to
// /?google_error=csrf_failed. Nothing failed loudly - the application refused its own state.
//
// The binding is reproduced here exactly as routes/auth.js builds it, so this test breaks if
// that construction ever changes shape again. It is now the sha256 of the single-use nonce
// held in the browser's HttpOnly cookie (it used to be sha256(req.ip + User-Agent), which
// bound nothing - see the comment on GOOGLE_LOGIN_NONCE_COOKIE in routes/auth.js).
function testServiceContainingColons() {
  const { generateOAuthState, verifyOAuthState } = require('../services/oauthHelpers');

  const nonceHash = crypto.createHash('sha256').update(crypto.randomBytes(32).toString('hex')).digest('hex');
  const service = `google_login:${nonceHash}`;
  const state = generateOAuthState(0, service);

  assert(
    state.split(':').length === 6,
    'the Google sign-in state really does carry six colon-separated fields (userId:service:issuedAt:salt:hmac, with a colon inside the service), not four'
  );

  const verified = verifyOAuthState(state);
  assert(
    verified !== null,
    'a Google sign-in state (service containing a colon) verifies at all - it used to be rejected outright'
  );
  assert(
    verified.userId === 0 && verified.service === service,
    'the service is reassembled whole, so routes/auth.js can compare it against the recomputed fingerprint'
  );

  // Accepting a variable field count must not weaken the signature. The fingerprint is the
  // whole point of the sign-in state - it is what ties the callback to the browser that
  // started the flow - so a state with a different fingerprint spliced in has to fail.
  const parts = state.split(':');
  const spliced = `${parts[0]}:${parts[1]}:${'b'.repeat(64)}:${parts[3]}:${parts[4]}:${parts[5]}`;
  assert(
    verifyOAuthState(spliced) === null,
    'swapping the binding hash inside the service field invalidates the state (the HMAC covers it)'
  );

  // Re-cutting the same characters into a different field boundary must not verify either -
  // otherwise the variable field count would let one state be reinterpreted as another.
  const shifted = `${parts[0]}:${parts[1]}:${parts[2]}${parts[3]}:x:${parts[4]}:${parts[5]}`;
  assert(
    verifyOAuthState(shifted) === null,
    'moving the service/salt boundary within the same state is rejected - the HMAC pins the split'
  );
}

function run() {
  console.log('\n--- TESTY: services/oauthHelpers.js (OAUTH_STATE_SECRET) ---');
  testStartupFailsWithoutSecret();
  testStateVerification();
  testServiceContainingColons();
  console.log('\n🎉 OAUTH STATE TESTS PASSED\n');
}

try {
  run();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY OAUTH STATE NIEUDANE');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
