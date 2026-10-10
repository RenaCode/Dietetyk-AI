// Account-security findings of the second audit round (2026-10-10), end to end over a real
// express app against a throwaway SQLite file.
//
// N-W1  Undoing an e-mail change restored the ATTACKER's address when they had changed it
//       twice: previous_email held only the address being replaced, so owner -> evil1 -> evil2
//       followed by the owner's "log out other devices" left evil1 in place.
// N-W2  The admin-forced password change revoked sessions and share links but left the
//       redirected e-mail, a Google identity linked by the attacker and the sync token.
// N-S1  send-*-summary mailed health summaries to ANY address in the request, no password.
// N-S3  unlink-google needed nothing - for a Google-created account, a permanent lock-out.
// N-S4  A Google-created account was asked for a password it never had, and every attempt
//       counted towards the lockout.
//
// Run with: node tests/test-account-security-r2.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-account-security-r2-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-account-security-r2';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-account-security-r2';

const BACKEND_DIR = path.join(__dirname, '..');
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });
// The route's gate is what is under test, not the summary itself: record who it was sent to.
const summarySends = [];
const recordSend = (kind) => async (userId, customEmail) => { summarySends.push({ kind, userId, to: customEmail || 'ACCOUNT' }); };
stubModule('services/summaries.js', {
  sendWeeklySummaryForUser: recordSend('weekly'),
  sendDailySummaryForUser: recordSend('daily'),
  sendMonthlySummaryForUser: recordSend('monthly'),
  getUserSettings: async () => ({}),
  aggregateNutritionAndHealth: async () => ({}),
  buildGoalPaceAnalysis: () => null
});

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PASSWORD = 'ownerpass123';

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
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function call(baseUrl, method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createUser(overrides = {}) {
  const username = 'r2_' + Math.random().toString(36).substring(2, 9);
  const email = `${username}@owner.invalid`;
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status, email, google_id, password_set)
    VALUES (?, ?, ?, 0, 'user', 'active', ?, ?, ?)
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_' + username + 'x'.repeat(16), email, overrides.google_id || null, overrides.password_set === 0 ? 0 : 1]);
  return { id: result.id, username, email };
}

const login = async (baseUrl, username, password = PASSWORD) => (await call(baseUrl, 'POST', '/api/login', { username, password })).body.token;
const pwcheckRows = async (userId) => (await db.get(`SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE ?`, [`%pwcheck_user:${userId}`])).n;

async function testTwoChangesFromOneSession(baseUrl) {
  console.log('\n--- TEST (N-W1): two changes from the attacker session, then "log out other devices" ---');
  const user = await createUser();
  const owner = await login(baseUrl, user.username);
  const attacker = await login(baseUrl, user.username);
  await call(baseUrl, 'POST', '/api/user/profile', { email: 'evil1@attacker.invalid', currentPassword: PASSWORD }, attacker);
  await call(baseUrl, 'POST', '/api/user/profile', { email: 'evil2@attacker.invalid', currentPassword: PASSWORD }, attacker);
  const out = await call(baseUrl, 'POST', '/api/user/logout-all', {}, owner);
  assert(out.status === 200 && out.body.emailReverted === true, 'the revert is reported');
  const row = await db.get(`SELECT email FROM users WHERE id = ?`, [user.id]);
  assert(row.email === user.email, `the owner's ORIGINAL address is back, not evil1 (got ${row.email})`);
}

async function testForcedChangeCleansUp(baseUrl) {
  console.log('\n--- TEST (N-W2): the admin-forced password change undoes what the attacker set ---');
  const user = await createUser();
  const attacker = await login(baseUrl, user.username);
  await call(baseUrl, 'POST', '/api/user/profile', { email: 'evil@attacker.invalid', currentPassword: PASSWORD }, attacker);
  await db.run(`UPDATE users SET google_id = 'g-attacker-sub' WHERE id = ?`, [user.id]);
  const syncBefore = (await db.get(`SELECT sync_token FROM users WHERE id = ?`, [user.id])).sync_token;

  // What POST /api/admin/users/:id/force-password-change does.
  await db.run(`UPDATE users SET force_password_change = 1 WHERE id = ?`, [user.id]);
  await db.run(`DELETE FROM sessions WHERE user_id = ?`, [user.id]);

  const step = await call(baseUrl, 'POST', '/api/login', { username: user.username, password: PASSWORD });
  assert(step.body.status === 'force_password_change', 'the owner is asked for a new password');
  const change = await call(baseUrl, 'POST', '/api/change-password-forced', { tempToken: step.body.tempToken, newPassword: 'ownernew456' });
  assert(change.status === 200, `the forced change succeeds (got ${change.status})`);
  const row = await db.get(`SELECT email, google_id, sync_token FROM users WHERE id = ?`, [user.id]);
  assert(row.email === user.email, `the redirected e-mail is undone (got ${row.email})`);
  assert(row.google_id === null, 'the Google identity linked by the attacker is gone');
  assert(row.sync_token !== syncBefore, 'the Apple Health sync token is rotated');
}

