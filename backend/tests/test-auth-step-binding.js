// Tests that a temporary login token can only finish the step it was handed out for, and
// that an enabled second factor cannot be re-keyed from a bare session.
//
// The bugs these tests pin down:
//
// 1. /api/change-password-forced accepted ANY temp session. /api/login mints the same kind
//    of temp token for the 2FA step, right after the password check and before any TOTP
//    code, so the password alone was enough to set a new password on a 2FA account - and
//    the forced-change path also revokes every other session and every share link, so the
//    owner was locked out on top of it.
// 2. The reverse: the token minted for an OWED password change was accepted by
//    /api/login-2fa and /api/verify-2fa-setup, which turned it into a full session with the
//    password change never made.
// 3. POST /api/user/setup-2fa overwrote users.totp_secret even with 2FA already on. The
//    authenticator on the owner's phone stopped matching and the caller - possibly a stolen
//    session with no password - held the only valid secret.
//
// End-to-end over a real express app against a throwaway SQLite file, like
// tests/test-temp-session.js: the holes live in which token each route is willing to accept,
// which no unit test of a single function would show.
//
// Run with: node tests/test-auth-step-binding.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-auth-step-binding-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-auth-step-binding';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-auth-step-binding';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PASSWORD = 'testpassword123';
const NEW_PASSWORD = 'attackerpass999';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json());
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
  const username = 'stepbind_' + Math.random().toString(36).substring(2, 9);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, force_password_change)
    VALUES (?, ?, ?, ?, ?, 'user', 'active', ?)
  `, [
    username,
    passwordHash,
    'sync_' + Math.random().toString(36).substring(2),
    overrides.totp_enabled || 0,
    overrides.totp_secret || null,
    overrides.force_password_change || 0
  ]);
  return { id: result.id, username };
}

async function fullLogin(baseUrl, username, secret) {
  const step1 = await post(baseUrl, '/api/login', { username, password: PASSWORD });
  const step2 = await post(baseUrl, '/api/login-2fa', { tempToken: step1.body.tempToken, code: authenticator.generate(secret) });
  return step2.body.token;
}

async function test2faTokenCannotForcePasswordChange(baseUrl) {
  console.log('\n--- TEST: the 2FA-step token cannot change the password ---');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret });

  // The owner's own, fully verified session - it must survive the attack.
  const ownerToken = await fullLogin(baseUrl, user.username, secret);
  assert(typeof ownerToken === 'string', 'the owner holds a full 2FA-verified session');

  // The attacker knows only the password.
  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.body.status === 'require_2fa', 'a password-only login stops at "require_2fa"');

  const change = await post(baseUrl, '/api/change-password-forced', { tempToken: login.body.tempToken, newPassword: NEW_PASSWORD });
  assert(change.status === 401, `change-password-forced rejects the 2FA-step token (got ${change.status}, expected 401)`);

  const row = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [user.id]);
  assert(await bcrypt.compare(PASSWORD, row.password_hash), 'the password is unchanged');

  const ownerProfile = await get(baseUrl, '/api/user/profile', ownerToken);
  assert(ownerProfile.status === 200, `the owner's session was not revoked (got ${ownerProfile.status}, expected 200)`);
}

async function testOwedPasswordChangeCannotBeSkipped(baseUrl) {
  console.log('\n--- TEST: an owed password change cannot be skipped through the 2FA routes ---');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret, force_password_change: 1 });

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.body.status === 'force_password_change', 'login asks for the forced password change first');
  const tempToken = login.body.tempToken;

  const via2fa = await post(baseUrl, '/api/login-2fa', { tempToken, code: authenticator.generate(secret) });
  assert(via2fa.status === 401 && !via2fa.body.token, `login-2fa does not turn the password-change token into a session (got ${via2fa.status})`);

  const viaSetup = await post(baseUrl, '/api/verify-2fa-setup', { tempToken, code: authenticator.generate(secret) });
  assert(viaSetup.status === 401 && !viaSetup.body.token, `verify-2fa-setup does not either (got ${viaSetup.status})`);

  // ...and the legitimate path still works end to end.
  const change = await post(baseUrl, '/api/change-password-forced', { tempToken, newPassword: 'ownernewpass456' });
  assert(change.status === 200 && change.body.status === 'require_2fa', 'the same token still completes the forced change, which then asks for 2FA');

  const finish = await post(baseUrl, '/api/login-2fa', { tempToken: change.body.tempToken, code: authenticator.generate(secret) });
  assert(finish.status === 200 && typeof finish.body.token === 'string', 'after the change, login-2fa issues a full session');
}

async function testSetup2faDoesNotRekeyEnabled2fa(baseUrl) {
  console.log('\n--- TEST: setup-2fa does not replace the secret of an enabled second factor ---');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret });
  const token = await fullLogin(baseUrl, user.username, secret);

  const setup = await post(baseUrl, '/api/user/setup-2fa', {}, token);
  assert(setup.status === 409, `setup-2fa is refused while 2FA is enabled (got ${setup.status}, expected 409)`);
  assert(!setup.body.secret, 'no new secret is handed out');

  const row = await db.get(`SELECT totp_secret, totp_enabled FROM users WHERE id = ?`, [user.id]);
  assert(row.totp_secret === secret && row.totp_enabled === 1, 'the stored secret is still the one on the owner\'s phone');

  // A user without 2FA must still be able to set it up.
  const plain = await createUser();
  const plainLogin = await post(baseUrl, '/api/login', { username: plain.username, password: PASSWORD });
  const plainSetup = await post(baseUrl, '/api/user/setup-2fa', {}, plainLogin.body.token);
  assert(plainSetup.status === 200 && typeof plainSetup.body.secret === 'string', 'setup-2fa still works for an account without 2FA');
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    await test2faTokenCannotForcePasswordChange(baseUrl);
    await testOwedPasswordChangeCannotBeSkipped(baseUrl);
    await testSetup2faDoesNotRekeyEnabled2fa(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 AUTH STEP BINDING TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.message || err));
    console.error('❌ AUTH STEP BINDING TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
