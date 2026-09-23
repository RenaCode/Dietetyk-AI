// End-to-end tests for the Apple Health webhook (routes/appleHealth.js).
//
// Until the 2026-09-23 audit this 780-line route had NO test at all, and the one test that
// claimed to cover its rules - tests/test-activity-sources.js - exercised a REBUILD of the
// upsert out of preserveHigherPriority()/preserveSourceLabel(), i.e. the services/sync.js
// pattern, while this file hand-wrote its own ON CONFLICT. So the protected rule was green
// in CI and broken in production. These tests therefore drive the real router over HTTP
// against a throwaway SQLite file: the payload goes in the way the phone sends it and the
// assertions read health_metrics, with nothing reconstructed in between.
//
// The three bugs pinned down here:
//
//  1. `activity_source = 'apple'` was written UNCONDITIONALLY. A Health Auto Export
//     automation that sends only Dietary Water (or only sleep, or only wrist temperature)
//     carries no activity at all, yet still stamped the day as Apple-owned - after which
//     preserveHigherPriority() in sync.js correctly refused to let Google Fit or Oura write
//     steps for that day ever again. The day froze at whatever step count it happened to
//     hold, for good.
//  2. Workout totals from data.workouts[] were ASSIGNED to the day's active_calories /
//     active_minutes, after the data.metrics[] loop had summed the real daily figures - so
//     a payload carrying both replaced "750 kcal today" with "320 kcal in one run".
//  3. Water was counted by trusting `INSERT OR IGNORE ... changes > 0` on the sample table
//     while the millilitres were added by a different statement much later. A sample
//     committed by a request that then failed was permanently invisible: the client's retry
//     saw changes = 0 and never added it to any counter.
//
// Run with: node tests/test-apple-health-webhook.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-apple-webhook-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-apple-webhook';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-apple-webhook';

const express = require('express');
const db = require('../db');
const {
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
} = require('../utils/activitySources');

