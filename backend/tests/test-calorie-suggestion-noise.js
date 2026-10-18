// The calorie target suggestion must not propose a gap smaller than its own noise
// (audit 2026-10-10, U5).
//
// The card offered "Zastosuj cel" whenever the logged and weight-implied balances differed by
// 100 kcal/day, although the weight-implied one comes from a slope over a handful of noisy
// weigh-ins - ±314 kcal/day by the audit's estimate. Here a user logs exactly what they burn
// (logged balance 0) while the weight bounces around a flat line: the old endpoint read the
// bounce as a trend and proposed a new target; now it must say the gap is within noise. A
// clean trend must still produce a suggestion, with the range of plausible targets.
//
// Run with: node tests/test-calorie-suggestion-noise.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-kcal-noise-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-kcal-noise';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-kcal-noise';

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

const BMR = 1800;
const TARGET = 2000;

async function makeUser(name, weights) {
  const userId = (await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES (?, 'x', ?, 'user', 'active')`,
    [name, `sync_${name}_xxxxxxxxxxxxxxxxxxxx`]
  )).id;
  await db.run(`INSERT INTO settings (user_id, key, value) VALUES (?, 'bmr', ?), (?, 'target_calories', ?)`, [userId, String(BMR), userId, String(TARGET)]);
  const today = getLocalDateString();
  // 14 days eating exactly BMR with no activity: the logged balance is 0 kcal/day.
  for (let i = 0; i < 14; i++) {
    await db.run(
      `INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json) VALUES (?, ?, 'test meal', ?, 100, 200, 60, '{}')`,
      [userId, shiftDate(today, -i), BMR]
    );
  }
  for (const [daysAgo, kg] of weights) {
    await db.run(`INSERT INTO health_metrics (user_id, date, weight) VALUES (?, ?, ?)`, [userId, shiftDate(today, -daysAgo), kg]);
  }
  return userId;
}

async function suggestionFor(userId) {
  const app = express();
  app.use((req, res, next) => { req.user = { id: userId, username: 'x', role: 'user' }; next(); });
  app.use(require('../routes/dashboard'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/calorie-target-suggestion?date=${getLocalDateString()}`);
    return await res.json();
  } finally {
    server.close();
  }
}

async function run() {
  await db.initDb();

  console.log('\n--- TEST: a weight bouncing around a flat line proposes nothing ---');
  // Five weigh-ins over 14 days, ±0.6-0.8 kg of water noise around 80 kg. The least-squares
  // slope is about +0.05 kg/day (~ +370 kcal/day), but its 95% interval is several times that.
  const noisy = await makeUser('noisy', [[14, 79.6], [10, 80.7], [7, 79.5], [3, 80.8], [0, 80.1]]);
  const n = await suggestionFor(noisy);
  assert(n.hasEnoughData === true, 'the sample meets the minimums');
  assert(Math.abs(n.gap) >= 100, `the raw gap would have triggered the old 100 kcal rule (gap ${n.gap})`);
  assert(n.suggestionNeeded === false, `no target is proposed for a gap inside the noise (gap ${n.gap}, ±${n.gapUncertainty})`);
  assert(n.withinNoise === true, 'the response says why, so the card does not claim the balance is under control');
  assert(n.gapUncertainty > Math.abs(n.gap), `the reported uncertainty exceeds the gap (±${n.gapUncertainty})`);
  assert(n.suggestedTargetCalories === undefined, 'there is no target to apply');

  console.log('\n--- TEST: a clean trend still produces a suggestion with its range ---');
  // 0.1 kg/day gain (~770 kcal/day) with ±0.1 kg of noise - well outside any noise band.
  const trend = await makeUser('trend', [[14, 80.0], [11, 80.4], [8, 80.55], [5, 80.95], [2, 81.15], [0, 81.4]]);
  const t = await suggestionFor(trend);
  assert(t.suggestionNeeded === true, `a clear gain with a 0 logged balance is flagged (gap ${t.gap}, ±${t.gapUncertainty})`);
  assert(t.suggestedTargetCalories === TARGET - t.gap, `target = current - gap (got ${t.suggestedTargetCalories})`);
  assert(t.suggestedTargetRange && t.suggestedTargetRange.min < t.suggestedTargetCalories && t.suggestedTargetRange.max > t.suggestedTargetCalories,
    `the range brackets the target (${t.suggestedTargetRange && t.suggestedTargetRange.min}-${t.suggestedTargetRange && t.suggestedTargetRange.max})`);
  assert(Math.abs((t.suggestedTargetRange.max - t.suggestedTargetRange.min) / 2 - t.gapUncertainty) <= 1, 'the range is the target ± the reported uncertainty');
}

run()
  .then(() => {
    console.log('\n🎉 CALORIE SUGGESTION NOISE TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ CALORIE SUGGESTION NOISE TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