async function testSummaryOnlyToAccountAddress(baseUrl) {
  console.log('\n--- TEST (N-S1): a summary goes elsewhere only with the password ---');
  const user = await createUser();
  const token = await login(baseUrl, user.username);
  summarySends.length = 0;
  const noPw = await call(baseUrl, 'POST', '/api/user/send-weekly-summary', { email: 'x@evil.invalid' }, token);
  assert(noPw.status === 400 && noPw.body.requirePassword === true, `another address without the password is refused (got ${noPw.status})`);
  for (const kind of ['daily', 'monthly']) {
    const r = await call(baseUrl, 'POST', `/api/user/send-${kind}-summary`, { email: 'x@evil.invalid' }, token);
    assert(r.status === 400, `${kind} too (got ${r.status})`);
  }
  assert(summarySends.length === 0, 'nothing was sent');
  const own = await call(baseUrl, 'POST', '/api/user/send-weekly-summary', {}, token);
  assert(own.status === 200 && summarySends[0] && summarySends[0].to === 'ACCOUNT', 'without an address it goes to the account address');
  const sameCase = await call(baseUrl, 'POST', '/api/user/send-weekly-summary', { email: user.email.toUpperCase() }, token);
  assert(sameCase.status === 200 && summarySends[1].to === 'ACCOUNT', 'the account address itself needs no password');
  const withPw = await call(baseUrl, 'POST', '/api/user/send-weekly-summary', { email: 'doctor@clinic.invalid', currentPassword: PASSWORD }, token);
  assert(withPw.status === 200 && summarySends[2].to === 'doctor@clinic.invalid', 'with the password another address is allowed');
}

async function testUnlinkGoogleNeedsPassword(baseUrl) {
  console.log('\n--- TEST (N-S3): unlinking Google needs the password ---');
  const user = await createUser({ google_id: 'g-owner' });
  const token = await login(baseUrl, user.username);
  const bare = await call(baseUrl, 'POST', '/api/user/unlink-google', {}, token);
  assert(bare.status === 400, `a session alone cannot unlink (got ${bare.status})`);
  assert((await db.get(`SELECT google_id FROM users WHERE id = ?`, [user.id])).google_id === 'g-owner', 'Google stays linked');
  const ok = await call(baseUrl, 'POST', '/api/user/unlink-google', { password: PASSWORD }, token);
  assert(ok.status === 200 && (await db.get(`SELECT google_id FROM users WHERE id = ?`, [user.id])).google_id === null, 'with the password it unlinks');
}

async function testGoogleOnlyAccountIsNotAskedForAPassword(baseUrl) {
  console.log('\n--- TEST (N-S4): an account without a password is sent to "set one via Google" ---');
  const user = await createUser({ google_id: 'g-only', password_set: 0 });
  const token = 'sess_r2_googleonly_' + 'q'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, user.id]);
  const profile = await call(baseUrl, 'GET', '/api/user/profile', null, token);
  assert(profile.body.password_set === false, 'the profile says the account has no password');
  for (const [label, method, urlPath, body] of [
    ['enable 2FA', 'POST', '/api/user/setup-2fa', { password: 'guess1234' }],
    ['disable 2FA', 'POST', '/api/user/disable-2fa', { password: 'guess1234' }],
    ['change the e-mail', 'POST', '/api/user/profile', { email: 'new@owner.invalid', currentPassword: 'guess1234' }],
    ['unlink Google', 'POST', '/api/user/unlink-google', { password: 'guess1234' }],
    ['delete the account', 'DELETE', '/api/user/account', { password: 'guess1234' }],
    ['change the password', 'POST', '/api/user/change-password', { currentPassword: 'guess1234', newPassword: 'newpass1234' }]
  ]) {
    const r = await call(baseUrl, method, urlPath, body, token);
    assert(r.status === 409 && r.body.requirePasswordSetup === true, `${label}: 409 "set a password first" (got ${r.status})`);
  }
  assert(await pwcheckRows(user.id) === 0, 'and none of it counted towards the lockout');
  assert((await db.get(`SELECT google_id FROM users WHERE id = ?`, [user.id])).google_id === 'g-only', 'the only way in is still linked');
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    await testTwoChangesFromOneSession(baseUrl);
    await testForcedChangeCleansUp(baseUrl);
    await testSummaryOnlyToAccountAddress(baseUrl);
    await testUnlinkGoogleNeedsPassword(baseUrl);
    await testGoogleOnlyAccountIsNotAskedForAPassword(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 ACCOUNT SECURITY ROUND 2 TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ ACCOUNT SECURITY ROUND 2 TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
