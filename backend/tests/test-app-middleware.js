// Tests of the middleware ORDER in app.js - the real application object, not a copy of it.
//
// The bugs these pin down (audit 2026-10):
//
// H4. /api/healthz sat behind the global rate limiter. Every request reaches the backend as
//     10.42.0.1 (see the trust-proxy note in app.js), so the kubelet's probes shared ONE
//     bucket with the whole internet: after 121 anonymous requests in a minute the probe got
//     429, readiness dropped the pod from the Service and liveness restarted it.
// H3. express.json({ limit: '20mb' }) was global and ran before the limiter and requireAuth,
//     so any anonymous POST had up to 20 MB of JSON parsed (~150 MB RSS each, 512Mi limit).
// M4. morgan logged /api/public/shared-reports/<token> in full - the token is the only key
//     to a PDF of someone's health data.
// L5. The public PDF endpoint sent no Cache-Control / X-Robots-Tag and had no per-link limit.
//
// Run with: node tests/test-app-middleware.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-app-middleware-'));
process.env.DATABASE_DIR = tmpDbDir;
// NOT 'test': middleware/rateLimit.js switches itself off under NODE_ENV=test, and the limiter
// is half of what is under test here.
process.env.NODE_ENV = 'app-middleware-test';
delete process.env.CI;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-app-middleware';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-app-middleware';

const db = require('../db');
const morgan = require('morgan');
const app = require('../app');

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

function bigJson(bytes, extra = {}) {
  return JSON.stringify({ ...extra, padding: 'x'.repeat(bytes) });
}

async function testBodyLimits(baseUrl) {
  console.log('\n--- TEST: anonymous requests cannot make the server parse large bodies ---');

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigJson(1024 * 1024, { username: 'a', password: 'b' })
  });
  assert(login.status === 413, `a 1 MB anonymous POST to /api/login is refused with 413 (got ${login.status})`);

  const meals = await fetch(`${baseUrl}/api/meals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigJson(5 * 1024 * 1024)
  });
  assert(meals.status === 401, `a 5 MB anonymous POST to /api/meals is answered by requireAuth (401) before its body is parsed (got ${meals.status})`);

  const unknownToken = await fetch(`${baseUrl}/api/integrations/apple-health/sync_doesnotexist_000000`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigJson(5 * 1024 * 1024)
  });
  assert(unknownToken.status === 404, `a 5 MB POST to the Apple Health webhook with an unknown token is refused (404) before parsing (got ${unknownToken.status})`);

  const syncToken = 'sync_' + 'a'.repeat(40);
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES ('apple_big_body', 'x', ?, 0, 'user', 'active')
  `, [syncToken]);
  const known = await fetch(`${baseUrl}/api/integrations/apple-health/${syncToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigJson(5 * 1024 * 1024, { data: { metrics: [], workouts: [] } })
  });
  assert(known.status === 200, `a 5 MB POST with a valid sync token is still accepted by the webhook (got ${known.status})`);

  // An authenticated caller still gets the larger limit on the routes that need it: a 5 MB
  // avatar is parsed and then refused by the route's own size rule (400), not by the parser.
  const sessionToken = 'sess_' + 'b'.repeat(48);
  const owner = await db.get(`SELECT id FROM users WHERE username = 'apple_big_body'`);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [sessionToken, owner.id]);
  const profile = await fetch(`${baseUrl}/api/user/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ avatar: 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024) })
  });
  assert(profile.status === 400, `an authenticated 5 MB profile update reaches the route's own avatar-size check (400, not 413; got ${profile.status})`);
}

async function testHealthzOutsideLimiter(baseUrl) {
  console.log('\n--- TEST: /api/healthz is not subject to the global rate limiter ---');
  // MAX_REQUESTS in middleware/rateLimit.js is 120/min per IP; everything here comes from
  // 127.0.0.1, the same way everything in production comes from 10.42.0.1.
  for (let i = 0; i < 130; i++) {
    const r = await fetch(`${baseUrl}/api/healthz`);
    if (r.status !== 200) {
      throw new Error(`❌ health-check request #${i + 1} returned ${r.status}, expected 200`);
    }
  }
  console.log('✅ 130 health-checks in a row from one address all returned 200');

  // And the limiter is still in force for the rest of /api - so the test above proves the
  // health-check is exempt, not that the limiter is broken.
  let limited = false;
  for (let i = 0; i < 125 && !limited; i++) {
    const r = await fetch(`${baseUrl}/api/invitation-status`);
    if (r.status === 429) limited = true;
  }
  assert(limited, 'the rest of /api still gets 429 past 120 requests a minute');

  const probe = await fetch(`${baseUrl}/api/healthz`);
  assert(probe.status === 200, 'with the /api bucket exhausted, the health-check still answers 200');
}