const USER_ID = 1;
const DATE = '2026-09-20';
// Warsaw is UTC+2 on that date, so this timestamp belongs to DATE in Europe/Warsaw.
const AT = (hhmmss) => `${DATE} ${hhmmss} +0200`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  // The webhook is mounted BEFORE any authentication in server.js - the phone has no
  // session, it identifies the user with the sync_token in the URL.
  app.use(require('../routes/appleHealth'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function postPayload(baseUrl, syncToken, data) {
  const res = await fetch(`${baseUrl}/api/integrations/apple-health/${syncToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
  return { status: res.status, body: await res.json() };
}

// The Google Fit / Oura side of the hierarchy, written exactly the way services/sync.js
// writes it - through the shared helpers in utils/activitySources.js. This is what has to
// be able to keep updating a day after the webhook has touched it.
async function writeFromLowerSource(source, { steps = null, calories = null, distance = null }) {
  const rank = getActivitySourceRank(source);
  await db.run(`
    INSERT INTO health_metrics (user_id, date, steps, active_calories, distance_meters, activity_source, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      ${preserveHigherPriority('steps', rank)},
      ${preserveHigherPriority('active_calories', rank)},
      ${preserveHigherPriority('distance_meters', rank)},
      ${preserveSourceLabel(rank, ['steps', 'active_calories', 'distance_meters'])},
      last_sync = excluded.last_sync
  `, [USER_ID, DATE, steps, calories, distance, source, new Date().toISOString()]);
}

function readDay(date = DATE) {
  return db.get('SELECT * FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, date]);
}

async function clearDay(date = DATE) {
  await db.run('DELETE FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, date]);
  await db.run('DELETE FROM apple_health_water_samples WHERE user_id = ? AND date = ?', [USER_ID, date]);
  await db.run('DELETE FROM apple_health_workouts WHERE user_id = ? AND date = ?', [USER_ID, date]);
}

// --- 1. A payload with no activity must not claim the day for Apple ---------------------
async function testWaterOnlyPayloadDoesNotClaimTheDay(baseUrl, syncToken) {
  console.log('\n--- TEST 1: a water-only payload does not stamp activity_source = apple ---');
  await clearDay();

  // 09:00 - Google Fit syncs the morning's steps.
  await writeFromLowerSource('google_fit', { steps: 3000 });

  // 10:00 - the phone forwards a Dietary Water reading. No steps, no calories, no distance.
  const res = await postPayload(baseUrl, syncToken, {
    metrics: [
      { name: 'dietary_water', units: 'mL', data: [{ date: AT('10:00:00'), qty: 250 }] }
    ]
  });
  assert(res.status === 200, 'the water-only payload is accepted (200)');

  let row = await readDay();
  assert(row.water_ml === 250, `the water itself is recorded (water_ml = ${row.water_ml})`);
  assert(
    row.activity_source === 'google_fit',
    `a payload carrying no activity leaves the day's activity_source alone (got '${row.activity_source}')`
  );

  // 11:00 - Google Fit syncs the real day. THIS is what used to be impossible: with the day
  // mislabelled 'apple' and holding 3000 steps, preserveHigherPriority() kept the stale
  // value and no source could ever correct it again.
  await writeFromLowerSource('google_fit', { steps: 11000, calories: 480 });
  row = await readDay();
  assert(row.steps === 11000, `Google Fit can still update the day afterwards (steps = ${row.steps})`);
  assert(row.active_calories === 480, 'and can still fill in the columns it owns');
}

// --- 2. A payload that DOES carry activity still wins -----------------------------------
async function testRealActivityStillWins(baseUrl, syncToken) {
  console.log('\n--- TEST 2: a payload with real activity still takes the day ---');
  await clearDay();

  await writeFromLowerSource('google_fit', { steps: 3000, calories: 200, distance: 2000 });

  const res = await postPayload(baseUrl, syncToken, {
    metrics: [
      { name: 'step_count', units: 'steps', data: [{ date: AT('12:00:00'), qty: 12000 }] },
      { name: 'walking_running_distance', units: 'km', data: [{ date: AT('12:00:00'), qty: 8 }] }
    ]
  });
  assert(res.status === 200, 'the activity payload is accepted (200)');

  let row = await readDay();
  assert(row.steps === 12000, `Apple's step count overwrites Google Fit's (steps = ${row.steps})`);
  assert(row.distance_meters === 8000, 'units are converted (8 km -> 8000 m)');
  assert(row.activity_source === 'apple', `the day is now labelled apple (got '${row.activity_source}')`);

  // And the label now means something: the lower source must not take those columns back.
  await writeFromLowerSource('google_fit', { steps: 5000, calories: 300, distance: 4000 });
  row = await readDay();
  assert(row.steps === 12000, 'Google Fit does not overwrite genuine Apple Health activity');
  assert(row.active_calories === 300, 'but may still fill a column Apple left empty');
}

// --- 3. Workouts are a lower bound on the day, not a replacement for it -----------------
async function testWorkoutsDoNotEraseTheDay(baseUrl, syncToken) {
  console.log('\n--- TEST 3: a workout does not overwrite the whole day ---');
  await clearDay();

  // One payload carrying both the daily metrics and the workout - the shape produced when
  // the user enables workout export on the same automation, or runs two automations.
  const res = await postPayload(baseUrl, syncToken, {
    metrics: [
      { name: 'active_energy', units: 'kcal', data: [{ date: AT('23:00:00'), qty: 750 }] },
      { name: 'basal_energy_burned', units: 'kcal', data: [{ date: AT('23:00:00'), qty: 1600 }] },
      { name: 'apple_exercise_time', units: 'min', data: [{ date: AT('23:00:00'), qty: 60 }] }
    ],
    workouts: [
      {
        id: 'workout-run-1',
        name: 'Running',
        start: AT('07:00:00'),
        end: AT('07:30:00'),
        duration: 1800,
        activeEnergyBurned: { qty: 320, units: 'kcal' }
      }
    ]
  });
  assert(res.status === 200, 'the combined metrics+workout payload is accepted (200)');

  const row = await readDay();
  assert(
    row.active_calories === 750,
    `the day keeps its full active calories, not just the run's (active_calories = ${row.active_calories}, expected 750)`
  );
  assert(
    row.active_minutes === 60,
    `the day keeps its full active minutes (active_minutes = ${row.active_minutes}, expected 60)`
  );
  assert(
    row.total_calories_burned === 2350,
    `total_calories_burned stays active + basal (got ${row.total_calories_burned}, expected 2350)`
  );

  // The workout itself is still stored, and still counts when it is all we have for a day.
  const workout = await db.get(
    'SELECT * FROM apple_health_workouts WHERE user_id = ? AND workout_id = ?',
    [USER_ID, 'workout-run-1']
  );
  assert(workout && Math.round(workout.active_calories) === 320, 'the workout row itself is unchanged');
}

async function testWorkoutOnlyDayStillCounts(baseUrl, syncToken) {
  console.log('\n--- TEST 4: a workout-only payload still fills the day ---');
  await clearDay();

  await postPayload(baseUrl, syncToken, {
    workouts: [{
      id: 'workout-ride-1',
      name: 'Cycling',
      start: AT('18:00:00'),
      end: AT('19:00:00'),
      duration: 2400,
      activeEnergyBurned: { qty: 410, units: 'kcal' }
    }]
  });

  const row = await readDay();
  assert(row.active_calories === 410, `with no daily metrics the workout is the day (active_calories = ${row.active_calories})`);
  assert(row.active_minutes === 40, `and supplies the active minutes (active_minutes = ${row.active_minutes})`);
  assert(row.activity_source === 'apple', 'a workout IS activity, so the day is labelled apple');
}

// --- 5. Water survives a failed write and is never counted twice ------------------------
async function testWaterIsIdempotentAndLossless(baseUrl, syncToken) {
  console.log('\n--- TEST 5: water is idempotent and survives a failed write ---');
  await clearDay();

  const waterPayload = (entries) => ({
    metrics: [{ name: 'dietary_water', units: 'mL', data: entries }]
  });

  await postPayload(baseUrl, syncToken, waterPayload([
    { date: AT('08:00:00'), qty: 300 },
    { date: AT('09:00:00'), qty: 200 }
  ]));
  let row = await readDay();
  assert(row.water_ml === 500, `two samples make 500 ml (got ${row.water_ml})`);

  // The user taps "+300 ml" in the UI (POST /api/water/add writes exactly this).
  await db.run(
    'UPDATE health_metrics SET water_ml = COALESCE(water_ml, 0) + 300 WHERE user_id = ? AND date = ?',
    [USER_ID, DATE]
  );

  // Health Auto Export re-sends the same batch, as it does after any 5xx.
  await postPayload(baseUrl, syncToken, waterPayload([
    { date: AT('08:00:00'), qty: 300 },
    { date: AT('09:00:00'), qty: 200 }
  ]));
  row = await readDay();
  assert(row.water_ml === 800, `a resend of the same samples changes nothing (got ${row.water_ml}, expected 800)`);

  // THE REGRESSION: a sample committed by a request that then failed on the health_metrics
  // upsert. Under the old code its millilitres were lost for ever - the retry's
  // INSERT OR IGNORE returned changes = 0, so nothing added them to any counter.
  await db.run(
    'INSERT OR IGNORE INTO apple_health_water_samples (user_id, timestamp, date, qty) VALUES (?, ?, ?, ?)',
    [USER_ID, AT('10:00:00'), DATE, 250]
  );
  await postPayload(baseUrl, syncToken, waterPayload([
    { date: AT('08:00:00'), qty: 300 },
    { date: AT('09:00:00'), qty: 200 },
    { date: AT('10:00:00'), qty: 250 }
  ]));
  row = await readDay();
  assert(
    row.water_ml === 1050,
    `water from a sample stored by a failed request is recovered on the retry (got ${row.water_ml}, expected 1050)`
  );
  assert(row.water_ml_apple === 750, `Apple's share is tracked separately (water_ml_apple = ${row.water_ml_apple})`);

  // A genuinely new sample still adds normally.
  await postPayload(baseUrl, syncToken, waterPayload([{ date: AT('11:00:00'), qty: 150 }]));
  row = await readDay();
  assert(row.water_ml === 1200, `a new sample is added once (got ${row.water_ml}, expected 1200)`);
}

async function main() {
  console.log('=== APPLE HEALTH WEBHOOK TESTS ===');
  let server;
  try {
    await db.initDb();
    const user = await db.get('SELECT sync_token FROM users WHERE id = ?', [USER_ID]);
    const started = await startServer();
    server = started.server;

    await testWaterOnlyPayloadDoesNotClaimTheDay(started.baseUrl, user.sync_token);
    await testRealActivityStillWins(started.baseUrl, user.sync_token);
    await testWorkoutsDoNotEraseTheDay(started.baseUrl, user.sync_token);
    await testWorkoutOnlyDayStillCounts(started.baseUrl, user.sync_token);
    await testWaterIsIdempotentAndLossless(started.baseUrl, user.sync_token);

    console.log('\n🎉 APPLE HEALTH WEBHOOK TESTS PASSED\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ APPLE HEALTH WEBHOOK TESTS FAILED');
    if (server) server.close();
    process.exit(1);
  }
}

main();
