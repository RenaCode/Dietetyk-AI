// Tests for the temporary-session marker (sessions.is_temp) and for the 2FA brute-force
// counter that used to be keyed by the tempToken value.
//
// The bug these tests pin down: requireAuth rejected a session only when
// `totp_enabled = 1 AND is_verified_2fa = 0`. A user being FORCED to configure 2FA has
// totp_enabled = 0 by definition, so the 5-minute tempToken handed out with
// `status: "setup_2fa"` sailed through requireAuth as a Bearer token and returned
// /api/user/profile and /api/settings with a 200 - no second factor anywhere. force_2fa
// therefore protected nothing.
//
// The companion bug: the 2FA lockout counted failures under a key built from the tempToken,
// and every password login mints a brand new random tempToken, so the counter reset on
// every retry. Five guesses, log in again, five more, for ever.
//
// These are end-to-end tests over a real express app (requireAuth + routes/auth +
// routes/account) against a throwaway SQLite file, because the hole lived precisely in the
// seam between the middleware and the routes - a unit test of either half alone would have
// missed it.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A fresh database per run: the login_attempts table is stateful and a reused file would
// carry a lockout from the previous run into scenario (c). Must be set before requiring
// ../db, which opens the file at require time.
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-temp-session-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
// Test-only values for the two secrets the backend refuses to start without. Set only when
// absent, so a caller passing real ones (see the `test` script in package.json) still wins.
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-temp-session';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-temp-session';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PASSWORD = 'testpassword123';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// A TOTP code that is guaranteed NOT to be the valid one for this secret, so the test never
// flakes by accidentally guessing right on the tick boundary.
function wrongCode(secret) {
  const valid = authenticator.generate(secret);
  return valid === '000000' ? '111111' : '000000';
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  // Mirrors server.js: requireAuth guards everything under /api, and the routers are
  // mounted behind it. The order is the point of the test - the exception list inside
  // requireAuth is what keeps the 2FA/password-change endpoints reachable.
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
  const username = 'tmpsess_' + Math.random().toString(36).substring(2, 9);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  // 25 hours old: the global force_2fa enforcement in /api/login only kicks in for accounts
  // older than 24h (see routes/auth.js), which is exactly the reported attack path.
  const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, created_at, force_password_change)
    VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)
  `, [
    username,
    passwordHash,
    'sync_' + Math.random().toString(36).substring(2),
    overrides.totp_enabled || 0,
    overrides.totp_secret || null,
    createdAt,
    overrides.force_password_change || 0
  ]);

  return { id: result.id, username };
}

async function setForce2fa(value) {
  await db.run(`
    INSERT INTO app_config (key, value) VALUES ('force_2fa', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [value]);
}

// (a) A tempToken must not authenticate an ordinary API request, and (b) it must still be
// able to finish the 2FA setup it was issued for. Both halves run off the same login, so
// the test cannot accidentally prove one with a token minted for the other.
async function testTempTokenBlockedButSetupWorks(baseUrl) {
  console.log('\n--- TEST: tempToken from setup_2fa is not an access token ---');
  await setForce2fa('1');
  const user = await createUser();

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.status === 200 && login.body.status === 'setup_2fa', 'login on a force_2fa account returns status "setup_2fa"');
  assert(typeof login.body.tempToken === 'string' && login.body.tempToken.length > 0, 'the setup_2fa response carries a tempToken');

  const tempToken = login.body.tempToken;

  const sessionRow = await db.get(`SELECT is_temp FROM sessions WHERE token = ?`, [tempToken]);
  assert(sessionRow && sessionRow.is_temp === 1, 'the temporary session is marked is_temp = 1 in the database');

  // The actual exploit: the same token replayed as a Bearer header.
  const profile = await get(baseUrl, '/api/user/profile', tempToken);
  assert(profile.status === 401, `GET /api/user/profile with a tempToken is rejected (got ${profile.status}, expected 401)`);
  assert(!profile.body.username, 'the rejected response leaks no username');

  const settings = await get(baseUrl, '/api/settings', tempToken);
  assert(settings.status === 401, `GET /api/settings with a tempToken is rejected (got ${settings.status}, expected 401)`);

  // ...and the half that must NOT break: the same token still completes 2FA setup.
  console.log('\n--- TEST: tempToken can still complete 2FA setup ---');
  const dbUser = await db.get(`SELECT totp_secret FROM users WHERE id = ?`, [user.id]);
  assert(!!dbUser.totp_secret, 'login stored a TOTP secret for the account');

  const setup = await post(baseUrl, '/api/verify-2fa-setup', {
    tempToken,
    code: authenticator.generate(dbUser.totp_secret)
  });
  assert(setup.status === 200, `POST /api/verify-2fa-setup with the tempToken succeeds (got ${setup.status}, expected 200)`);
  assert(typeof setup.body.token === 'string', 'verify-2fa-setup returns a permanent session token');

  const enabled = await db.get(`SELECT totp_enabled FROM users WHERE id = ?`, [user.id]);
  assert(enabled.totp_enabled === 1, '2FA is enabled on the account afterwards');

  // The permanent token issued by that step is a real session and must work everywhere the
  // tempToken did not - otherwise "blocked" would just mean "broken".
  const profileAfter = await get(baseUrl, '/api/user/profile', setup.body.token);
  assert(profileAfter.status === 200, `the permanent token returned by verify-2fa-setup opens /api/user/profile (got ${profileAfter.status}, expected 200)`);
  assert(profileAfter.body.username === user.username, 'the profile belongs to the user who logged in');
}

