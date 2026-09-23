// Tests for the nutrition aggregation behind the weekly and monthly e-mail reports
// (services/summaries.js - aggregateNutritionAndHealth and the two callers that feed it).
//
// The bug these pin down: the weekly/monthly meal query was "optimised" down to the columns
// whose values are summed (SELECT calories, protein, carbs, fat, fiber, sugar, sodium), which
// dropped `date`. The aggregator divides every nutrition total by the number of DISTINCT meal
// dates, so with m.date === undefined on every row the distinct set held a single element and
// the divisor became 1. "Average daily intake" in the prompt was then the sum of the whole
// window: a user eating 2000 kcal/day was described to Gemini as eating 14000 kcal/day (weekly)
// or ~60000 kcal/day (monthly), and the returned advice ("cut your intake drastically") was
// e-mailed to them - directly contradicting the correct weekly totals in the table above it.
//
// Nothing detected this because tests/test-summary-schedule.js replaces the whole
// services/summaries module with a stub, so the aggregation never ran in any test. This file
// runs the real sendWeeklySummaryForUser / sendMonthlySummaryForUser against a temporary
// database and inspects the prompt handed to the model, so removing `date` from either query
// fails the suite instead of silently changing the number.
//
// Run with: node tests/test-summary-aggregation.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-summary-agg-'));
process.env.DATABASE_DIR = tmpDir;
// utils/encryption.js refuses to load without these; summaries.js pulls it in for the
// per-user Gemini key. No encrypted value is exercised here.
process.env.APP_PASSWORD = 'test-app-password-for-summary-aggregation';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-summary-aggregation';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// Replaces a module in the require cache BEFORE services/summaries.js is loaded, so it gets
// these objects instead of the real ones (which would call Gemini, Mailgun and Open-Meteo).
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

const captured = { prompts: [], emails: [] };

