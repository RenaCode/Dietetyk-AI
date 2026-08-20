// Testy baterii energii (/api/dashboard/energy-battery) oraz zbiorczego
// pobierania insightów (/api/dashboard/insights).
//
// Test uruchamia REALNY router Express na TYMCZASOWEJ bazie (DATABASE_DIR w katalogu
// tymczasowym systemu), nigdy na backend/dietetyk.db - dzięki temu można go puszczać
// lokalnie bez ryzyka zabrudzenia danych deweloperskich.
//
// Uwaga na kolejność: DATABASE_DIR i APP_PASSWORD muszą być ustawione ZANIM
// zaimportujemy db.js/config.js, bo oba czytają zmienne środowiskowe przy załadowaniu
// modułu, a nie przy wywołaniu.

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
          reject(new Error(`Odpowiedź nie jest JSON-em (status ${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function startServer() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  // Atrapa autoryzacji - w produkcji robi to app.use('/api', requireAuth) w server.js.
  // Tu interesuje nas logika insightów, nie sesje.
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

// Wypełnia okno historyczne spokojnym, powtarzalnym baseline'em, żeby testowany
// dzień miał się do czego porównać (bateria wymaga min. 7 dni historii obciążenia).
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
  assert.strictEqual(res.body.hasEnoughData, false, 'Bateria wymyśliła liczbę bez danych o śnie.');
  assert.strictEqual(res.body.reason, 'no_sleep_data');
  console.log(`  reason=${res.body.reason}`);
  console.log('✅ Brak danych raportowany wprost, bez zmyślonej liczby.');
}

async function testGoodNightGivesHighBattery() {
  console.log('\n--- TEST 2: dobra noc + spokojny dzień = wysoka bateria ---');
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
  assert.ok(body.battery >= 50, `Oczekiwano wysokiej baterii, było ${body.battery}`);
  assert.strictEqual(body.sleepDebt.hours, 0, 'Przy nocach powyżej celu dług snu powinien być zerowy.');
  console.log(`  bateria=${body.battery} (${body.label}), dług snu=${body.sleepDebt.hours}h`);
  console.log(`  zalecenie: ${body.recommendation}`);
  console.log('✅ Wysoka bateria przy dobrej nocy.');
}

async function testSleepDebtDragsBatteryDown() {
  console.log('\n--- TEST 3: skumulowany dług snu obniża baterię ---');
  const today = todayWarsaw();

  // Wariant A: te same dane dnia, ale 14 nocy po 5h zamiast 7.5h.
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

  console.log(`  wyspany: bateria=${rested.battery}, dług=${rested.sleepDebt.hours}h`);
  console.log(`  z długiem: bateria=${indebted.battery}, dług=${indebted.sleepDebt.hours}h`);
  console.log(`  zalecenie przy długu: ${indebted.recommendation}`);

  assert.ok(indebted.sleepDebt.hours > 20, `Dług snu powinien być duży, było ${indebted.sleepDebt.hours}h`);
  assert.ok(indebted.battery < rested.battery,
    'Dług snu nie obniżył baterii mimo identycznych danych bieżącego dnia.');
  assert.ok(indebted.recommendation.includes('Dług snu'),
    'Przy dużym długu snu zalecenie powinno wskazywać właśnie na sen.');
  console.log('✅ Dług snu realnie obniża baterię i zmienia zalecenie.');
}

async function testHardDayDrainsMoreThanEasyDay() {
  console.log('\n--- TEST 4: cięższy dzień niż zwykle zużywa więcej baterii ---');
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

  console.log(`  lekki dzień: bateria=${easy.battery}, zużycie=${easy.components.dayDrain}, ratio=${easy.strain.ratioToBaseline}`);
  console.log(`  ciężki dzień: bateria=${hard.battery}, zużycie=${hard.components.dayDrain}, ratio=${hard.strain.ratioToBaseline}`);

  assert.ok(hard.components.dayDrain > easy.components.dayDrain,
    'Cięższy dzień nie zużył więcej baterii niż lekki.');
  assert.ok(hard.battery < easy.battery, 'Cięższy dzień nie obniżył baterii.');
  assert.ok(hard.strain.ratioToBaseline > easy.strain.ratioToBaseline);
  console.log('✅ Zużycie skaluje się z obciążeniem względem własnego baseline.');
}

async function testHistoricalDayIsFullDay() {
  console.log('\n--- TEST 5: dzień historyczny liczony jako pełna doba (isLive=false) ---');
  await clearMetrics();
  const today = todayWarsaw();
  const past = shiftDate(today, -3);
  await seedBaseline(today);
  await setMetrics(past, {
    sleep_score: 80, sleep_duration: 7.5, readiness_score: 80,
    active_calories: 500, active_minutes: 45, steps: 9000
  });

  const { body } = await getJson(`/api/dashboard/energy-battery?date=${past}`);
  assert.strictEqual(body.isLive, false, 'Dzień historyczny nie powinien być oznaczony jako bieżący.');
  assert.strictEqual(body.date, past);
  console.log(`  data=${body.date}, isLive=${body.isLive}, bateria=${body.battery}`);
  console.log('✅ Daty historyczne rozróżniane od stanu bieżącego.');
}

async function testBatchReturnsSameAsIndividual() {
  console.log('\n--- TEST 6: wsad zwraca to samo co osobne żądania ---');
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
    assert.strictEqual(batch.results[id].status, 'ok', `Insight ${id} nie zwrócił ok we wsadzie.`);
    assert.deepStrictEqual(batch.results[id].data, single,
      `Wynik wsadowy różni się od pojedynczego dla ${id}.`);
    console.log(`  ${id}: wsad == pojedyncze żądanie ✓`);
  }
  console.log('✅ Wsad daje identyczne wyniki co osobne żądania.');
}

async function testBatchIsolatesUnknownIds() {
  console.log('\n--- TEST 7: nieznany insight nie przewraca całego wsadu ---');
  const today = todayWarsaw();
  const batch = (await getJson(
    `/api/dashboard/insights?ids=energy-battery,nie-ma-takiego,wellness-score&date=${today}`
  )).body;

  assert.strictEqual(batch.results['nie-ma-takiego'].status, 'unknown');
  assert.strictEqual(batch.results['energy-battery'].status, 'ok');
  assert.strictEqual(batch.results['wellness-score'].status, 'ok');
  console.log(`  statusy: ${Object.entries(batch.results).map(([k, v]) => `${k}=${v.status}`).join(', ')}`);
  console.log('✅ Błędna pozycja izolowana, reszta zwrócona normalnie.');
}

async function testBatchRejectsEmptyAndOversizedRequests() {
  console.log('\n--- TEST 8: walidacja parametru ids ---');
  const empty = await getJson('/api/dashboard/insights');
  assert.strictEqual(empty.status, 400, 'Brak ids powinien dać 400.');
  assert.ok(Array.isArray(empty.body.available) && empty.body.available.length > 40,
    'Odpowiedź 400 powinna podpowiadać listę dostępnych insightów.');

  const tooMany = await getJson(`/api/dashboard/insights?ids=${Array.from({ length: 101 }, (_, i) => `x${i}`).join(',')}`);
  assert.strictEqual(tooMany.status, 400, 'Przekroczenie limitu ids powinno dać 400.');

  console.log(`  bez ids -> 400, zarejestrowanych insightów: ${empty.body.available.length}`);
  console.log(`  101 pozycji -> 400`);
  console.log('✅ Walidacja działa.');
}

async function testLabelAndRecommendationAgree() {
  console.log('\n--- TEST 10: etykieta i zalecenie nie przeczą sobie ---');
  const today = todayWarsaw();

  // Sprawdzamy kilka poziomów naładowania, w tym wartości tuż pod granicami progów -
  // to tam pojawiła się sprzeczność "Niska" + "Bateria w normie".
  const scenarios = [
    { name: 'wysoka', day: { active_calories: 60, active_minutes: 5, steps: 1500 }, night: { sleep_score: 92, sleep_duration: 8.2, readiness_score: 90 } },
    { name: 'średnia', day: { active_calories: 500, active_minutes: 45, steps: 9000 }, night: { sleep_score: 78, sleep_duration: 7.2, readiness_score: 76 } },
    { name: 'niska', day: { active_calories: 900, active_minutes: 90, steps: 16000 }, night: { sleep_score: 62, sleep_duration: 6.2, readiness_score: 58 } },
    { name: 'rezerwa', day: { active_calories: 1600, active_minutes: 150, steps: 25000 }, night: { sleep_score: 40, sleep_duration: 4.5, readiness_score: 38 } }
  ];

  // Które sformułowania są dopuszczalne dla której etykiety. "Na rezerwie" i "Niska"
  // nie mogą nigdy dostać zdania mówiącego, że jest w normie albo że to dobry dzień
  // na mocniejszy trening.
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
        `Etykieta "${body.label}" (${body.battery}) razem z zaleceniem zawierającym "${phrase}".`);
    }
  }
  console.log('✅ Etykieta i zalecenie zawsze mówią to samo.');
}

async function testRegistryCoversAllInsightRoutes() {
  console.log('\n--- TEST 9: rejestr obejmuje wszystkie trasy insightów ---');
  // Rejestr jest budowany przez przechwycenie router.get - jeśli ktoś doda insight
  // w innym stylu, ten test to wychwyci, zanim karta po cichu wypadnie z dashboardu.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dashboard.js'), 'utf8');
  const declared = [...source.matchAll(/router\.get\('\/api\/dashboard\/([a-z0-9-]+)'/g)]
    .map(m => m[1]);

  const available = (await getJson('/api/dashboard/insights')).body.available;
  const missing = declared.filter(id => !available.includes(id));

  console.log(`  tras w pliku: ${declared.length}, w rejestrze: ${available.length}`);
  assert.strictEqual(missing.length, 0, `Poza rejestrem zostały: ${missing.join(', ')}`);
  console.log('✅ Każdy insight trafia do wsadu automatycznie.');
}

async function main() {
  console.log('=== TESTY BATERII ENERGII I WSADU INSIGHTÓW ===');
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

    console.log('\n✅ WSZYSTKIE TESTY BATERII I WSADU PRZESZŁY.\n');
  } catch (err) {
    console.error('\n❌ TEST NIE PRZESZEDŁ:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failed = true;
  } finally {
    if (server) server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* katalog tymczasowy */ }
    // db.js trzyma otwarte połączenie i timery - zamykamy proces jawnie.
    process.exit(failed ? 1 : 0);
  }
}

main();
