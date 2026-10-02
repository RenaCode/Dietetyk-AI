// Input validation on the routes that WRITE per-day rows (routes/meals.js, routes/health.js).
//
// The bugs these tests pin down:
//
// 1. `date` was checked for presence only. It is the row key of meals, health_metrics and
//    body_measurements, and every aggregation selects on it with string comparisons, so
//    '2026-09-99' sorted inside September and was counted in that month's numbers, while
//    free text created rows no screen could show or delete.
// 2. POST /api/meals validated the photo's MIME type and size only when the value was a
//    well-formed data URL. Anything else skipped both checks and was STILL stored in
//    meals.image_base64 and served back as an <img src>.
// 3. Non-string `rawText` / `supplements` crashed on .trim() and came back as a 500.
//
// Gemini is stubbed (config.js) so the meal route can run with no network access; the stub
// counts its calls, which is how the tests prove a rejected request never reached the model.
//
// Run with: node tests/test-write-input-validation.js

process.env.TZ = 'Europe/Warsaw';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-write-validation-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-write-validation';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-write-validation';

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

let geminiCalls = 0;
stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async () => {
    geminiCalls += 1;
    return JSON.stringify({ calories: 300, protein: 20, carbs: 30, fat: 10, food_items: [] });
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const TOKEN = 'sess_write_validation_test_token';
// Assigned in run(): db.initDb() creates the bootstrap admin first, so the id is not fixed.
let USER_ID = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', requireAuth);
  app.use(require('../routes/meals'));
  app.use(require('../routes/health'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function post(baseUrl, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function countRows(table) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [USER_ID]);
  return row.n;
}

const BAD_DATES = ['2026-09-99', '2026-02-30', 'yesterday', '2026-9-1'];

async function testMealDates(baseUrl) {
  console.log('\n--- TEST: meal routes refuse a date that is not a calendar date ---');
  for (const date of BAD_DATES) {
    const before = geminiCalls;
    const res = await post(baseUrl, '/api/meals', { rawText: 'owsianka', date });
    assert(res.status === 400, `POST /api/meals with date "${date}" is rejected (got ${res.status}, expected 400)`);
    assert(geminiCalls === before, `...and never reaches the model`);
  }
  assert(await countRows('meals') === 0, 'no meal row was written for any malformed date');

  const ok = await post(baseUrl, '/api/meals', { rawText: 'owsianka', date: '2026-09-15' });
  assert(ok.status === 201, `a real calendar date is still accepted (got ${ok.status}, expected 201)`);
  const today = await post(baseUrl, '/api/meals', { rawText: 'kanapka z serem', date: '' });
  assert(today.status === 201, `an empty date still means "today" (got ${today.status}, expected 201)`);

  const mealId = ok.body.meals[0].id;
  const repeat = await post(baseUrl, '/api/meals/repeat', { mealId, date: '2026-09-99' });
  assert(repeat.status === 400, `POST /api/meals/repeat with a malformed date is rejected (got ${repeat.status}, expected 400)`);
  const repeatOk = await post(baseUrl, '/api/meals/repeat', { mealId, date: '2026-09-16' });
  assert(repeatOk.status === 201, `repeat to a real date still works (got ${repeatOk.status}, expected 201)`);
}

async function testMealImage(baseUrl) {
  console.log('\n--- TEST: a photo that is not a data URL is refused, not stored ---');
  const mealsBefore = await countRows('meals');
  const before = geminiCalls;

  const notDataUrl = await post(baseUrl, '/api/meals', { rawText: 'obiad', date: '2026-09-15', image: 'x'.repeat(200000) });
  assert(notDataUrl.status === 400, `a non-data-URL image is rejected (got ${notDataUrl.status}, expected 400)`);

  const notString = await post(baseUrl, '/api/meals', { rawText: 'obiad', date: '2026-09-15', image: { src: 'x' } });
  assert(notString.status === 400, `a non-string image is rejected (got ${notString.status}, expected 400)`);

  assert(geminiCalls === before, 'neither request reached the model');
  assert(await countRows('meals') === mealsBefore, 'and neither wrote a meal row');

  const stored = await db.get(`SELECT COUNT(*) AS n FROM meals WHERE user_id = ? AND image_base64 IS NOT NULL`, [USER_ID]);
  assert(stored.n === 0, 'no unvalidated image string ended up in meals.image_base64');

  const svg = await post(baseUrl, '/api/meals', { rawText: 'obiad', date: '2026-09-15', image: 'data:image/svg+xml;base64,PHN2Zz4=' });
  assert(svg.status === 400, `the existing MIME allowlist still applies to data URLs (got ${svg.status}, expected 400)`);

  const png = await post(baseUrl, '/api/meals', { rawText: 'obiad', date: '2026-09-15', image: 'data:image/png;base64,iVBORw0KGgo=' });
  assert(png.status === 201, `a well-formed PNG data URL is still accepted (got ${png.status}, expected 201)`);
}

async function testNonStringText(baseUrl) {
  console.log('\n--- TEST: non-string text fields are a 400, not a 500 ---');
  const meal = await post(baseUrl, '/api/meals', { rawText: 12345, date: '2026-09-15' });
  assert(meal.status === 400, `rawText as a number is rejected with 400 (got ${meal.status})`);

  const supp = await post(baseUrl, '/api/supplements', { date: '2026-09-15', supplements: ['magnez'] });
  assert(supp.status === 400, `supplements as an array is rejected with 400 (got ${supp.status})`);
}

async function testHealthDates(baseUrl) {
  console.log('\n--- TEST: health write routes refuse a date that is not a calendar date ---');
  const metricsBefore = await countRows('health_metrics');
  const cases = [
    ['/api/water/add', { amount_ml: 250 }],
    ['/api/water/reset', {}],
    ['/api/supplements', { supplements: 'magnez' }],
    ['/api/feeling', { energy_level: 3 }],
    ['/api/body-measurements', { waist: 80 }]
  ];
  for (const [route, payload] of cases) {
    const res = await post(baseUrl, route, { ...payload, date: '2026-09-99' });
    assert(res.status === 400, `${route} with date "2026-09-99" is rejected (got ${res.status}, expected 400)`);
  }
  assert(await countRows('health_metrics') === metricsBefore, 'no health_metrics row was written for the malformed date');
  assert(await countRows('body_measurements') === 0, 'no body_measurements row was written either');

  for (const [route, payload] of cases) {
    const res = await post(baseUrl, route, { ...payload, date: '2026-09-15' });
    assert(res.status === 200, `${route} with a real date still works (got ${res.status}, expected 200)`);
  }
}

async function run() {
  await db.initDb();
  // The admin role lets routes/meals.js fall back to the (stubbed) server-side Gemini call
  // instead of demanding a per-user API key.
  const user = await db.run(
    `INSERT INTO users (username, email, password_hash, sync_token, role, status) VALUES ('write_validation', 'wv@example.com', 'x', 'sync_write_validation_test', 'admin', 'active')`
  );
  USER_ID = user.id;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa, is_temp) VALUES (?, ?, datetime('now', '+1 day'), 1, 0)`,
    [TOKEN, USER_ID]
  );
  const { server, baseUrl } = await startServer();
  try {
    await testMealDates(baseUrl);
    await testMealImage(baseUrl);
    await testNonStringText(baseUrl);
    await testHealthDates(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 WRITE INPUT VALIDATION TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.message || err));
    console.error('❌ WRITE INPUT VALIDATION TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
