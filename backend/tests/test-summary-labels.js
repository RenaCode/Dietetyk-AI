// Tests that the figures in the weekly and monthly e-mails are called the same thing in the
// AI prompt and in the statistics table (services/summaries.js).
//
// The defect these pin down is not a wrong number - it is a wrong NAME for a right number,
// which is harder to see and survives longer. Round 12 of the audit changed workoutsCount
// from "days with active_calories > 0" to "rows in apple_health_workouts". The table labels
// were updated to "Treningi w tygodniu" / "Treningi w miesiącu"; the prompt text was not, and
// went on telling Gemini "Workout days in the month" / "Liczba dni z treningiem w miesiącu".
// A user who trains twice a day was therefore described to the model as training twice as
// many days as the month contains, and the health advice written on that basis arrived in
// their inbox directly above a table quoting the very same number under a different name.
//
// The same class of mistake was found three other times in one audit round (a missing `date`
// column in three SELECTs, and pdfReport.js calling the aggregator without userId/startDate
// and silently getting the fallback branch), so it is worth a test that compares the two
// descriptions rather than checking either one alone.
//
// Also covered: the sign of weightChange. It is LAST minus FIRST measurement, so a loss is
// negative - which is what buildGoalPaceAnalysis reads to decide whether the user is moving
// towards their goal. That contract lived only in a comment, and the comment said the
// opposite ("first minus last"), so nothing would have caught an inversion.
//
// Run with: node tests/test-summary-labels.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-summary-labels-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-summary-labels';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-summary-labels';

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

const captured = { prompts: [], emails: [] };

