// Tests for revoking sessions and share links - the critical finding of the 2026-09-23 audit.
//
// THE BUG. Changing a password used to update one column and nothing else. `DELETE FROM
// sessions WHERE user_id` existed ONLY in the three admin endpoints (routes/admin.js); no
// user-reachable path revoked anything. So a stolen session token (XSS against localStorage,
// a borrowed laptop, a token pulled from an old log line) stayed valid after the victim
// changed their password - and since middleware/auth.js re-extends any token used at least
// once a week, the attacker's session effectively never expired. The victim had no lever at
// all: POST /api/logout deletes only the token in the caller's own header, the forced-change
// endpoint deleted only its tempToken, and there was no "log out everywhere". Active
// shared_reports links - unauthenticated URLs rendering the owner's full health report -
// survived everything too.
//
// WHY THESE ARE END-TO-END. The hole was never in a helper; it was in which routes called
// one. A unit test of revokeUserSessions would pass against the original code, where the
// helper did not exist and no route revoked anything - it would prove the fix while missing
// the bug entirely. So every assertion below goes through a real express app with the real
// middleware and routers, mints real sessions, and then asks the only question that matters:
// does the attacker's token still work?
//
// Run with: node tests/test-session-revocation.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-session-revocation-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-session-revocation';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-session-revocation';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PASSWORD = 'testpassword123';
const NEW_PASSWORD = 'brandnewpassword456';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  // Mirrors server.js: requireAuth guards everything under /api, routers behind it.
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  app.use(require('../routes/account'));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function request(baseUrl, method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const post = (baseUrl, p, body, token) => request(baseUrl, 'POST', p, body, token);
const get = (baseUrl, p, token) => request(baseUrl, 'GET', p, null, token);
const del = (baseUrl, p, body, token) => request(baseUrl, 'DELETE', p, body, token);

let userCounter = 0;

async function createUser(overrides = {}) {
  userCounter += 1;
  const username = `revoke_${userCounter}_${Math.random().toString(36).substring(2, 8)}`;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
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

// A session row written straight to the table: these stand in for the devices that are
// already logged in when the user acts - the attacker's stolen session among them. Minting
// them through /api/login would work too, but this keeps each test about revocation rather
// than about the login flow.
async function mintSession(userId, { days = 7 } = {}) {
  const token = 'sess_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  // The cap is written here for the same reason createSession writes it: this row stands in
  // for a device that is already logged in, and a real one is never uncapped. Leaving it NULL
  // would also make the fixture the only source of uncapped rows in the database, which would
  // then read as a production defect in the "nothing is left uncapped" assertion below.
  const absoluteExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const hasCapColumn = (await db.all(`PRAGMA table_info(sessions)`)).some(c => c.name === 'absolute_expires_at');
  if (hasCapColumn) {
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp) VALUES (?, ?, ?, ?, 1, 0)`,
      [token, userId, expiresAt, absoluteExpiresAt]
    );
  } else {
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa, is_temp) VALUES (?, ?, ?, 1, 0)`,
      [token, userId, expiresAt]
    );
  }
  return token;
}

async function mintShareLink(userId, { hoursValid = 24, revoked = 0 } = {}) {
  const token = 'share_' + Math.random().toString(36).substring(2);
  const expiresAt = new Date(Date.now() + hoursValid * 60 * 60 * 1000).toISOString();
  await db.run(
    `INSERT INTO shared_reports (user_id, token, days, expires_at, revoked) VALUES (?, ?, 30, ?, ?)`,
    [userId, token, expiresAt, revoked]
  );
  return token;
}

// The one question worth asking of a revoked token: does it still authorise anything?
async function tokenStillWorks(baseUrl, token) {
  const res = await get(baseUrl, '/api/settings', token);
  return res.status === 200;
}

async function shareIsRevoked(token) {
  const row = await db.get(`SELECT revoked FROM shared_reports WHERE token = ?`, [token]);
  return !!(row && row.revoked === 1);
}

