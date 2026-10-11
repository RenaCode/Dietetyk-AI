// Google Fit is kept but switched OFF by default (2026-10-11): an administrator turns it on in
// the Admin Panel (app_config.google_fit_enabled = '1'). These tests pin down both states over
// the real application object (app.js), with every outbound request stubbed:
//
// - off (the default, no row): every /api/auth/google-fit* route and the google-fit ticket
//   answer 404, the hourly sync and the manual sync do not touch Google at all, Settings is told
//   to hide the card - and a stored connection (tokens, history) is left exactly as it was;
// - on: the integration works as before - ticket, consent redirect, browser-bound callback,
//   token stored, data synced hourly and manually, disconnect;
// - the Admin Panel stores the switch and the Google client next to it.
//
// Run with: node tests/test-google-fit-switch.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-google-fit-switch-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-google-fit-switch';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-google-fit-switch';

const BACKEND_DIR = path.join(__dirname, '..');
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

// Every request the application makes to the outside world. Google answers with a token and
// one day of steps; anything else is an empty success.
const outbound = [];
const DAY_START_MS = Date.UTC(2026, 9, 5, 22, 0, 0); // 2026-10-06 00:00 Europe/Warsaw
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    outbound.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fit-access', refresh_token: 'fit-refresh', expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith('https://www.googleapis.com/fitness/')) {
      return new Response(JSON.stringify({
        bucket: [{
          startTimeMillis: String(DAY_START_MS),
          endTimeMillis: String(DAY_START_MS + 86400000),
          dataset: [{ dataSourceId: 'derived:com.google.step_count.delta', point: [{ value: [{ intVal: 6543 }] }] }]
        }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
});

const db = require('../db');
const app = require('../app');
const { syncAllGoogleFit } = require('../services/sync');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
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

async function call(baseUrl, method, urlPath, { token, body, cookies } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookies ? { Cookie: cookieHeader(cookies) } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, location: res.headers.get('location') || '', json, res };
}

async function createUserWithSession(role) {
  const username = 'gfit_' + Math.random().toString(36).substring(2, 8);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES (?, 'x', ?, 0, ?, 'active')
  `, [username, 'sync_' + 'f'.repeat(40) + Math.random().toString(36).substring(2, 6), role]);
  const token = 'sess_' + Math.random().toString(36).substring(2) + 'w'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, result.id]);
  return { id: result.id, token };
}

// A Google Fit connection made while the integration was on: an unexpired token, so a sync
// would go straight to the Fitness API without refreshing it.
async function seedConnection(userId) {
  await db.run(`
    INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
    VALUES (?, 'google_fit', 'stored-access', 'stored-refresh', ?)
  `, [userId, new Date(Date.now() + 3600 * 1000).toISOString()]);
}

const tokenRow = (userId) => db.get(`SELECT access_token FROM oauth_tokens WHERE user_id = ? AND service = 'google_fit'`, [userId]);
const fitDay = (userId) => db.get(`SELECT steps, activity_source FROM health_metrics WHERE user_id = ? AND date = '2026-10-06'`, [userId]);
const googleCalls = () => outbound.filter(u => u.includes('google')).length;

async function testOffByDefault(baseUrl, user, admin) {
  console.log('\n--- TEST: Google Fit is off by default and touches nothing ---');
  await seedConnection(user.id);
  const before = googleCalls();

  const ticket = await call(baseUrl, 'POST', '/api/auth/ticket', { token: user.token, body: { service: 'google-fit' } });
  assert(ticket.status === 404 && !(ticket.json && ticket.json.ticket), `no google-fit ticket while off (got ${ticket.status})`);
  for (const [method, urlPath, token] of [
    ['GET', '/api/auth/google-fit?ticket=tkt_x', null],
    ['GET', '/api/auth/google-fit/callback?code=c&state=s', null],
    ['GET', '/api/auth/google-fit/callback', null],
    ['POST', '/api/auth/google-fit/disconnect', user.token]
  ]) {
    const r = await call(baseUrl, method, urlPath, { token, body: method === 'POST' ? {} : undefined });
    assert(r.status === 404 && !/google\.com/.test(r.location), `${method} ${urlPath}: 404 while off (got ${r.status})`);
  }

  await syncAllGoogleFit();
  const manual = await call(baseUrl, 'POST', '/api/sync/manual', { token: user.token, body: {} });
  assert(manual.status === 200 && manual.json.google_fit === null, 'the manual sync skips Google Fit');
  assert(googleCalls() === before, 'neither the hourly nor the manual sync made a single request to Google');
  assert(!(await fitDay(user.id)), 'no activity was written');
  assert((await tokenRow(user.id)).access_token === 'stored-access', 'the stored connection is left exactly as it was');

  const profile = await call(baseUrl, 'GET', '/api/user/profile', { token: user.token });
  assert(profile.json.google_fit_enabled === false, 'the profile tells Settings to hide the card');
  assert(profile.json.has_google_fit === true, 'and still knows the connection exists');

  const config = await call(baseUrl, 'GET', '/api/admin/config', { token: admin.token });
  assert(!config.json.google_fit_enabled, 'the Admin Panel shows the switch as off (no row)');
}

async function testAdminTurnsItOn(baseUrl, admin) {
  console.log('\n--- TEST: the Admin Panel stores the switch and the Google client ---');
  const save = await call(baseUrl, 'POST', '/api/admin/config', {
    token: admin.token,
    body: { google_fit_enabled: '1', google_client_id: 'cid.apps.example', google_client_secret: 'csecret' }
  });
  assert(save.status === 200, 'saving succeeds');
  const config = await call(baseUrl, 'GET', '/api/admin/config', { token: admin.token });
  assert(config.json.google_fit_enabled === '1' && config.json.google_client_id === 'cid.apps.example', 'the switch and the Client ID come back');
  assert(config.json.google_client_secret === '********', 'the client secret comes back masked');
  const stored = await db.get(`SELECT value FROM app_config WHERE key = 'google_client_secret'`);
  assert(stored.value.startsWith('enc:v1:'), 'and is stored encrypted');
}

async function testOnWorksAsBefore(baseUrl, user, newcomer) {
  console.log('\n--- TEST: switched on, Google Fit works as before ---');
  const profile = await call(baseUrl, 'GET', '/api/user/profile', { token: newcomer.token });
  assert(profile.json.google_fit_enabled === true && profile.json.google_configured === true, 'the profile shows the card');

  // The stored connection resumes on the next hourly sync.
  await syncAllGoogleFit();
  assert(outbound.some(u => u.startsWith('https://www.googleapis.com/fitness/')), 'the hourly sync calls the Fitness API');
  const day = await fitDay(user.id);
  assert(day && day.steps === 6543 && day.activity_source === 'google_fit', 'and writes the day for the stored connection');

  // A new connection, the way the browser makes it.
  const ticket = await call(baseUrl, 'POST', '/api/auth/ticket', { token: newcomer.token, body: { service: 'google-fit' } });
  assert(ticket.status === 200 && ticket.json.ticket, 'a google-fit ticket is issued');
  const start = await call(baseUrl, 'GET', `/api/auth/google-fit?ticket=${encodeURIComponent(ticket.json.ticket)}`);
  assert(start.status === 302 && start.location.startsWith('https://accounts.google.com/') && start.location.includes('fitness.activity.read'), 'the flow redirects to the Google consent screen for Fitness');
  const state = new URL(start.location).searchParams.get('state');

  const foreign = await call(baseUrl, 'GET', `/api/auth/google-fit/callback?code=c&state=${encodeURIComponent(state)}`);
  assert(foreign.status === 400 && !(await tokenRow(newcomer.id)), 'a callback from another browser is still refused (binding cookie)');

  const ticket2 = await call(baseUrl, 'POST', '/api/auth/ticket', { token: newcomer.token, body: { service: 'google-fit' } });
  const start2 = await call(baseUrl, 'GET', `/api/auth/google-fit?ticket=${encodeURIComponent(ticket2.json.ticket)}`);
  const state2 = new URL(start2.location).searchParams.get('state');
  const ok = await call(baseUrl, 'GET', `/api/auth/google-fit/callback?code=c&state=${encodeURIComponent(state2)}`, { cookies: cookiesFrom(start2.res) });
  assert(ok.status === 302 && ok.location.includes('success=google_fit'), `the callback completes (got ${ok.status} ${ok.location})`);
  assert(!!(await tokenRow(newcomer.id)), 'the token is stored');

  const manual = await call(baseUrl, 'POST', '/api/sync/manual', { token: newcomer.token, body: {} });
  assert(manual.json.google_fit && manual.json.google_fit.success === true, 'the manual sync includes Google Fit');

  const disconnect = await call(baseUrl, 'POST', '/api/auth/google-fit/disconnect', { token: newcomer.token, body: {} });
  assert(disconnect.status === 200 && !(await tokenRow(newcomer.id)), 'disconnect removes the connection');
}

async function testOffAgainKeepsData(baseUrl, admin, user) {
  console.log('\n--- TEST: switching it off again keeps what is stored ---');
  await call(baseUrl, 'POST', '/api/admin/config', { token: admin.token, body: { google_fit_enabled: '0' } });
  const before = googleCalls();
  await syncAllGoogleFit();
  assert(googleCalls() === before, 'the hourly sync stops at once (no restart)');
  assert(!!(await tokenRow(user.id)) && (await fitDay(user.id)).steps === 6543, 'the connection and the synced history stay');
  const r = await call(baseUrl, 'GET', '/api/auth/google-fit/callback?code=c&state=s');
  assert(r.status === 404, 'the routes are 404 again');
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    const user = await createUserWithSession('user');
    const newcomer = await createUserWithSession('user');
    const admin = await createUserWithSession('admin');
    await testOffByDefault(baseUrl, user, admin);
    await testAdminTurnsItOn(baseUrl, admin);
    await testOnWorksAsBefore(baseUrl, user, newcomer);
    await testOffAgainKeepsData(baseUrl, admin, user);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOOGLE FIT SWITCH TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message));
    console.error('❌ GOOGLE FIT SWITCH TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
