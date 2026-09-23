// Tests for services/pdfReport.js - the health report a user downloads and hands to a
// doctor or dietician.
//
// WHY THIS FILE EXISTS. Nothing in the `npm test` chain touched pdfReport.js at all, and it
// carried two defects at once, each of which is invisible from the outside because a PDF is
// still produced either way:
//
//  1. `aggregateNutritionAndHealth` is async, and buildHealthReportPdf called it WITHOUT
//     await. `stats` was therefore a Promise, every `stats.avgX` read as undefined, and the
//     document handed to a doctor said "Energia: undefined kcal" on every line of the
//     averages section. The PDF generated, downloaded and opened normally.
//  2. The meal SELECT listed only the summed columns and omitted `date`. The aggregator
//     divides nutrition totals by the number of DISTINCT meal dates, so without that column
//     the divisor collapses to 1 and "average daily intake" becomes the sum of the whole
//     window - a 2000 kcal/day patient described to their doctor as eating 60000 kcal/day.
//     This is the third place the same omission appeared (see tests/test-summary-aggregation.js
//     for the weekly and monthly e-mail reports).
//
// The two interact: services/summaries.js now rejects meal rows with no `date`, so with the
// missing await that rejection became an unhandled promise rejection - and server.js's
// unhandledRejection handler logs and returns rather than exiting, so the failure would have
// surfaced only as a stream of log lines next to a PDF full of `undefined`.
//
// The assertions below therefore check the NUMBERS in the document, not that a document was
// produced. A test that only asserted "a Buffer came back" would have passed against both
// bugs.
//
// Run with: node tests/test-pdf-report.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-pdf-'));
process.env.DATABASE_DIR = tmpDir;
// utils/encryption.js refuses to load without these; pdfReport pulls services/summaries.js in
// for getUserSettings and the aggregator, which reaches encryption for the per-user Gemini
// key. No encrypted value is exercised here.
process.env.APP_PASSWORD = 'test-app-password-for-pdf-report';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-pdf-report';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function stubModule(fullPath, exports) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports, children: [], paths: [] };
}

function resolveBackend(relativePath) {
  return require.resolve(path.join(BACKEND_DIR, relativePath));
}

// services/summaries.js is loaded as a side effect of requiring pdfReport; these three would
// otherwise reach Gemini, Mailgun and Open-Meteo at require time. The PDF report itself
// deliberately contains no AI text, so nothing here is part of what is being tested.
stubModule(resolveBackend('config.js'), {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async () => 'stubbed AI analysis',
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});
const sentEmails = [];
stubModule(resolveBackend('services/mailgun.js'), {
  sendMailgunEmail: async (message) => { sentEmails.push(message); }
});
stubModule(resolveBackend('utils/weatherContext.js'), {
  getWeatherAndTimeContext: async () => '',
  getUserLocationOverride: async () => null
});

const db = require('../db');

const PDF_REPORT_PATH = resolveBackend('services/pdfReport.js');
const PDFKIT_PATH = require.resolve('pdfkit', { paths: [BACKEND_DIR] });

let USER_ID = null;

// Two meals a day so that a day is never accidentally the same thing as a row: if the divisor
// were ever taken from meals.length rather than from distinct dates, these numbers would still
// come out wrong.
const LOGGED_DAYS = 3;
// Two workouts on one of those days, and one on a day whose health_metrics row has NO active
// calories. Both are deliberate: the first breaks any measure that counts DAYS (it would say
// 3 where the truth is 4), the second breaks any measure derived from active_calories (it
// would miss the strength session done without a watch). Between them they separate the two
// candidate measures completely - a count that comes out 4 can only have come from
// apple_health_workouts.
const WORKOUT_DAY_OFFSETS = [0, 0, 1, 2];
const TOTAL_WORKOUTS = WORKOUT_DAY_OFFSETS.length;
const DAILY_CALORIES = 2000;
const DAILY_PROTEIN = 150;
const DAILY_CARBS = 200;
const DAILY_FAT = 60;
const DAILY_STEPS = 8000;
const SLEEP_SCORE = 82;

function dateNDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function seed() {
  for (let i = 0; i < LOGGED_DAYS; i++) {
    const date = dateNDaysAgo(i);
    for (let half = 0; half < 2; half++) {
      await db.run(
        `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
        [USER_ID, date, `${date} ${half === 0 ? '08:00:00' : '18:00:00'}`, 'test meal',
          DAILY_CALORIES / 2, DAILY_PROTEIN / 2, DAILY_CARBS / 2, DAILY_FAT / 2, 12, 20, 750]
      );
    }
    // The oldest day records no active calories at all - a strength session logged without a
    // watch. A measure taken from active_calories cannot see it; apple_health_workouts can.
    const activeCalories = i === LOGGED_DAYS - 1 ? 0 : 400;
    await db.run(
      `INSERT INTO health_metrics (user_id, date, steps, active_calories, water_ml, sleep_score, readiness_score, weight, fat_ratio, muscle_mass, blood_pressure_systolic, blood_pressure_diastolic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [USER_ID, date, DAILY_STEPS, activeCalories, 2000, SLEEP_SCORE, 75, 80 - i * 0.1, 20, 35, 120, 80]
    );
  }

  for (let w = 0; w < WORKOUT_DAY_OFFSETS.length; w++) {
    await db.run(
      `INSERT INTO apple_health_workouts (user_id, workout_id, date, active_calories, duration_minutes)
       VALUES (?, ?, ?, ?, ?)`,
      [USER_ID, `workout-${w}`, dateNDaysAgo(WORKOUT_DAY_OFFSETS[w]), 300, 45]
    );
  }
  await db.run(
    `INSERT INTO body_measurements (user_id, date, chest, waist, biceps) VALUES (?, ?, ?, ?, ?)`,
    [USER_ID, dateNDaysAgo(LOGGED_DAYS - 1), 100, 85, 35]
  );
  await db.run(
    `INSERT INTO body_measurements (user_id, date, chest, waist, biceps) VALUES (?, ?, ?, ?, ?)`,
    [USER_ID, dateNDaysAgo(0), 100.5, 83.5, 35.5]
  );
}

// --- Phase 1: the real PDFKit, so the document itself is proven to render ---

async function testRealPdfIsProduced() {
  console.log('\n--- TEST: the real PDF renders ---');
  const { buildHealthReportPdf } = require('../services/pdfReport');
  const buffer = await buildHealthReportPdf(USER_ID, 30);

  assert(Buffer.isBuffer(buffer), 'buildHealthReportPdf resolves with a Buffer');
  assert(buffer.slice(0, 5).toString('latin1') === '%PDF-', 'the buffer is a real PDF document');
  assert(buffer.length > 1000, `the document has actual content (${buffer.length} bytes)`);
}

// --- Phase 2: PDFKit replaced by a recorder, so the text can be asserted on ---
//
// The rendered PDF compresses its content streams, so reading the numbers back out of the
// real document would mean inflating and parsing PDF internals - brittle, and it would test
// PDFKit rather than this application. Recording the strings passed to doc.text() checks the
// same thing at the boundary that matters: what the report says.

const recordedLines = [];

class RecordingDocument extends EventEmitter {
  constructor() {
    super();
    this.options = {};
  }
  registerFont() { return this; }
  font() { return this; }
  fontSize() { return this; }
  fillColor() { return this; }
  moveDown() { return this; }
  text(value) { recordedLines.push(String(value)); return this; }
  end() {
    // buildHealthReportPdf resolves from the 'end' event with the concatenated 'data' chunks,
    // so the recorder has to behave like the stream it replaces.
    this.emit('data', Buffer.from('%PDF-recorded'));
    this.emit('end');
  }
  destroy() {}
}

function installRecorder() {
  stubModule(PDFKIT_PATH, RecordingDocument);
  // pdfReport captured the real PDFDocument when it was first required in phase 1.
  delete require.cache[PDF_REPORT_PATH];
  return require('../services/pdfReport');
}

function findLine(label) {
  const line = recordedLines.find(l => l.startsWith(`${label}: `));
  assert(!!line, `the report contains a "${label}" line`);
  return line.slice(label.length + 2);
}

async function testAveragesAreNumbers() {
  console.log('\n--- TEST: the averages section holds numbers, not undefined ---');
  const { buildHealthReportPdf } = installRecorder();
  recordedLines.length = 0;
  await buildHealthReportPdf(USER_ID, 30);

  assert(recordedLines.length > 10, `the recorder captured the document text (${recordedLines.length} lines)`);

  // The blanket check. Without `await` on aggregateNutritionAndHealth every one of the fifteen
  // stats.* reads below renders as the string "undefined", so this single assertion is what
  // pins that bug down wherever in the document it shows up.
  const undefinedLines = recordedLines.filter(l => l.includes('undefined'));
  assert(
    undefinedLines.length === 0,
    `no line in the report reads "undefined" (offending lines: ${JSON.stringify(undefinedLines.slice(0, 5))})`
  );
  const nanLines = recordedLines.filter(l => /\bNaN\b/.test(l));
  assert(nanLines.length === 0, `no line in the report reads "NaN" (offending lines: ${JSON.stringify(nanLines.slice(0, 5))})`);
}

async function testDailyAverageIsPerDayNotWindowTotal() {
  console.log('\n--- TEST: "average daily" is an average, not the window sum ---');
  // Re-uses what testAveragesAreNumbers recorded; the document is deterministic for the seed.
  const energy = findLine('Energia');
  assert(
    energy === `${DAILY_CALORIES} kcal`,
    `daily energy is ${DAILY_CALORIES} kcal, not the ${LOGGED_DAYS}-day total (got "${energy}") ` +
    '- this fails if `date` is dropped from the meal SELECT again'
  );
  assert(energy !== `${DAILY_CALORIES * LOGGED_DAYS} kcal`, 'the figure is not the window sum');

  const macros = findLine('Białko / Węglowodany / Tłuszcz');
  assert(
    macros === `${DAILY_PROTEIN} g / ${DAILY_CARBS} g / ${DAILY_FAT} g`,
    `macros are per-day averages (got "${macros}")`
  );

  const steps = findLine('Kroki');
  assert(steps === String(DAILY_STEPS), `steps are the daily average (got "${steps}")`);

  const sleep = findLine('Średni wynik snu');
  assert(sleep === `${SLEEP_SCORE}/100`, `the sleep score is the measured value (got "${sleep}")`);

  // A "no data" field must stay readable rather than turning into undefined: the aggregator
  // returns null for these, and the report is supposed to print a Polish placeholder.
  const bp = findLine('Średnie ciśnienie tętnicze');
  assert(bp === '120/80 mmHg', `blood pressure is rendered from the metrics (got "${bp}")`);
}

async function testWorkoutCountComesFromTheWorkoutTable() {
  console.log('\n--- TEST: the workout figure is the one the project stands behind ---');
  // Re-uses what testAveragesAreNumbers recorded.
  const workouts = findLine('Treningi w okresie');

  // The number of rows in apple_health_workouts. Audit round 12 replaced the old measure -
  // days where active_calories > 0 - precisely because it scored a day holding several
  // workouts as one and could not see a workout logged without a watch. The seed contains
  // both of those cases, so the two measures cannot coincide by accident here.
  assert(
    workouts === String(TOTAL_WORKOUTS),
    `the report counts ${TOTAL_WORKOUTS} workouts from apple_health_workouts (got "${workouts}")`
  );

  const daysWithActiveCalories = LOGGED_DAYS - 1; // the oldest day has none
  assert(
    workouts !== String(daysWithActiveCalories),
    `it is NOT the rejected "days with active calories" measure, which would say ${daysWithActiveCalories}`
  );
  assert(
    workouts !== String(LOGGED_DAYS),
    `nor a plain count of days with data, which would say ${LOGGED_DAYS}`
  );
}

async function testPdfAgreesWithTheWeeklyEmail() {
  console.log('\n--- TEST: the PDF and the weekly e-mail report the same workout count ---');
  // The canary for the whole pattern this audit kept turning up: a fix landed at one call
  // site while another call site stayed on the old path. Both documents are built from the
  // same rows over the same seven days and go to the same person - a patient may well put
  // them side by side in front of a doctor - so they have to agree. If either caller is ever
  // changed alone, this assertion is what notices.
  const { buildHealthReportPdf } = require('../services/pdfReport');
  const { sendWeeklySummaryForUser } = require('../services/summaries');

  recordedLines.length = 0;
  await buildHealthReportPdf(USER_ID, 7);
  const fromPdf = findLine('Treningi w okresie');

  sentEmails.length = 0;
  await sendWeeklySummaryForUser(USER_ID);
  assert(sentEmails.length === 1, 'the weekly report was handed to the mailer');

  const match = sentEmails[0].html.match(/Treningi w tygodniu<\/td>\s*<td><strong>(\d+)<\/strong>/);
  assert(!!match, 'the weekly e-mail contains its workout row');
  const fromEmail = match[1];

  assert(
    fromPdf === fromEmail,
    `the PDF (${fromPdf}) and the weekly e-mail (${fromEmail}) report the same number of workouts`
  );
  assert(fromPdf === String(TOTAL_WORKOUTS), `and both report the ${TOTAL_WORKOUTS} real workouts`);
}

async function testEmptyPeriodStillRenders() {
  console.log('\n--- TEST: a user with no logged data ---');
  const { buildHealthReportPdf } = require('../services/pdfReport');
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role)
     VALUES ('pdf-test-empty', 'x', 'sync-token-pdf-test-empty', 'user')`
  );
  recordedLines.length = 0;
  await buildHealthReportPdf(inserted.id, 30);

  // An empty window is an ordinary state, not a broken query - the divisor falls back to the
  // window length and every average is 0. It must not print undefined either.
  const undefinedLines = recordedLines.filter(l => l.includes('undefined'));
  assert(undefinedLines.length === 0, 'an account with no meals or metrics still renders numbers, not undefined');
  assert(findLine('Energia') === '0 kcal', 'no meals gives 0 kcal/day rather than a division artefact');
  assert(findLine('Średni wynik snu') === 'brak danych', 'a metric with no data keeps its "brak danych" placeholder');
}

async function testUnknownUserRejects() {
  console.log('\n--- TEST: an unknown user id ---');
  const { buildHealthReportPdf } = require('../services/pdfReport');
  let threw = null;
  try {
    await buildHealthReportPdf(999999, 30);
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'building a report for a non-existent user rejects instead of producing an empty document');
}

async function main() {
  await db.initDb();
  // initDb seeds an admin with id 1, so this user takes whatever id follows.
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, sync_token, email, role, first_name, last_name)
     VALUES ('pdf-report-test', 'x', 'sync-token-pdf-report-test', 'pdf@example.com', 'user', 'Test', 'Patient')`
  );
  USER_ID = inserted.id;
  assert(typeof USER_ID === 'number' && USER_ID > 0, 'test user created');

  await seed();

  await testRealPdfIsProduced();
  await testAveragesAreNumbers();
  await testDailyAverageIsPerDayNotWindowTotal();
  await testWorkoutCountComesFromTheWorkoutTable();
  await testPdfAgreesWithTheWeeklyEmail();
  await testEmptyPeriodStillRenders();
  await testUnknownUserRejects();
}

main()
  .then(() => {
    console.log('\n🎉 PDF REPORT TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ PDF REPORT TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
