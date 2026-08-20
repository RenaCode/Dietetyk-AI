// Tests for the energy battery (/api/dashboard/energy-battery) and the batch insight
// endpoint (/api/dashboard/insights).
//
// The Polish strings asserted below are the API's
// user-facing output, which stays Polish by design - translating the assertions would break
// them.
//
// Test uruchamia REALNY router Express na TYMCZASOWEJ bazie (DATABASE_DIR w katalogu
// system temp directory), never against backend/dietetyk.db - so it can be run locally
// without any risk of polluting development data.
//
// Order matters: DATABASE_DIR and APP_PASSWORD must be set BEFORE db.js/config.js are
// imported, because both read the environment when the module loads rather than when it is
// called.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-password-for-encryption';

const express = require('express');
const db = require('../db');

const TEST_USER_ID = 1;
let server;
let baseUrl;

function todayWarsaw() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function getJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathAndQuery}`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`The response is not JSON (status ${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function startServer() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  // Stub authentication - in production app.use('/api', requireAuth) in server.js does this.
  // What matters here is the insight logic, not sessions.
  app.use((req, res, next) => { req.user = { id: TEST_USER_ID }; next(); });
  app.use(require('../routes/dashboard'));

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function seedUser() {
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role, status)
     VALUES (?, 'battery_test', 'x', 'user', 'active')`,
    [TEST_USER_ID]
  );
}

async function setSetting(key, value) {
  await db.run(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [TEST_USER_ID, key, String(value)]
  );
}

async function clearMetrics() {
  await db.run(`DELETE FROM health_metrics WHERE user_id = ?`, [TEST_USER_ID]);
}

async function setMetrics(date, values) {
  const columns = Object.keys(values);
  await db.run(
    `INSERT INTO health_metrics (user_id, date, ${columns.join(', ')})
     VALUES (?, ?, ${columns.map(() => '?').join(', ')})
     ON CONFLICT(user_id, date) DO UPDATE SET
       ${columns.map(c => `${c} = excluded.${c}`).join(', ')}`,
    [TEST_USER_ID, date, ...columns.map(c => values[c])]
  );
}

// Fills the historical window with a calm, repeatable baseline so the day under test has
// something to compare against (the battery needs at least 7 days of load history).
async function seedBaseline(today, days = 30, activeCalories = 500) {
  for (let i = 1; i <= days; i++) {
    await setMetrics(shiftDate(today, -i), {
      sleep_score: 80,
      sleep_duration: 7.5,
      readiness_score: 80,
      active_calories: activeCalories,
      active_minutes: 45,
      steps: 9000
    });
  }
}

async function testNoDataIsHonest() {
  console.log('\n--- TEST 1: brak danych o nocy zwraca hasEnoughData=false ---');
  await clearMetrics();
  const today = todayWarsaw();

  const res = await getJson(`/api/dashboard/energy-battery?date=${today}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.hasEnoughData, false, 'The battery invented a number with no sleep data.');
  assert.strictEqual(res.body.reason, 'no_sleep_data');
  console.log(`  reason=${res.body.reason}`);
  console.log('✅ Missing data is reported plainly, with no invented number.');
}

async function testGoodNightGivesHighBattery() {
  console.log('\n--- TEST 2: good night + calm day = high battery ---');
  await clearMetrics();
  const today = todayWarsaw();
  await seedBaseline(today);
  await setMetrics(today, {
    sleep_score: 88, sleep_duration: 8.0, readiness_score: 85,
    active_calories: 120, active_minutes: 15, steps: 3000,
    stress_high_minutes: 10, stress_recovery_minutes: 200
  });

  const { body } = await getJson(`/api/dashboard/energy-battery?date=${today}`);
  assert.strictEqual(body.hasEnoughData, true);
  assert.ok(body.battery >= 50, `Expected a high battery, got ${body.battery}`);
  assert.strictEqual(body.sleepDebt.hours, 0, 'With nights above the goal the sleep debt should be zero.');
  console.log(`  battery=${body.battery} (${body.label}), sleep debt=${body.sleepDebt.hours}h`);
  console.log(`  recommendation: ${body.recommendation}`);
  console.log('✅ High battery after a good night.');
}

