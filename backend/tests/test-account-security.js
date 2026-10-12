// Account-security fixes from the audit of 2026-10-09, end to end over a real express app
// against a throwaway SQLite file.
//
// What each block pins down (the audit ids are in docs and commit messages):
//
// B-W2  A stolen session (no password) could point users.email - where the summary e-mails
//       with health data go - at the attacker, and switch 2FA on with the attacker's own
//       authenticator, locking the owner out at their next login. Neither needed the
//       password, and a later password change / "log out other devices" undid neither.
// B-S1  The password re-check on account operations was limited per IP only: 8 addresses x 5
//       tries = 40 guesses without one 429.
// B-S2  Forced 2FA enrolment at login reused a totp_secret planted earlier through setup-2fa.
// B-S4  (An account created through Google sign-in could set a password after a Google
//       re-authentication. Removed with Google sign-in on 2026-10-11 - such an account now
//       recovers through scripts/reset-password.js, see tests/test-account-security-r2.js.)
// B-N1  /api/login answered an unknown name ~35x faster than a known one, which enumerated
//       accounts by timing.
// B-N2  The avatar was stored without checking it was an image at all.
//
// Mailgun and every outbound fetch are stubbed; nothing leaves the machine.
//
// Run with: node tests/test-account-security.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-account-security-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-account-security';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-account-security';

const BACKEND_DIR = path.join(__dirname, '..');
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
const sentEmails = [];
stubModule('services/mailgun.js', {
  sendMailgunEmail: async (message) => { sentEmails.push(message); }
});
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    throw new Error(`unexpected outbound request in test: ${url}`);
  }
});

const express = require('express');
const bcrypt = require('bcryptjs');
const { newTotpSecret } = require('../utils/totp');
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
  // X-Forwarded-For decides req.ip, so one process can play several client addresses (B-S1).
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  app.use(require('../routes/account'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function call(baseUrl, method, urlPath, body, token, extraHeaders = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})), res };
}

