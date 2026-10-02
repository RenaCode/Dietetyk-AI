// Tests of getOrRefreshToken (services/oauthHelpers.js): which refresh failures delete the
// stored token, and that concurrent refreshes do not race.
//
// The bugs these pin down (audit 2026-10, M5):
//   - ANY 4xx from the provider marked the token as permanently dead and deleted it. A 429
//     (rate limit - transient by definition) silently disconnected the integration.
//   - Two refreshes at once (the "Sync" button during the hourly sync) both spent the same
//     refresh token. Oura and Withings rotate refresh tokens, so the second one got a 4xx -
//     and deleted the fresh token the first had just stored.
//
// Run with: node tests/test-oauth-refresh.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-oauth-refresh-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-oauth-refresh';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-oauth-refresh';

const BACKEND_DIR = path.join(__dirname, '..');
let nextResponse = null;
let tokenPosts = 0;
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    if (url === 'https://api.ouraring.com/oauth/token') {
      tokenPosts += 1;
      // Long enough for a parallel caller to arrive while this refresh is in flight.
      await new Promise((r) => setTimeout(r, 50));
      return nextResponse();
    }
    throw new Error(`unexpected outbound request in test: ${url}`);
  }
});

const db = require('../db');
const { encrypt } = require('../utils/encryption');
const { getOrRefreshToken } = require('../services/oauthHelpers');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

let userCounter = 0;
async function userWithExpiringOuraToken() {
  userCounter += 1;
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES (?, 'x', ?, 0, 'user', 'active')
  `, [`refresh_user_${userCounter}`, `sync_refresh_${userCounter}_${'d'.repeat(20)}`]);
  const userId = result.id;
  for (const [key, value] of [['oura_client_id', 'cid'], ['oura_client_secret', 'csecret']]) {
    await db.run(`INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)`, [userId, key, encrypt(value)]);
  }
  // Expires in one minute - inside the 5-minute refresh margin.
  await db.run(`
    INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
    VALUES (?, 'oura', ?, ?, ?)
  `, [userId, encrypt('old-access'), encrypt('old-refresh'), new Date(Date.now() + 60 * 1000).toISOString()]);
  return userId;
}

const hasToken = async (userId) => !!(await db.get(`SELECT 1 AS ok FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [userId]));

async function run() {
  await db.initDb();

  console.log('\n--- TEST: a 429 from the provider keeps the token ---');
  let userId = await userWithExpiringOuraToken();
  nextResponse = () => new Response('{"error":"rate_limited"}', { status: 429 });
  let result = await getOrRefreshToken(userId, 'oura');
  assert(result === null, 'the refresh reports failure');
  assert(await hasToken(userId), 'the stored token survives a 429');

  console.log('\n--- TEST: a 5xx keeps the token ---');
  nextResponse = () => new Response('upstream down', { status: 503 });
  await getOrRefreshToken(userId, 'oura');
  assert(await hasToken(userId), 'the stored token survives a 503');

  console.log('\n--- TEST: invalid_grant deletes the token ---');
  nextResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 });
  await getOrRefreshToken(userId, 'oura');
  assert(!(await hasToken(userId)), 'a revoked refresh token (400 invalid_grant) removes the stored token');

  console.log('\n--- TEST: concurrent refreshes share one request ---');
  userId = await userWithExpiringOuraToken();
  tokenPosts = 0;
  nextResponse = () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 });
  const [a, b] = await Promise.all([getOrRefreshToken(userId, 'oura'), getOrRefreshToken(userId, 'oura')]);
  assert(tokenPosts === 1, `exactly one refresh request was sent for two concurrent callers (got ${tokenPosts})`);
  assert(a === 'new-access' && b === 'new-access', 'both callers receive the refreshed access token');
}

run()
  .then(() => {
    console.log('\n🎉 OAUTH REFRESH TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ OAUTH REFRESH TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
