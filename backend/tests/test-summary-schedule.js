// Tests for the hourly tick in scheduler.js - specifically, WHEN it is willing to look at a
// user's configured summary time at all.
//
// The bug these pin down: runHourlySyncIfDue() returned early outside the 05:00-22:00 sync
// window, and the summary check (checkAndSendAutomatedSummaries) lived inside that early
// return. The window exists for the external Oura/Withings/Google Fit syncs - there is nothing
// to fetch overnight - but the summaries have nothing to do with it.
//
// The result was a silent hole rather than a delay. checkAndSendAutomatedSummaries fires on
// `currentTimeStr >= scheduledTime` and then writes a per-day idempotency key, so a time of
// 23:30 was never reached: 23:xx ticks did not run at all, and on the following day the first
// tick that DID run compared '05:00' >= '23:30', which is false, as was every later tick that
// day. A user who picked any minute between 23:00 and 23:59 in Settings - a plain
// <input type="time">, so all of them are selectable - simply never got a summary, and nothing
// in the logs said so.
//
// Run with: node tests/test-summary-schedule.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-schedule-'));
process.env.DATABASE_DIR = tmpDir;
// scheduler.js pulls in db.js, which needs nothing else; the stubbed modules below are the
// ones that would otherwise demand APP_PASSWORD (encryption) and network access.
process.env.APP_PASSWORD = 'test-app-password-for-summary-schedule';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-summary-schedule';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// Records of what the scheduler asked the outside world to do during one tick.
const calls = { oura: 0, withings: 0, googleFit: 0, daily: [], weekly: [], monthly: [], adminReport: 0 };

// Replaces a module in the require cache BEFORE scheduler.js is loaded, so the scheduler gets
// these objects instead of the real ones. The real modules would hit the Oura/Withings/Google
// APIs and Mailgun; this test is about the scheduler's gating, not about them.
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

stubModule('services/sync.js', {
  syncAllOura: async () => { calls.oura += 1; },
  syncAllWithings: async () => { calls.withings += 1; },
  syncAllGoogleFit: async () => { calls.googleFit += 1; }
});
stubModule('services/summaries.js', {
  sendDailySummaryForUser: async (userId) => { calls.daily.push(userId); },
  sendWeeklySummaryForUser: async (userId) => { calls.weekly.push(userId); },
  sendMonthlySummaryForUser: async (userId) => { calls.monthly.push(userId); }
});
stubModule('services/adminReport.js', {
  sendWeeklyAdminReport: async () => { calls.adminReport += 1; }
});

const db = require('../db');
const scheduler = require('../scheduler');

// Pins `new Date()` and `Date.now()` to one instant, so the test can ask "what does the
// scheduler do at 23:30 Warsaw time" without waiting until 23:30. Everything else about Date
// (parsing, Date.UTC, arithmetic) keeps working, which matters because utils/dates.js rebuilds
// dates through Date.UTC and formats them through Intl.
const RealDate = Date;
function freezeClock(isoInstant) {
  const fixedMs = new RealDate(isoInstant).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...args);
      }
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

// Every tick has to start from a clean slate: the scheduler remembers the last hour it ran for
// (a module-level variable) and the per-user "already sent today" keys live in the database.
async function resetSchedulerState() {
  await db.run(`DELETE FROM settings WHERE key LIKE 'last_%_summary_sent'`);
  await db.run(`DELETE FROM app_config WHERE key = 'last_admin_report_sent'`);
  // The scheduler keys its once-per-hour guard on the Warsaw date and hour, so moving the
  // frozen clock to a different hour is enough to make the next call eligible. Ticks below
  // deliberately use different hours for that reason.
}

async function seedUser(summaryTime) {
  await db.run(`UPDATE users SET email = 'scheduler-test@example.invalid', status = 'active' WHERE id = 1`);
  const rows = [
    ['weekly_summary_enabled', '1'],
    ['weekly_summary_time', summaryTime],
    ['weekly_summary_day', '1'],
    ['monthly_summary_enabled', '0']
  ];
  for (const [key, value] of rows) {
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (1, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }
}

async function run() {
  console.log('\n--- TESTS: scheduler.js summary window ---');

  await db.initDb();
  await seedUser('23:30');

  // 2026-09-15 is a Tuesday; 21:40 UTC is 23:40 Europe/Warsaw (CEST, UTC+2). The user's daily
  // summary is due at 23:30, so this tick must send it.
  await resetSchedulerState();
  freezeClock('2026-09-15T21:40:00Z');
  try {
    await scheduler.runHourlySyncIfDue();
  } finally {
    restoreClock();
  }

  assert(
    calls.daily.includes(1),
    'a daily summary scheduled for 23:30 is sent by the 23:xx tick - the summary check is no longer trapped inside the 05:00-22:00 sync window'
  );
  assert(
    calls.oura === 0 && calls.withings === 0 && calls.googleFit === 0,
    'the 23:xx tick still skips the external Oura/Withings/Google Fit syncs - the window that exists for them is unchanged'
  );

  // The other half of the contract: inside the window the syncs must still run, so the fix did
  // not simply delete the window.
  calls.daily.length = 0;
  await resetSchedulerState();
  // 2026-09-15 16:00 UTC = 18:00 Europe/Warsaw, inside the window, and past a 17:00 summary.
  await seedUser('17:00');
  freezeClock('2026-09-15T16:00:00Z');
  try {
    await scheduler.runHourlySyncIfDue();
  } finally {
    restoreClock();
  }

  assert(
    calls.oura === 1 && calls.withings === 1 && calls.googleFit === 1,
    'a tick inside the 05:00-22:00 window still runs all three external syncs'
  );
  assert(
    calls.daily.includes(1),
    'a daily summary scheduled inside the window is still sent'
  );
}

run()
  .then(() => {
    console.log('\n🎉 SUMMARY SCHEDULE TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ SUMMARY SCHEDULE TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