async function createUser(overrides = {}) {
  const username = 'acctsec_' + Math.random().toString(36).substring(2, 9);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, email, force_2fa)
    VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)
  `, [
    username,
    await bcrypt.hash(overrides.password || PASSWORD, 10),
    'sync_' + Math.random().toString(36).substring(2) + 'x'.repeat(16),
    overrides.totp_enabled || 0,
    overrides.totp_secret || null,
    overrides.email === undefined ? `${username}@example.invalid` : overrides.email,
    overrides.force_2fa || 0
  ]);
  return { id: result.id, username, email: overrides.email === undefined ? `${username}@example.invalid` : overrides.email };
}

async function login(baseUrl, username, password = PASSWORD) {
  const r = await call(baseUrl, 'POST', '/api/login', { username, password });
  return r.body.token;
}

async function testEmailChangeNeedsPassword(baseUrl) {
  console.log('\n--- TEST (B-W2): changing the e-mail address needs the password ---');
  const user = await createUser();
  const token = await login(baseUrl, user.username);

  const noPassword = await call(baseUrl, 'POST', '/api/user/profile', { email: 'attacker@example.invalid', first_name: 'Mallory' }, token);
  assert(noPassword.status === 400 && noPassword.body.requirePassword === true, `a session alone cannot change the address (got ${noPassword.status})`);
  const wrong = await call(baseUrl, 'POST', '/api/user/profile', { email: 'attacker@example.invalid', currentPassword: 'guess12345' }, token);
  assert(wrong.status === 400, `nor with a wrong password (got ${wrong.status})`);
  let row = await db.get(`SELECT email, first_name FROM users WHERE id = ?`, [user.id]);
  assert(row.email === user.email, 'the address is unchanged');
  assert(row.first_name === null, 'and nothing else from the refused request was written either');

  // The profile form always sends the address: re-sending the same one is not a change.
  const same = await call(baseUrl, 'POST', '/api/user/profile', { email: user.email, first_name: 'Alice' }, token);
  assert(same.status === 200, `saving the profile with the unchanged address needs no password (got ${same.status})`);

  sentEmails.length = 0;
  const ok = await call(baseUrl, 'POST', '/api/user/profile', { email: 'new-owner@example.invalid', currentPassword: PASSWORD }, token);
  assert(ok.status === 200, `with the password the address changes (got ${ok.status})`);
  row = await db.get(`SELECT email FROM users WHERE id = ?`, [user.id]);
  assert(row.email === 'new-owner@example.invalid', 'the new address is stored');
  assert(sentEmails.length === 1 && sentEmails[0].to === user.email, 'the OLD address is told about the change');
}

async function testRevokingTheSessionUndoesItsEmailChange(baseUrl) {
  console.log('\n--- TEST (B-W2): logging out the session that changed the address undoes the change ---');
  const user = await createUser();
  const ownerToken = await login(baseUrl, user.username);
  // The attacker knows the password too here - the strongest case the revert is for.
  const attackerToken = await login(baseUrl, user.username);
  const changed = await call(baseUrl, 'POST', '/api/user/profile', { email: 'attacker@example.invalid', currentPassword: PASSWORD, weekly_summary_enabled: true }, attackerToken);
  assert(changed.status === 200, 'the attacker changed the address');

  const out = await call(baseUrl, 'POST', '/api/user/logout-all', {}, ownerToken);
  assert(out.status === 200 && out.body.emailReverted === true, `"log out other devices" reports the revert (got ${out.status}, ${out.body.emailReverted})`);
  const row = await db.get(`SELECT email FROM users WHERE id = ?`, [user.id]);
  assert(row.email === user.email, `the previous address is back (got ${row.email})`);

  // The owner's own change, from the session they keep, is left alone.
  const own = await call(baseUrl, 'POST', '/api/user/profile', { email: 'owner-new@example.invalid', currentPassword: PASSWORD }, ownerToken);
  assert(own.status === 200, 'the owner changes the address themselves');
  const out2 = await call(baseUrl, 'POST', '/api/user/logout-all', {}, ownerToken);
  assert(out2.body.emailReverted === false, 'logging out the OTHER devices does not undo it');
  const row2 = await db.get(`SELECT email FROM users WHERE id = ?`, [user.id]);
  assert(row2.email === 'owner-new@example.invalid', 'the owner\'s address stays');

  // A password change from the owner's session undoes a change made from another session.
  const attacker2 = await login(baseUrl, user.username);
  await call(baseUrl, 'POST', '/api/user/profile', { email: 'attacker2@example.invalid', currentPassword: PASSWORD }, attacker2);
  const pw = await call(baseUrl, 'POST', '/api/user/change-password', { currentPassword: PASSWORD, newPassword: 'ownerpass456' }, ownerToken);
  assert(pw.status === 200 && pw.body.emailReverted === true, 'a password change reports the revert too');
  const row3 = await db.get(`SELECT email FROM users WHERE id = ?`, [user.id]);
  assert(row3.email === 'owner-new@example.invalid', `and restores the owner's address (got ${row3.email})`);
}

async function testEnabling2faNeedsPassword(baseUrl) {
  console.log('\n--- TEST (B-W2): switching 2FA on needs the password ---');
  const user = await createUser();
  const token = await login(baseUrl, user.username);
  const noPassword = await call(baseUrl, 'POST', '/api/user/setup-2fa', {}, token);
  assert(noPassword.status === 400 && !noPassword.body.secret, `a session alone gets no 2FA secret (got ${noPassword.status})`);
  const row = await db.get(`SELECT totp_secret FROM users WHERE id = ?`, [user.id]);
  assert(row.totp_secret === null, 'and none is written');
  const ok = await call(baseUrl, 'POST', '/api/user/setup-2fa', { password: PASSWORD }, token);
  assert(ok.status === 200 && typeof ok.body.secret === 'string', 'with the password setup proceeds');
}

