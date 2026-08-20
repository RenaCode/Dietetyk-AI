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
const LOCKOUT_MS = 15 * 60 * 1000;  // czas blokady po przekroczeniu limitu

function buildKey(ip, identifier) {
  return `${ip || 'unknown'}::${(identifier || '').toString().toLowerCase()}`;
}

// Returns the number of milliseconds left on the block (0 when not blocked)
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

async function recordFailure(ip, identifier) {
  const key = buildKey(ip, identifier);
  const now = Date.now();
  const existing = await db.get(`SELECT * FROM login_attempts WHERE key = ?`, [key]);

  let count = 1;
  let firstAt = now;
  if (existing && (now - existing.first_at) <= WINDOW_MS) {
    count = existing.count + 1;
    firstAt = existing.first_at;
  }

  const lockedUntil = count >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0;

  if (count >= MAX_ATTEMPTS) {
    const logger = require('./logger');
    logger.security(`Blokada brute-force (lockout) dla: ${identifier}`, 'AUTH_LOCKOUT', { key, count }, ip);
  }

  await db.run(`
    INSERT INTO login_attempts (key, count, first_at, locked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET count = ?, first_at = ?, locked_until = ?
  `, [key, count, firstAt, lockedUntil, count, firstAt, lockedUntil]);
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
  recordFailure,
  recordSuccess,
  MAX_ATTEMPTS,
  LOCKOUT_MS
};