stubModule('config.js', {
  PORT: 0,
  // Truthy so generateAiSummaryText takes the "generate" branch and we see the prompt.
  genAI: {},
  model: null,
  generateContentWithFallback: async (prompt) => {
    captured.prompts.push(prompt);
    return 'stubbed AI analysis';
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});
stubModule('services/mailgun.js', {
  sendMailgunEmail: async (message) => { captured.emails.push(message); }
});
stubModule('utils/weatherContext.js', {
  getWeatherAndTimeContext: async () => '',
  getUserLocationOverride: async () => null
});

const db = require('../db');
const {
  aggregateNutritionAndHealth,
  sendWeeklySummaryForUser,
  sendMonthlySummaryForUser
} = require('../services/summaries');

let USER_ID = null;
const DAILY_CALORIES = 2000;
const DAILY_PROTEIN = 150;

// The window boundary the two reports compute (Date.now() minus 7 or 30 days, sliced to
// YYYY-MM-DD), so the seeded dates land inside it exactly as production rows would.
function dateNDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function seed(numDays) {
  await db.run(`DELETE FROM meals WHERE user_id = ?`, [USER_ID]);
  // Two meals a day, so a day is not accidentally equivalent to a row - if the divisor were
  // ever taken from meals.length instead of distinct dates, the numbers would still be wrong.
  for (let i = 0; i < numDays; i++) {
    const date = dateNDaysAgo(i);
    for (let half = 0; half < 2; half++) {
      await db.run(
        `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
        [USER_ID, date, `${date} ${half === 0 ? '08:00:00' : '18:00:00'}`, 'test meal',
          DAILY_CALORIES / 2, DAILY_PROTEIN / 2, 100, 30, 10, 20, 500]
      );
    }
  }
}

// Pulls "Średnie dzienne spożycie energii: N kcal" (or the English variant) out of the prompt
// the model was given - that string is what the whole AI analysis is built on.
function avgCaloriesInPrompt(prompt) {
  const match = prompt.match(/(?:Średnie dzienne spożycie energii|Average daily energy intake): (\d+) kcal/);
  assert(!!match, 'prompt contains the average daily energy intake line');
  return Number(match[1]);
}

async function testWeeklyReportAverage() {
  console.log('\n--- TEST: weekly report - average daily calories ---');
  await seed(7);
  captured.prompts.length = 0;
  captured.emails.length = 0;

  await sendWeeklySummaryForUser(USER_ID);

  assert(captured.prompts.length === 1, 'weekly report built exactly one AI prompt');
  const avg = avgCaloriesInPrompt(captured.prompts[0]);
  assert(
    avg === DAILY_CALORIES,
    `weekly prompt reports ${DAILY_CALORIES} kcal/day, not the window total (got ${avg}) ` +
    '- this fails if `date` is dropped from the meal SELECT again'
  );
  assert(avg !== DAILY_CALORIES * 7, 'weekly average is not the 7-day sum (14000 kcal)');
  assert(captured.emails.length === 1, 'weekly report was handed to the mailer');
}

async function testMonthlyReportAverage() {
  console.log('\n--- TEST: monthly report - average daily calories ---');
  await seed(30);
  captured.prompts.length = 0;
  captured.emails.length = 0;

  await sendMonthlySummaryForUser(USER_ID);

  assert(captured.prompts.length === 1, 'monthly report built exactly one AI prompt');
  const avg = avgCaloriesInPrompt(captured.prompts[0]);
  assert(
    avg === DAILY_CALORIES,
    `monthly prompt reports ${DAILY_CALORIES} kcal/day, not the window total (got ${avg})`
  );
  assert(avg !== DAILY_CALORIES * 30, 'monthly average is not the 30-day sum (~60000 kcal)');
}

async function testDivisorIsDistinctDays() {
  console.log('\n--- TEST: aggregateNutritionAndHealth - divisor ---');
  const meals = [];
  for (let i = 0; i < 7; i++) {
    meals.push({ date: dateNDaysAgo(i), calories: 2000, protein: 150, carbs: 200, fat: 60, fiber: 25, sugar: 40, sodium: 2000 });
  }
  const stats = await aggregateNutritionAndHealth(meals, [], 7, null, null);
  assert(stats.avgEatenCalories === 2000, '7 days x 2000 kcal gives an average of 2000 kcal/day');
  assert(stats.totalEatenCalories === 14000, 'the window total stays 14000 kcal (the average is not the total)');

  // Irregular logging: the original point of dividing by days-with-data rather than by the
  // fixed window length. 2 logged days must not be deflated to ~571 kcal/day.
  const twoDays = meals.slice(0, 2);
  const sparse = await aggregateNutritionAndHealth(twoDays, [], 7, null, null);
  assert(sparse.avgEatenCalories === 2000, '2 logged days out of 7 still average 2000 kcal/day, not 571');
}

async function testMissingDateColumnIsRejected() {
  console.log('\n--- TEST: aggregateNutritionAndHealth - rows without a date ---');
  const rowsFromABrokenSelect = [
    { calories: 2000, protein: 150, carbs: 200, fat: 60, fiber: 25, sugar: 40, sodium: 2000 },
    { calories: 2000, protein: 150, carbs: 200, fat: 60, fiber: 25, sugar: 40, sodium: 2000 }
  ];
  let threw = null;
  try {
    await aggregateNutritionAndHealth(rowsFromABrokenSelect, [], 7, null, null);
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'meal rows without a `date` column are rejected instead of averaged by a divisor of 1');
  assert(/date/.test(threw.message), 'the error names the missing column, so the broken SELECT is findable');

  // An empty week is a normal state (a user who logged nothing), not a broken query.
  const empty = await aggregateNutritionAndHealth([], [], 7, null, null);
  assert(empty.avgEatenCalories === 0, 'no meals at all is still handled without throwing');
}

async function main() {
  await db.initDb();
  // initDb seeds an admin with id 1, so this user gets whatever id follows; everything below
  // addresses it through USER_ID rather than assuming a value.
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, sync_token, email, role, first_name)
     VALUES ('aggregation-test', 'x', 'sync-token-aggregation-test', 'test@example.com', 'user', 'Test')`
  );
  USER_ID = inserted.id;
  assert(typeof USER_ID === 'number' && USER_ID > 0, 'test user created');

  await testDivisorIsDistinctDays();
  await testMissingDateColumnIsRejected();
  await testWeeklyReportAverage();
  await testMonthlyReportAverage();

  console.log('\n✅ ALL SUMMARY AGGREGATION TESTS PASSED');
}

main()
  .then(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(err => {
    console.error(`\n${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
