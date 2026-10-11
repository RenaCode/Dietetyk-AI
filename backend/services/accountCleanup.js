const crypto = require('crypto');
const db = require('../db');
const { revokeUserSessions } = require('../middleware/auth');
const { revokeAllSharesForUser } = require('./sharedReports');
const { revertEmailChangedByRevokedSession } = require('./emailChange');

// Replaces users.sync_token, the only credential of the Apple Health webhook
// (routes/appleHealth.js). Part of "end everything the old credentials could reach" on a
// password change and on "log out all other devices": revoking sessions left the sync token
// alone, so whoever had copied the webhook URL from Settings while holding a stolen session
// kept writing - and, through the dashboard built from it, influencing - the victim's health
// data indefinitely. The cost is that the user has to paste the new URL into Health Auto
// Export; the responses say so.
async function rotateSyncToken(userId) {
  await db.run(`UPDATE users SET sync_token = ? WHERE id = ?`, ['sync_' + crypto.randomBytes(24).toString('hex'), userId]);
}

// "Clean up after a takeover" - ONE function for every action that means "the old
// credentials or sessions are no longer trusted" (audit round 2, 2026-10-10, N-W2). Each of
// change-password, logout-all and change-password-forced used to carry its own copy of this
// list, and the copies drifted: the admin-forced password change - the reset an
// administrator performs precisely when the password is believed to have leaked - revoked
// sessions and share links but left a redirected e-mail address and the Apple Health sync
// token exactly where the attacker had put them.
//
// There used to be a fourth way back in, a Google identity linked from a stolen session, and
// an `unlinkGoogle` option here for it. Google sign-in has been removed altogether
// (2026-10-11): users.google_id is still in the schema but nothing reads it, so there is no
// link left to cut. If a new way to log in is ever added, its "unlink" belongs in this list.
//
// `keepSessionToken` - the caller's own session, which survives; null revokes all of them.
// `revokeShares`     - share links go on a credential change, not on "log out other devices"
//                      (a report sent to a doctor is not proof of a leak).
async function cleanUpAfterCredentialReset(userId, { keepSessionToken = null, revokeShares = true } = {}) {
  const revokedSessions = await revokeUserSessions(userId, keepSessionToken);
  const revokedShares = revokeShares ? await revokeAllSharesForUser(userId) : 0;
  const emailRevert = await revertEmailChangedByRevokedSession(userId, keepSessionToken);
  await rotateSyncToken(userId);
  return { revokedSessions, revokedShares, emailRevert, syncTokenRotated: true };
}

module.exports = { cleanUpAfterCredentialReset, rotateSyncToken };
