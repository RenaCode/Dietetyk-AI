// Tests for the activity data source hierarchy (utils/activitySources.js).
//
// Why this test in particular: before the fix, each upsert guarded only against
// overwriting 'apple' data while Google Fit and Oura ranked equally - so the result for a
// given day depended on the ORDER the syncs ran in that hour. It is a class of bug that is
// invisible in the code and in the logs: the data simply flickers.
// The test runs real SQL against an in-memory database rather than dietetyk.db, so it
// verifies the generated SQL rather than just the JS helpers.

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const {
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
} = require('../utils/activitySources');

const LABEL_COLUMNS = ['steps', 'active_calories', 'distance_meters'];

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Reproduces the shape of the upsert in services/sync.js for any source.
function upsertSql(source) {
  const rank = getActivitySourceRank(source);
  return `
    INSERT INTO health_metrics (user_id, date, steps, active_calories, distance_meters, activity_source)
    VALUES (?, ?, ?, ?, ?, '${source}')
    ON CONFLICT(user_id, date) DO UPDATE SET
      ${preserveHigherPriority('steps', rank)},
      ${preserveHigherPriority('active_calories', rank)},
      ${preserveHigherPriority('distance_meters', rank)},
      ${preserveSourceLabel(rank, LABEL_COLUMNS)}
  `;
}

async function write(db, source, { steps = null, calories = null, distance = null }) {
  await run(db, upsertSql(source), [1, '2026-08-20', steps, calories, distance]);
  return get(db, `SELECT * FROM health_metrics WHERE user_id = 1 AND date = '2026-08-20'`);
}

async function freshDb() {
  const db = await openDb();
  await run(db, `
    CREATE TABLE health_metrics (
      user_id INTEGER, date TEXT,
      steps INTEGER, active_calories INTEGER, distance_meters INTEGER,
      activity_source TEXT,
      PRIMARY KEY (user_id, date)
    )
  `);
  return db;
}

async function testOrderIndependence() {
  console.log('\n--- TEST 1: the result does not depend on sync order ---');

  // Same day, same data, two different write orders.
  const orderA = [['oura', { steps: 4000 }], ['google_fit', { steps: 9000 }]];
  const orderB = [['google_fit', { steps: 9000 }], ['oura', { steps: 4000 }]];

  const results = [];
  for (const order of [orderA, orderB]) {
    const db = await freshDb();
    let row;
    for (const [source, data] of order) row = await write(db, source, data);
    results.push(row);
    db.close();
  }

  console.log(`  oura -> google_fit: steps=${results[0].steps}, source=${results[0].activity_source}`);
  console.log(`  google_fit -> oura: steps=${results[1].steps}, source=${results[1].activity_source}`);

  assert.strictEqual(results[0].steps, results[1].steps,
    'Steps differ depending on sync order - this is the bug.');
  assert.strictEqual(results[0].activity_source, results[1].activity_source,
    'The source label differs depending on sync order.');
  assert.strictEqual(results[0].steps, 9000, 'Google Fit ranks above Oura, so its step count should win.');
  console.log('✅ Both orders produce the same result.');
}

async function testAppleWins() {
  console.log('\n--- TEST 2: Apple Health beats the other sources ---');
  const db = await freshDb();

  await write(db, 'apple', { steps: 12000, calories: 600, distance: 8000 });
  let row = await write(db, 'oura', { steps: 3000, calories: 200, distance: 2000 });
  assert.strictEqual(row.steps, 12000, 'Oura overwrote the Apple Health data.');
  row = await write(db, 'google_fit', { steps: 5000, calories: 300, distance: 4000 });
  assert.strictEqual(row.steps, 12000, 'Google Fit overwrote the Apple Health data.');
  assert.strictEqual(row.activity_source, 'apple', 'The source label moved away from apple.');

  console.log(`  po zapisach oura+google_fit: steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Apple Health data untouched.');
  db.close();
}

async function testLowerSourceFillsGaps() {
  console.log('\n--- TEST 3: a lower source fills the GAPS of a higher one ---');
  const db = await freshDb();

  // Apple Health reported steps only - typical when the automation fires before the watch
  // has synced the remaining metrics.
  await write(db, 'apple', { steps: 12000, calories: null, distance: null });
  const row = await write(db, 'oura', { steps: 3000, calories: 450, distance: 6000 });

  assert.strictEqual(row.steps, 12000, 'The Apple Health step count was overwritten.');
  assert.strictEqual(row.active_calories, 450, 'An empty column was not filled in by Oura.');
  assert.strictEqual(row.distance_meters, 6000, 'An empty column was not filled in by Oura.');
  assert.strictEqual(row.activity_source, 'apple', 'The label should stay with apple - it holds real steps.');

  console.log(`  steps=${row.steps} (apple), kcal=${row.active_calories} (oura), dystans=${row.distance_meters} (oura)`);
  console.log('✅ Gaps filled, the higher source data preserved.');
  db.close();
}

async function testZeroFromHigherSourceIsNotALock() {
  console.log('\n--- TEST 4: all-zeros from a higher source do not lock the day ---');
  const db = await freshDb();

  // The regression described in the sync.js comment: a day written by Apple Health as all
  // zeros must not be permanently pinned at zero.
  await write(db, 'apple', { steps: 0, calories: 0, distance: 0 });
  const row = await write(db, 'oura', { steps: 7500, calories: 400, distance: 5000 });

  assert.strictEqual(row.steps, 7500, 'The day stayed pinned at zero.');
  assert.strictEqual(row.activity_source, 'oura', 'The label should move to oura - it supplied the real data.');

  console.log(`  steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Zeros do not block the fill-in.');
  db.close();
}

async function testDistanceOnlyKeepsLabel() {
  console.log('\n--- TEST 5: distance alone from a higher source keeps the label ---');
  const db = await freshDb();

  // Audit round 12: days where Apple Health supplied ONLY distance lost their label
  // protection and a lower source took over activity_source.
  await write(db, 'apple', { steps: null, calories: null, distance: 9000 });
  const row = await write(db, 'oura', { steps: 6000, calories: 350, distance: 1000 });

  assert.strictEqual(row.distance_meters, 9000, 'The Apple Health distance was overwritten.');
  assert.strictEqual(row.activity_source, 'apple', 'The label moved away from apple despite a real distance.');

  console.log(`  dystans=${row.distance_meters}, steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Label retained.');
  db.close();
}

async function main() {
  console.log('=== ACTIVITY SOURCE PRIORITY TESTS ===');
  try {
    await testOrderIndependence();
    await testAppleWins();
    await testLowerSourceFillsGaps();
    await testZeroFromHigherSourceIsNotALock();
    await testDistanceOnlyKeepsLabel();
    console.log('\n✅ ALL ACTIVITY SOURCE PRIORITY TESTS PASSED.\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    process.exit(1);
  }
}

main();
