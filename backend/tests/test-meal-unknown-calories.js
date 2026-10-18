// A meal without known calories is unknown, not 0 kcal (audit 2026-10-10, N7).
//
// Two ways a placeholder zero passed for a measurement: an AI answer with no `calories` was
// stored as an analysed 0 kcal meal (sanitizeNumber's fallback), and a meal saved while the AI
// was down (pending/failed, placeholder zeros) was summed into every multi-day aggregate. This
// test checks the ingestion, the API shape, the aggregates and the backfill of old rows.
//
// Run with: node tests/test-meal-unknown-calories.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-unknown-kcal-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-unknown-kcal';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-unknown-kcal';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
let nextAiAnswer = '{}';
stubModule('config.js', {
  PORT: 0, genAI: {}, model: null,
  generateContentWithFallback: async () => nextAiAnswer,
  ACTIVE_GEMINI_MODEL: 'stub-model', DEFAULT_GEMINI_MODEL: 'stub-model',
  GEMINI_REQUEST_TIMEOUT_MS: 90000, GEMINI_WORST_CASE_MS: 180000
});
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });
stubModule('utils/weatherContext.js', { getWeatherAndTimeContext: async () => '', getUserLocationOverride: async () => null });

const express = require('express');
const db = require('../db');
const { getLocalDateString, shiftDate } = require('../utils/dates');
const { hasCalorieValue } = require('../utils/mealCalories');
const { analyzeMeal, pendingFlags } = require('../services/mealAnalysis');
const { getCalorieBaseline } = require('../utils/mealAnomaly');

async function meal(userId, date, calories, { status = null, json = null } = {}) {
  return (await db.run(
    `INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json, analysis_status)
     VALUES (?, ?, 'test meal', ?, 10, 10, 10, ?, ?)`,
    [userId, date, calories, json || JSON.stringify({ calories }), status]
  )).id;
}

