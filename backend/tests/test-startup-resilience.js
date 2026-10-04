// Tests of the things that decide whether a slow or crash-looping start can do damage.
//
// The bugs these pin down (audit 2026-10, M8, L8):
//
// 1. server.js ran the startup backup, the cleanups and a full sync of every user (Oura,
//    Withings, Google Fit, summaries through Gemini + Mailgun) BEFORE app.listen(). The
//    liveness probe allows 15 s + 3 x 30 s; a slow start was killed before it ever listened,
//    and the next start repeated it - a crashloop.
// 2. Backups were rotated as "the newest 14 FILES", and every start takes one. Fourteen
//    restarts of a crashloop rotated out every copy from before the problem began.
// 3. The PDF report computed its window with toISOString() (UTC), so between 00:00 and 02:00
//    Warsaw time it started a day early.
//
// Run with: node tests/test-startup-resilience.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-startup-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-startup';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-startup';

const { start } = require('../server');
const { selectBackupsToDelete } = require('../db');
const { reportWindow } = require('../services/pdfReport');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function testListenBeforeSlowWork() {
  console.log('\n--- TEST: start() listens before the backup and the sync ---');
  const events = [];
  let releaseSync;
  const syncGate = new Promise((r) => { releaseSync = r; });

  const fakeApp = {
    listen: (port, cb) => {
      events.push('listen');
      setImmediate(cb);
      return { on: () => {} };
    }
  };
  const fakeDb = {
    initDb: async () => { events.push('initDb'); },
    cleanupExpiredSessions: async () => { events.push('cleanupExpiredSessions'); }
  };

  const { background } = await start({
    app: fakeApp,
    db: fakeDb,
    port: 0,
    schedule: () => {},
    scheduleBackup: () => {},
    runBackupThenCleanup: async () => { events.push('backup'); },
    // A sync that hangs (Gemini without a timeout) must not keep the port closed.
    runHourlySyncIfDue: async () => { events.push('sync'); await syncGate; }
  });

  assert(events[0] === 'initDb' && events[1] === 'listen', `the schema is migrated and the port opened first (order: ${events.join(', ')})`);
  assert(events.indexOf('listen') < events.indexOf('backup'), 'the backup runs after listen');
  releaseSync();
  await background;
  assert(events.indexOf('backup') < events.indexOf('sync'), 'the backup still precedes the sync in the background');
}

function backupName(iso) {
  return `dietetyk-${iso.replace(/[:.]/g, '-')}.db`;
}

function testBackupRetentionByDay() {
  console.log('\n--- TEST: backup retention keeps one copy per day for 14 days ---');
  const files = [];
  // Ten earlier days, one nightly copy each.
  for (let d = 1; d <= 10; d++) {
    files.push(backupName(`2026-09-${String(d).padStart(2, '0')}T02:00:00.000Z`));
  }
  // A crashloop today: twenty restarts, twenty backups.
  for (let i = 0; i < 20; i++) {
    files.push(backupName(`2026-09-11T10:${String(i).padStart(2, '0')}:00.000Z`));
  }
  const toDelete = new Set(selectBackupsToDelete(files));
  const kept = files.filter(f => !toDelete.has(f));

  assert(kept.filter(f => f.includes('2026-09-11')).length === 1, 'of the twenty crashloop copies only the newest is kept');
  assert(kept.includes(files[19 + 10]), 'the newest copy overall is kept');
  assert(files.slice(0, 10).every(f => kept.includes(f)), 'all ten earlier days survive the crashloop');

  const many = [];
  for (let d = 1; d <= 20; d++) many.push(backupName(`2026-08-${String(d).padStart(2, '0')}T02:00:00.000Z`));
  const keptMany = many.filter(f => !selectBackupsToDelete(many).includes(f));
  assert(keptMany.length === 14 && keptMany[0].includes('2026-08-07'), 'with 20 daily copies, the newest 14 days are kept');
}

function testPdfWindowUsesWarsawDate() {
  console.log('\n--- TEST: the PDF report window uses the Warsaw date ---');
  const RealDate = Date;
  // 2026-10-25T23:30Z is 00:30 on 26.10 in Warsaw (CET after the DST change).
  const fixedMs = new RealDate('2026-10-25T23:30:00Z').getTime();
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  };
  try {
    const { startDate, today } = reportWindow(30);
    assert(today === '2026-10-26', `"today" is the Warsaw date (got ${today})`);
    assert(startDate === '2026-09-26', `the window starts 30 days before it (got ${startDate})`);
  } finally {
    global.Date = RealDate;
  }
}

async function run() {
  await testListenBeforeSlowWork();
  testBackupRetentionByDay();
  testPdfWindowUsesWarsawDate();
}

run()
  .then(() => {
    console.log('\n🎉 STARTUP RESILIENCE TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ STARTUP RESILIENCE TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
