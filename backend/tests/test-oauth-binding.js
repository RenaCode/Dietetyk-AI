// Tests of how the OAuth connect/link flows are started and finished.
//
// The bugs these pin down (audit 2026-10):
//
// M2. The signed `state` of the Oura / Withings / Google Fit / Google-link flows bound only a
//     userId, not the browser, and was reusable for ten minutes. An attacker could start the
//     flow for their own account and send the consent URL to a victim: the victim's Google
//     Fit / Oura tokens landed on the attacker's account (or the victim's Google identity was
//     pinned to it). The Oura callback also accepted a state minted for any other service.
// M4. The flows were started with the SESSION TOKEN in the query string
//     (/api/auth/oura?token=sess_...), which nginx wrote to its access log.
// M3. Linking Google needed nothing but a session, and neither a password change nor
//     "log out everywhere" touched the linked Google identity or the Apple Health sync token -
//     so a stolen session could plant a way back in that outlived the owner's response.
//
// Run with: node tests/test-oauth-binding.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-oauth-binding-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-oauth-binding';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-oauth-binding';

const BACKEND_DIR = path.join(__dirname, '..');
const outbound = [];
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    outbound.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fit-access', refresh_token: 'fit-refresh', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
});

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PASSWORD = 'Owner12345';

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
  app.use(require('../routes/integrations'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function cookiesFrom(res) {
  const jar = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

async function post(baseUrl, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createUserWithSession() {
  const username = 'oauthbind_' + Math.random().toString(36).substring(2, 8);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES (?, ?, ?, 0, 'user', 'active')
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_' + 'c'.repeat(40) + Math.random().toString(36).substring(2, 6)]);
  const token = 'sess_' + Math.random().toString(36).substring(2) + 'x'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, result.id]);
  return { id: result.id, username, token };
}

// Starts a Google Fit connection the way the frontend does and returns the state the browser
// would carry to Google plus the cookies it would hold.
async function startGoogleFit(baseUrl, sessionToken) {
  const ticket = await post(baseUrl, '/api/auth/ticket', { service: 'google-fit' }, sessionToken);
  const start = await fetch(`${baseUrl}/api/auth/google-fit?ticket=${ticket.body.ticket}`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return { ticket: ticket.body.ticket, start, state, jar: cookiesFrom(start) };
}

async function callback(baseUrl, route, state, jar) {
  const res = await fetch(`${baseUrl}${route}?code=provider-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: jar ? { Cookie: cookieHeader(jar) } : {}
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}

async function tokenRow(userId, service) {
  return db.get(`SELECT 1 AS ok FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
}

async function testTicketsReplaceSessionTokens(baseUrl) {
  console.log('\n--- TEST: connect flows start from a one-time ticket, not the session token ---');
  const user = await createUserWithSession();

  const legacy = await fetch(`${baseUrl}/api/auth/google-fit?token=${user.token}`, { redirect: 'manual' });
  assert(legacy.status === 401, 'the session token in ?token= no longer starts a flow');

  const { ticket, start } = await startGoogleFit(baseUrl, user.token);
  assert(typeof ticket === 'string' && ticket.startsWith('tkt_'), 'POST /api/auth/ticket returns a ticket');
  assert(start.status === 302, 'the ticket starts the Google Fit flow');

  const reuse = await fetch(`${baseUrl}/api/auth/google-fit?ticket=${ticket}`, { redirect: 'manual' });
  assert(reuse.status === 401, 'the same ticket does not start a second flow');

  const wrongService = await post(baseUrl, '/api/auth/ticket', { service: 'oura' }, user.token);
  const crossed = await fetch(`${baseUrl}/api/auth/google-fit?ticket=${wrongService.body.ticket}`, { redirect: 'manual' });
  assert(crossed.status === 401, 'a ticket issued for Oura does not start Google Fit');

  const anonymous = await post(baseUrl, '/api/auth/ticket', { service: 'oura' });
  assert(anonymous.status === 401, 'tickets are only issued to an authenticated session');
}

async function testCallbackBoundToBrowser(baseUrl) {
  console.log('\n--- TEST: the callback only accepts the browser that started the flow ---');
  const attacker = await createUserWithSession();

  // The attacker starts the flow for THEIR account and hands the consent URL to a victim. The
  // victim's browser comes back to the callback without the attacker's binding cookie.
  const { state } = await startGoogleFit(baseUrl, attacker.token);
  const victim = await callback(baseUrl, '/api/auth/google-fit/callback', state, null);
  assert(victim.status === 400, `the callback without the binding cookie is refused (got ${victim.status})`);
  assert(!(await tokenRow(attacker.id, 'google_fit')), 'no Google Fit tokens were stored on the attacker\'s account');

  // The browser that started a flow completes it.
  const own = await startGoogleFit(baseUrl, attacker.token);
  const ok = await callback(baseUrl, '/api/auth/google-fit/callback', own.state, own.jar);
  assert(ok.status === 302 && !!(await tokenRow(attacker.id, 'google_fit')), 'the starting browser completes the flow and the tokens are stored');

  // ...and only once, even if both state and cookie were kept.
  await db.run(`DELETE FROM oauth_tokens WHERE user_id = ?`, [attacker.id]);
  const replay = await callback(baseUrl, '/api/auth/google-fit/callback', own.state, own.jar);
  assert(replay.status === 400 && !(await tokenRow(attacker.id, 'google_fit')), 'the same state is refused the second time');

  // A state minted for another service is not accepted by the Oura callback.
  const fit = await startGoogleFit(baseUrl, attacker.token);
  const viaOura = await callback(baseUrl, '/api/auth/oura/callback', fit.state, fit.jar);
  assert(viaOura.status === 400 && !(await tokenRow(attacker.id, 'oura')), 'a google_fit state is refused by the Oura callback');
}

async function testGoogleLinkNeedsPassword(baseUrl) {
  console.log('\n--- TEST: linking Google requires the password ---');
  const user = await createUserWithSession();

  const noPassword = await post(baseUrl, '/api/auth/ticket', { service: 'google_link' }, user.token);
  assert(noPassword.status === 400 && !noPassword.body.ticket, 'no password -> no google_link ticket');

  const wrong = await post(baseUrl, '/api/auth/ticket', { service: 'google_link', password: 'not-it-123' }, user.token);
  assert(wrong.status === 400 && !wrong.body.ticket, 'a wrong password -> no google_link ticket');

  const right = await post(baseUrl, '/api/auth/ticket', { service: 'google_link', password: PASSWORD }, user.token);
  assert(right.status === 200 && typeof right.body.ticket === 'string', 'the right password -> a google_link ticket');
}

async function testPasswordChangeCutsSideDoors(baseUrl) {
  console.log('\n--- TEST: change-password and logout-all cut the Google link and the sync token ---');
  const user = await createUserWithSession();
  await db.run(`UPDATE users SET google_id = 'attacker-google-sub' WHERE id = ?`, [user.id]);
  const before = await db.get(`SELECT sync_token FROM users WHERE id = ?`, [user.id]);

  const change = await post(baseUrl, '/api/user/change-password', { currentPassword: PASSWORD, newPassword: 'NewPass9876' }, user.token);
  assert(change.status === 200, 'the password change succeeds');
  const after = await db.get(`SELECT google_id, sync_token FROM users WHERE id = ?`, [user.id]);
  assert(after.google_id === null, 'the linked Google identity is removed');
  assert(after.sync_token && after.sync_token !== before.sync_token, 'the Apple Health sync token is rotated');

  const logoutAll = await post(baseUrl, '/api/user/logout-all', {}, user.token);
  assert(logoutAll.status === 200, 'logout-all succeeds');
  const afterLogout = await db.get(`SELECT sync_token FROM users WHERE id = ?`, [user.id]);
  assert(afterLogout.sync_token !== after.sync_token, 'logout-all rotates the sync token as well');
}

async function run() {
  await db.initDb();
  await db.run(`INSERT INTO app_config (key, value) VALUES ('google_client_id', 'cid') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  await db.run(`INSERT INTO app_config (key, value) VALUES ('google_client_secret', 'csecret') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const { server, baseUrl } = await startServer();
  try {
    await testTicketsReplaceSessionTokens(baseUrl);
    await testCallbackBoundToBrowser(baseUrl);
    await testGoogleLinkNeedsPassword(baseUrl);
    await testPasswordChangeCutsSideDoors(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 OAUTH BINDING TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ OAUTH BINDING TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
