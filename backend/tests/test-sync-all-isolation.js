// Tests that one user's broken integration cannot stop the hourly sync for everybody else
// (audit 2026-10-02).
//
// syncAllOura / syncAllWithings / syncAllGoogleFit loop over every connected user and await
// syncOura(userId) etc. inside ONE try/catch around the whole loop. The per-user functions
// catch their own HTTP errors, but getOrRefreshToken() runs before their try - and it calls
// decrypt() on the stored tokens, which throws on a ciphertext that no longer authenticates
// (a botched APP_PASSWORD rotation, a hand-edited row). That exception escaped to the outer
// catch and ended the loop: every user after the broken one silently stopped syncing, every
// hour, with a single "[CRON ERROR] Oura sync failed" line as the only trace.
//
// No network: utils/fetchWithTimeout.js is stubbed and only records which tokens it was
// called with.
//
// Run with: node tests/test-sync-all-isolation.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-sync-isolation-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-sync-isolation';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-sync-isolation';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const fetchedWithTokens = [];
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url, options = {}) => {
    const auth = options.headers && options.headers.Authorization;
    fetchedWithTokens.push(auth || null);
    return { ok: false, status: 503, text: async () => 'stubbed', json: async () => ({}) };
  }
});

const db = require('../db');
const { syncAllOura, syncAllWithings, syncAllGoogleFit } = require('../services/sync');

async function main() {
  console.log('=== SYNC-ALL ISOLATION TESTS ===');
  try {
    await db.initDb();
    for (const id of [101, 102]) {
      await db.run(
        `INSERT INTO users (id, username, password_hash, sync_token, role, status) VALUES (?, ?, 'x', ?, 'user', 'active')`,
        [id, `sync_isolation_${id}`, `sync_isolation_token_${id}`]
      );
    }
    const farFuture = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const runs = [
      ['oura', syncAllOura],
      ['withings', syncAllWithings],
      ['google_fit', syncAllGoogleFit]
    ];
    for (const [service, syncAll] of runs) {
      console.log(`\n--- ${service}: a user whose token cannot be decrypted does not stop the next one ---`);
      await db.run('DELETE FROM oauth_tokens');
      // Inserted first so it is visited first. 'enc:v1:' + garbage fails authentication in decrypt().
      await db.run(
        'INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)',
        [101, service, 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null, farFuture]
      );
      await db.run(
        'INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)',
        [102, service, `plain-token-${service}`, null, farFuture]
      );
      fetchedWithTokens.length = 0;
      await syncAll();
      assert(
        fetchedWithTokens.includes(`Bearer plain-token-${service}`),
        `${service}: the second user is still synced (fetch calls: ${JSON.stringify(fetchedWithTokens)})`
      );
    }
    console.log('\n🎉 SYNC-ALL ISOLATION TESTS PASSED\n');
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ SYNC-ALL ISOLATION TESTS FAILED');
    process.exit(1);
  }
}

main();