async function testSleepDebtDragsBatteryDown() {
  console.log('\n--- TEST 3: accumulated sleep debt lowers the battery ---');
  const today = todayWarsaw();

  // Variant A: the same day data, but 14 nights of 5h instead of 7.5h.
  await clearMetrics();
  await seedBaseline(today);
  await setMetrics(today, {
    sleep_score: 70, sleep_duration: 7.5, readiness_score: 70,
    active_calories: 500, active_minutes: 45, steps: 9000
  });
  const rested = (await getJson(`/api/dashboard/energy-battery?date=${today}`)).body;

  await clearMetrics();
  await seedBaseline(today);
  for (let i = 1; i <= 14; i++) {
    await setMetrics(shiftDate(today, -i), { sleep_duration: 5.0 });
  }
  await setMetrics(today, {
    sleep_score: 70, sleep_duration: 7.5, readiness_score: 70,
    active_calories: 500, active_minutes: 45, steps: 9000
  });
  const indebted = (await getJson(`/api/dashboard/energy-battery?date=${today}`)).body;

  console.log(`  rested: battery=${rested.battery}, debt=${rested.sleepDebt.hours}h`);
  console.log(`  in debt: battery=${indebted.battery}, debt=${indebted.sleepDebt.hours}h`);
  console.log(`  recommendation under debt: ${indebted.recommendation}`);

  assert.ok(indebted.sleepDebt.hours > 20, `The sleep debt should be large, got ${indebted.sleepDebt.hours}h`);
  assert.ok(indebted.battery < rested.battery,
    'The sleep debt did not lower the battery despite identical data for the current day.');
  assert.ok(indebted.recommendation.includes('Dług snu'),
    'With a large sleep debt the recommendation should point at sleep.');
  console.log('✅ Sleep debt genuinely lowers the battery and changes the recommendation.');
}

async function testHardDayDrainsMoreThanEasyDay() {
  console.log('\n--- TEST 4: a harder day than usual drains more battery ---');
  const today = todayWarsaw();
  const night = { sleep_score: 80, sleep_duration: 7.5, readiness_score: 80 };

  await clearMetrics();
  await seedBaseline(today);
  await setMetrics(today, { ...night, active_calories: 250, active_minutes: 20, steps: 5000 });
  const easy = (await getJson(`/api/dashboard/energy-battery?date=${today}`)).body;

  await clearMetrics();
  await seedBaseline(today);
  await setMetrics(today, { ...night, active_calories: 1400, active_minutes: 120, steps: 22000 });
  const hard = (await getJson(`/api/dashboard/energy-battery?date=${today}`)).body;

  console.log(`  light day: battery=${easy.battery}, drain=${easy.components.dayDrain}, ratio=${easy.strain.ratioToBaseline}`);
  console.log(`  hard day: battery=${hard.battery}, drain=${hard.components.dayDrain}, ratio=${hard.strain.ratioToBaseline}`);

  assert.ok(hard.components.dayDrain > easy.components.dayDrain,
    'A harder day did not use more battery than a light one.');
  assert.ok(hard.battery < easy.battery, 'A harder day did not lower the battery.');
  assert.ok(hard.strain.ratioToBaseline > easy.strain.ratioToBaseline);
  console.log('✅ Drain scales with load relative to the user own baseline.');
}

async function testHistoricalDayIsFullDay() {
  console.log('\n--- TEST 5: a historical day counts as a full day (isLive=false) ---');
  await clearMetrics();
  const today = todayWarsaw();
  const past = shiftDate(today, -3);
  await seedBaseline(today);
  await setMetrics(past, {
    sleep_score: 80, sleep_duration: 7.5, readiness_score: 80,
    active_calories: 500, active_minutes: 45, steps: 9000
  });

  const { body } = await getJson(`/api/dashboard/energy-battery?date=${past}`);
  assert.strictEqual(body.isLive, false, 'A historical day should not be marked as live.');
  assert.strictEqual(body.date, past);
  console.log(`  data=${body.date}, isLive=${body.isLive}, bateria=${body.battery}`);
  console.log('✅ Historical dates are distinguished from the live state.');
}

async function testBatchReturnsSameAsIndividual() {
  console.log('\n--- TEST 6: the batch returns the same as individual requests ---');
  await clearMetrics();
  const today = todayWarsaw();
  await seedBaseline(today);
  await setMetrics(today, {
    sleep_score: 82, sleep_duration: 7.8, readiness_score: 79,
    active_calories: 480, active_minutes: 40, steps: 8500
  });

  const ids = ['energy-battery', 'wellness-score', 'calorie-balance'];
  const batch = (await getJson(`/api/dashboard/insights?ids=${ids.join(',')}&date=${today}`)).body;

  for (const id of ids) {
    const single = (await getJson(`/api/dashboard/${id}?date=${today}`)).body;
    assert.strictEqual(batch.results[id].status, 'ok', `Insight ${id} did not return ok in the batch.`);
    assert.deepStrictEqual(batch.results[id].data, single,
      `The batched result differs from the individual one for ${id}.`);
    console.log(`  ${id}: batch == individual request ✓`);
  }
  console.log('✅ The batch yields results identical to individual requests.');
}

async function testBatchIsolatesUnknownIds() {
  console.log('\n--- TEST 7: an unknown insight does not break the whole batch ---');
  const today = todayWarsaw();
  const batch = (await getJson(
    `/api/dashboard/insights?ids=energy-battery,nie-ma-takiego,wellness-score&date=${today}`
  )).body;

  assert.strictEqual(batch.results['nie-ma-takiego'].status, 'unknown');
  assert.strictEqual(batch.results['energy-battery'].status, 'ok');
  assert.strictEqual(batch.results['wellness-score'].status, 'ok');
  console.log(`  statusy: ${Object.entries(batch.results).map(([k, v]) => `${k}=${v.status}`).join(', ')}`);
  console.log('✅ The bad entry is isolated; the rest is returned normally.');
}

