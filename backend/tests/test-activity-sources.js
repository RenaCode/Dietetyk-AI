// Test hierarchii źródeł danych o aktywności (utils/activitySources.js).
//
// Dlaczego akurat ten test: przed poprawką każdy upsert bronił się wyłącznie przed
// nadpisaniem danych z 'apple', a Google Fit i Oura były równorzędne - więc wynik
// dla tej samej doby zależał od KOLEJNOŚCI synchronizacji w danej godzinie.
// To klasa błędu, której nie widać w kodzie ani w logach: dane po prostu "migoczą".
// Test uruchamia realne zapytania SQL na bazie w pamięci (nie na dietetyk.db),
// więc weryfikuje wygenerowany SQL, a nie tylko funkcje pomocnicze w JS.

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

// Odtwarza kształt upsertu z services/sync.js dla dowolnego źródła.
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
  console.log('\n--- TEST 1: wynik nie zależy od kolejności synchronizacji ---');

  // Ta sama doba, te same dane, dwie różne kolejności zapisu.
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
    'Kroki różnią się w zależności od kolejności synchronizacji - to jest ten błąd.');
  assert.strictEqual(results[0].activity_source, results[1].activity_source,
    'Etykieta źródła różni się w zależności od kolejności synchronizacji.');
  assert.strictEqual(results[0].steps, 9000, 'Google Fit stoi wyżej od Oury, jego kroki powinny wygrać.');
  console.log('✅ Obie kolejności dają ten sam wynik.');
}

async function testAppleWins() {
  console.log('\n--- TEST 2: Apple Health wygrywa z pozostałymi źródłami ---');
  const db = await freshDb();

  await write(db, 'apple', { steps: 12000, calories: 600, distance: 8000 });
  let row = await write(db, 'oura', { steps: 3000, calories: 200, distance: 2000 });
  assert.strictEqual(row.steps, 12000, 'Oura nadpisała dane Apple Health.');
  row = await write(db, 'google_fit', { steps: 5000, calories: 300, distance: 4000 });
  assert.strictEqual(row.steps, 12000, 'Google Fit nadpisał dane Apple Health.');
  assert.strictEqual(row.activity_source, 'apple', 'Etykieta źródła zeszła z apple.');

  console.log(`  po zapisach oura+google_fit: steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Dane Apple Health nietknięte.');
  db.close();
}

async function testLowerSourceFillsGaps() {
  console.log('\n--- TEST 3: niższe źródło uzupełnia LUKI wyżej notowanego ---');
  const db = await freshDb();

  // Apple Health zaraportowało tylko kroki (typowe, gdy automatyzacja odpali się
  // zanim zegarek dosynchronizuje resztę metryk).
  await write(db, 'apple', { steps: 12000, calories: null, distance: null });
  const row = await write(db, 'oura', { steps: 3000, calories: 450, distance: 6000 });

  assert.strictEqual(row.steps, 12000, 'Kroki Apple Health zostały nadpisane.');
  assert.strictEqual(row.active_calories, 450, 'Pusta kolumna nie została uzupełniona przez Ourę.');
  assert.strictEqual(row.distance_meters, 6000, 'Pusta kolumna nie została uzupełniona przez Ourę.');
  assert.strictEqual(row.activity_source, 'apple', 'Etykieta powinna zostać przy apple - ma realne kroki.');

  console.log(`  steps=${row.steps} (apple), kcal=${row.active_calories} (oura), dystans=${row.distance_meters} (oura)`);
  console.log('✅ Luki uzupełnione, dane wyżej notowanego źródła zachowane.');
  db.close();
}

async function testZeroFromHigherSourceIsNotALock() {
  console.log('\n--- TEST 4: same zera z wyżej notowanego źródła nie blokują dnia ---');
  const db = await freshDb();

  // Regresja opisana w komentarzu w sync.js: dzień zapisany przez Apple Health
  // z samymi zerami nie może zostać trwale zablokowany na zerze.
  await write(db, 'apple', { steps: 0, calories: 0, distance: 0 });
  const row = await write(db, 'oura', { steps: 7500, calories: 400, distance: 5000 });

  assert.strictEqual(row.steps, 7500, 'Dzień pozostał zablokowany na zerze.');
  assert.strictEqual(row.activity_source, 'oura', 'Etykieta powinna przejść na oura - to ona dostarczyła realne dane.');

  console.log(`  steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Zera nie blokują uzupełnienia.');
  db.close();
}

async function testDistanceOnlyKeepsLabel() {
  console.log('\n--- TEST 5: sam dystans z wyżej notowanego źródła utrzymuje etykietę ---');
  const db = await freshDb();

  // Runda 12 audytu: dni, w których Apple Health dostarczył WYŁĄCZNIE dystans,
  // traciły ochronę etykiety i niższe źródło przejmowało activity_source.
  await write(db, 'apple', { steps: null, calories: null, distance: 9000 });
  const row = await write(db, 'oura', { steps: 6000, calories: 350, distance: 1000 });

  assert.strictEqual(row.distance_meters, 9000, 'Dystans Apple Health został nadpisany.');
  assert.strictEqual(row.activity_source, 'apple', 'Etykieta zeszła z apple mimo realnego dystansu.');

  console.log(`  dystans=${row.distance_meters}, steps=${row.steps}, source=${row.activity_source}`);
  console.log('✅ Etykieta utrzymana.');
  db.close();
}

async function main() {
  console.log('=== TESTY HIERARCHII ŹRÓDEŁ AKTYWNOŚCI ===');
  try {
    await testOrderIndependence();
    await testAppleWins();
    await testLowerSourceFillsGaps();
    await testZeroFromHigherSourceIsNotALock();
    await testDistanceOnlyKeepsLabel();
    console.log('\n✅ WSZYSTKIE TESTY HIERARCHII ŹRÓDEŁ PRZESZŁY.\n');
  } catch (err) {
    console.error('\n❌ TEST NIE PRZESZEDŁ:', err.message);
    process.exit(1);
  }
}

main();
