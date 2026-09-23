// Tests for /api/dashboard/ai-explanation-insight (routes/dashboard.js) - the card that
// names the day's largest deviation from the user's own baseline and asks Gemini for one
// sentence explaining it.
//
// Two defects are pinned down here.
//
// 1. THE CACHE DID NOT RECORD WHAT IT WAS ABOUT. The explanation lived in two bare columns
//    (ai_explanation, ai_explanation_generated_at) with nothing saying which metric the
//    sentence described, while the finding itself was recomputed from live data on every
//    request. So a sentence generated in the morning for sleep_score was still served in the
//    afternoon, after a sync had made resting heart rate the largest deviation - the card
//    rendered the label "tętno spoczynkowe" over a sentence about the user's sleep. For PAST
//    days it never recovered: there the cache counted as fresh forever, and the only callers
//    of invalidateAiExplanationCache are routes/meals.js and routes/health.js - never
//    services/sync.js, which is exactly what backfills a past day's Oura and Withings data.
//
//    Keying the cache on the metric alone would only move the defect one step (same metric,
//    re-synced numbers, a sentence quoting values that no longer exist), so the key is a hash
//    of the whole prompt. These tests therefore also cover a change confined to the context.
//
// 2. THE LAST MEAL HOUR WAS SHIFTED BACK BY THE UTC OFFSET. meals.timestamp is written by
//    datetime('now','localtime') - a string with no timezone marker, in the timezone of the
//    process, which both deployments set to Europe/Warsaw. Reading it with getUTCHours()
//    converted that wall clock back to UTC, so a meal eaten at 21:30 was handed to the model
//    as "Godzina ostatniego posiłku: 19:00" and the model duly rejected a late dinner as the
//    explanation for a poor night.
//
// TZ is pinned below for that second case: the meaning of meals.timestamp depends on the
// process timezone, so a test that did not fix it would assert a different hour depending on
// the machine it ran on. Europe/Warsaw is what docker-compose.yml and the Helm chart set.
//
// Run with: node tests/test-ai-explanation.js

process.env.TZ = 'Europe/Warsaw';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-ai-explanation-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-ai-explanation';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-ai-explanation';

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

const captured = { prompts: [] };

stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  // The answer echoes the metric label the prompt was built for, so a cached sentence can be
  // traced back to the finding it actually describes - which is the whole question here.
  generateContentWithFallback: async (prompt) => {
    captured.prompts.push(prompt);
    const label = (prompt.match(/metryki "([^"]+)"/) || [])[1] || 'unknown';
    return `Wyjaśnienie dotyczące: ${label}`;
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});
stubModule('utils/weatherContext.js', {
  getWeatherAndTimeContext: async () => '',
  getUserLocationOverride: async () => null
});

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
      res.on('data', (chunk) => { body += chunk; });
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

// The handler generates in the background and answers `generating: true` first (the frontend
// polls, see Dashboard.jsx), so the tests wait for the text the same way the UI does.
async function getUntilExplained(query, attempts = 40) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await getJson(`/api/dashboard/ai-explanation-insight${query}`);
    if (last.body && last.body.explanation) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return last;
}

