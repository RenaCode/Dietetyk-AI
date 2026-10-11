// Tests the retry budget of scheduled summaries (scheduler.js, claimSummaryAttempt).
//
// The bug this pins down (audit 2026-10, M7): the "already sent" key is written only after a
// successful send, and every send generates the AI text afresh. A summary that kept failing -
// Mailgun down, a recipient Mailgun rejects - was therefore retried on EVERY 5-minute tick
// until the day ended: ~12 Gemini calls an hour per user, all thrown away, and a duplicate
// email every five minutes when Mailgun delivered but answered too late.
//
// The summary senders are stubbed (the real ones call Gemini and Mailgun); each stub call
// stands for one AI generation + one send attempt.
//
// Run with: node tests/test-summary-retry.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-summary-retry-'));
process.env.DATABASE_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-summary-retry';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-summary-retry';

const BACKEND_DIR = path.join(__dirname, '..');
let dailyCalls = 0;
let dailyShouldFail = true;

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('services/sync.js', {
  syncAllOura: async () => {},
  syncAllWithings: async () => {},
  syncAllGoogleFit: async () => {}
});
stubModule('services/summaries.js', {
  sendDailySummaryForUser: async () => {
    dailyCalls += 1;
    if (dailyShouldFail) throw new Error('Mailgun API error: 503 - unavailable');
  },
  sendWeeklySummaryForUser: async () => {},
  sendMonthlySummaryForUser: async () => {}
});
stubModule('services/adminReport.js', { sendWeeklyAdminReport: async () => {} });

const db = require('../db');
const scheduler = require('../scheduler');

const RealDate = Date;
function freezeClock(isoInstant) {
  const fixedMs = new RealDate(isoInstant).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() {
      return fixedMs;
    }
  }
  global.Date = FrozenDate;
}
function restoreClock() {
  global.Date = RealDate;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function tickAt(iso) {
  freezeClock(iso);
  try {
    await scheduler.checkAndSendAutomatedSummaries();
  } finally {
    restoreClock();
  }
}

async function run() {
  await db.initDb();
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status)
    VALUES ('retry_user', 'x', 'sync_retry_user_000000000000', 0, 'retry@example.invalid', 'user', 'active')
  `);
  const user = await db.get(`SELECT id FROM users WHERE username = 'retry_user'`);
  for (const [key, value] of [['weekly_summary_enabled', '1'], ['weekly_summary_time', '08:00'], ['weekly_summary_day', '7'], ['monthly_summary_enabled', '0']]) {
    await db.run(`INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)`, [user.id, key, value]);
  }
  // The admin account seeded by initDb has no summaries enabled, so only retry_user counts.

  console.log('\n--- TEST: a failing daily summary is not retried on every tick ---');
  // 2026-09-15 (Tuesday) 08:00 UTC = 10:00 Warsaw, past the 08:00 schedule.
  await tickAt('2026-09-15T08:00:00Z');
  assert(dailyCalls === 1, 'the first tick attempts the summary once');

  await tickAt('2026-09-15T08:05:00Z');
  await tickAt('2026-09-15T08:10:00Z');
  assert(dailyCalls === 1, `ticks 5 and 10 minutes later do not regenerate it (calls: ${dailyCalls})`);

  await tickAt('2026-09-15T09:01:00Z');
  assert(dailyCalls === 2, 'after the backoff hour it is tried again');

  await tickAt('2026-09-15T10:02:00Z');
  await tickAt('2026-09-15T11:03:00Z');
  await tickAt('2026-09-15T12:04:00Z');
  assert(dailyCalls === 3, `the day's budget stops at 3 attempts (calls: ${dailyCalls})`);

  console.log('\n--- TEST: the next day starts with a fresh budget, and a success ends the retries ---');
  dailyShouldFail = false;
  await tickAt('2026-09-16T08:00:00Z');
  assert(dailyCalls === 4, 'the next day the summary is attempted again');
  await tickAt('2026-09-16T09:30:00Z');
  assert(dailyCalls === 4, 'once sent, it is not sent again the same day');
  const leftover = await db.get(`SELECT 1 AS ok FROM settings WHERE user_id = ? AND key = 'summary_attempt_daily'`, [user.id]);
  assert(!leftover, 'a successful send clears the attempt record');
}

run()
  .then(() => {
    console.log('\n🎉 SUMMARY RETRY TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ SUMMARY RETRY TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
