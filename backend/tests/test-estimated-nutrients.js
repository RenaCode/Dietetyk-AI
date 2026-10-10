// A missing AI estimate of sodium/fibre/sugar is missing, not 0 (audit 2026-10-09, W3).
//
// SQLite's SUM() skips NULL, and meals without a Gemini estimate store NULL. A day of three
// meals with ONE sodium estimate therefore summed to that meal alone and was filed as a
// "normal sodium" day in the sodium -> next-day blood pressure comparison, next to real
// Withings readings; "today's sodium" understated the day and kept the WHO/AHA warning
// silent. The e-mail and PDF averages added `m.sodium || 0` per meal and divided by every
// logged day. These tests feed data WITH gaps and check that incomplete days drop out.
//
// Run with: node tests/test-estimated-nutrients.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-estimates-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-estimates';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-estimates';

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
stubModule('config.js', {
  PORT: 0, genAI: {}, model: null,
  generateContentWithFallback: async () => 'stub',
  ACTIVE_GEMINI_MODEL: 'stub-model', DEFAULT_GEMINI_MODEL: 'stub-model',
  GEMINI_REQUEST_TIMEOUT_MS: 90000, GEMINI_WORST_CASE_MS: 180000
});
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });
stubModule('utils/weatherContext.js', { getWeatherAndTimeContext: async () => '', getUserLocationOverride: async () => null });

const express = require('express');
const db = require('../db');
const { getLocalDateString, shiftDate } = require('../utils/dates');
const { sumIfComplete, formatEstimateForPrompt } = require('../utils/estimatedNutrients');
const { aggregateNutritionAndHealth } = require('../services/summaries');

async function meal(userId, date, sodium, fiber = null) {
  await db.run(
    `INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sodium, analysis_json)
     VALUES (?, ?, 'test', 500, 20, 50, 20, ?, ?, '{}')`,
    [userId, date, fiber, sodium]
  );
}
async function bp(userId, date, sys, dia) {
  await db.run(
    `INSERT INTO health_metrics (user_id, date, blood_pressure_systolic, blood_pressure_diastolic) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET blood_pressure_systolic = excluded.blood_pressure_systolic, blood_pressure_diastolic = excluded.blood_pressure_diastolic`,
    [userId, date, sys, dia]
  );
}

async function run() {
  await db.initDb();
  const userId = (await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES ('estimates', 'x', 'sync_estimates_xxxxxxxxxxxxxx', 'user', 'active')`
  )).id;
  const today = getLocalDateString();

  console.log('\n--- TEST: the helpers ---');
  assert(sumIfComplete([{ sodium: 100 }, { sodium: null }], 'sodium') === null, 'a day with a missing estimate has no total');
  assert(sumIfComplete([{ sodium: 100 }, { sodium: 200 }], 'sodium') === 300, 'a complete day sums');
  assert(formatEstimateForPrompt(null, 'mg', 'pl') === 'brak szacunku', 'the prompt says "brak szacunku", not "0mg"');
  assert(/szacunek AI/.test(formatEstimateForPrompt(900, 'mg', 'pl')), 'a value is quoted as an AI estimate');

  // Six complete high-sodium days and six complete normal days, each followed by a BP reading.
  for (let i = 0; i < 6; i++) {
    const high = shiftDate(today, -(40 + i * 2));
    await meal(userId, high, 2000); await meal(userId, high, 1000);
    await bp(userId, shiftDate(high, 1), 140, 90);
    const normal = shiftDate(today, -(20 + i * 2));
    await meal(userId, normal, 700); await meal(userId, normal, 500);
    await bp(userId, shiftDate(normal, 1), 120, 80);
  }
  // Three incomplete days: one estimated meal (1500 mg) and two without. Their partial sums
  // look "normal"; the next-day readings are deliberately extreme so including them would show.
  for (let i = 0; i < 3; i++) {
    const partial = shiftDate(today, -(5 + i * 2));
    await meal(userId, partial, 1500); await meal(userId, partial, null); await meal(userId, partial, null);
    await bp(userId, shiftDate(partial, 1), 180, 110);
  }
  // Today: one meal with 1800 mg, one without an estimate.
  await meal(userId, today, 1800); await meal(userId, today, null);

  const app = express();
  app.use((req, res, next) => { req.user = { id: userId, username: 'estimates', role: 'user' }; next(); });
  app.use(require('../routes/dashboard'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    console.log('\n--- TEST: sodium -> blood pressure leaves incomplete days out ---');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/sodium-bp-insight?date=${today}`);
    const body = await res.json();
    assert(res.status === 200, 'the insight answers');
    assert(body.insight.normalSodiumDays === 6, `the partial days are not counted as normal-sodium days (got ${body.insight.normalSodiumDays})`);
    assert(body.insight.avgSystolicAfterNormalSodium === 120, `the normal group is not skewed by them (got ${body.insight.avgSystolicAfterNormalSodium})`);
    assert(body.insight.excludedIncompleteDays === 3, `the excluded days are reported (got ${body.insight.excludedIncompleteDays})`);
    assert(body.today.sodium === null && body.today.mealsWithoutEstimate === 1, `today's sodium is unknown, not 1800 (got ${body.today.sodium})`);
    assert(body.sodiumIsEstimate === true, 'the response says the values are estimates');
  } finally {
    server.close();
  }

  console.log('\n--- TEST: e-mail / PDF averages are over complete days only ---');
  const meals = [
    { date: '2026-10-01', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: 1000, fiber: 10 },
    { date: '2026-10-01', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: 1000, fiber: null },
    { date: '2026-10-02', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: 3000, fiber: null }
  ];
  const stats = await aggregateNutritionAndHealth(meals, [], 2);
  assert(stats.avgSodium === 2500, `average sodium over the two complete days (2000 + 3000) / 2, got ${stats.avgSodium}`);
  assert(stats.avgFiber === null, `no complete fibre day -> no average (got ${stats.avgFiber}, before: 5)`);
  const gappy = await aggregateNutritionAndHealth([
    { date: '2026-10-01', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: 1200 },
    { date: '2026-10-01', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: null },
    { date: '2026-10-02', calories: 500, protein: 1, carbs: 1, fat: 1, sodium: 2000 }
  ], [], 2);
  assert(gappy.avgSodium === 2000, `an incomplete day does not drag the average down (got ${gappy.avgSodium}, before: 1600)`);
}

run()
  .then(() => {
    console.log('\n🎉 ESTIMATED NUTRIENT TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ ESTIMATED NUTRIENT TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
