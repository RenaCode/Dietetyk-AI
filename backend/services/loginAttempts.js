// Simple, dependency-free brute-force protection for login and 2FA verification.
// Tracks failed attempts by key (IP + username, or IP + tempToken) and blocks further
// attempts for a while once the limit is exceeded.
// Requires no additional npm package.
//
// State lives in the `login_attempts` table in SQLite rather than in process memory, so
// that blocks survive a restart or redeploy of the backend container - otherwise an
// attacker could clear a block by forcing a restart (crashing the process, say) or
// simply waiting for a routine redeploy.

const db = require('../db');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;   // window over which failed attempts are counted
const LOCKOUT_MS = 15 * 60 * 1000;  // how long the block lasts once the limit is exceeded

function buildKey(ip, identifier) {
  return `${ip || 'unknown'}::${(identifier || '').toString().toLowerCase()}`;
}

// Returns the number of milliseconds left on the block (0 when not blocked). Read-only:
// it neither counts nor reserves anything, so it must NOT be used as the gate in front of a
// password or code comparison - see reserveAttempt below for why.
async function isLocked(ip, identifier) {
  const key = buildKey(ip, identifier);
  const rec = await db.get(`SELECT * FROM login_attempts WHERE key = ?`, [key]);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.locked_until && rec.locked_until > now) {
    return rec.locked_until - now;
  }
  return 0;
}

// The gate every guarded comparison goes through: counts the attempt FIRST, in one atomic
// statement, and only then lets the caller compare the secret. Returns the milliseconds left
// on the block when the attempt is refused, 0 when the caller may go ahead.
//
// This replaced an `isLocked()` check followed, after bcrypt, by `recordFailure()` - a
// read-modify-write with a ~100 ms bcrypt in the middle. Every request in a parallel burst
// read the counter before ANY of them had written a failure, so all of them passed the gate:
// measured on the audit PoC (2026-10), a burst of 120 parallel logins got 20 passwords
// through to bcrypt against MAX_ATTEMPTS=5, and the correct one (16th) logged in. The same
// race gave ~20 TOTP guesses per window instead of 5. Counting before comparing makes the
// limit hold under concurrency: SQLite executes the upsert as one statement on a single
// connection, so the N-th parallel request sees count = N, whatever order bcrypt finishes in.
//
// Consequence for callers: the attempt is already "spent" when this returns 0. A failure
// needs no further bookkeeping; a success must call recordSuccess() to give the slots back.
//
// The window resets only once the old window has passed AND no lock is running, so a lock is
// never shortened by a fresh attempt. The lock itself starts at the first refused attempt
// (count = MAX_ATTEMPTS + 1), i.e. after exactly MAX_ATTEMPTS attempts that reached the
// comparison - the same number the old code allowed sequentially.
async function reserveAttempt(ip, identifier) {
  const key = buildKey(ip, identifier);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const rec = await db.get(`
    INSERT INTO login_attempts (key, count, first_at, locked_until)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN first_at < ? AND locked_until <= ? THEN 1 ELSE count + 1 END,
      first_at = CASE WHEN first_at < ? AND locked_until <= ? THEN ? ELSE first_at END,
      locked_until = CASE
        WHEN first_at < ? AND locked_until <= ? THEN 0
        WHEN count + 1 > ? AND locked_until <= ? THEN ?
        ELSE locked_until
      END
    RETURNING count, locked_until
  `, [
    key, now,
    windowStart, now,
    windowStart, now, now,
    windowStart, now,
    MAX_ATTEMPTS, now, now + LOCKOUT_MS
  ]);

  if (rec.count === MAX_ATTEMPTS + 1) {
    const logger = require('./logger');
    logger.security(`Brute-force lockout for: ${identifier}`, 'AUTH_LOCKOUT', { key, count: rec.count }, ip);
  }

  if (rec.count > MAX_ATTEMPTS) {
    return Math.max(rec.locked_until - now, 1);
  }
  return 0;
}

async function recordSuccess(ip, identifier) {
  await db.run(`DELETE FROM login_attempts WHERE key = ?`, [buildKey(ip, identifier)]);
}

// Periodic cleanup of expired entries so the table does not grow without bound
setInterval(async () => {
  try {
    const now = Date.now();
    await db.run(`DELETE FROM login_attempts WHERE locked_until < ? AND first_at < ?`, [now, now - WINDOW_MS]);
  } catch (err) {
    console.error('[LOGIN ATTEMPTS] Failed to clean up expired entries:', err.message);
  }
}, 10 * 60 * 1000);

module.exports = {
  isLocked,
  reserveAttempt,
  recordSuccess,
  MAX_ATTEMPTS,
  LOCKOUT_MS
};
