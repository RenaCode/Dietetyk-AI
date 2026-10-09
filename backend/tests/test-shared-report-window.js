// A shared report link shows the period the user chose to share - not whatever they logged
// afterwards (audit 2026-10-09, B-S3).
//
// The public endpoint (routes/sharedReport.js) rebuilds the PDF on every visit, and the window
// used to be "the last N days up to TODAY". A link sent to a doctor on Monday therefore showed,
// on Friday, four more days of meals, weight and workouts nobody had decided to share - for as
// long as the link lived (up to 30 days). The window now ends on the day the link was created.
//
// PDFKit is replaced by a recorder of doc.text() calls, as in tests/test-pdf-report.js: the
// real document compresses its streams, and what matters is what the report says.
//
// Run with: node tests/test-shared-report-window.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-share-window-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-share-window';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-share-window';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function stubModule(relativeOrFull, exports) {
  const full = path.isAbsolute(relativeOrFull) ? relativeOrFull : require.resolve(path.join(BACKEND_DIR, relativeOrFull));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async () => 'stubbed',
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });
stubModule('utils/weatherContext.js', { getWeatherAndTimeContext: async () => '', getUserLocationOverride: async () => null });

const recordedLines = [];
class RecordingDocument extends EventEmitter {
  constructor() { super(); this.options = {}; }
  registerFont() { return this; }
  font() { return this; }
  fontSize() { return this; }
  fillColor() { return this; }
  moveDown() { return this; }
  text(value) { recordedLines.push(String(value)); return this; }
  end() { this.emit('data', Buffer.from('%PDF-recorded')); this.emit('end'); }
  destroy() {}
}
stubModule(require.resolve('pdfkit', { paths: [BACKEND_DIR] }), RecordingDocument);

const express = require('express');
const db = require('../db');
const { getLocalDateString, shiftDate } = require('../utils/dates');
const { createShareLink } = require('../services/sharedReports');

async function addMeal(userId, date, calories) {
  await db.run(
    `INSERT INTO meals (user_id, date, timestamp, raw_text, calories, protein, carbs, fat, analysis_json)
     VALUES (?, ?, ?, 'test meal', ?, 10, 10, 10, '{}')`,
    [userId, date, `${date} 12:00:00`, calories]
  );
}

async function fetchReportLines(baseUrl, token) {
  recordedLines.length = 0;
  const res = await fetch(`${baseUrl}/api/public/shared-reports/${token}`);
  assert(res.status === 200, `the shared report opens (got ${res.status})`);
  return [...recordedLines];
}

const lineValue = (lines, label) => {
  const line = lines.find(l => l.startsWith(`${label}: `));
  return line ? line.slice(label.length + 2) : null;
};

async function run() {
  await db.initDb();
  const user = await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES ('share_window', 'x', 'sync_share_window_xxxxxxxxxxxx', 'user', 'active')`
  );
  const userId = user.id;
  const today = getLocalDateString();
  const sharedOn = shiftDate(today, -5);

  // One meal inside the shared period.
  await addMeal(userId, shiftDate(today, -8), 1500);

  const app = express();
  app.use(require('../routes/sharedReport'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n--- TEST: a link freezes its window on the day it was created ---');
    const { token } = await createShareLink(userId, 7, '30d');
    const stored = await db.get(`SELECT report_end_date FROM shared_reports WHERE token = ?`, [token]);
    assert(stored.report_end_date === today, `the link records its last day at creation (${stored.report_end_date})`);

    // Pretend the link was created five days ago, then log a meal "after sharing".
    await db.run(`UPDATE shared_reports SET report_end_date = ? WHERE token = ?`, [sharedOn, token]);
    await addMeal(userId, today, 3000);

    const lines = await fetchReportLines(baseUrl, token);
    const period = lineValue(lines, 'Okres raportu');
    assert(period && period.startsWith(`${shiftDate(sharedOn, -7)} - ${sharedOn}`), `the report period ends on the sharing day (${period})`);
    assert(lineValue(lines, 'Energia') === '1500 kcal', `the meal logged after sharing is not in the report (energy ${lineValue(lines, 'Energia')})`);

    console.log('\n--- TEST: a link created before the column existed freezes on created_at ---');
    const legacy = await createShareLink(userId, 7, '30d');
    await db.run(`UPDATE shared_reports SET report_end_date = NULL, created_at = ? WHERE token = ?`, [`${sharedOn} 10:00:00`, legacy.token]);
    const legacyLines = await fetchReportLines(baseUrl, legacy.token);
    assert((lineValue(legacyLines, 'Okres raportu') || '').includes(`- ${sharedOn}`), 'the legacy link ends on its creation date');
    assert(lineValue(legacyLines, 'Energia') === '1500 kcal', 'and leaves out the later meal too');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 SHARED REPORT WINDOW TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ SHARED REPORT WINDOW TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
