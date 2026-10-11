// Re-entering the current password for an operation a session alone must not be able to
// perform. Shared by routes/account.js (the account's own sensitive changes) and
// routes/admin.js (every administrative action - audit D-4, see the comment there), so both
// count attempts against ONE per-account budget: guesses spread across the two cannot add up
// to more than the single lockout allows.

const bcrypt = require('bcryptjs');
const db = require('../db');
const loginAttempts = require('./loginAttempts');
const logger = require('./logger');

// Brute-force key for the password re-checks in this file, namespaced the same way as
// `twoFactorAttemptKey` in routes/auth.js so it cannot collide with the login keys.
//
// Three endpoints in routes/account.js compare a password: disable-2fa, change-password and account
// deletion. None of them counted attempts, so the 5-try lockout that guards /api/login
// (services/loginAttempts.js) simply did not exist on this side of the wall. Someone holding
// only a session token - the exact situation these password prompts are meant to survive -
// could sit on POST /api/user/disable-2fa and guess for ever: the sole brake was the global
// apiRateLimiter, which in this cluster is one shared bucket for the whole internet (see
// server.js), i.e. roughly 170k guesses a day with not one AUTH_LOCKOUT row in app_logs and
// therefore nothing in the weekly security report either. A hit switches off the second
// factor or deletes every health record the account holds.
//
// Keyed by user id, not by the submitted value and not by IP alone, for the same reason
// `twoFactorAttemptKey` is: the id is the stable thing across retries. The IP still forms
// part of the key through loginAttempts.buildKey.
const passwordCheckAttemptKey = (userId) => `pwcheck_user:${userId}`;

// Shared guard for those endpoints. Returns a response body to send with 429 when the
// account is locked, or null when the caller may go ahead and compare the password. The
// attempt is COUNTED here, before the comparison (reserveAttempt - see
// services/loginAttempts.js for the parallel-burst race this closes), so a failure needs only
// to be logged and a success must call recordSuccess.
//
// Per IP AND account-wide (audit 2026-10-09, B-S1), the same pair /api/login uses. The per-IP
// key alone gave 5 guesses per address: a session token replayed from 8 addresses got 40
// wrong answers without one 429, and the 41st - the right password - went through (at the
// time it handed out a ticket for linking a Google identity, removed since). The account-wide
// counter (services/loginAttempts.js, ACCOUNT_SCOPE) does not care where the guesses come
// from.
async function passwordCheckLockout(req) {
  const key = passwordCheckAttemptKey(req.user.id);
  const lockedMs = await loginAttempts.reserveAttempt(req.ip, key)
    || await loginAttempts.reserveAccountAttempt(key);
  if (lockedMs > 0) {
    return { error: `Za dużo nieudanych prób podania hasła. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.` };
  }
  return null;
}

async function recordPasswordCheckSuccess(req) {
  const key = passwordCheckAttemptKey(req.user.id);
  await loginAttempts.recordSuccess(req.ip, key);
  await loginAttempts.recordAccountSuccess(key);
}

async function recordPasswordCheckFailure(req, action) {
  logger.security(
    `Wrong password supplied for an account operation: ${action} (UID: ${req.user.id})`,
    'AUTH_PASSWORD_FAILURE',
    { userId: req.user.id, action },
    req.ip
  );
}

// Re-entering the current password for an operation a session alone must not be able to
// perform. Sends the error response itself and returns false, or returns true when the caller
// may go ahead. `requirePassword: true` in the 400 lets the frontend tell "ask for the
// password" apart from any other validation error on the same endpoint.
//
// An account that never had a password it knows (password_set = 0) is refused with 409
// `requirePasswordSetup` BEFORE anything is compared or counted (audit round 2, N-S4): asking
// it for "your current password" could only fail, and every failure moved it closer to a
// 15-minute lockout.
//
// Only the since-removed "Sign in with Google" ever created such accounts (with a random hash
// nobody knows), and it used to offer a way out: set a password after re-authenticating with
// Google. That way is gone with Google itself, and nothing replaces it inside the app on
// purpose - a session alone must not be enough to set a password. Such an account gets one
// from an administrator instead: `node scripts/reset-password.js <username>` in the backend
// container issues a one-time password and forces a change at the next login, which then runs
// the full cleanup of /api/change-password-forced (routes/auth.js) and sets password_set = 1.
async function respondIfNoPassword(req, res) {
  const flags = await db.get(`SELECT password_set FROM users WHERE id = ?`, [req.user.id]);
  if (flags && flags.password_set === 0) {
    res.status(409).json({
      error: 'To konto nie ma ustawionego hasła. Poproś administratora o jednorazowe hasło - przy logowaniu ustawisz własne.',
      requirePasswordSetup: true
    });
    return true;
  }
  return false;
}

// A session from single sign-on (req.authMethod === 'sso') goes through this exactly like a
// password session - it is NOT a fresh authentication (renacode-infra docs/sso-tozsamosc.md,
// section 4). Its only proof is a header Authelia sets for as long as its own cookie lives
// (up to 12 hours, or 7 days with "remember me"), so an unlocked laptop or a stolen Authelia
// cookie would otherwise be enough to set a new local password - turning a borrowed browser
// into a permanent credential, the break-glass one included - or to enrol an attacker's TOTP,
// or to mail the health summaries elsewhere. The local password stays the second key for
// those. The cost: an SSO user who has forgotten a password they never type gets a one-time
// one from an administrator (scripts/reset-password.js), as an account without one already
// does.
//
// `status` is the code for a missing or wrong password: 400 for the account's own changes (as
// before), 403 for the admin panel. Not 401 - the frontend treats any 401 as an expired
// session and logs the user out, which would turn a mistyped password into a lost session.
async function confirmCurrentPassword(req, res, password, action, { status = 400, missingMessage = 'Potwierdź tę zmianę aktualnym hasłem.' } = {}) {
  if (await respondIfNoPassword(req, res)) return false;
  if (!password || typeof password !== 'string') {
    res.status(status).json({ error: missingMessage, requirePassword: true });
    return false;
  }
  const locked = await passwordCheckLockout(req);
  if (locked) {
    res.status(429).json(locked);
    return false;
  }
  const user = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await recordPasswordCheckFailure(req, action);
    res.status(status).json({ error: 'Niepoprawne hasło.', requirePassword: true });
    return false;
  }
  await recordPasswordCheckSuccess(req);
  return true;
}

module.exports = {
  passwordCheckLockout,
  recordPasswordCheckSuccess,
  recordPasswordCheckFailure,
  respondIfNoPassword,
  confirmCurrentPassword
};
