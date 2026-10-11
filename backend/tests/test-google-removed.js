// Google sign-in and Google Fit were removed on 2026-10-11 (the application moved behind a
// shared SSO, and the Google client had never been configured). These tests pin down that they
// are gone for good, over the real application object (app.js):
//
// - every former Google route answers 404 to a logged-in caller, and 401 - not a redirect to
//   accounts.google.com - to an anonymous one: the routes were on requireAuth's public list,
//   and a path left on that list without its handler would be public surface for nothing;
// - the profile no longer reports Google flags, and the Admin Panel neither stores nor returns
//   the Google client keys;
// - the start-up migration deletes the Google secrets (Google Fit tokens, the client secret)
//   and keeps the activity history Google Fit wrote;
// - no backend source talks to Google's OAuth or Fitness endpoints any more (Gemini's API is a
//   different host and stays).
//
// Run with: node tests/test-google-removed.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-google-removed-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-google-removed';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-google-removed';

const db = require('../db');
const app = require('../app');

const BACKEND_DIR = path.join(__dirname, '..');

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

async function call(baseUrl, method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, location: res.headers.get('location') || '', json };
}

async function createUserWithSession(role) {
  const username = 'nogoogle_' + Math.random().toString(36).substring(2, 8);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status, google_id)
    VALUES (?, 'x', ?, 0, ?, 'active', ?)
  `, [username, 'sync_' + 'e'.repeat(40) + Math.random().toString(36).substring(2, 6), role, 'g-sub-' + username]);
  const token = 'sess_' + Math.random().toString(36).substring(2) + 'z'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, result.id]);
  return { id: result.id, token };
}

const REMOVED_ROUTES = [
  ['GET', '/api/auth/google'],
  ['GET', '/api/auth/google/enabled'],
  ['GET', '/api/auth/google/callback?code=c&state=s'],
  ['GET', '/api/auth/google/link?ticket=tkt_x'],
  ['GET', '/api/auth/google/reauth?ticket=tkt_x'],
  ['POST', '/api/auth/google/exchange'],
  ['GET', '/api/auth/google-fit?ticket=tkt_x'],
  ['GET', '/api/auth/google-fit/callback?code=c&state=s'],
  ['POST', '/api/auth/google-fit/disconnect'],
  ['POST', '/api/user/unlink-google'],
  ['POST', '/api/user/set-password']
];

async function testRoutesAreGone(baseUrl, user) {
  console.log('\n--- TEST: the Google routes no longer exist ---');
  for (const [method, urlPath] of REMOVED_ROUTES) {
    const anonymous = await call(baseUrl, method, urlPath, { body: method === 'POST' ? {} : undefined });
    assert(
      anonymous.status === 401 && !/google\.com/.test(anonymous.location),
      `${method} ${urlPath} anonymously: 401 from requireAuth, no redirect to Google (got ${anonymous.status})`
    );
    const loggedIn = await call(baseUrl, method, urlPath, { token: user.token, body: method === 'POST' ? {} : undefined });
    assert(loggedIn.status === 404, `${method} ${urlPath} with a session: 404 (got ${loggedIn.status})`);
  }
}

async function testProfileAndSync(baseUrl, user) {
  console.log('\n--- TEST: the profile and the manual sync say nothing about Google ---');
  const profile = await call(baseUrl, 'GET', '/api/user/profile', { token: user.token });
  assert(profile.status === 200, 'the profile loads');
  for (const key of ['has_google', 'has_google_fit', 'google_configured']) {
    assert(!(key in profile.json), `the profile has no '${key}' (even for a row with google_id set)`);
  }
  assert(profile.json.password_set === true, 'password_set is still reported');

  const sync = await call(baseUrl, 'POST', '/api/sync/manual', { token: user.token, body: {} });
  assert(sync.status === 200 && !('google_fit' in sync.json), 'the manual sync reports Oura and Withings only');
}

async function testAdminPanelRefusesGoogleKeys(baseUrl, admin) {
  console.log('\n--- TEST: the Admin Panel neither stores nor returns the Google client ---');
  const save = await call(baseUrl, 'POST', '/api/admin/config', {
    token: admin.token,
    body: { google_client_id: 'cid.apps.example', google_client_secret: 'csecret', app_url: 'https://diet.example.invalid' }
  });
  assert(save.status === 200, 'saving the config still works');
  const stored = await db.all(`SELECT key FROM app_config WHERE key LIKE 'google_%'`);
  assert(stored.length === 0, `no google_* key was written (found ${stored.map(r => r.key).join(', ') || 'none'})`);
  assert((await db.get(`SELECT value FROM app_config WHERE key = 'app_url'`)).value === 'https://diet.example.invalid', 'the allowed keys next to them were saved');

  // A row that got there some other way (a restored backup) is not echoed back either.
  await db.run(`INSERT INTO app_config (key, value) VALUES ('google_client_id', 'leftover')`);
  const read = await call(baseUrl, 'GET', '/api/admin/config', { token: admin.token });
  assert(read.status === 200 && !('google_client_id' in read.json), 'GET /api/admin/config does not return a leftover google_client_id');
  await db.run(`DELETE FROM app_config WHERE key = 'google_client_id'`);
}

async function testMigrationDropsSecretsKeepsHistory(user) {
  console.log('\n--- TEST: the start-up migration deletes Google secrets and keeps Google Fit history ---');
  await db.run(`INSERT INTO app_config (key, value) VALUES ('google_client_id', 'cid'), ('google_client_secret', 'enc:v1:whatever')`);
  await db.run(`
    INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
    VALUES (?, 'google_fit', 'enc:v1:a', 'enc:v1:r', datetime('now', '+1 hour')),
           (?, 'oura', 'enc:v1:a', 'enc:v1:r', datetime('now', '+1 hour'))
  `, [user.id, user.id]);
  await db.run(`
    INSERT INTO health_metrics (user_id, date, steps, active_calories, activity_source, steps_source, active_calories_source)
    VALUES (?, '2026-09-01', 8421, 377, 'google_fit', 'google_fit', 'google_fit')
  `, [user.id]);

  await db.initDb();
  await db.initDb(); // idempotent: a second start finds nothing to delete and changes nothing

  assert((await db.all(`SELECT key FROM app_config WHERE key LIKE 'google_%'`)).length === 0, 'the Google client keys are deleted');
  assert(!(await db.get(`SELECT 1 FROM oauth_tokens WHERE service = 'google_fit'`)), 'the Google Fit tokens are deleted');
  assert(!!(await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [user.id])), 'other integrations\' tokens are untouched');
  const day = await db.get(`SELECT steps, active_calories, activity_source, steps_source FROM health_metrics WHERE user_id = ? AND date = '2026-09-01'`, [user.id]);
  assert(day && day.steps === 8421 && day.active_calories === 377, 'the steps and calories Google Fit wrote are still there');
  assert(day.activity_source === 'google_fit' && day.steps_source === 'google_fit', 'and so is their provenance');
  assert((await db.get(`SELECT google_id FROM users WHERE id = ?`, [user.id])).google_id !== null, 'users.google_id is left as it was (the column is inert, not dropped)');
}

function testNoGoogleEndpointsInSource() {
  console.log('\n--- TEST: no backend code calls Google OAuth or Fitness ---');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'public', 'docs'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const host of ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com/oauth2', 'www.googleapis.com/fitness']) {
          if (source.includes(host)) offenders.push(`${path.relative(BACKEND_DIR, full)}: ${host}`);
        }
      }
    }
  };
  walk(BACKEND_DIR);
  assert(offenders.length === 0, `no source file names a Google OAuth/Fitness endpoint${offenders.length ? ': ' + offenders.join('; ') : ''}`);
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    const user = await createUserWithSession('user');
    const admin = await createUserWithSession('admin');
    await testRoutesAreGone(baseUrl, user);
    await testProfileAndSync(baseUrl, user);
    await testAdminPanelRefusesGoogleKeys(baseUrl, admin);
    await testMigrationDropsSecretsKeepsHistory(user);
    testNoGoogleEndpointsInSource();
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOOGLE REMOVAL TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message));
    console.error('❌ GOOGLE REMOVAL TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
