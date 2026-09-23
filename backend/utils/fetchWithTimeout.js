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
//
// THE TIMEOUT COVERS THE RESPONSE BODY, NOT JUST THE HEADERS (audit 2026-09-23).
// The previous version cleared the timer in a `finally` around `await fetch(...)`, and
// fetch() resolves as soon as the response HEADERS arrive - the body is still an unread
// stream at that moment. So `clearTimeout` disarmed the AbortController exactly one line
// before the part that actually hangs: `await res.json()` in sync.js reads that stream
// with nothing left to interrupt it. A server that answers 200 with headers and then stops
// transmitting mid-body (a dying TLS proxy - the normal way this fails in production, not
// a clean connection reset) left `await sleepRes.json()` pending forever, which pinned
// `isSyncRunning = true` in scheduler.js because its `finally` never ran.
//
// The timer is therefore started ONCE, before the request, and disarmed only when the body
// has actually been consumed (json/text/arrayBuffer/blob/bytes) or the request failed. The
// caller keeps the ordinary Response API; only those body readers are wrapped, so
// sync.js/mailgun.js need no changes. A caller that never reads the body simply lets the
// timer fire and abort a stream nobody was reading, which is harmless.
const DEFAULT_TIMEOUT_MS = 15000;

const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'bytes', 'formData'];

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let disarmed = false;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // unref so a response whose body nobody reads cannot hold the event loop open for the
  // remainder of the timeout; the in-flight socket keeps the process alive on its own for
  // as long as the request really is pending.
  if (typeof timer.unref === 'function') timer.unref();

  const disarm = () => {
    if (!disarmed) {
      disarmed = true;
      clearTimeout(timer);
    }
  };

  const asTimeoutError = (err) => {
    if (err && err.name === 'AbortError') {
      return new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    return err;
  };

  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    disarm();
    throw asTimeoutError(err);
  }

  for (const reader of BODY_READERS) {
    if (typeof res[reader] !== 'function') continue;
    const original = res[reader].bind(res);
    Object.defineProperty(res, reader, {
      configurable: true,
      writable: true,
      value: async (...args) => {
        try {
          return await original(...args);
        } catch (err) {
          throw asTimeoutError(err);
        } finally {
          disarm();
        }
      }
    });
  }

  return res;
}

module.exports = { fetchWithTimeout };