async function testPasswordChangeRevokesOtherSessions(baseUrl) {
  console.log('\n--- TEST: changing a password ends every other session ---');
  const user = await createUser();
  const other = await createUser();

  const callerToken = await mintSession(user.id);     // the browser the user is sitting in
  const attackerToken = await mintSession(user.id);   // the stolen token
  const phoneToken = await mintSession(user.id);      // the user's own second device
  const strangerToken = await mintSession(other.id);  // an unrelated account

  assert(await tokenStillWorks(baseUrl, attackerToken), 'baseline: the stolen token authorises before the password change');

  const res = await post(baseUrl, '/api/user/change-password', {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD
  }, callerToken);
  assert(res.status === 200, `the password change succeeded (status ${res.status})`);

  // The whole point of the finding: this is what used to stay true after a password change.
  assert(!(await tokenStillWorks(baseUrl, attackerToken)), 'the stolen token no longer authorises ANYTHING');
  assert(!(await tokenStillWorks(baseUrl, phoneToken)), 'the other device was logged out too');
  assert(await tokenStillWorks(baseUrl, callerToken), 'the caller stays logged in - they do not log themselves out by changing their own password');
  assert(await tokenStillWorks(baseUrl, strangerToken), 'another user\'s session is untouched - the DELETE is scoped by user_id');

  const remaining = await db.get(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?`, [user.id]);
  assert(remaining.count === 1, `exactly one session row survives, the caller's (got ${remaining.count})`);
}

async function testPasswordChangeRevokesShareLinks(baseUrl) {
  console.log('\n--- TEST: changing a password revokes the active share links ---');
  const user = await createUser();
  const other = await createUser();
  const callerToken = await mintSession(user.id);

  const activeShare = await mintShareLink(user.id);
  const secondShare = await mintShareLink(user.id);
  const strangerShare = await mintShareLink(other.id);

  const res = await post(baseUrl, '/api/user/change-password', {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD
  }, callerToken);
  assert(res.status === 200, 'the password change succeeded');

  // A share link is an unauthenticated URL rendering the owner's full health report and is
  // tied to no session, so revoking sessions alone would leave an attacker who had time to
  // press "share" holding a working read handle to the victim's medical data.
  assert(await shareIsRevoked(activeShare), 'the active share link was revoked');
  assert(await shareIsRevoked(secondShare), 'and so was the second one');
  assert(!(await shareIsRevoked(strangerShare)), 'another user\'s share link is untouched');
  assert(res.body.revokedShares === 2, `the response reports how many links were revoked (got ${res.body.revokedShares})`);
}

async function testWrongCurrentPasswordRevokesNothing(baseUrl) {
  console.log('\n--- TEST: a failed password change must not revoke anything (known-bad) ---');
  const user = await createUser();
  const callerToken = await mintSession(user.id);
  const phoneToken = await mintSession(user.id);
  const share = await mintShareLink(user.id);

  const res = await post(baseUrl, '/api/user/change-password', {
    currentPassword: 'not-the-current-password',
    newPassword: NEW_PASSWORD
  }, callerToken);
  assert(res.status === 400, `a wrong current password is rejected (status ${res.status})`);

  // Revocation on a FAILED attempt would hand anyone holding a session token a way to log
  // the real owner out of every device and break their doctor's link, without knowing the
  // password at all.
  assert(await tokenStillWorks(baseUrl, phoneToken), 'the other device is still logged in');
  assert(!(await shareIsRevoked(share)), 'the share link still works');
}

async function testForcedPasswordChangeRevokesOtherSessions(baseUrl) {
  console.log('\n--- TEST: a forced password change ends every other session ---');
  const user = await createUser({ force_password_change: 1 });
  const attackerToken = await mintSession(user.id);

  // A forced change is often the FIRST thing that happens after an administrator resets a
  // compromised account. This path used to delete only the tempToken it was handed, so any
  // session from before the reset survived it and the reset achieved nothing.
  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.body.status === 'force_password_change', `login demands a password change (got ${login.body.status})`);

  const res = await post(baseUrl, '/api/change-password-forced', {
    tempToken: login.body.tempToken,
    newPassword: NEW_PASSWORD
  });
  assert(res.status === 200, `the forced change succeeded (status ${res.status})`);
  assert(!(await tokenStillWorks(baseUrl, attackerToken)), 'the session that predates the forced change no longer authorises anything');
}

async function testDisable2faRevokesSessionsButKeepsShares(baseUrl) {
  console.log('\n--- TEST: disabling 2FA ends other sessions but leaves share links alone ---');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret });
  const callerToken = await mintSession(user.id);
  const attackerToken = await mintSession(user.id);
  const share = await mintShareLink(user.id);

  const res = await post(baseUrl, '/api/user/disable-2fa', { password: PASSWORD }, callerToken);
  assert(res.status === 200, `2FA was disabled (status ${res.status})`);

  // Turning the second factor off lowers the protection on every session that exists, so
  // the sessions that exist do not get to keep running.
  assert(!(await tokenStillWorks(baseUrl, attackerToken)), 'the other session was revoked');
  assert(await tokenStillWorks(baseUrl, callerToken), 'the caller stays logged in');

  // Deliberately NOT revoked here, unlike on a password change: disabling 2FA is not "my
  // credentials leaked", and silently breaking a report the user sent to their doctor would
  // be a surprise with no security gain.
  assert(!(await shareIsRevoked(share)), 'the share link survives - this is a deliberate difference from the password change');
}

