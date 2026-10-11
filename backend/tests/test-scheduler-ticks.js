// Tests for what the 5-minute tick in scheduler.js is willing to do, and in what order
// (audit 2026-09-23).
//
// Two failure modes are pinned down here. Both were silent - the logs looked completely
// ordinary while nothing happened.
//
//  1. THE ONCE-PER-HOUR GATE SWALLOWED THE SUMMARY CHECK.
//     server.js ticks every 5 minutes, but `if (hourKey === lastSyncedHourKey) return;` let
//     only the FIRST tick of each clock hour through. The summary check decides on
//     `currentTimeStr >= scheduledTime`, so a user's configured time was compared exactly
//     once an hour, at whatever minute the process happened to start on. A summary set for
//     23:30 on a pod ticking at :00/:05/:10 was tested at 23:00 ('23:00' >= '23:30' is
//     false), the 23:35 and 23:55 ticks were dropped by the gate, and after midnight
//     todayStr changes while every remaining comparison that day is false too. The mail
//     never went. tests/test-summary-schedule.js does not catch this: it freezes the clock
//     at 23:40, i.e. at a first-tick-of-the-hour that happens to fall after the scheduled
//     time.
//
//  2. THE IRREVERSIBLE CLEANUP RAN BEFORE THE BACKUP, AND REGARDLESS OF IT.
//     server.js called cleanupOldImages() (blanks meal photos older than 14 days) and
//     cleanupOldLogs() first, then backupDatabase(), which reported failure by printing
//     `[BACKUP ERROR]` and returning. Nothing read that. A `./data` volume filling up makes
//     `VACUUM INTO` fail every night while the deletion goes ahead every night: after a
//     fortnight the newest usable backup predates the failure and the photos deleted since
//     then exist nowhere at all.
//
// Run with: node tests/test-scheduler-ticks.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-ticks-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-scheduler-ticks';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-scheduler-ticks';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const calls = { oura: 0, withings: 0, googleFit: 0, daily: [], loggedErrors: [] };
// Lets one test make the external sync hang the way a half-delivered HTTP body used to hang
// it (see utils/fetchWithTimeout.js).
let ouraGate = null;

// Replaces a module in the require cache BEFORE scheduler.js is loaded, so the scheduler gets
// these objects instead of the real ones - the real ones would reach the Oura/Withings/Google
// APIs and Mailgun.
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

stubModule('services/sync.js', {
  syncAllOura: async () => { calls.oura += 1; if (ouraGate) await ouraGate; },
  syncAllWithings: async () => { calls.withings += 1; },
  syncAllGoogleFit: async () => { calls.googleFit += 1; }
});
stubModule('services/summaries.js', {
  sendDailySummaryForUser: async (userId) => { calls.daily.push(userId); },
  sendWeeklySummaryForUser: async () => {},
  sendMonthlySummaryForUser: async () => {}
});
stubModule('services/adminReport.js', {
  sendWeeklyAdminReport: async () => {}
});
stubModule('services/logger.js', {
  error: (message, category) => { calls.loggedErrors.push({ message, category }); },
  warn: () => {},
  info: () => {},
  debug: () => {}
});

const db = require('../db');
const scheduler = require('../scheduler');

// Pins `new Date()` and `Date.now()` to one instant, so the test can ask "what does the
// scheduler do at 23:35 Warsaw time" without waiting until 23:35. Everything else about Date
// keeps working, which matters because utils/dates.js rebuilds dates through Date.UTC and
// formats them through Intl.
const RealDate = Date;
function freezeClock(isoInstant) {
  const fixedMs = new RealDate(isoInstant).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
}
function restoreClock() {
  global.Date = RealDate;
}

async function tickAt(isoInstant) {
  freezeClock(isoInstant);
  try {
    await scheduler.runHourlySyncIfDue();
  } finally {
    restoreClock();
  }
}

