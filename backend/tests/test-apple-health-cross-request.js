// End-to-end tests for Apple Health webhook behaviour that only shows up ACROSS requests
// (audit 2026-10-02). tests/test-apple-health-webhook.js pins the single-payload cases; every
// bug here passed it, because each one needs a second payload to arrive after the first.
//
//  1. AGGREGATED WATER WAS FROZEN AT ITS FIRST VALUE. Health Auto Export groups samples into
//     buckets (hour / day) and re-sends the CURRENT bucket with a growing total on every
//     export. The sample table was written with INSERT OR IGNORE keyed on the bucket
//     timestamp, so 250 ml exported at 14:10 was kept and the 500 ml exported for the same
//     14:00 bucket at 14:50 was dropped. With day grouping the whole day froze at whatever
//     the first export of the morning said.
//  2. A WORKOUT-ONLY PAYLOAD OVERWROTE THE DAY. The workout sum is a lower bound on the day's
//     active calories / minutes, but that bound was only applied against the metrics in the
//     SAME payload. Two automations (metrics, workouts) arrive as two requests, so the
//     workouts request replaced "750 kcal today" with "320 kcal in one run".
//  3. A null entry in sleep_analysis.data crashed the whole request with a 500 (the other
//     metric loops already skip such entries), which makes the phone retry the same payload
//     for ever.
//  4. A heart-rate notification carrying a very long heartRate[] list hit
//     `Math.min(...list)`, which throws a RangeError once the spread exceeds the engine's
//     argument limit - an events-only export then failed with a 500 on every retry.
//
// Run with: node tests/test-apple-health-cross-request.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-apple-cross-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-apple-cross';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-apple-cross';

const express = require('express');
const db = require('../db');

const USER_ID = 1;
const DATE = '2026-09-20';
// Warsaw is UTC+2 on that date, so these timestamps belong to DATE in Europe/Warsaw.
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

function readDay(date = DATE) {
  return db.get('SELECT * FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, date]);
}

async function clearDay(date = DATE) {
  await db.run('DELETE FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, date]);
  await db.run('DELETE FROM apple_health_water_samples WHERE user_id = ? AND date = ?', [USER_ID, date]);
  await db.run('DELETE FROM apple_health_workouts WHERE user_id = ? AND date = ?', [USER_ID, date]);
}

async function testAggregatedWaterBucketGrows(baseUrl, syncToken) {
  console.log('\n--- TEST 1: a re-exported water bucket with a larger total is not frozen ---');
  await clearDay();
  const water = (qty) => ({ metrics: [{ name: 'dietary_water', units: 'mL', data: [{ date: AT('14:00:00'), qty }] }] });

  await postPayload(baseUrl, syncToken, water(250));
  let row = await readDay();
  assert(row.water_ml === 250, `first export of the 14:00 bucket gives 250 ml (got ${row.water_ml})`);

  await postPayload(baseUrl, syncToken, water(500));
  row = await readDay();
  assert(row.water_ml === 500, `the same bucket re-exported with 500 ml is updated, not ignored (got ${row.water_ml})`);

  // And the update is still idempotent: a resend of the final value changes nothing.
  await postPayload(baseUrl, syncToken, water(500));
  row = await readDay();
  assert(row.water_ml === 500, `a resend of the same bucket value is idempotent (got ${row.water_ml})`);
}

async function testWorkoutOnlyPayloadDoesNotLowerTheDay(baseUrl, syncToken) {
  console.log('\n--- TEST 2: a workouts-only request does not overwrite the day from an earlier metrics request ---');
  await clearDay();

  await postPayload(baseUrl, syncToken, {
    metrics: [
      { name: 'active_energy', units: 'kcal', data: [{ date: AT('20:00:00'), qty: 750 }] },
      { name: 'apple_exercise_time', units: 'min', data: [{ date: AT('20:00:00'), qty: 60 }] }
    ]
  });
  await postPayload(baseUrl, syncToken, {
    workouts: [{
      id: 'cross-run-1', name: 'Running', start: AT('07:00:00'), end: AT('07:30:00'),
      duration: 1800, activeEnergyBurned: { qty: 320, units: 'kcal' }
    }]
  });

  let row = await readDay();
  assert(row.active_calories === 750, `the day keeps 750 kcal after a 320 kcal workout arrives separately (got ${row.active_calories})`);
  assert(row.active_minutes === 60, `the day keeps 60 active minutes (got ${row.active_minutes})`);

  // The bound still RAISES the day when the workouts outgrow what is stored.
  await postPayload(baseUrl, syncToken, {
    workouts: [{
      id: 'cross-ride-1', name: 'Cycling', start: AT('17:00:00'), end: AT('18:30:00'),
      duration: 5400, activeEnergyBurned: { qty: 600, units: 'kcal' }
    }]
  });
  row = await readDay();
  assert(row.active_calories === 920, `workouts summing past the stored value raise it (got ${row.active_calories}, expected 920)`);
  assert(row.active_minutes === 120, `and the minutes likewise (got ${row.active_minutes}, expected 120)`);
}

async function testNullSleepEntryIsSkipped(baseUrl, syncToken) {
  console.log('\n--- TEST 3: a null entry in sleep_analysis.data is skipped, not a 500 ---');
  await clearDay();
  const res = await postPayload(baseUrl, syncToken, {
    metrics: [{
      name: 'sleep_analysis',
      data: [null, { startDate: AT('00:30:00'), endDate: AT('07:30:00'), value: 'Core' }]
    }]
  });
  assert(res.status === 200, `the payload is accepted (status ${res.status})`);
  const row = await readDay();
  assert(row && row.sleep_duration === 7, `the valid entry is still stored (sleep_duration = ${row && row.sleep_duration})`);
}

async function testLongHeartRateNotification(baseUrl, syncToken) {
  console.log('\n--- TEST 4: a heart-rate notification with a very long sample list is stored ---');
  const heartRate = [];
  for (let i = 0; i < 200000; i++) heartRate.push({ hr: 100 + (i % 50) });
  const res = await postPayload(baseUrl, syncToken, {
    heartRateNotifications: [{ start: AT('12:00:00'), end: AT('12:10:00'), threshold: 120, heartRate }]
  });
  assert(res.status === 200, `the events-only payload is accepted (status ${res.status})`);
  const ev = await db.get(
    "SELECT * FROM apple_health_events WHERE user_id = ? AND kind = 'heart_rate_notification'",
    [USER_ID]
  );
  assert(ev && JSON.parse(ev.details_json).hr_max === 149, `min/max are computed over the whole list (got ${ev && ev.details_json})`);
}

async function main() {
  console.log('=== APPLE HEALTH CROSS-REQUEST TESTS ===');
  let server;
  try {
    await db.initDb();
    const user = await db.get('SELECT sync_token FROM users WHERE id = ?', [USER_ID]);
    const started = await startServer();
    server = started.server;

    await testAggregatedWaterBucketGrows(started.baseUrl, user.sync_token);
    await testWorkoutOnlyPayloadDoesNotLowerTheDay(started.baseUrl, user.sync_token);
    await testNullSleepEntryIsSkipped(started.baseUrl, user.sync_token);
    await testLongHeartRateNotification(started.baseUrl, user.sync_token);

    console.log('\n🎉 APPLE HEALTH CROSS-REQUEST TESTS PASSED\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ APPLE HEALTH CROSS-REQUEST TESTS FAILED');
    if (server) server.close();
    process.exit(1);
  }
}

main();