function testMorganRedaction() {
  console.log('\n--- TEST: access-log redaction ---');
  const fmt = (url) => morgan['safe-url']({ originalUrl: url });
  const shared = fmt('/api/public/shared-reports/share_abc123secret');
  assert(!shared.includes('share_abc123secret'), `the shared-report token is redacted (${shared})`);
  const apple = fmt('/api/integrations/apple-health/sync_secret_value');
  assert(!apple.includes('sync_secret_value'), 'the Apple Health sync token is still redacted');
  const ticket = fmt('/api/auth/oura?ticket=tkt_secret');
  assert(!ticket.includes('tkt_secret'), 'a ?ticket= is redacted');
}

async function testSharedReportHeadersAndLimit(baseUrl) {
  console.log('\n--- TEST: public shared-report responses ---');
  // Runs before testHealthzOutsideLimiter in run(): that test exhausts the global /api bucket
  // for 127.0.0.1 on purpose.
  const token = 'share_' + 'z'.repeat(30);
  const first = await fetch(`${baseUrl}/api/public/shared-reports/${token}`);
  assert(first.status === 404, 'an unknown share token is a 404');
  assert(first.headers.get('cache-control') === 'no-store', 'the response carries Cache-Control: no-store');
  assert((first.headers.get('x-robots-tag') || '').includes('noindex'), 'the response carries X-Robots-Tag: noindex');

  let status = first.status;
  for (let i = 2; i <= 21; i++) {
    status = (await fetch(`${baseUrl}/api/public/shared-reports/${token}`)).status;
  }
  assert(status === 429, `the 21st request for one link within 10 minutes is refused with 429 (got ${status})`);

  const other = await fetch(`${baseUrl}/api/public/shared-reports/share_${'y'.repeat(30)}`);
  assert(other.status === 404, 'a different link is not affected by the first one\'s limit');
}

// L-D11 (audit 2026-10-03): without backend/public (the production image) the SPA fallback
// failed inside sendFile and logged a WARN row per stray request. With or without a frontend
// build in public/, a non-API path must not write to app_logs.
async function testSpaFallbackDoesNotLog(baseUrl) {
  console.log('\n--- TEST: SPA fallback ---');
  const before = (await db.get(`SELECT COUNT(*) AS n FROM app_logs WHERE level IN ('WARN', 'ERROR')`)).n;
  const res = await fetch(`${baseUrl}/some/spa/route`);
  const hasBuild = fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'));
  assert(res.status === (hasBuild ? 200 : 404), `SPA fallback answers ${hasBuild ? 200 : 404} (frontend build ${hasBuild ? 'present' : 'absent'})`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = (await db.get(`SELECT COUNT(*) AS n FROM app_logs WHERE level IN ('WARN', 'ERROR')`)).n;
  assert(after === before, 'the SPA fallback writes no WARN/ERROR row to app_logs');
}

// D-10 (audit 2026-10-04): API responses carried `X-Powered-By: Express`.
async function testNoPoweredByHeader(baseUrl) {
  console.log('\n--- TEST: no X-Powered-By header ---');
  const res = await fetch(`${baseUrl}/api/healthz`);
  assert(res.headers.get('x-powered-by') === null, `no X-Powered-By (got ${res.headers.get('x-powered-by')})`);
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    testMorganRedaction();
    await testSharedReportHeadersAndLimit(baseUrl);
    await testBodyLimits(baseUrl);
    await testHealthzOutsideLimiter(baseUrl);
    await testSpaFallbackDoesNotLog(baseUrl);
    await testNoPoweredByHeader(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 APP MIDDLEWARE TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ APP MIDDLEWARE TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
