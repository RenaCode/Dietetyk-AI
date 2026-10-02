const app = require('./app');
const db = require('./db');
const { PORT } = require('./config');
const logger = require('./services/logger');
const { runHourlySyncIfDue, runBackupThenCleanup } = require('./scheduler');

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
    schedule = setInterval
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
  const background = (async () => {
    try {
      await database.cleanupExpiredSessions();
      await backupThenCleanup('startup');
    } catch (err) {
      logger.error(`Startup backup/cleanup failed: ${err.message}`, 'SYSTEM', err);
    }
    try {
      await hourlySync();
    } catch (err) {
      logger.error(`Startup sync failed: ${err.message}`, 'SYSTEM', err);
    }
  })();

  schedule(async () => {
    await database.cleanupExpiredSessions();
    await backupThenCleanup('cron');
  }, 24 * 60 * 60 * 1000);
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

  // Global process-level error handling
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, 'SYSTEM', err);
    // Give the logs time to flush before exiting the process
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled promise rejection: ${reason}`,
      'SYSTEM',
      reason instanceof Error ? reason : new Error(String(reason))
    );
  });
}

module.exports = { start };