async function testPasswordCheckLimitedPerAccount(baseUrl) {
  console.log('\n--- TEST (B-S1): password re-checks are limited per account, not only per IP ---');
  const user = await createUser();
  const token = await login(baseUrl, user.username);
  let firstLimited = null;
  let attempts = 0;
  for (let ip = 1; ip <= 8 && firstLimited === null; ip++) {
    for (let i = 0; i < 5; i++) {
      attempts++;
      const r = await call(baseUrl, 'POST', '/api/user/disable-2fa', { password: `wrong${ip}x${i}` }, token, { 'X-Forwarded-For': `198.51.100.${ip}` });
      if (r.status === 429) { firstLimited = attempts; break; }
    }
  }
  assert(firstLimited !== null && firstLimited <= 31, `wrong passwords spread over 8 addresses hit 429 (at attempt ${firstLimited}, before: never within 40)`);
  // ...and the right password from yet another address is refused while locked.
  const right = await call(baseUrl, 'POST', '/api/user/disable-2fa', { password: PASSWORD }, token, { 'X-Forwarded-For': '198.51.100.99' });
  assert(right.status === 429, `the correct password does not get through the account lock (got ${right.status})`);
}

async function testForced2faAlwaysFreshSecret(baseUrl) {
  console.log('\n--- TEST (B-S2): forced 2FA enrolment never reuses a planted secret ---');
  const planted = newTotpSecret();
  const user = await createUser({ force_2fa: 1, totp_secret: planted });
  const r = await call(baseUrl, 'POST', '/api/login', { username: user.username, password: PASSWORD });
  assert(r.body.status === 'setup_2fa', 'login asks for 2FA enrolment');
  assert(r.body.secret && r.body.secret !== planted, 'the secret offered is NOT the one planted before');
  const row = await db.get(`SELECT totp_secret FROM users WHERE id = ?`, [user.id]);
  assert(row.totp_secret === r.body.secret, 'the stored secret is the fresh one');
}

async function testLoginTimingDoesNotEnumerate(baseUrl) {
  console.log('\n--- TEST (B-N1): an unknown login name costs as much as a known one ---');
  const user = await createUser();
  const time = async (username) => {
    const t0 = process.hrtime.bigint();
    await call(baseUrl, 'POST', '/api/login', { username, password: 'wrongpass123' });
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const known = [];
  const unknown = [];
  for (let i = 0; i < 3; i++) {
    known.push(await time(user.username));
    unknown.push(await time('nobody_' + Math.random().toString(36).substring(2, 10)));
  }
  const k = median(known);
  const u = median(unknown);
  // Before the fix the ratio was ~35x (2 ms vs ~75 ms). Half is a generous margin for noise.
  assert(u >= k * 0.5, `unknown name ${u.toFixed(1)} ms vs known ${k.toFixed(1)} ms`);
}

async function testAvatarMustBeAnImage(baseUrl) {
  console.log('\n--- TEST (B-N2): the avatar must be an image ---');
  const user = await createUser();
  const token = await login(baseUrl, user.username);
  const html = await call(baseUrl, 'POST', '/api/user/profile', { avatar: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') }, token);
  assert(html.status === 400, `an HTML data URL is refused (got ${html.status})`);
  const fake = await call(baseUrl, 'POST', '/api/user/profile', { avatar: 'data:image/jpeg;base64,' + Buffer.from('not a jpeg at all').toString('base64') }, token);
  assert(fake.status === 400, `bytes that are not a JPEG under an image/jpeg label are refused (got ${fake.status})`);
  const svg = await call(baseUrl, 'POST', '/api/user/profile', { avatar: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="x()"/>').toString('base64') }, token);
  assert(svg.status === 400, `SVG is refused (got ${svg.status})`);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
  const ok = await call(baseUrl, 'POST', '/api/user/profile', { avatar: 'data:image/jpeg;base64,' + jpeg.toString('base64') }, token);
  assert(ok.status === 200, `a real JPEG header is accepted (got ${ok.status})`);
  const removed = await call(baseUrl, 'POST', '/api/user/profile', { avatar: null }, token);
  assert(removed.status === 200, 'removing the avatar (null) still works');
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    await testEmailChangeNeedsPassword(baseUrl);
    await testRevokingTheSessionUndoesItsEmailChange(baseUrl);
    await testEnabling2faNeedsPassword(baseUrl);
    await testPasswordCheckLimitedPerAccount(baseUrl);
    await testForced2faAlwaysFreshSecret(baseUrl);
    await testLoginTimingDoesNotEnumerate(baseUrl);
    await testAvatarMustBeAnImage(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 ACCOUNT SECURITY TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ ACCOUNT SECURITY TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
