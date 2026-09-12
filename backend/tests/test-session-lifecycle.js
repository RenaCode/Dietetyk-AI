// Tests for the parts of the authentication surface that the previous round did not touch:
// what happens to a session AFTER it has been issued, and whether the credential-changing
// endpoints actually revoke anything.
//
// Each block below is written so that it FAILS on the current code and passes once the
// matching fix lands. They are deliberately end-to-end over a real express app against a
// throwaway SQLite file, for the same reason test-temp-session.js is: every one of these
// bugs lives in the seam between a route and middleware/auth.js, and a unit test of either
// half alone reproduces none of them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-session-lifecycle-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-session-lifecycle';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-session-lifecycle';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateOAuthState, verifyOAuthState } = require('../services/oauthHelpers');

const PASSWORD = 'testpassword123';
const NEW_PASSWORD = 'brandnewpassword456';

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.log(`❌ ${message}`);
    return;
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  app.use(require('../routes/account'));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function post(baseUrl, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(baseUrl, urlPath, token) {
  const res = await fetch(baseUrl + urlPath, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createUser(overrides = {}) {
  const username = 'lifecycle_' + crypto.randomBytes(5).toString('hex');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
  `, [
    username,
    passwordHash,
    'sync_' + crypto.randomBytes(12).toString('hex'),
    overrides.totp_enabled || 0,
    overrides.totp_secret || null,
    overrides.status || 'active',
    createdAt
  ]);

  return { id: result.id, username };
}

// (1) Changing the password must revoke the other sessions of that account.
//
// Scenario: an attacker has stolen a session token (an unlocked laptop, a token read out of
// localStorage by an XSS, a shared machine). The victim notices and changes their password in
// Settings. The endpoint answers "Hasło zostało pomyślnie zmienione" - and the attacker's
// token keeps working, because nothing deletes it. requireAuth then slides expires_at forward
// by 7 days on every request the attacker makes, so the session never expires on its own
// either. The user has been told the account is secured and it is not.
async function testPasswordChangeRevokesOtherSessions(baseUrl) {
  console.log('\n--- TEST: changing the password revokes the other sessions ---');
  const user = await createUser();

  const attacker = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  const victim = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  const attackerToken = attacker.body.token;
  const victimToken = victim.body.token;
  assert(!!attackerToken && !!victimToken && attackerToken !== victimToken, 'two independent sessions exist on the account');

  const before = await get(baseUrl, '/api/user/profile', attackerToken);
  assert(before.status === 200, 'the stolen session works before the password change');

  const change = await post(baseUrl, '/api/user/change-password', {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD
  }, victimToken);
  assert(change.status === 200, 'the victim successfully changes the password');

  const after = await get(baseUrl, '/api/user/profile', attackerToken);
  assert(after.status === 401, `the stolen session is rejected after the password change (got ${after.status}, expected 401)`);
}

// (2) Replacing the TOTP secret must be as protected as switching 2FA off.
//
// POST /api/user/disable-2fa deliberately re-verifies the password, precisely so that holding
// a session alone cannot remove the second factor. POST /api/user/setup-2fa followed by
// POST /api/user/verify-2fa reaches the same outcome and asks for no password at all: it
// overwrites users.totp_secret with a fresh one while totp_enabled stays 1. The account still
// reports "2FA enabled", so nothing looks wrong - but the factor now belongs to whoever holds
// the session, and the real owner's authenticator app stops producing accepted codes.
async function testTotpReenrolmentRequiresPassword(baseUrl) {
  console.log('\n--- TEST: re-enrolling 2FA requires the password, like disabling it ---');
  const originalSecret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: originalSecret });

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.body.status === 'require_2fa', 'the account is protected by 2FA at login');
  const twoFa = await post(baseUrl, '/api/login-2fa', {
    tempToken: login.body.tempToken,
    code: authenticator.generate(originalSecret)
  });
  const stolenToken = twoFa.body.token;
  assert(!!stolenToken, 'a fully verified session exists (the token an attacker would steal)');

  const noPassword = await post(baseUrl, '/api/user/disable-2fa', {}, stolenToken);
  assert(noPassword.status === 400, 'disable-2fa refuses without the password (the control that is supposed to hold)');

  const setup = await post(baseUrl, '/api/user/setup-2fa', {}, stolenToken);
  const attackerSecret = setup.body.secret;
  const verified = await post(baseUrl, '/api/user/verify-2fa', {
    tempToken: setup.body.tempToken,
    code: authenticator.generate(attackerSecret)
  }, stolenToken);

  const row = await db.get('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [user.id]);
  const secretWasReplaced = verified.status === 200 && row.totp_secret === attackerSecret && row.totp_secret !== originalSecret;
  assert(!secretWasReplaced, 'setup-2fa + verify-2fa cannot silently replace the TOTP secret without the password');
  assert(row.totp_secret === originalSecret, "the legitimate owner's authenticator still matches the stored secret");
}

// (3) A non-active account must not be able to log in with a password.
//
// The Google callback checks `user.status !== 'active'` (routes/auth.js) before issuing a
// session. POST /api/login never looks at the column, and neither does requireAuth. The two
// doors into the same account therefore enforce different rules, which is the shape of bug
// that gets shipped the moment anyone adds a "suspend user" button to the admin panel: it
// will lock the Google door and leave the password door open.
async function testInactiveAccountCannotLogIn(baseUrl) {
  console.log('\n--- TEST: a suspended account cannot log in with a password ---');
  const user = await createUser({ status: 'suspended' });

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.status === 401 || login.status === 403, `login on a non-active account is refused (got ${login.status})`);
  assert(!login.body.token, 'no session token is handed out for a non-active account');
}

// (4) An already-issued session must stop working once the account stops being active.
async function testRequireAuthChecksStatus(baseUrl) {
  console.log('\n--- TEST: an existing session dies when the account is suspended ---');
  const user = await createUser();
  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  const token = login.body.token;
  assert((await get(baseUrl, '/api/user/profile', token)).status === 200, 'the session works while the account is active');

  await db.run(`UPDATE users SET status = 'suspended' WHERE id = ?`, [user.id]);
  const after = await get(baseUrl, '/api/user/profile', token);
  assert(after.status === 401 || after.status === 403, `the session is refused once the account is suspended (got ${after.status})`);
}

// (5) The `state` of the Google SIGN-IN flow must survive its own round trip.
//
// routes/auth.js builds the sign-in state as generateOAuthState(0, `google_login:${fp}`),
// where fp is a sha256 hex digest. The service label therefore contains a colon, so the state
// string has FIVE colon-separated parts - and verifyOAuthState only accepts four, returning
// null. isLoginFlow can never be true, so every Google sign-in ends at
// `/?google_error=csrf_failed`. Nothing logs an error: the failure is indistinguishable from
// CSRF protection doing its job. test-oauth-state.js misses it because it only ever exercises
// the four-part `google_link` label.
function testGoogleLoginStateRoundTrips() {
  console.log('\n--- TEST: the Google sign-in state verifies (5-part service label) ---');
  const fingerprint = crypto.createHash('sha256').update('203.0.113.7Mozilla/5.0').digest('hex');
  const service = `google_login:${fingerprint}`;
  const state = generateOAuthState(0, service);
  const verified = verifyOAuthState(state);

  assert(verified !== null, 'a state produced by generateOAuthState for the sign-in flow verifies');
  assert(verified !== null && verified.userId === 0, 'the sign-in state round-trips userId = 0');
  assert(verified !== null && verified.service === service, 'the sign-in state round-trips the full google_login:<fingerprint> label');
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    console.log('\n=== TESTS: session lifecycle and the rest of the auth surface ===');
    await testPasswordChangeRevokesOtherSessions(baseUrl);
    await testTotpReenrolmentRequiresPassword(baseUrl);
    await testInactiveAccountCannotLogIn(baseUrl);
    await testRequireAuthChecksStatus(baseUrl);
    testGoogleLoginStateRoundTrips();
  } finally {
    server.close();
    db.db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n💥 ${failures} assertion(s) failed - see the ❌ lines above.`);
    process.exit(1);
  }
  console.log('\n🎉 SESSION LIFECYCLE TESTS PASSED');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
