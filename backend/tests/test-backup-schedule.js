// Tests the fixed-hour backup schedule and the file permissions of backups
// (audit 2026-10-04, D-11, D-12).
//
//   D-12  the backup ran setInterval(24 h) from process start - in practice 09:32 Warsaw time,
//         while renacode-kopia ships the newest copy off-site at ~05:50, so the off-site copy
//         was always the previous day's: ~20 h older than it had to be.
//   D-11  VACUUM INTO created every backup with mode 0644 - readable by any local user of the
//         host - next to a 0600 database.
//
// Run with: node tests/test-backup-schedule.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-backup-schedule-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-backup-schedule';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-backup-schedule';

const db = require('../db');
const { nextWarsawTimeMillis } = require('../utils/dates');
const { start } = require('../server');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function testNextBackupTime() {
  console.log('\n--- TEST 1: the next 04:30 in Europe/Warsaw ---');
  // 2026-10-04 is CEST (UTC+2): 04:30 Warsaw = 02:30 UTC.
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2026-10-04T02:29:00Z'))) === '2026-10-04T02:30:00.000Z', 'at 04:29 the next run is today 04:30');
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2026-10-04T02:31:00Z'))) === '2026-10-05T02:30:00.000Z', 'at 04:31 the next run is tomorrow 04:30');
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2026-10-04T02:30:00Z'))) === '2026-10-05T02:30:00.000Z', 'exactly at 04:30 the next run is tomorrow (no double run)');
  // 2026-10-25: clocks go back 03:00 -> 02:00, so 04:30 that day is CET (UTC+1) = 03:30 UTC.
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2026-10-24T22:00:00Z'))) === '2026-10-25T03:30:00.000Z', 'on the autumn DST day 04:30 is 03:30 UTC');
  // 2027-03-28: clocks go forward 02:00 -> 03:00, so 04:30 that day is CEST = 02:30 UTC.
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2027-03-27T23:00:00Z'))) === '2027-03-28T02:30:00.000Z', 'on the spring DST day 04:30 is 02:30 UTC');
  // Late evening in Warsaw is already the next UTC day for part of the hour, and vice versa.
  assert(iso(nextWarsawTimeMillis('04:30', new Date('2026-12-31T23:30:00Z'))) === '2027-01-01T03:30:00.000Z', 'just after midnight Warsaw on New Year the next run is that morning');
}

async function testBackupPermissions() {
  console.log('\n--- TEST 2: backups are 0600 ---');
  await db.initDb();
  const result = await db.backupDatabase();
  assert(result.ok, `the backup succeeds (${result.reason || result.path})`);
  const mode = fs.statSync(result.path).mode & 0o777;
  assert(mode === 0o600, `a new backup has mode 0600 (got ${mode.toString(8)})`);

  const legacy = path.join(path.dirname(result.path), 'dietetyk-2026-09-01T07-32-56-516Z.db');
  fs.writeFileSync(legacy, 'x');
  fs.chmodSync(legacy, 0o644);
  const changed = await db.tightenBackupPermissions();
  assert(changed === 1, `tightenBackupPermissions fixes exactly the one loose file (changed ${changed})`);
  assert((fs.statSync(legacy).mode & 0o777) === 0o600, 'the old 0644 backup is now 0600');
  fs.unlinkSync(legacy);
}

async function testStartupBackupOnlyWhenStale() {
  console.log('\n--- TEST 3: the startup backup runs only when the newest copy is a day old ---');
  const fakeApp = { listen: (port, cb) => { setImmediate(cb); return { on: () => {} }; } };
  const runStart = async (ageMs) => {
    const events = [];
    let scheduled = 0;
    const { background } = await start({
      app: fakeApp,
      db: {
        initDb: async () => {},
        cleanupExpiredSessions: async () => {},
        tightenBackupPermissions: async () => 0,
        newestBackupAgeMs: async () => ageMs
      },
      port: 0,
      schedule: () => {},
      scheduleBackup: () => { scheduled += 1; },
      runBackupThenCleanup: async (trigger) => { events.push(trigger); },
      runHourlySyncIfDue: async () => {}
    });
    await background;
    return { events, scheduled };
  };
  const fresh = await runStart(2 * 60 * 60 * 1000);
  assert(fresh.events.length === 0, 'a backup 2 h old means no startup backup');
  assert(fresh.scheduled === 1, 'the daily backup is still scheduled');
  const stale = await runStart(25 * 60 * 60 * 1000);
  assert(stale.events.join() === 'startup', 'a backup 25 h old triggers the startup backup');
  const none = await runStart(null);
  assert(none.events.join() === 'startup', 'no backup at all triggers the startup backup');
}

async function main() {
  console.log('=== BACKUP SCHEDULE TESTS ===');
  try {
    testNextBackupTime();
    await testBackupPermissions();
    await testStartupBackupOnlyWhenStale();
    console.log('\n🎉 BACKUP SCHEDULE TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ BACKUP SCHEDULE TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
