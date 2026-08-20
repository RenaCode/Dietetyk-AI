// Shared helper for fetch() calls with a timeout.
//
// NOTE: the native fetch() in Node.js has NO default timeout - if an external API
// (Oura, Withings, Google Fit, Mailgun) hangs and never responds, await fetch(...) waits
// forever. Because syncing multiple users (sync.js/scheduler.js) processes them
// SEQUENTIALLY in a for...of loop (one after another, awaiting each iteration), a hung
// request for ONE user would block the hourly sync for ALL the others indefinitely - and
// the next scheduler tick (`runHourlySyncIfDue`, called every 5 minutes) would not rerun
// it either, because `lastSyncedHourKey` is set BEFORE the sync executes while the
// previous call never finishes. The timeout below guarantees that a single hung request
// cannot stall the whole process: it is aborted and treated as an error (caught in
// syncOura/syncWithings/syncGoogleFit/mailgun.js).
const DEFAULT_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