async function startServer() {
  await db.initDb();
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, role, status)
     VALUES (?, 'ai_explanation_test', 'explain@example.com', 'x', 'admin', 'active')`,
    [TEST_USER_ID]
  );
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: TEST_USER_ID, username: 'ai_explanation_test', role: 'admin' }; next(); });
  app.use(require('../routes/dashboard'));

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
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

// A calm, low-variance baseline: every metric has a small standard deviation, so a single
// clearly abnormal value on the day under test dominates the z-score comparison and it is
// unambiguous which metric the card should be about.
async function seedBaseline(today) {
  for (let i = 1; i <= 30; i++) {
    const even = i % 2 === 0;
    await setMetrics(shiftDate(today, -i), {
      sleep_score: even ? 80 : 84,
      readiness_score: even ? 80 : 84,
      hrv: even ? 60 : 64,
      rhr: even ? 55 : 57
    });
  }
}

const NORMAL_DAY = { sleep_score: 82, readiness_score: 82, hrv: 62, rhr: 56 };

async function testExplanationIsGeneratedForTheWorstMetric(today) {
  console.log('\n--- TEST: the explanation follows the metric it was generated for ---');
  await setMetrics(today, { ...NORMAL_DAY, sleep_score: 60 });

  const res = await getUntilExplained('');
  assert(res.body.hasFinding === true, 'a clearly abnormal sleep score produces a finding');
  assert(res.body.metric === 'sleep_score', 'the worst deviation is the sleep score');
  assert(res.body.explanation === 'Wyjaśnienie dotyczące: jakość snu',
    'the explanation that arrives is the one generated for that metric');
}

async function testCacheIsRejectedWhenTheMetricChanges(today) {
  console.log('\n--- TEST: today, the worst metric changes under a cached explanation ---');
  // What an afternoon Oura sync does: the sleep score turns out to be normal after all and
  // resting heart rate becomes the standout. The cached sentence is about sleep.
  await setMetrics(today, { ...NORMAL_DAY, rhr: 70 });

  const immediate = await getJson('/api/dashboard/ai-explanation-insight');
  assert(immediate.body.metric === 'rhr', 'the card is now about resting heart rate');
  assert(immediate.body.explanation === null,
    'the sentence about sleep is NOT served under the resting-heart-rate label - it is withheld until the right one exists');
  assert(immediate.body.generating === true, 'the card reports that it is regenerating, so the frontend polls');

  const settled = await getUntilExplained('');
  assert(settled.body.explanation === 'Wyjaśnienie dotyczące: tętno spoczynkowe',
    'the explanation that eventually arrives is about resting heart rate');
}

async function testCacheIsRejectedWhenOnlyTheNumbersChange(today) {
  console.log('\n--- TEST: today, same metric but re-synced values ---');
  // The metric does not change - only its value does, as happens when a device re-uploads a
  // corrected figure. The cached sentence quotes the OLD number, so it is just as wrong as a
  // sentence about a different metric; keying the cache on the metric alone would serve it.
  const before = captured.prompts.length;
  await setMetrics(today, { ...NORMAL_DAY, rhr: 90 });

  const immediate = await getJson('/api/dashboard/ai-explanation-insight');
  assert(immediate.body.metric === 'rhr', 'the metric is unchanged');
  assert(immediate.body.explanation === null,
    'a changed value invalidates the cached sentence too - the key covers the numbers, not just the metric name');

  await getUntilExplained('');
  assert(captured.prompts.length > before, 'a new prompt was actually sent for the corrected value');
  assert(captured.prompts[captured.prompts.length - 1].includes('dziś: 90'),
    'the regenerated prompt quotes the corrected value');
}

async function testPastDayCacheIsRejectedAfterABackfill(today) {
  console.log('\n--- TEST: a PAST day, backfilled by a sync ---');
  const yesterday = shiftDate(today, -1);
  const query = `?date=${yesterday}`;

  await setMetrics(yesterday, { ...NORMAL_DAY, sleep_score: 60 });
  const first = await getUntilExplained(query);
  assert(first.body.metric === 'sleep_score', 'the past day starts out as a sleep finding');
  assert(first.body.explanation === 'Wyjaśnienie dotyczące: jakość snu', 'and gets an explanation about sleep');

  // services/sync.js backfilling yesterday's Oura data. It does NOT call
  // invalidateAiExplanationCache - it never has - and a past day used to count as fresh
  // forever, so this is the case that stayed wrong permanently.
  await setMetrics(yesterday, { ...NORMAL_DAY, rhr: 75 });

  const afterSync = await getJson(`/api/dashboard/ai-explanation-insight${query}`);
  assert(afterSync.body.metric === 'rhr', 'after the backfill the past day is a resting-heart-rate finding');
  assert(afterSync.body.explanation === null,
    'the past-day cache does not survive a backfill it was never told about - no invalidation call is needed for this to hold');

  const settled = await getUntilExplained(query);
  assert(settled.body.explanation === 'Wyjaśnienie dotyczące: tętno spoczynkowe',
    'the past day ends up with an explanation about the metric it now shows');
}

async function testLegacyPlainTextCacheIsNotServed(today) {
  console.log('\n--- TEST: a row written before the key existed ---');
  const legacyDay = shiftDate(today, -2);
  await setMetrics(legacyDay, { ...NORMAL_DAY, sleep_score: 60 });
  await db.run(
    `UPDATE health_metrics SET ai_explanation = ?, ai_explanation_generated_at = ?
     WHERE user_id = ? AND date = ?`,
    ['Twój sen spadł, bo zjadłeś późną kolację.', new Date().toISOString(), TEST_USER_ID, legacyDay]
  );

  const res = await getJson(`/api/dashboard/ai-explanation-insight?date=${legacyDay}`);
  assert(res.body.explanation === null,
    'a bare sentence from before the key existed is not served - there is no way to tell what it described');
}

async function testLastMealHourIsWarsawWallClock(today) {
  console.log('\n--- TEST: the last meal hour handed to the model ---');
  await db.run(`DELETE FROM meals WHERE user_id = ?`, [TEST_USER_ID]);
  // Exactly what SQLite's datetime('now','localtime') writes: local wall clock, no offset.
  await db.run(
    `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, analysis_json)
     VALUES (?, ?, ?, 'kolacja', 700, 40, 60, 25, '{}')`,
    [TEST_USER_ID, today, `${today} 21:30:00`]
  );

  // Force a regeneration so a fresh prompt is built with the meal present.
  await setMetrics(today, { ...NORMAL_DAY, sleep_score: 55 });
  captured.prompts.length = 0;
  await getUntilExplained('');

  const prompt = captured.prompts[captured.prompts.length - 1];
  assert(prompt.includes('Godzina ostatniego posiłku: 21:00'),
    'a meal logged at 21:30 reaches the model as 21:00 - not 19:00, which is what getUTCHours() made of the Warsaw wall clock');
}

async function run() {
  try {
    await startServer();
    const today = todayWarsaw();
    await seedBaseline(today);

    await testExplanationIsGeneratedForTheWorstMetric(today);
    await testCacheIsRejectedWhenTheMetricChanges(today);
    await testCacheIsRejectedWhenOnlyTheNumbersChange(today);
    await testLastMealHourIsWarsawWallClock(today);
    await testPastDayCacheIsRejectedAfterABackfill(today);
    await testLegacyPlainTextCacheIsNotServed(today);

    console.log('\n✅ ALL AI EXPLANATION TESTS PASSED');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
}

run();
