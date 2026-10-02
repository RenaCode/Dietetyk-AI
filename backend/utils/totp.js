const { authenticator } = require('otplib');
const db = require('../db');

// Verifies a TOTP code AND burns it: a code is accepted at most once per user.
//
// authenticator.verify() alone answers "is this code valid right now", so the same six digits
// worked for every request inside their 30-second step (and the window around it). A code
// seen once - over a shoulder, or relayed by a real-time phishing page that logs in in
// parallel with the victim - was a second login, or a second enrolment of a fresh 2FA setup.
//
// The step that matched is stored in users.totp_last_step and anything at or below it is
// refused. The UPDATE carries the comparison itself (`totp_last_step < ?`), so two parallel
// requests with the same code cannot both win: SQLite runs the statement atomically and only
// one of them changes the row.
async function verifyTotpOnce(userId, secret, code) {
  if (!secret || (typeof code !== 'string' && typeof code !== 'number')) return false;
  const token = String(code).trim();
  let delta;
  try {
    delta = authenticator.checkDelta(token, secret);
  } catch {
    return false;
  }
  if (delta === null || delta === undefined) return false;

  const stepSeconds = authenticator.allOptions().step;
  const step = Math.floor(Date.now() / 1000 / stepSeconds) + delta;
  const result = await db.run(
    `UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
    [step, userId, step]
  );
  return result.changes === 1;
}

module.exports = { verifyTotpOnce };
