// Process-level error handlers (uncaughtException, unhandledRejection, stdout/stderr errors).
//
// Audit 2026-10-03 (D3): a k3s restart closed the pod's stdout while the process was still
// running, and the next console write failed with EPIPE. The stream had no 'error' listener,
// so the EPIPE became an uncaughtException; the handler logged it through the logger, which
// writes to the console first - another EPIPE, another uncaughtException - until the delayed
// process.exit fired a second later. That one second left 556 "write EPIPE" rows in app_logs,
// which the weekly admin report reads.
//
// Two guards break the loop:
// - EPIPE on stdout/stderr is swallowed by an 'error' listener on the stream itself. The
//   reader is gone, so there is nobody to tell, and logging it would only write to the same
//   dead pipe.
// - the uncaughtException handler is re-entrant-safe: the first exception is logged and
//   schedules the exit, anything after that while the process is going down is dropped.
//
// Split out of server.js so tests can drive it with a fake process object.

const EXIT_DELAY_MS = 1000;

function installProcessErrorHandlers({ proc = process, logger, exit = (code) => proc.exit(code), exitDelayMs = EXIT_DELAY_MS } = {}) {
  let shuttingDown = false;

  // Every logger call writes to the console before the database, so logging a stdio error
  // from here would fail on the same stream and come straight back. EPIPE is the case seen in
  // production; other codes (EBADF, ECONNRESET on a socket-backed stdout) mean the same thing
  // - the stream is unusable - and are dropped for the same reason.
  const onStdioError = () => {};
  if (proc.stdout && typeof proc.stdout.on === 'function') proc.stdout.on('error', onStdioError);
  if (proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('error', onStdioError);

  const onUncaughtException = (err) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.error(`Uncaught exception: ${err && err.message}`, 'SYSTEM', err);
    // Give the logs time to flush before exiting the process
    setTimeout(() => exit(1), exitDelayMs);
  };

  const onUnhandledRejection = (reason) => {
    if (shuttingDown) return;
    logger.error(
      `Unhandled promise rejection: ${reason}`,
      'SYSTEM',
      reason instanceof Error ? reason : new Error(String(reason))
    );
  };

  proc.on('uncaughtException', onUncaughtException);
  proc.on('unhandledRejection', onUnhandledRejection);

  return { onUncaughtException, onUnhandledRejection, onStdioError, isShuttingDown: () => shuttingDown };
}

module.exports = { installProcessErrorHandlers };
