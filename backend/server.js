const app = require('./app');
const db = require('./db');
const { PORT } = require('./config');
const logger = require('./services/logger');
const { installProcessErrorHandlers } = require('./services/processErrors');
const { runHourlySyncIfDue, runBackupThenCleanup } = require('./scheduler');
const { nextWarsawTimeMillis } = require('./utils/dates');

// Daily backup at a fixed Warsaw time (audit 04.10.2026, D-12). It used to be setInterval(24 h)
// from process start, so the copy was taken whenever the pod last restarted (09:32 for weeks),
// and renacode-kopia on the host, which ships the newest backup off-site at ~05:50, always took
// the one from the day before: up to ~44 h of data lost with the disk. 04:30 lands ~1.5 h
// before that, and outside the 05:00-22:00 sync window.
const DEFAULT_BACKUP_TIME = '04:30';
const BACKUP_TIME_LOCAL = /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.BACKUP_HOUR_LOCAL || '')
  ? process.env.BACKUP_HOUR_LOCAL
  : DEFAULT_BACKUP_TIME;
const DAY_MS = 24 * 60 * 60 * 1000;

// Runs `task` at the next BACKUP_TIME_LOCAL and then again at each following one. A chain of
// setTimeouts rather than one interval, so every run re-reads the clock (DST changes the gap
// between two 04:30s). unref(): the HTTP server is what keeps the process alive, not this timer.
function scheduleDailyBackup(task, hhmm = BACKUP_TIME_LOCAL) {
  const arm = () => {
    const at = nextWarsawTimeMillis(hhmm);
    console.log(`[BACKUP] Next scheduled backup at ${new Date(at).toISOString()} (${hhmm} Europe/Warsaw)`);
    const timer = setTimeout(async () => {
      try {
        await task();
      } finally {
        arm();
      }
    }, Math.max(at - Date.now(), 1000));
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  arm();
}

// Start the server.
//
// ORDER (audit 2026-10): open the port first, then do the slow work in the background.
//
// This used to run the startup backup (VACUUM INTO + verification), the cleanups AND a full
// hourly sync of every user - Oura, Withings, Google Fit and the summary checks, which call
// Gemini and Mailgun - all BEFORE app.listen(). Each of those has network or disk time in it,
// and Gemini had no timeout at all (see GEMINI_REQUEST_TIMEOUT_MS in config.js). The
// liveness probe gives a pod 15 s + 3 x 30 s: a slow start meant the probe killed the
// container before it had ever listened, the next start did the same work again, and every
// one of those starts took a new backup - which, under the old "keep the newest 14 files"
// rotation, flushed out the good copies within minutes (see selectBackupsToDelete in db.js).
//
// What has to happen before listening is only what serving a request needs: the schema
// (initDb - a failed migration must stop the start, see the catch below). The backup still
// gates the irreversible cleanup inside runBackupThenCleanup, which is all its ordering ever
// had to guarantee; it does not need the port to be closed while it runs.
//
// `deps` exists for tests/test-server-start.js, which checks this order without a network or
// a database.
async function start(deps = {}) {
  const {
    app: server = app,
    db: database = db,
    runHourlySyncIfDue: hourlySync = runHourlySyncIfDue,
    runBackupThenCleanup: backupThenCleanup = runBackupThenCleanup,
    port = PORT,
    schedule = setInterval,
    scheduleBackup = scheduleDailyBackup
  } = deps;

  await database.initDb();

  await new Promise((resolve, reject) => {
    const listener = server.listen(port, () => {
      console.log(`Dietetyk AI server listening on port ${port}`);
      resolve(listener);
    });
    if (listener && typeof listener.on === 'function') listener.on('error', reject);
  });

  // BACKUP FIRST, THEN THE IRREVERSIBLE CLEANUP - and only if the backup actually worked
  // (audit 2026-09-23). See runBackupThenCleanup in scheduler.js: a backup that failed has to
  // STOP the deletion of meal photos and logs, not annotate it.
  //
  // cleanupExpiredSessions() stays outside the gate: it removes sessions whose expires_at
  // has already passed, which are unusable by definition, so there is nothing to lose.
  //
  // Data sync (Oura, Withings) and summary checks: hourly, and only within the 05:00-22:00
  // window. We check every 5 minutes whether a new clock hour has begun - which also makes
  // this robust to a restart mid-day, since the first check runs right after startup.
  //
  // The startup backup runs only when the newest copy is a day old or missing (first start,
  // or the pod was down at 04:30) - a restart in the afternoon does not need a second copy of
  // a database already backed up this morning.
  const background = (async () => {
    try {
      await database.cleanupExpiredSessions();
      if (typeof database.tightenBackupPermissions === 'function') {
        const tightened = await database.tightenBackupPermissions();
        if (tightened > 0) console.log(`[BACKUP] Set 0600 on ${tightened} existing backup file(s)`);
      }
      const age = typeof database.newestBackupAgeMs === 'function'
        ? await database.newestBackupAgeMs()
        : null;
      if (age === null || age >= DAY_MS) {
        await backupThenCleanup('startup');
      } else {
        console.log(`[BACKUP] Startup: newest backup is ${Math.round(age / 60000)} min old - no startup backup.`);
      }
    } catch (err) {
      logger.error(`Startup backup/cleanup failed: ${err.message}`, 'SYSTEM', err);
    }
    try {
      await hourlySync();
    } catch (err) {
      logger.error(`Startup sync failed: ${err.message}`, 'SYSTEM', err);
    }
  })();

  scheduleBackup(async () => {
    try {
      await database.cleanupExpiredSessions();
      await backupThenCleanup('cron');
    } catch (err) {
      logger.error(`Scheduled backup/cleanup failed: ${err.message}`, 'SYSTEM', err);
    }
  });
  schedule(hourlySync, 5 * 60 * 1000);

  return { background };
}

if (require.main === module) {
  // A failure inside start() - a migration that could not run (see addColumn in db.js), a
  // database that will not open - must stop the process, not leave it standing. Without this
  // catch the rejection only reached the unhandledRejection handler below, which logs and
  // returns: app.listen() never ran, so the container stayed "up" with nothing on port 3000,
  // and the only symptom was the liveness probe timing out a minute later with no explanation
  // in between. Exiting non-zero makes Kubernetes restart the pod and puts the real error at
  // the top of `kubectl logs --previous`.
  start().catch((err) => {
    logger.error(`Server startup failed: ${err.message}`, 'SYSTEM', err);
    console.error('[STARTUP FAILED]', err);
    setTimeout(() => process.exit(1), 1000);
  });

  // Global process-level error handling - see services/processErrors.js for the EPIPE loop
  // these handlers guard against.
  installProcessErrorHandlers({ logger });
}

module.exports = { start, scheduleDailyBackup };