async function testLogoutAll(baseUrl) {
  console.log('\n--- TEST: "log out all other devices" ---');
  const user = await createUser();
  const callerToken = await mintSession(user.id);
  const deviceA = await mintSession(user.id);
  const deviceB = await mintSession(user.id);

  const res = await post(baseUrl, '/api/user/logout-all', {}, callerToken);
  assert(res.status === 200, `the endpoint answered (status ${res.status})`);
  assert(res.body.revokedSessions === 2, `it reports the two sessions it ended (got ${res.body.revokedSessions})`);
  assert(!(await tokenStillWorks(baseUrl, deviceA)) && !(await tokenStillWorks(baseUrl, deviceB)), 'both other devices are logged out');
  assert(await tokenStillWorks(baseUrl, callerToken), 'the caller keeps working - this is not a self-logout');

  // No password is required, on purpose: the endpoint only ever REMOVES access, and demanding
  // one would lock out Google-created accounts, whose password hash is random and unknown to
  // anybody - exactly the accounts that need this most.
  const secondRun = await post(baseUrl, '/api/user/logout-all', {}, callerToken);
  assert(secondRun.status === 200 && secondRun.body.revokedSessions === 0, 'running it again is harmless and reports nothing left to revoke');
}

async function testAccountDeletionPasswordCheckIsRateLimited(baseUrl) {
  console.log('\n--- TEST: guessing the password on an authenticated endpoint gets locked out ---');
  const user = await createUser();
  const callerToken = await mintSession(user.id);

  // Someone holding only a session token - the exact situation these password prompts exist
  // to survive - used to be able to sit on this endpoint and guess for ever: the 5-try
  // lockout lived only in /api/login.
  let sawLockout = false;
  let sawRejection = false;
  for (let i = 0; i < 8; i++) {
    const res = await del(baseUrl, '/api/user/account', { password: `wrong-guess-${i}` }, callerToken);
    if (res.status === 400) sawRejection = true;
    if (res.status === 429) { sawLockout = true; break; }
  }
  assert(sawRejection, 'a wrong password is rejected');
  assert(sawLockout, 'repeated wrong passwords hit a 429 lockout rather than being allowed indefinitely');

  // Without a row here the lockout would be invisible: the weekly admin report is built from
  // app_logs, so a brute-force campaign against this endpoint would leave no trace anywhere.
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM app_logs WHERE category = 'AUTH_PASSWORD_FAILURE' AND message LIKE ?`,
    [`%UID: ${user.id}%`]
  );
  assert(row.count > 0, `the failures are recorded in app_logs against this account, so they reach the weekly admin report (got ${row.count})`);
}

async function testAbsoluteSessionCap(baseUrl) {
  console.log('\n--- TEST: the hard cap on total session lifetime ---');
  const columns = await db.all(`PRAGMA table_info(sessions)`);
  const hasCap = columns.some(c => c.name === 'absolute_expires_at');

  const user = await createUser();
  const token = await mintSession(user.id, { days: 5 });

  if (!hasCap) {
    // The second half of the finding - "a token used once a week never expires" - is NOT
    // closed yet: middleware/auth.js reads sessions.absolute_expires_at, and that column does
    // not exist in db.js, so the cap is dormant and renewal is still unbounded. The migration
    // belongs to db.js (schema + backfill + writing the value when a session is created).
    // Until it lands this asserts only that the dormant code is harmless.
    console.log('   ⚠️  sessions.absolute_expires_at does not exist yet - the renewal cap is DORMANT (db.js migration pending)');
    assert(await tokenStillWorks(baseUrl, token), 'without the column the middleware still authorises normally rather than erroring');
    const after = await db.get(`SELECT expires_at FROM sessions WHERE token = ?`, [token]);
    assert(!!after, 'and the session row survives the request');
    return;
  }

  await db.run(
    `UPDATE sessions SET absolute_expires_at = ? WHERE token = ?`,
    [new Date(Date.now() - 60 * 1000).toISOString().replace('T', ' ').slice(0, 19), token]
  );
  assert(!(await tokenStillWorks(baseUrl, token)), 'a session past its absolute cap is refused even though expires_at is still in the future');
  const row = await db.get(`SELECT token FROM sessions WHERE token = ?`, [token]);
  assert(!row, 'and the row is deleted rather than left behind as a live row that answers "expired"');
}

async function testCreateSessionWritesTheCap(baseUrl) {
  console.log('\n--- TEST: every new session is born with an absolute cap ---');
  const columns = await db.all(`PRAGMA table_info(sessions)`);
  if (!columns.some(c => c.name === 'absolute_expires_at')) {
    console.log('   ⚠️  sessions.absolute_expires_at does not exist yet - nothing to write (db.js migration pending)');
    return;
  }

  const plain = await createUser();
  const forced = await createUser({ force_password_change: 1 });

  const permanentLogin = await post(baseUrl, '/api/login', { username: plain.username, password: PASSWORD });
  assert(!!permanentLogin.body.token, 'a normal login returns a permanent session token');
  const tempLogin = await post(baseUrl, '/api/login', { username: forced.username, password: PASSWORD });
  assert(!!tempLogin.body.tempToken, 'a forced-change login returns a temporary session token');

  const permanentRow = await db.get(`SELECT expires_at, absolute_expires_at FROM sessions WHERE token = ?`, [permanentLogin.body.token]);
  const tempRow = await db.get(`SELECT expires_at, absolute_expires_at FROM sessions WHERE token = ?`, [tempLogin.body.tempToken]);

  // db.js carries a standing repair - UPDATE sessions SET absolute_expires_at = expires_at
  // WHERE absolute_expires_at IS NULL - which logs "[DB MIGRATE] Capped N session(s)". That
  // statement is meant to match NOTHING once createSession writes the column, and a non-zero
  // count is documented there as meaning "createSession stopped writing it". This assertion
  // is the same check, made where it fails loudly instead of in a log line during a restart.
  assert(!!permanentRow.absolute_expires_at, 'the permanent session row carries a cap, so the db.js repair has nothing to fix');
  assert(!!tempRow.absolute_expires_at, 'the temporary session row carries one too');

  const uncapped = await db.get(`SELECT COUNT(*) AS count FROM sessions WHERE absolute_expires_at IS NULL`);
  assert(uncapped.count === 0, `no session row anywhere is left uncapped (got ${uncapped.count})`);

  // A NEW session gets the full window measured from now - unlike the db.js backfill, which
  // writes expires_at because a pre-migration row has no evidence of when it was born and
  // may therefore only ever be shortened.
  const permanentExpiry = new Date(permanentRow.expires_at.replace(' ', 'T') + 'Z').getTime();
  const permanentCap = new Date(permanentRow.absolute_expires_at.replace(' ', 'T') + 'Z').getTime();
  assert(
    permanentCap > permanentExpiry,
    'the cap sits beyond the 7-day expiry, so the rolling renewal still has room to work - a cap at or below it would make every session a fixed 7 days'
  );
  const capDays = Math.round((permanentCap - Date.now()) / (24 * 60 * 60 * 1000));
  assert(capDays === 30, `the cap is the full 30 days from creation (got ${capDays})`);

  // A temporary session is never renewed (requireAuth refuses is_temp outright), so its cap
  // is its own 5-minute expiry rather than a month it will never see.
  assert(
    tempRow.absolute_expires_at === tempRow.expires_at,
    `a temporary session is capped at its own expiry (got ${tempRow.absolute_expires_at} vs ${tempRow.expires_at})`
  );
}

async function run() {
  await db.initDb();

  const { server, baseUrl } = await startServer();
  try {
    await testPasswordChangeRevokesOtherSessions(baseUrl);
    await testPasswordChangeRevokesShareLinks(baseUrl);
    await testWrongCurrentPasswordRevokesNothing(baseUrl);
    await testForcedPasswordChangeRevokesOtherSessions(baseUrl);
    await testDisable2faRevokesSessionsButKeepsShares(baseUrl);
    await testLogoutAll(baseUrl);
    await testAccountDeletionPasswordCheckIsRateLimited(baseUrl);
    await testAbsoluteSessionCap(baseUrl);
    await testCreateSessionWritesTheCap(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 SESSION REVOCATION TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.message || err));
    console.error('❌ SESSION REVOCATION TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