async function seedDailySummaryAt(time) {
  await db.run(`UPDATE users SET email = 'ticks-test@example.invalid', status = 'active' WHERE id = 1`);
  // `weekly_summary_enabled` is the master switch for summaries and `weekly_summary_time`
  // the time of day both the daily and the weekly summary go out at - see
  // checkAndSendAutomatedSummaries. weekly_summary_day is set to a weekday this test never
  // runs on, so only the DAILY summary can fire and the assertions stay unambiguous.
  const rows = [
    ['weekly_summary_enabled', '1'],
    ['weekly_summary_time', time],
    ['weekly_summary_day', '7'],
    ['monthly_summary_enabled', '0']
  ];
  for (const [key, value] of rows) {
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (1, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }
  await db.run(`DELETE FROM settings WHERE key LIKE 'last_%_summary_sent'`);
}

// --- 1. A later tick in the same clock hour still checks the schedule ------------------
async function testLaterTickInTheSameHourStillChecks() {
  console.log('\n--- TEST 1: a summary at 23:30 is sent by the 23:35 tick ---');
  await seedDailySummaryAt('23:30');
  calls.daily.length = 0;

  // 2026-09-15, Warsaw is UTC+2. 21:00Z = 23:00 local: the first tick of hour 23, and the
  // one that used to consume the hour's only chance to look at the schedule.
  await tickAt('2026-09-15T21:00:00Z');
  assert(
    calls.daily.length === 0,
    'the 23:00 tick sends nothing - 23:30 has not arrived yet (this tick is not the bug, it is the trap)'
  );

  // 21:35Z = 23:35 local. Under the old gate this tick returned immediately, and so did
  // every tick after it - that day and, because todayStr then changes, for good.
  await tickAt('2026-09-15T21:35:00Z');
  assert(
    calls.daily.includes(1),
    'the 23:35 tick sends the 23:30 summary - the once-per-hour gate no longer covers the summary check'
  );

  // The gate still has to do its actual job: not burning the external API quotas 12x an hour.
  calls.daily.length = 0;
  await seedDailySummaryAt('17:00');
  await tickAt('2026-09-15T15:00:00Z'); // 17:00 local, inside the 05:00-22:00 window
  assert(
    calls.oura === 1 && calls.withings === 1 && calls.googleFit === 1,
    'a tick inside the sync window runs the three external syncs'
  );
  await tickAt('2026-09-15T15:05:00Z'); // 17:05 local, same clock hour
  assert(
    calls.oura === 1,
    'the next tick in the same hour does NOT sync again - the gate still protects the external APIs'
  );
}

// --- 2. A stuck external sync does not take the summaries with it ----------------------
async function testStuckSyncDoesNotSilenceSummaries() {
  console.log('\n--- TEST 2: a hung external sync does not stop the next tick sending mail ---');
  await seedDailySummaryAt('17:00');
  calls.daily.length = 0;

  let releaseOura;
  ouraGate = new Promise((resolve) => { releaseOura = resolve; });

  // 16:00Z = 18:00 local: inside the window, past the 17:00 summary, and a clock hour this
  // process has not synced yet. The tick reaches syncAllOura and never comes back - exactly
  // what a response whose body stops mid-transfer used to do.
  freezeClock('2026-09-15T16:00:00Z');
  const hungTick = scheduler.runHourlySyncIfDue();
  restoreClock();
  // Let the hung tick run up to its await.
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    calls.daily.length === 0,
    'the tick that hangs inside the sync sends nothing - it never gets past the sync'
  );

  // The point of the fix: the NEXT tick is not held hostage. The hour is already marked as
  // synced, so this tick skips the external calls entirely and goes straight to the mail.
  await tickAt('2026-09-15T16:05:00Z');
  assert(
    calls.daily.includes(1),
    'the following tick still sends the summary while the previous sync is stuck'
  );

  // Let the hung tick finish so it cannot outlive this test. Summaries are switched off
  // first: it resumes on the real clock, and its summary check would otherwise send a
  // second mail dated today and confuse the output of whatever runs next.
  await db.run(`UPDATE settings SET value = '0' WHERE user_id = 1 AND key = 'weekly_summary_enabled'`);
  releaseOura();
  await hungTick;
  ouraGate = null;
}

// --- 3. No backup, no deletion --------------------------------------------------------
async function testCleanupIsGatedOnTheBackup() {
  console.log('\n--- TEST 3: the irreversible cleanup only runs after a verified backup ---');
  const realBackup = db.backupDatabase;
  const realCleanupImages = db.cleanupOldImages;
  const realCleanupLogs = db.cleanupOldLogs;
  let cleanedImages = 0;
  let cleanedLogs = 0;
  db.cleanupOldImages = async () => { cleanedImages += 1; };
  db.cleanupOldLogs = async () => { cleanedLogs += 1; };

  try {
    db.backupDatabase = async () => ({ ok: false, reason: 'no space left on device' });
    calls.loggedErrors.length = 0;
    const failed = await scheduler.runBackupThenCleanup('test');

    assert(failed.cleaned === false, 'a failed backup reports that nothing was cleaned');
    assert(
      cleanedImages === 0 && cleanedLogs === 0,
      'NOTHING is deleted when the backup failed - the meal photos of the last fortnight are still the only copy'
    );
    assert(
      calls.loggedErrors.some(e => /backup failed/i.test(e.message) && /SKIPPING/.test(e.message)),
      'the failure is escalated through logger.error, so it reaches app_logs and the weekly admin report - not just the container log'
    );

    db.backupDatabase = async () => ({ ok: true, path: '/tmp/backup.db', users: 3 });
    const succeeded = await scheduler.runBackupThenCleanup('test');
    assert(succeeded.cleaned === true, 'a verified backup lets the cleanup proceed');
    assert(
      cleanedImages === 1 && cleanedLogs === 1,
      'the cleanup runs exactly once, AFTER the backup'
    );
  } finally {
    db.backupDatabase = realBackup;
    db.cleanupOldImages = realCleanupImages;
    db.cleanupOldLogs = realCleanupLogs;
  }
}

async function main() {
  console.log('=== SCHEDULER TICK TESTS ===');
  try {
    await db.initDb();
    await testLaterTickInTheSameHourStillChecks();
    await testStuckSyncDoesNotSilenceSummaries();
    await testCleanupIsGatedOnTheBackup();
    console.log('\n🎉 SCHEDULER TICK TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ SCHEDULER TICK TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