stubModule('config.js', {
  PORT: 0,
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
const { sendWeeklySummaryForUser, sendMonthlySummaryForUser } = require('../services/summaries');

const TEST_USER_ID = 1;
const EMAIL = 'labels@example.com';

// Two sessions on ONE day, plus single sessions on two other days: 4 workouts across 3 days.
// The two counts differ, so a label claiming "days" while the value counts sessions is
// visible in the assertion rather than hidden behind a number that happens to match.
const WORKOUT_SESSIONS = 4;
const WORKOUT_DAYS = 3;

function dateNDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function setLanguage(language) {
  await db.run(
    `INSERT INTO settings (user_id, key, value) VALUES (?, 'language', ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [TEST_USER_ID, language]
  );
}

async function seed() {
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, role, status)
     VALUES (?, 'summary_labels_test', ?, 'x', 'admin', 'active')`,
    [TEST_USER_ID, EMAIL]
  );
  await db.run(`DELETE FROM meals WHERE user_id = ?`, [TEST_USER_ID]);
  await db.run(`DELETE FROM health_metrics WHERE user_id = ?`, [TEST_USER_ID]);
  await db.run(`DELETE FROM apple_health_workouts WHERE user_id = ?`, [TEST_USER_ID]);

  // Weight falls from 82.0 on the oldest day to 80.0 on the newest, i.e. a 2 kg LOSS.
  for (let i = 0; i < 6; i++) {
    const date = dateNDaysAgo(i);
    await db.run(
      `INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json)
       VALUES (?, ?, 'test meal', 2000, 150, 200, 60, 20, 40, 1000, '{}')`,
      [TEST_USER_ID, date]
    );
    await db.run(
      `INSERT INTO health_metrics (user_id, date, steps, active_calories, water_ml, weight, sleep_score, readiness_score)
       VALUES (?, ?, 9000, 500, 2500, ?, 80, 80)`,
      [TEST_USER_ID, date, 80 + (i * 0.4)]
    );
  }

  // Day 1 carries two sessions; days 2 and 3 one each.
  const workouts = [
    [dateNDaysAgo(1), 'a'], [dateNDaysAgo(1), 'b'],
    [dateNDaysAgo(2), 'c'], [dateNDaysAgo(3), 'd']
  ];
  for (const [date, suffix] of workouts) {
    await db.run(
      `INSERT INTO apple_health_workouts (user_id, workout_id, date, workout_type, duration_minutes, active_calories)
       VALUES (?, ?, ?, 'Run', 45, 400)`,
      [TEST_USER_ID, `w-${date}-${suffix}`, date]
    );
  }
}

// The number the e-mail table shows for a given row label.
function tableValue(html, label) {
  const match = html.match(new RegExp(`<td>${label}</td>\\s*<td><strong>([^<]*)</strong></td>`));
  return match ? match[1].trim() : null;
}

// The number the prompt reports on the line whose description starts with `label`.
function promptValue(prompt, label) {
  const line = prompt.split('\n').find(l => l.includes(label));
  if (!line) return null;
  return line.slice(line.lastIndexOf(':') + 1).trim();
}


// The header of the value column, and every row label in the table.
function valueColumnHeader(html) {
  const match = html.match(/<th>Parametr<\/th>\s*<th>([^<]*)<\/th>/);
  return match ? match[1].trim() : null;
}

function rowLabels(html) {
  return [...html.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td><strong>/g)].map(m => m[1].trim());
}

async function testMonthlyWorkoutCountIsCalledTheSameThingEverywhere() {
  console.log('\n--- TEST: monthly report - the workout figure has one name ---');
  captured.prompts.length = 0;
  captured.emails.length = 0;
  await setLanguage('pl');

  await sendMonthlySummaryForUser(TEST_USER_ID, EMAIL);
  assert(captured.prompts.length === 1, 'the monthly report built exactly one AI prompt');
  const prompt = captured.prompts[0];
  const html = captured.emails[0].html;

  assert(
    !/dni z treningiem|Workout days/i.test(prompt),
    'the prompt does not describe the figure as a number of DAYS - it is a number of sessions'
  );
  assert(
    prompt.includes('Treningi w miesiącu'),
    'the prompt uses the same wording as the table row ("Treningi w miesiącu")'
  );

  const fromPrompt = promptValue(prompt, 'Treningi w miesiącu');
  const fromTable = tableValue(html, 'Treningi w miesiącu');
  assert(fromTable === String(WORKOUT_SESSIONS), `the table counts sessions (${WORKOUT_SESSIONS}, got ${fromTable})`);
  assert(fromPrompt === String(WORKOUT_SESSIONS), `the prompt reports the same number (${WORKOUT_SESSIONS}, got ${fromPrompt})`);
  assert(
    fromPrompt !== String(WORKOUT_DAYS),
    `the figure is not the number of training days (${WORKOUT_DAYS}) - the fixture makes the two differ so a "days" label cannot pass by accident`
  );
}

async function testMonthlyEnglishVariantAgreesToo() {
  console.log('\n--- TEST: monthly report in English ---');
  captured.prompts.length = 0;
  captured.emails.length = 0;
  await setLanguage('en');

  await sendMonthlySummaryForUser(TEST_USER_ID, EMAIL);
  const prompt = captured.prompts[0];

  assert(!/Workout days/i.test(prompt), 'the English prompt does not call sessions "workout days" either');
  assert(prompt.includes('Workouts in the month'), 'the English prompt names the figure as workouts');
  assert(
    promptValue(prompt, 'Workouts in the month') === String(WORKOUT_SESSIONS),
    `the English prompt reports the session count (${WORKOUT_SESSIONS})`
  );
}

async function testWeeklyWorkoutCountAgrees() {
  console.log('\n--- TEST: weekly report - table and figure agree ---');
  captured.prompts.length = 0;
  captured.emails.length = 0;
  await setLanguage('pl');

  await sendWeeklySummaryForUser(TEST_USER_ID, EMAIL);
  const html = captured.emails[0].html;
  assert(
    tableValue(html, 'Treningi w tygodniu') === String(WORKOUT_SESSIONS),
    `the weekly table counts sessions (${WORKOUT_SESSIONS}, got ${tableValue(html, 'Treningi w tygodniu')})`
  );
}

async function testColumnHeaderIsTrueOfEveryRow() {
  console.log('\n--- TEST: monthly table - the column header does not lie about any row ---');
  captured.prompts.length = 0;
  captured.emails.length = 0;
  await setLanguage('pl');

  await sendMonthlySummaryForUser(TEST_USER_ID, EMAIL);
  const html = captured.emails[0].html;
  const header = valueColumnHeader(html);
  const labels = rowLabels(html);

  // The header used to read "Średnia" over a table that also holds a workout COUNT and three
  // start-to-end CHANGES. A header naming one statistic is only admissible if every row is
  // that statistic, and this table has not been such a table for several rounds.
  assert(
    !/(średni|suma|łącznie|razem)/i.test(header),
    `the value column header does not claim a statistic that is untrue of some rows (got "${header}")`
  );
  assert(header.length > 0, 'the value column still has a header');

  // Each row says for itself what period and what kind of figure it carries, so the reader
  // never has to infer it from the header.
  const averageRows = labels.filter(l => /Kalorie Spożyte|Białko|Węglowodany|Tłuszcz|Kroki|Kalorie Spalone|Woda/.test(l));
  assert(averageRows.length >= 7, `the daily-average rows are present (got ${averageRows.length})`);
  averageRows.forEach(l => assert(/śr\. dobowa/.test(l), `"${l}" says it is a daily average`));

  const nonAverageRows = labels.filter(l => /Treningi|Zmiana/.test(l));
  assert(nonAverageRows.length === 4, `the non-average rows are present (got ${nonAverageRows.length})`);
  nonAverageRows.forEach(l => {
    assert(/miesiąc/i.test(l), `"${l}" names its period instead of borrowing it from the header`);
    assert(!/śr\. dobowa/.test(l), `"${l}" is not described as a daily average`);
  });

  // The section heading above the table made the same claim as the header did.
  assert(
    !/Średnia Dobowa/i.test(html.slice(0, html.indexOf('<table>'))),
    'the section heading above the table does not call the whole table a set of daily averages either'
  );
}

async function testWeightChangeIsNegativeWhenTheUserLosesWeight() {
  console.log('\n--- TEST: the sign of the weight change ---');
  captured.prompts.length = 0;
  captured.emails.length = 0;
  await setLanguage('pl');

  await sendMonthlySummaryForUser(TEST_USER_ID, EMAIL);
  const html = captured.emails[0].html;
  const change = tableValue(html, 'Zmiana wagi \\(w miesiącu\\)');

  // Seeded 82.0 on the oldest day down to 80.0 on the newest.
  assert(change === '-2 kg', `a 2 kg loss is reported as a NEGATIVE change (got ${change}) - buildGoalPaceAnalysis reads this sign to tell progress from regression`);
  assert(
    captured.prompts[0].includes('zmiana w miesiącu: -2 kg'),
    'the prompt reports the same signed change as the table'
  );
}

async function run() {
  try {
    await db.initDb();
    await seed();
    await testMonthlyWorkoutCountIsCalledTheSameThingEverywhere();
    await testMonthlyEnglishVariantAgreesToo();
    await testWeeklyWorkoutCountAgrees();
    await testColumnHeaderIsTrueOfEveryRow();
    await testWeightChangeIsNegativeWhenTheUserLosesWeight();
    console.log('\n✅ ALL SUMMARY LABEL TESTS PASSED');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
}

run();
