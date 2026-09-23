// Tests for the date pairing between daytime behaviour and Oura sleep rows in
// routes/dashboard.js (nightAfterDay / dayBeforeNight / dayAfterNight).
//
// The bug these pin down: services/sync.js files every night's metrics under the date the
// sleep ENDED, so health_metrics(X).sleep_score describes the night that followed the waking
// day X-1. Several insights nevertheless joined behaviour and sleep on the identical date,
// which compared a day with a night that had finished before that day began - a 21:00 dinner
// on day D was scored against sleep that ended at 07:00 that same morning, and the card then
// advised the user to move dinner earlier. sleep-insight and
// sleep-workout-performance-insight had the mirror-image error, shifting a full day too far.
//
// The fixtures below are built so the relationship exists ONLY under the correct shift: the
// behaviour alternates day by day, so a pairing that is off by one day does not merely weaken
// the signal, it reverses its sign. Asserting the sign therefore fails on the pre-fix code
// instead of quietly passing on noise.
//
// Runs the REAL Express router against a TEMPORARY database (DATABASE_DIR under the system
// temp directory), never against backend/dietetyk.db.
//
// Run with: node tests/test-sleep-day-pairing.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-pairing-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-password-for-encryption';

const TEST_USER_ID = 1;

// Most insight routes rely on server.js mounting requireAuth for the whole /api prefix, but a
// few (sleep-workout-performance-insight) apply it themselves, so without this they answer
// 401 here. Identity is not what these tests are about.
const authPath = require.resolve(path.join(__dirname, '..', 'middleware', 'auth.js'));
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    requireAuth: (req, res, next) => { req.user = { id: TEST_USER_ID }; next(); },
    requireAdmin: (req, res, next) => next()
  }
};

const express = require('express');
const db = require('../db');
let server;
let baseUrl;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

// A fixed date passed as ?date=, so the fixtures do not depend on when the suite runs.
const TODAY = '2026-06-15';
const DAYS = 20;

function getJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathAndQuery}`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`Response is not JSON (status ${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function startServer() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  // Stubbed authentication - server.js does this with requireAuth in production. What is
  // under test is the date arithmetic, not sessions.
  app.use((req, res, next) => { req.user = { id: TEST_USER_ID }; next(); });
  app.use(require('../routes/dashboard'));

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function clearFixtures() {
  await db.run(`DELETE FROM meals WHERE user_id = ?`, [TEST_USER_ID]);
  await db.run(`DELETE FROM health_metrics WHERE user_id = ?`, [TEST_USER_ID]);
}

async function insertMeal(date, timeOfDay, { calories = 700, sugar = 20, fiber = 5 } = {}) {
  await db.run(
    `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json)
     VALUES (?, ?, ?, 'test meal', ?, 30, 60, 20, ?, ?, 400, '{}')`,
    [TEST_USER_ID, date, `${date} ${timeOfDay}`, calories, fiber, sugar]
  );
}

async function insertNight(date, fields) {
  const columns = Object.keys(fields);
  await db.run(
    `INSERT INTO health_metrics (user_id, date, ${columns.join(', ')})
     VALUES (?, ?, ${columns.map(() => '?').join(', ')})`,
    [TEST_USER_ID, date, ...columns.map(c => fields[c])]
  );
}

// --- meal-timing-sleep-insight: behaviour on day D -> the night filed under D + 1 ----------
//
// Day D-1 has a late dinner and a BAD following night, day D-2 an early dinner and a GOOD
// following night, alternating. Under the correct pairing late eating comes out with the worse
// sleep (negative diff); under the old same-date join every day is matched with its
// neighbour's night, so the same fixture yields the opposite sign.
async function testMealTimingPairing() {
  console.log('\n--- TEST: meal-timing-sleep-insight ---');
  await clearFixtures();

  const BAD_SLEEP = 60;
  const GOOD_SLEEP = 90;
  for (let k = 1; k <= DAYS; k++) {
    const day = shiftDate(TODAY, -k);
    const lateDinner = k % 2 === 1;
    await insertMeal(day, lateDinner ? '22:00:00' : '17:00:00');
    await insertNight(shiftDate(day, 1), {
      sleep_score: lateDinner ? BAD_SLEEP : GOOD_SLEEP,
      sleep_deep: lateDinner ? 0.5 : 1.5
    });
  }

  const { status, body } = await getJson(`/api/dashboard/meal-timing-sleep-insight?date=${TODAY}`);
  assert(status === 200, 'meal-timing-sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'meal-timing-sleep-insight has enough data');
  assert(
    body.avgSleepScoreLaterEating === BAD_SLEEP,
    `late dinners are matched with the night that FOLLOWS them (${BAD_SLEEP}), not the one that ended that morning (got ${body.avgSleepScoreLaterEating})`
  );
  assert(
    body.avgSleepScoreEarlierEating === GOOD_SLEEP,
    `early dinners are matched with their own following night (${GOOD_SLEEP}, got ${body.avgSleepScoreEarlierEating})`
  );
  assert(
    body.sleepScoreDiff < 0,
    `late eating shows WORSE sleep (negative diff, got ${body.sleepScoreDiff}) - an off-by-one day flips this sign`
  );
}

// --- sleep-insight: the night filed under D is followed by the waking day D -----------------
//
// The mirror-image error: this insight used to look at the meals of D + 1, a full day after
// the user woke up. Short nights are given a high-calorie waking day and good nights a normal
// one, alternating, so the old pairing reports the reverse.
async function testSleepInsightPairing() {
  console.log('\n--- TEST: sleep-insight ---');
  await clearFixtures();

  const CALORIES_AFTER_SHORT = 3000;
  const CALORIES_AFTER_GOOD = 2000;
  for (let k = 1; k <= DAYS; k++) {
    const night = shiftDate(TODAY, -k);
    const shortNight = k % 2 === 1;
    await insertNight(night, { sleep_duration: shortNight ? 6.0 : 8.0, sleep_score: 70 });
    // The waking day IS the night row's own date.
    const calories = shortNight ? CALORIES_AFTER_SHORT : CALORIES_AFTER_GOOD;
    await insertMeal(night, '12:00:00', { calories, sugar: shortNight ? 120 : 40 });
  }

  const { status, body } = await getJson(`/api/dashboard/sleep-insight?date=${TODAY}`);
  assert(status === 200, 'sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'sleep-insight has enough data');
  assert(
    body.avgCaloriesAfterShortSleep === CALORIES_AFTER_SHORT,
    `a short night is matched with the SAME date's eating (${CALORIES_AFTER_SHORT}, got ${body.avgCaloriesAfterShortSleep})`
  );
  assert(
    body.avgCaloriesAfterGoodSleep === CALORIES_AFTER_GOOD,
    `a good night is matched with the same date's eating (${CALORIES_AFTER_GOOD}, got ${body.avgCaloriesAfterGoodSleep})`
  );
  assert(
    body.caloriesDiff > 0,
    `short sleep shows MORE calories (positive diff, got ${body.caloriesDiff}) - taking meals from date + 1 flips this sign`
  );
}

// --- fiber-sleep-insight: eating on day D -> the night filed under D + 1 --------------------
async function testFiberSleepPairing() {
  console.log('\n--- TEST: fiber-sleep-insight ---');
  await clearFixtures();

  const DEEP_AFTER_HIGH_FIBER_H = 1.5;
  const DEEP_AFTER_LOW_FIBER_H = 0.5;
  for (let k = 1; k <= DAYS; k++) {
    const day = shiftDate(TODAY, -k);
    const highFiber = k % 2 === 1;
    await insertMeal(day, '13:00:00', { fiber: highFiber ? 40 : 5 });
    await insertNight(shiftDate(day, 1), {
      sleep_deep: highFiber ? DEEP_AFTER_HIGH_FIBER_H : DEEP_AFTER_LOW_FIBER_H,
      sleep_rem: highFiber ? 2.0 : 1.0
    });
  }

  const { status, body } = await getJson(`/api/dashboard/fiber-sleep-insight?date=${TODAY}`);
  assert(status === 200, 'fiber-sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'fiber-sleep-insight has enough data');
  // The endpoint reports deep sleep in minutes (stored in hours).
  assert(
    body.avgSleepDeepMoreFiber === DEEP_AFTER_HIGH_FIBER_H * 60,
    `high-fiber days are matched with their FOLLOWING night (${DEEP_AFTER_HIGH_FIBER_H * 60} min, got ${body.avgSleepDeepMoreFiber})`
  );
  assert(
    body.sleepDeepDiff > 0,
    `more fiber shows more deep sleep (positive diff, got ${body.sleepDeepDiff}) - an off-by-one day flips this sign`
  );
}

// --- workout-type-sleep-insight: training on day D -> the night filed under D + 1 -----------
async function testWorkoutTypeSleepPairing() {
  console.log('\n--- TEST: workout-type-sleep-insight ---');
  await clearFixtures();
  await db.run(`DELETE FROM apple_health_workouts WHERE user_id = ?`, [TEST_USER_ID]);

  const SLEEP_AFTER_TRAINING = 55;
  const SLEEP_AFTER_REST = 85;
  for (let k = 1; k <= DAYS; k++) {
    const day = shiftDate(TODAY, -k);
    const trained = k % 2 === 1;
    if (trained) {
      await db.run(
        `INSERT INTO apple_health_workouts (user_id, workout_id, date, workout_type, duration_minutes, active_calories)
         VALUES (?, ?, ?, 'HIIT', 45, 400)`,
        [TEST_USER_ID, `workout-${day}`, day]
      );
    }
    await insertNight(shiftDate(day, 1), { sleep_score: trained ? SLEEP_AFTER_TRAINING : SLEEP_AFTER_REST });
  }

  const { status, body } = await getJson(`/api/dashboard/workout-type-sleep-insight?date=${TODAY}`);
  assert(status === 200, 'workout-type-sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'workout-type-sleep-insight has enough data');
  const hiit = body.types.find(t => t.type === 'HIIT');
  assert(!!hiit, 'the HIIT type is present in the result');
  assert(
    hiit.avgSleepScore === SLEEP_AFTER_TRAINING,
    `HIIT days are matched with the night that FOLLOWS them (${SLEEP_AFTER_TRAINING}, got ${hiit.avgSleepScore})`
  );
  assert(
    body.avgRestDaySleepScore === SLEEP_AFTER_REST,
    `the rest-day baseline uses nights following a day WITHOUT a workout (${SLEEP_AFTER_REST}, got ${body.avgRestDaySleepScore})`
  );
  assert(
    hiit.diffVsRestDays < 0,
    `training shows worse sleep than rest days (negative diff, got ${hiit.diffVsRestDays}) - an off-by-one day flips this sign`
  );
}

// --- sedentary-sleep-insight: sitting on day D -> the night filed under D + 1 ---------------
async function testSedentarySleepPairing() {
  console.log('\n--- TEST: sedentary-sleep-insight ---');
  await clearFixtures();

  // 21 days rather than DAYS: only days whose FOLLOWING night exists can pair up, which
  // leaves an even number of usable days and therefore a median that sits between the two
  // sitting levels. With an odd count the median IS one of the two levels, and the endpoint's
  // `>= median` split drops every day into one group - a fixture problem, not a code defect.
  const SPAN = 21;
  const SLEEP_AFTER_MUCH_SITTING = 60;
  const SLEEP_AFTER_LITTLE_SITTING = 90;
  // sedentary_minutes and the sleep columns used to be read off ONE health_metrics row, so a
  // day of sitting was scored against the night that had ended that morning. Writing the two
  // halves on different rows here is what makes the fixture distinguish the two readings:
  // day D carries only the sitting, day D+1 only the sleep.
  for (let k = 1; k <= SPAN; k++) {
    const day = shiftDate(TODAY, -k);
    const muchSitting = k % 2 === 1;
    await insertNight(day, { sedentary_minutes: muchSitting ? 700 : 300 });
    await db.run(
      `UPDATE health_metrics SET sleep_score = ?, sleep_deep = ?, sleep_rem = ?
       WHERE user_id = ? AND date = ?`,
      [muchSitting ? SLEEP_AFTER_MUCH_SITTING : SLEEP_AFTER_LITTLE_SITTING,
        muchSitting ? 0.5 : 1.5, muchSitting ? 1.0 : 2.0,
        TEST_USER_ID, shiftDate(day, 1)]
    );
  }

  const { status, body } = await getJson(`/api/dashboard/sedentary-sleep-insight?date=${TODAY}`);
  assert(status === 200, 'sedentary-sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'sedentary-sleep-insight has enough data');
  assert(
    body.avgSleepScoreMoreSitting === SLEEP_AFTER_MUCH_SITTING,
    `days of heavy sitting are matched with their FOLLOWING night (${SLEEP_AFTER_MUCH_SITTING}, got ${body.avgSleepScoreMoreSitting})`
  );
  assert(
    body.sleepScoreDiff < 0,
    `more sitting shows worse sleep (negative diff, got ${body.sleepScoreDiff}) - an off-by-one day flips this sign`
  );
}

// --- water-sleep-insight: drinking on day D -> the night filed under D + 1 ------------------
async function testWaterSleepPairing() {
  console.log('\n--- TEST: water-sleep-insight ---');
  await clearFixtures();

  // See the SPAN comment in testSedentarySleepPairing - this endpoint splits at the median
  // too, so the number of usable days has to be even.
  const SPAN = 21;
  const SLEEP_AFTER_HYDRATED = 88;
  const SLEEP_AFTER_DRY = 58;
  for (let k = 1; k <= SPAN; k++) {
    const day = shiftDate(TODAY, -k);
    const hydrated = k % 2 === 1;
    await insertNight(day, { water_ml: hydrated ? 3000 : 900 });
    await db.run(
      `UPDATE health_metrics SET sleep_score = ?, sleep_deep = ? WHERE user_id = ? AND date = ?`,
      [hydrated ? SLEEP_AFTER_HYDRATED : SLEEP_AFTER_DRY, hydrated ? 1.5 : 0.6,
        TEST_USER_ID, shiftDate(day, 1)]
    );
  }

  const { status, body } = await getJson(`/api/dashboard/water-sleep-insight?date=${TODAY}`);
  assert(status === 200, 'water-sleep-insight responds 200');
  assert(body.hasEnoughData === true, 'water-sleep-insight has enough data');
  assert(
    body.avgSleepScoreWellHydrated === SLEEP_AFTER_HYDRATED,
    `well-hydrated days are matched with their FOLLOWING night (${SLEEP_AFTER_HYDRATED}, got ${body.avgSleepScoreWellHydrated})`
  );
  assert(
    body.sleepScoreDiff > 0,
    `drinking more shows better sleep (positive diff, got ${body.sleepScoreDiff}) - an off-by-one day flips this sign`
  );
}

// --- hydration-readiness-insight: drinking on day D -> the recovery measured over the night
// filed under D + 1. Readiness and HRV used to be read off the water row itself, i.e. from
// recovery measured BEFORE the drinking it was meant to reflect.
async function testHydrationReadinessPairing() {
  console.log('\n--- TEST: hydration-readiness-insight ---');
  await clearFixtures();

  const READINESS_AFTER_HYDRATED = 88;
  const READINESS_AFTER_DRY = 58;
  for (let k = 1; k <= DAYS; k++) {
    const day = shiftDate(TODAY, -k);
    const hydrated = k % 2 === 1;
    await insertNight(day, { water_ml: hydrated ? 3000 : 900 });
    await db.run(
      `UPDATE health_metrics SET readiness_score = ?, hrv = ?, rhr = ? WHERE user_id = ? AND date = ?`,
      [hydrated ? READINESS_AFTER_HYDRATED : READINESS_AFTER_DRY,
        hydrated ? 70 : 40, hydrated ? 50 : 60,
        TEST_USER_ID, shiftDate(day, 1)]
    );
  }

  const { status, body } = await getJson(`/api/dashboard/hydration-readiness-insight?date=${TODAY}`);
  assert(status === 200, 'hydration-readiness-insight responds 200');
  assert(body.hasEnoughData === true, 'hydration-readiness-insight has enough data');
  assert(
    body.avgReadinessHydrated === READINESS_AFTER_HYDRATED,
    `hydrated days are matched with the recovery of the FOLLOWING night (${READINESS_AFTER_HYDRATED}, got ${body.avgReadinessHydrated})`
  );
  assert(
    body.readinessDiff > 0,
    `drinking more shows better readiness (positive diff, got ${body.readinessDiff}) - an off-by-one day flips this sign`
  );
  assert(
    body.avgNextDayRhrHydrated === 50,
    `resting heart rate comes from the same following night as readiness (50, got ${body.avgNextDayRhrHydrated})`
  );
}

// --- sleep-workout-performance-insight: the night filed under D -> the workout of day D ----
//
// The mirror-image error: the row's date already IS the waking day the night ended on, so
// taking date + 1 skipped a whole day and scored a workout against the night before last.
async function testSleepWorkoutPerformancePairing() {
  console.log('\n--- TEST: sleep-workout-performance-insight ---');
  await clearFixtures();
  await db.run(`DELETE FROM apple_health_workouts WHERE user_id = ?`, [TEST_USER_ID]);

  const KCAL_PER_MIN_AFTER_GOOD = 10;
  const KCAL_PER_MIN_AFTER_POOR = 4;
  for (let k = 1; k <= DAYS; k++) {
    const day = shiftDate(TODAY, -k);
    const sleptWell = k % 2 === 1;
    await insertNight(day, { sleep_score: sleptWell ? 85 : 55 });
    const kcalPerMin = sleptWell ? KCAL_PER_MIN_AFTER_GOOD : KCAL_PER_MIN_AFTER_POOR;
    await db.run(
      `INSERT INTO apple_health_workouts (user_id, workout_id, date, workout_type, duration_minutes, active_calories)
       VALUES (?, ?, ?, 'Run', 60, ?)`,
      [TEST_USER_ID, `perf-${day}`, day, kcalPerMin * 60]
    );
  }

  const { status, body } = await getJson(`/api/dashboard/sleep-workout-performance-insight?date=${TODAY}`);
  assert(status === 200, 'sleep-workout-performance-insight responds 200');
  assert(body.hasEnoughData === true, 'sleep-workout-performance-insight has enough data');
  assert(
    body.avgKcalPerMinAfterGoodSleep === KCAL_PER_MIN_AFTER_GOOD,
    `a good night is matched with the workout of the day it ENDED on (${KCAL_PER_MIN_AFTER_GOOD}, got ${body.avgKcalPerMinAfterGoodSleep})`
  );
  assert(
    body.diff > 0,
    `a better night shows a better workout (positive diff, got ${body.diff}) - an off-by-one day flips this sign`
  );
}

async function main() {
  await startServer();
  await testMealTimingPairing();
  await testSleepInsightPairing();
  await testFiberSleepPairing();
  await testWorkoutTypeSleepPairing();
  await testSedentarySleepPairing();
  await testWaterSleepPairing();
  await testHydrationReadinessPairing();
  await testSleepWorkoutPerformancePairing();
  console.log('\n✅ ALL SLEEP/DAY PAIRING TESTS PASSED');
}

main()
  .then(() => {
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(err => {
    console.error(`\n${err.message}`);
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
