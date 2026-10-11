// "Sign in with Google" was removed on 2026-10-11 (the application moved behind a shared SSO,
// and the Google client had never been configured). These tests pin down that it is gone for
// good, over the real application object (app.js):
//
// - every former sign-in route answers 404 to a logged-in caller, and 401 - not a redirect to
//   accounts.google.com - to an anonymous one: the routes were on requireAuth's public list,
//   and a path left on that list without its handler would be public surface for nothing;
// - the profile no longer reports the Google identity;
// - no backend source fetches a Google user profile any more (Google Fit, which stays behind a
//   switch, uses the token and Fitness endpoints only - see tests/test-google-fit-switch.js).
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
  ['POST', '/api/user/unlink-google'],
  ['POST', '/api/user/set-password']
];

async function testRoutesAreGone(baseUrl, user) {
  console.log('\n--- TEST: the Google sign-in routes no longer exist ---');
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

async function testProfile(baseUrl, user) {
  console.log('\n--- TEST: the profile says nothing about a Google identity ---');
  const profile = await call(baseUrl, 'GET', '/api/user/profile', { token: user.token });
  assert(profile.status === 200, 'the profile loads');
  assert(!('has_google' in profile.json), "the profile has no 'has_google' (even for a row with google_id set)");
  assert(profile.json.password_set === true, 'password_set is still reported');
}

function testNoGoogleEndpointsInSource() {
  console.log('\n--- TEST: no backend code signs anybody in with Google ---');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'public', 'docs'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        // The userinfo endpoint and the `openid` scope are what sign-in needs and Google Fit
        // does not.
        for (const host of ['www.googleapis.com/oauth2', "'openid"]) {
          if (source.includes(host)) offenders.push(`${path.relative(BACKEND_DIR, full)}: ${host}`);
        }
      }
    }
  };
  walk(BACKEND_DIR);
  assert(offenders.length === 0, `no source file asks Google who the user is${offenders.length ? ': ' + offenders.join('; ') : ''}`);
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    const user = await createUserWithSession('user');
    await testRoutesAreGone(baseUrl, user);
    await testProfile(baseUrl, user);
    testNoGoogleEndpointsInSource();
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOOGLE SIGN-IN REMOVAL TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message));
    console.error('❌ GOOGLE SIGN-IN REMOVAL TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