async function run() {
  await db.initDb();
  const userId = (await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES ('unknownkcal', 'x', 'sync_unknownkcal_xxxxxxxxxxxx', 'user', 'active')`
  )).id;
  const today = getLocalDateString();

  console.log('\n--- TEST: what counts as a calorie value ---');
  assert(hasCalorieValue(0) && hasCalorieValue(350) && hasCalorieValue('420'), 'numbers, a real 0 and numeric strings count');
  assert(!hasCalorieValue(undefined) && !hasCalorieValue(null) && !hasCalorieValue('') && !hasCalorieValue('około 300') && !hasCalorieValue(NaN),
    'missing, empty and non-numeric values do not - Number() would have made the first three a 0');

  console.log('\n--- TEST: an AI answer without calories is a failed analysis, not 0 kcal ---');
  nextAiAnswer = JSON.stringify({ protein: 20, carbs: 30, fat: 10, food_items: [] });
  let threw = false;
  try {
    await analyzeMeal({ userId, role: 'user', userText: 'kanapka', imagePart: null });
  } catch (err) {
    threw = true;
  }
  assert(threw, 'analyzeMeal rejects the answer, so POST /api/meals saves the meal as pending');
  nextAiAnswer = JSON.stringify({ meals: [{ name: 'a', calories: 300 }, { name: 'b', protein: 5 }] });
  threw = false;
  try {
    await analyzeMeal({ userId, role: 'user', userText: '', imagePart: { inlineData: { data: 'x', mimeType: 'image/png' } } });
  } catch (err) {
    threw = true;
  }
  assert(threw, 'one sub-meal of a photo without calories fails the photo instead of storing it as 0 kcal');
  nextAiAnswer = JSON.stringify({ calories: 0, protein: 0, carbs: 0, fat: 0, food_items: [] });
  const water = await analyzeMeal({ userId, role: 'user', userText: 'woda', imagePart: null });
  assert(water.length === 1 && water[0].calories === 0, 'a real 0 from the AI (water) is still accepted');

  console.log('\n--- TEST: the API reports placeholder macros as unknown ---');
  const pending = pendingFlags('pending');
  const failed = pendingFlags('failed');
  assert(pending.calories === null && pending.protein === null && pending.analysis_pending === true, 'pending -> calories null');
  assert(failed.calories === null && failed.fat === null && failed.analysis_failed === true, 'failed -> calories null');
  assert(Object.keys(pendingFlags(null)).length === 0, 'an analysed meal keeps its values');

  // Seven complete days of 2000 kcal, and two days where a 1000 kcal meal is joined by one the
  // AI never analysed - summed as 0, those days read as 1000 kcal and drag every average down.
  for (let i = 1; i <= 7; i++) {
    await meal(userId, shiftDate(today, -i), 1000);
    await meal(userId, shiftDate(today, -i), 1000);
  }
  for (const i of [8, 9]) {
    await meal(userId, shiftDate(today, -i), 1000);
    await meal(userId, shiftDate(today, -i), 0, { status: i === 8 ? 'pending' : 'failed', json: '{"analysis_pending":true}' });
  }

  console.log('\n--- TEST: the anomaly baseline ignores placeholder zeros ---');
  const baseline = await getCalorieBaseline(userId, today);
  assert(baseline.hasEnoughData && baseline.mean === 1000 && baseline.stddev === 0,
    `per-meal baseline is 1000 kcal with no spread (got mean ${baseline.mean}, stddev ${baseline.stddev})`);

  const app = express();
  app.use((req, res, next) => { req.user = { id: userId, username: 'unknownkcal', role: 'user' }; next(); });
  app.use(require('../routes/dashboard'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    console.log('\n--- TEST: multi-day aggregates leave days with an unanalysed meal out ---');
    const cmp = await (await fetch(`${base}/api/dashboard/nutrition-comparison?date=${today}`)).json();
    const month = cmp.month.current;
    assert(month.days_logged === 7, `the 30-day window counts the 7 complete days only (got ${month.days_logged})`);
    assert(month.avg.calories === 2000, `the average is 2000 kcal, not dragged towards 1000 (got ${month.avg.calories})`);

    const balance = await (await fetch(`${base}/api/dashboard/calorie-balance?date=${today}`)).json();
    assert(balance.month.days_with_data === 7, `the calorie balance skips the incomplete days (got ${balance.month.days_with_data})`);
    assert(balance.month.total_eaten === 14000, `eaten = 7 x 2000 (got ${balance.month.total_eaten})`);
  } finally {
    server.close();
  }

  console.log('\n--- TEST: old analysed 0 kcal rows without a calorie value are relabelled ---');
  const day = shiftDate(today, -60);
  const missing = await meal(userId, day, 0, { json: JSON.stringify({ name: 'zupa', protein: 5 }) });
  const realZero = await meal(userId, day, 0, { json: JSON.stringify({ name: 'woda', calories: 0 }) });
  const brokenJson = await meal(userId, day, 0, { json: 'not json' });
  const catering = (await db.run(
    `INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json, source, external_id)
     VALUES (?, ?, 'catering', 0, 0, 0, 0, '{}', 'dietly', 'ext-1')`, [userId, day]
  )).id;
  await db.initDb();
  const status = async (id) => (await db.get(`SELECT analysis_status, calories FROM meals WHERE id = ?`, [id]));
  assert((await status(missing)).analysis_status === 'failed', 'a saved AI answer with no calories -> failed');
  assert((await status(missing)).calories === 0, 'the column itself is untouched, so the relabel can be undone');
  assert((await status(realZero)).analysis_status === null, 'an AI answer with calories: 0 stays analysed');
  assert((await status(brokenJson)).analysis_status === null, 'unparseable JSON proves nothing and is left alone');
  assert((await status(catering)).analysis_status === null, 'catering imports are not touched');
  await db.initDb();
  assert((await status(missing)).analysis_status === 'failed', 'a second start changes nothing');
}

run()
  .then(() => {
    console.log('\n🎉 UNKNOWN CALORIE TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ UNKNOWN CALORIE TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
