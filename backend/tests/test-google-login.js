// Tests of "Sign in with Google" end to end: GET /api/auth/google -> callback -> exchange.
//
// The bugs these pin down (audit 2026-10):
//
// H2. The callback put a live session token in the URL fragment (`/#google_token=sess_...`)
//     and the frontend stored whatever token such a URL carried. Anyone could log in to their
//     own account, copy the redirect URL and send it to a victim: one click and the victim
//     was silently working inside the attacker's account. Now the callback issues a one-time
//     code bound to the browser by an HttpOnly cookie, and only code + cookie together are
//     exchanged for a login result.
// H1. The callback created an account for ANY Google identity even with public registration
//     closed, and checked only totp_enabled before issuing a full session - global
//     force_2fa, per-user force_2fa and force_password_change were all bypassed.
//
// Google itself is replaced by a stub of utils/fetchWithTimeout.js: the token endpoint and
// the userinfo endpoint answer with whatever profile the current test sets.
//
// Run with: node tests/test-google-login.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-google-login-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-google-login';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-google-login';

const BACKEND_DIR = path.join(__dirname, '..');
let currentProfile = null;
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200 });
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      return new Response(JSON.stringify(currentProfile), { status: 200 });
    }
    throw new Error(`unexpected outbound request in test: ${url}`);
  }
});

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Pulls `name=value` pairs out of Set-Cookie headers, the way a browser jar would keep them.
function cookiesFrom(res) {
  const jar = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Drives the browser half of the flow: start, "approve" at Google, land on the callback.
// Returns the callback's Location and the cookies the browser holds afterwards.
async function googleRoundTrip(baseUrl, profile) {
  currentProfile = profile;
  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
  const jar = cookiesFrom(start);
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const callback = await fetch(`${baseUrl}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { Cookie: cookieHeader(jar) }
  });
  Object.assign(jar, cookiesFrom(callback));
  return { location: callback.headers.get('location') || '', jar };
}

async function exchange(baseUrl, code, jar) {
  const res = await fetch(`${baseUrl}/api/auth/google/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify({ code })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function codeFrom(location) {
  const hash = location.split('#')[1] || '';
  return new URLSearchParams(hash).get('google_code');
}

async function setConfig(key, value) {
  await db.run(`
    INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, value]);
}

async function testNoSessionTokenInUrl(baseUrl) {
  console.log('\n--- TEST: the callback hands out a one-time code, never a session token ---');
  await setConfig('allow_public_registration', '1');
  const { location, jar } = await googleRoundTrip(baseUrl, { sub: 'g-sub-1', email: 'one@example.invalid', email_verified: true });

  assert(!location.includes('google_token=') && !location.includes('sess_'), `no session token in the redirect (${location.slice(0, 40)}...)`);
  const code = codeFrom(location);
  assert(!!code, 'the redirect carries #google_code=');

  // The attacker's scenario: the same URL opened in a browser that did not do the round trip.
  const foreign = await exchange(baseUrl, code, null);
  assert(foreign.status === 401 && !foreign.body.token, 'the code without the browser-binding cookie is refused (login CSRF blocked)');

  // The lookup above consumed the code - one code, one attempt, whoever makes it.
  const afterProbe = await exchange(baseUrl, code, jar);
  assert(afterProbe.status === 401, 'a code probed once is dead, even for the right browser');

  const second = await googleRoundTrip(baseUrl, { sub: 'g-sub-1', email: 'one@example.invalid', email_verified: true });
  const ok = await exchange(baseUrl, codeFrom(second.location), second.jar);
  assert(ok.status === 200 && typeof ok.body.token === 'string', 'the browser that did the round trip gets its session from the exchange');

  const replay = await exchange(baseUrl, codeFrom(second.location), second.jar);
  assert(replay.status === 401, 'the same code cannot be exchanged twice');
}

async function testRegistrationClosed(baseUrl) {
  console.log('\n--- TEST: Google sign-in cannot create an account while registration is closed ---');
  await setConfig('allow_public_registration', '0');
  const before = await db.get(`SELECT COUNT(*) AS n FROM users`);
  const { location } = await googleRoundTrip(baseUrl, { sub: 'g-sub-new', email: 'stranger@example.invalid', email_verified: true });
  const after = await db.get(`SELECT COUNT(*) AS n FROM users`);

  assert(location.includes('google_error=registration_closed'), `the callback answers registration_closed (${location})`);
  assert(after.n === before.n, 'no users row was created');

  // An EXISTING Google-linked account still signs in with registration closed.
  const existing = await googleRoundTrip(baseUrl, { sub: 'g-sub-1', email: 'one@example.invalid', email_verified: true });
  const ok = await exchange(baseUrl, codeFrom(existing.location), existing.jar);
  assert(ok.status === 200 && typeof ok.body.token === 'string', 'an already linked account still signs in');
}

async function createLinkedUser(sub, overrides = {}) {
  const username = 'glinked_' + Math.random().toString(36).substring(2, 8);
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status, google_id, force_2fa, force_password_change, created_at)
    VALUES (?, 'x', ?, 0, 'user', 'active', ?, ?, ?, ?)
  `, [username, 'sync_' + Math.random().toString(36).substring(2), sub, overrides.force_2fa || 0, overrides.force_password_change || 0, overrides.created_at || "2026-01-01 00:00:00"]);
}

async function testEnforcementApplies(baseUrl) {
  console.log('\n--- TEST: Google sign-in obeys force_2fa and force_password_change ---');
  await setConfig('force_2fa', '0');

  await createLinkedUser('g-sub-forced', { force_2fa: 1 });
  let rt = await googleRoundTrip(baseUrl, { sub: 'g-sub-forced', email: 'forced@example.invalid' });
  let result = await exchange(baseUrl, codeFrom(rt.location), rt.jar);
  assert(result.status === 200 && result.body.status === 'setup_2fa' && !result.body.token, 'per-user force_2fa -> setup_2fa with a temp token, no session');
  assert(typeof result.body.qrCode === 'string' && result.body.qrCode.startsWith('data:image'), 'the exchange carries the QR code the enrolment screen needs');

  await setConfig('force_2fa', '1');
  await createLinkedUser('g-sub-global');
  rt = await googleRoundTrip(baseUrl, { sub: 'g-sub-global', email: 'global@example.invalid' });
  result = await exchange(baseUrl, codeFrom(rt.location), rt.jar);
  assert(result.body.status === 'setup_2fa' && !result.body.token, 'global force_2fa on an account older than 24h -> setup_2fa, no session');
  await setConfig('force_2fa', '0');

  await createLinkedUser('g-sub-pwchange', { force_password_change: 1 });
  rt = await googleRoundTrip(baseUrl, { sub: 'g-sub-pwchange', email: 'pw@example.invalid' });
  result = await exchange(baseUrl, codeFrom(rt.location), rt.jar);
  assert(result.body.status === 'force_password_change' && !result.body.token, 'force_password_change -> the forced-change step, no session');
}

async function run() {
  await db.initDb();
  await setConfig('google_client_id', 'test-client-id');
  await setConfig('google_client_secret', 'test-client-secret');
  await setConfig('app_url', 'http://127.0.0.1');
  const { server, baseUrl } = await startServer();
  try {
    await testNoSessionTokenInUrl(baseUrl);
    await testRegistrationClosed(baseUrl);
    await testEnforcementApplies(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOOGLE LOGIN TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ GOOGLE LOGIN TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
