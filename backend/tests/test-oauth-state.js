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

// Builds a state string the way an attacker would, using whichever secret they are guessing at.
function forgeState(secret, userId, service) {
  const salt = crypto.randomBytes(16).toString('hex');
  const data = `${userId}:${service}:${salt}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}:${hmac}`;
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

function run() {
  console.log('\n--- TESTY: services/oauthHelpers.js (OAUTH_STATE_SECRET) ---');
  testStartupFailsWithoutSecret();
  testStateVerification();
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