async function testBatchRejectsEmptyAndOversizedRequests() {
  console.log('\n--- TEST 8: walidacja parametru ids ---');
  const empty = await getJson('/api/dashboard/insights');
  assert.strictEqual(empty.status, 400, 'Missing ids should give a 400.');
  assert.ok(Array.isArray(empty.body.available) && empty.body.available.length > 40,
    'The 400 response should suggest the list of available insights.');

  const tooMany = await getJson(`/api/dashboard/insights?ids=${Array.from({ length: 101 }, (_, i) => `x${i}`).join(',')}`);
  assert.strictEqual(tooMany.status, 400, 'Exceeding the ids limit should give a 400.');

  console.log(`  no ids -> 400, registered insights: ${empty.body.available.length}`);
  console.log(`  101 pozycji -> 400`);
  console.log('✅ Validation works.');
}

async function testLabelAndRecommendationAgree() {
  console.log('\n--- TEST 10: the label and the recommendation do not contradict ---');
  const today = todayWarsaw();

  // We check several charge levels, including values just under the band boundaries - that
  // is where the contradiction 'Niska' + 'Bateria w normie' appeared.
  const scenarios = [
    { name: 'high', day: { active_calories: 60, active_minutes: 5, steps: 1500 }, night: { sleep_score: 92, sleep_duration: 8.2, readiness_score: 90 } },
    { name: 'average', day: { active_calories: 500, active_minutes: 45, steps: 9000 }, night: { sleep_score: 78, sleep_duration: 7.2, readiness_score: 76 } },
    { name: 'low', day: { active_calories: 900, active_minutes: 90, steps: 16000 }, night: { sleep_score: 62, sleep_duration: 6.2, readiness_score: 58 } },
    { name: 'reserve', day: { active_calories: 1600, active_minutes: 150, steps: 25000 }, night: { sleep_score: 40, sleep_duration: 4.5, readiness_score: 38 } }
  ];

  // Which phrasings are acceptable for which label. 'Na rezerwie' and 'Niska' must never
  // receive a sentence saying things are normal, or that it is a good day for a harder
  // workout. The forbidden phrases stay Polish: they are matched against the backend's
  // own Polish recommendation text.
  const FORBIDDEN = {
    'Na rezerwie': ['w normie', 'dobry dzień na mocniejszy trening'],
    'Niska': ['w normie', 'dobry dzień na mocniejszy trening']
  };

  for (const s of scenarios) {
    await clearMetrics();
    await seedBaseline(today);
    await setMetrics(today, { ...s.night, ...s.day });
    const { body } = await getJson(`/api/dashboard/energy-battery?date=${today}`);

    console.log(`  ${s.name}: ${body.battery} "${body.label}" -> ${body.recommendation}`);

    const forbidden = FORBIDDEN[body.label] || [];
    for (const phrase of forbidden) {
      assert.ok(!body.recommendation.includes(phrase),
        `Label "${body.label}" (${body.battery}) together with a recommendation containing "${phrase}".`);
    }
  }
  console.log('✅ The label and the recommendation always say the same thing.');
}

async function testRegistryCoversAllInsightRoutes() {
  console.log('\n--- TEST 9: the registry covers every insight route ---');
  // The registry is built by intercepting router.get - if someone adds an insight
  // in a different style, this test catches it before the card silently drops off the dashboard.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dashboard.js'), 'utf8');
  const declared = [...source.matchAll(/router\.get\('\/api\/dashboard\/([a-z0-9-]+)'/g)]
    .map(m => m[1]);

  const available = (await getJson('/api/dashboard/insights')).body.available;
  const missing = declared.filter(id => !available.includes(id));

  console.log(`  routes in the file: ${declared.length}, in the registry: ${available.length}`);
  assert.strictEqual(missing.length, 0, `Left outside the registry: ${missing.join(', ')}`);
  console.log('✅ Every insight joins the batch automatically.');
}

async function main() {
  console.log('=== ENERGY BATTERY AND INSIGHT BATCH TESTS ===');
  let failed = false;
  try {
    await startServer();
    await seedUser();
    await setSetting('target_sleep_duration', 7.2);

    await testNoDataIsHonest();
    await testGoodNightGivesHighBattery();
    await testSleepDebtDragsBatteryDown();
    await testHardDayDrainsMoreThanEasyDay();
    await testHistoricalDayIsFullDay();
    await testBatchReturnsSameAsIndividual();
    await testBatchIsolatesUnknownIds();
    await testBatchRejectsEmptyAndOversizedRequests();
    await testLabelAndRecommendationAgree();
    await testRegistryCoversAllInsightRoutes();

    console.log('\n✅ ALL BATTERY AND BATCH TESTS PASSED.\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed = true;
  } finally {
    if (server) server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* katalog tymczasowy */ }
    // db.js holds an open connection and timers - exit the process explicitly.
    process.exit(failed ? 1 : 0);
  }
}

main();
