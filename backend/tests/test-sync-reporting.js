// Tests of what the hourly sync reports, and of the Oura SpO2 scope handling (audit
// 2026-10-03, D4).
//
// 1. "[CRON OURA] Synced N user(s)" counted attempts: a user whose sync returned
//    { success: false } was still counted, and the failure reached only the console - the
//    weekly admin report (which reads app_logs) never saw a broken integration. Now the summary
//    counts successes and each failure is a WARN/SYNC row in app_logs.
// 2. Oura answered daily_spo2 with 401 every hour: connections were authorised with
//    `daily heartrate personal`, without `spo2`. The first 401 now sets a per-user flag, later
//    syncs skip SpO2, the profile reports oura_needs_reconnect, and disconnecting clears it.
//
// No network: utils/fetchWithTimeout.js is stubbed.
//
// Run with: node tests/test-sync-reporting.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-sync-reporting-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-sync-reporting';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-sync-reporting';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const spo2Calls = [];
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url, options = {}) => {
    const auth = (options.headers && options.headers.Authorization) || '';
    // The "broken" user's token is rejected everywhere - a real failed sync.
    if (auth === 'Bearer token-broken') return json(401, { detail: 'invalid token' });
    if (url.includes('/daily_spo2')) {
      spo2Calls.push(auth);
      return json(401, { detail: 'missing scope' });
    }
    return json(200, { data: [] });
  }
});

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncAllOura } = require('../services/sync');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureConsoleLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use(require('../routes/account'));
  app.use(require('../routes/integrations'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function main() {
  console.log('=== SYNC REPORTING TESTS ===');
  await db.initDb();
  const farFuture = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  for (const [id, token] of [[201, 'token-good'], [202, 'token-broken']]) {
    await db.run(
      `INSERT INTO users (id, username, password_hash, sync_token, role, status) VALUES (?, ?, 'x', ?, 'user', 'active')`,
      [id, `sync_reporting_${id}`, `sync_reporting_token_${id}`]
    );
    await db.run(
      'INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)',
      [id, 'oura', token, null, farFuture]
    );
  }
  const session = 'sess_' + 'r'.repeat(40);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, 201, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [session]);

  console.log('\n--- the summary counts successes, failures land in app_logs ---');
  const lines = await captureConsoleLog(() => syncAllOura());
  await sleep(100);
  const summary = lines.find((l) => l.startsWith('[CRON OURA] Synced'));
  assert(summary && summary.includes('Synced 1/2 user(s), 1 failed'), `summary counts 1 success and 1 failure (got: ${summary})`);
  const failRows = await db.all(`SELECT level, category, user_id, message FROM app_logs WHERE category = 'SYNC' AND message LIKE 'Oura sync failed%'`);
  assert(failRows.length === 1 && failRows[0].user_id === 202 && failRows[0].level === 'WARN', 'the failed user is a WARN/SYNC row in app_logs with its user_id');

  console.log('\n--- SpO2 without the scope: asked once, then skipped ---');
  assert(spo2Calls.length === 1 && spo2Calls[0] === 'Bearer token-good', 'daily_spo2 was asked once for the working token');
  const flag = await db.get(`SELECT value FROM settings WHERE user_id = 201 AND key = 'oura_spo2_scope_missing'`);
  assert(flag && flag.value === '1', 'the 401 sets oura_spo2_scope_missing');
  const scopeRows = await db.all(`SELECT 1 FROM app_logs WHERE category = 'SYNC' AND user_id = 201 AND message LIKE '%no spo2 scope%'`);
  assert(scopeRows.length === 1, 'the missing scope is recorded once in app_logs');

  await captureConsoleLog(() => syncAllOura());
  await syncAllOura();
  assert(spo2Calls.length === 1, 'later syncs do not ask daily_spo2 again (no hourly 401)');
  const okRow = await db.all(`SELECT 1 FROM app_logs WHERE category = 'SYNC' AND user_id = 201 AND message LIKE 'Oura sync failed%'`);
  assert(okRow.length === 0, 'skipping SpO2 does not turn the sync into a failure');

  const { server, baseUrl } = await startServer();
  try {
    const auth = { Authorization: `Bearer ${session}` };
    let profile = await (await fetch(`${baseUrl}/api/user/profile`, { headers: auth })).json();
    assert(profile.oura_needs_reconnect === true, 'the profile reports oura_needs_reconnect');

    const res = await fetch(`${baseUrl}/api/auth/oura/disconnect`, { method: 'POST', headers: auth });
    assert(res.status === 200, 'Oura disconnect succeeds');
    profile = await (await fetch(`${baseUrl}/api/user/profile`, { headers: auth })).json();
    const cleared = await db.get(`SELECT 1 FROM settings WHERE user_id = 201 AND key = 'oura_spo2_scope_missing'`);
    assert(profile.oura_needs_reconnect === false && !cleared, 'disconnecting clears the flag');
  } finally {
    server.close();
  }
}

main()
  .then(() => {
    console.log('\n🎉 SYNC REPORTING TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ SYNC REPORTING TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