// The second route that a user holding ONLY a tempToken depends on. Locking it would leave
// an account with force_password_change = 1 permanently unable to log in.
async function testForcedPasswordChangeStillWorks(baseUrl) {
  console.log('\n--- TEST: tempToken can still change a forced password ---');
  await setForce2fa('0');
  const user = await createUser({ force_password_change: 1 });

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.status === 200 && login.body.status === 'force_password_change', 'login on a force_password_change account returns status "force_password_change"');

  const tempToken = login.body.tempToken;
  const sessionRow = await db.get(`SELECT is_temp FROM sessions WHERE token = ?`, [tempToken]);
  assert(sessionRow && sessionRow.is_temp === 1, 'the forced-password-change session is marked is_temp = 1');

  const blocked = await get(baseUrl, '/api/user/profile', tempToken);
  assert(blocked.status === 401, `the force_password_change tempToken is also rejected on /api/user/profile (got ${blocked.status}, expected 401)`);

  const newPassword = 'newpassword456';
  const change = await post(baseUrl, '/api/change-password-forced', { tempToken, newPassword });
  assert(change.status === 200, `POST /api/change-password-forced with the tempToken succeeds (got ${change.status}, expected 200)`);
  assert(typeof change.body.token === 'string', 'change-password-forced returns a real session token');

  const updated = await db.get(`SELECT password_hash, force_password_change FROM users WHERE id = ?`, [user.id]);
  assert(await bcrypt.compare(newPassword, updated.password_hash), 'the password was actually changed');
  assert(updated.force_password_change === 0, 'the force_password_change flag was cleared');

  const profileAfter = await get(baseUrl, '/api/user/profile', change.body.token);
  assert(profileAfter.status === 200, `the session token returned afterwards opens /api/user/profile (got ${profileAfter.status}, expected 200)`);
}

// The brute-force counter must survive a re-login. Keyed by tempToken it never did, because
// a re-login mints a new one.
async function test2faLockoutAccumulatesAcrossLogins(baseUrl) {
  console.log('\n--- TEST: 2FA lockout accumulates across re-logins ---');
  await setForce2fa('0');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret });

  const login1 = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login1.status === 200 && login1.body.status === 'require_2fa', 'login on a 2FA account returns status "require_2fa"');

  const bad = wrongCode(secret);
  const MAX_ATTEMPTS = 5; // must match MAX_ATTEMPTS in services/loginAttempts.js

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const attempt = await post(baseUrl, '/api/login-2fa', { tempToken: login1.body.tempToken, code: bad });
    assert(attempt.status === 400, `wrong 2FA code #${i} is rejected with 400`);
  }

  const overLimit = await post(baseUrl, '/api/login-2fa', { tempToken: login1.body.tempToken, code: bad });
  assert(overLimit.status === 429, `attempt #${MAX_ATTEMPTS + 1} on the same tempToken is locked out with 429 (got ${overLimit.status})`);

  // The escape hatch that used to reset everything: log in again with the (known) password
  // for a brand new tempToken. Note this also clears the password counter via
  // recordSuccess, so nothing at all stood in the attacker's way.
  const login2 = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login2.status === 200 && login2.body.status === 'require_2fa', 'a second login succeeds and hands out a fresh tempToken');
  assert(login2.body.tempToken !== login1.body.tempToken, 'the second tempToken is a different value from the first');

  const afterRelogin = await post(baseUrl, '/api/login-2fa', { tempToken: login2.body.tempToken, code: bad });
  assert(
    afterRelogin.status === 429,
    `a wrong code on the FRESH tempToken is still locked out with 429 - the counter did not reset (got ${afterRelogin.status})`
  );
}

async function run() {
  await db.initDb();

  const cols = await db.all(`PRAGMA table_info(sessions)`);
  assert(cols.some((c) => c.name === 'is_temp'), 'the migration added the is_temp column to sessions');

  const { server, baseUrl } = await startServer();
  try {
    await testTempTokenBlockedButSetupWorks(baseUrl);
    await testForcedPasswordChangeStillWorks(baseUrl);
    await test2faLockoutAccumulatesAcrossLogins(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 TEMPORARY SESSION TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.message || err));
    console.error('❌ TEMPORARY SESSION TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
