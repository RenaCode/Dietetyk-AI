// Test for the "no main sleep" branch of syncOura (services/sync.js, audit 2026-09-23).
//
// The branch exists for a good reason: if the database already holds a sleep duration for a
// day and Oura reports no main sleep for it - only naps, or nothing at all - the stored
// sleep figures must not be replaced by a nap's. But it also copied `readiness_score` (and
// hrv/rhr) back out of the existing row, and the readiness score does not come from the
// sleep record at all. It comes from a different endpoint entirely,
// /v2/usercollection/daily_readiness.
//
// What that cost, for anyone wearing both an Oura ring and an Apple Watch: the Apple Health
// webhook writes sleep_duration for day D overnight. The ring logs that night as naps, or
// was off the finger, so /sleep has no long_sleep for D. Oura still publishes a readiness
// score for D. Every sync then overwrote the freshly fetched score with the NULL already in
// the row, and `COALESCE(excluded.readiness_score, readiness_score)` made the NULL
// permanent. The readiness card and every insight derived from it lost that day for good -
// and a resync could not bring it back, because the sync itself was what erased it.
//
// Run with: node tests/test-oura-readiness.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-oura-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-oura-readiness';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-oura-readiness';

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

// What the fake Oura API answers, keyed by the endpoint name in the URL.
const ouraResponses = {};

stubModule('services/oauthHelpers.js', {
  getOrRefreshToken: async () => 'fake-oura-access-token',
  // syncOura reads the per-user "token lacks the spo2 scope" flag (services/sync.js).
  getUserSetting: async () => null
});
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    const endpoint = url.split('/usercollection/')[1].split('?')[0];
    const body = ouraResponses[endpoint] || { data: [] };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  }
});

const db = require('../db');
const { formatDateString } = require('../utils/dates');
const { syncOura } = require('../services/sync');

const USER_ID = 1;
const DAY = formatDateString(new Date());

function readDay() {
  return db.get('SELECT * FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, DAY]);
}

async function testReadinessSurvivesANightWithoutMainSleep() {
  console.log('\n--- TEST: a day with no main sleep keeps its readiness score ---');

  // Overnight: the Apple Health webhook writes the night's sleep duration. No readiness -
  // that is not a metric Apple Health has.
  await db.run(
    `INSERT INTO health_metrics (user_id, date, sleep_duration) VALUES (?, ?, 7.5)`,
    [USER_ID, DAY]
  );

  // The ring: naps only for that day (no `type: 'long_sleep'` record)...
  ouraResponses.sleep = {
    data: [{
      day: DAY,
      type: 'sleep',
      total_sleep_duration: 2400,
      deep_sleep_duration: 600,
      rem_sleep_duration: 300,
      lowest_heart_rate: 61,
      average_hrv: 33
    }]
  };
  // ...but a perfectly normal readiness score, from the other endpoint.
  ouraResponses.daily_readiness = {
    data: [{ day: DAY, score: 82, temperature_deviation: 0.2 }]
  };

  const result = await syncOura(USER_ID);
  assert.ok(result.success, `the sync should succeed, got: ${JSON.stringify(result)}`);

  const row = await readDay();
  assert.strictEqual(
    row.readiness_score,
    82,
    `the readiness score from /daily_readiness must be stored (got ${row.readiness_score}) - it has nothing to do with whether the ring recorded a main sleep`
  );
  console.log('✅ readiness_score is written even though Oura reported no main sleep');

  // The half of the branch that must NOT change: a nap does not get to overwrite the sleep
  // duration already recorded for the night.
  assert.strictEqual(
    row.sleep_duration,
    7.5,
    `the existing sleep duration must survive a nap-only day (got ${row.sleep_duration})`
  );
  console.log('✅ the nap does not overwrite the night already recorded');

  // And the score must still be there after the next sync - the original failure made the
  // NULL permanent through COALESCE, so one green sync proves nothing on its own.
  await syncOura(USER_ID);
  const after = await readDay();
  assert.strictEqual(after.readiness_score, 82, 'a second sync erased the readiness score again');
  console.log('✅ a repeated sync keeps it');
}

async function main() {
  console.log('=== OURA READINESS TESTS ===');
  try {
    await db.initDb();
    await testReadinessSurvivesANightWithoutMainSleep();
    console.log('\n🎉 OURA READINESS TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ OURA READINESS TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
