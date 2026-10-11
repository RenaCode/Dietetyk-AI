const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { verifyTotpOnce } = require('../utils/totp');
const QRCode = require('qrcode');
const crypto = require('crypto');
const loginAttempts = require('../services/loginAttempts');
const logger = require('../services/logger');
const { isValidUsername, USERNAME_RULE_MESSAGE } = require('../utils/username');
const { cleanUpAfterCredentialReset } = require('../services/accountCleanup');

// Helper for creating a session (temporary or permanent) - extracted because the same
// pattern (generate a token, compute expires_at, insert a sessions row) was repeated
// separately in a dozen places in this file (force_password_change, require_2fa, setup_2fa,
// login without 2FA, 2FA verification, registration and so on) with identical
// logic apart from the validity period and the is_verified_2fa flag.
// `ttlDays` also accepts fractional values (5-minute temporary sessions, see
// TEMP_SESSION_TTL_DAYS below) - it is computed in milliseconds anyway.
// The token prefix ('temp_' for short-lived verification sessions, 'sess_' for real login
// sessions) is kept only so that tokens stay recognisable to a human reading a log or a
// database row. NOTHING may authorise on it: the authoritative marker is the is_temp column
// written below and read by middleware/auth.js.
const TEMP_SESSION_TTL_DAYS = 5 / (24 * 60); // 5 minutes expressed in days
const PERMANENT_SESSION_TTL_DAYS = 7;

// The ceiling on a session's TOTAL life, counted from the moment it is created and never
// moved afterwards. It is what makes PERMANENT_SESSION_TTL_DAYS mean something: requireAuth
// renews a session by another 7 days whenever fewer than 6 remain, and that renewal had no
// end, so a token used at least once a week lived for ever. "Sessions expire after 7 days"
// described only a token nobody touched - a stolen one being polled by a script is exactly
// the one that never expired.
//
// 30 days, not 7: the rolling window exists so that someone using the app daily is not
// logged out every week, and a cap at or below the renewal window would delete that property
// entirely. 30 days keeps the convenience for ordinary use and still guarantees that every
// session - including one nobody knows has leaked - reaches a forced re-authentication within
// a month. The number is a judgement call about that trade, not a derived constant.
const ABSOLUTE_SESSION_TTL_DAYS = 30;

// Brute-force key for the 2FA code, namespaced so it cannot collide with the login keys,
// which are built from a username. It is keyed by user id rather than by the tempToken it
// used to use: every successful password login mints a fresh random tempToken, so the
// counter reset itself on every retry. An attacker holding the password but not the TOTP
// secret got 5 guesses, logged in again (which also cleared the password counter via
// recordSuccess) and got another 5, without limit. The user id is stable across those
// re-logins, which is exactly the property the counter needs.
const twoFactorAttemptKey = (userId) => `2fa_user:${userId}`;

// Second brute-force key for password login, alongside the one built from whatever the
// caller typed. /api/login accepts EITHER a username or an email address
// (`WHERE username = ? OR email = ?`), and services/loginAttempts.js keys its counter on the
// submitted string - so one account has as many independent counters as it has ways of being
// named. An attacker guessing Alice's password gets 5 tries as `alice`, then 5 more as
// `alice@example.com`: ten guesses where the limit says five, and more still if a second address
// ever reaches that row. The account id is the one identifier that does not multiply.
const loginAttemptKeyForUser = (userId) => `login_user:${userId}`;

// Compared against when the login name matches no account, so that a miss costs the same
// bcrypt round as a hit - see /api/login. Same cost factor (10) as every real hash written in
// this codebase; a cheaper one would bring the timing difference back. Hashed once at start
// from random bytes, so no input can ever match it.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const validatePassword = (password) => {
  if (!password || password.length < 8) {
    return 'Hasło musi mieć co najmniej 8 znaków.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Hasło musi zawierać co najmniej jedną literę i jedną cyfrę.';
  }
  return null;
};

async function createSession(userId, isVerified2fa, ttlDays = PERMANENT_SESSION_TTL_DAYS) {
  // A sub-day TTL is only ever produced by TEMP_SESSION_TTL_DAYS, i.e. by a session that
  // exists purely to carry the user through one verification step. Deriving both the flag
  // and the prefix from the same expression keeps them from drifting apart.
  const isTemp = ttlDays < 1;
  const token = (isTemp ? 'temp_' : 'sess_') + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  // The hard cap, written once here and never touched again - middleware/auth.js only reads
  // it and clamps its renewals against it. A NEW session gets the FULL window measured from
  // now, which is the difference between this and the backfill in db.js: that one writes
  // `absolute_expires_at = expires_at` because a pre-migration row carries no evidence of
  // when it was born, so the only safe move is to let it die in whatever time it has left.
  // Here the birth moment IS now, so there is nothing to be cautious about.
  //
  // A temporary session gets its own expiry as the cap rather than the 30 days. It is never
  // renewed at all (requireAuth refuses is_temp sessions outright), so a cap beyond its
  // 5-minute life would cap nothing - and a row claiming a month of validity for a session
  // that dies in five minutes is the kind of thing someone reads later and believes.
  const absoluteExpiresAt = isTemp
    ? expiresAt
    : new Date(Date.now() + ABSOLUTE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [token, userId, expiresAt, absoluteExpiresAt, isVerified2fa ? 1 : 0, isTemp ? 1 : 0]);
  return token;
}

// Everything that happens once a user has proved WHO they are, up to the response the
// frontend acts on: an owed password change, the second factor, a forced 2FA enrolment, or a
// full session. Returns the JSON body.
//
// Extracted from /api/login because the (since removed) Google sign-in had its own, shorter
// copy that checked only totp_enabled: global force_2fa, per-user force_2fa and
// force_password_change were all skipped, so a user an administrator had forced into 2FA - or
// into a password change after a suspected compromise - got a full session simply by clicking
// "Sign in with Google". Any future way in must go through this function too: one function
// means one policy for every way in.
async function completeLogin(user) {
  // The second factor comes BEFORE an owed password change (audit 2026-10-09, B-W1). The
  // order used to be the reverse: an account with 2FA and force_password_change got a
  // password-change token straight after the password check, and /api/change-password-forced
  // set a new password with it - no TOTP code involved. An administrator forces a password
  // change precisely when the password is believed to have leaked, which is the one
  // situation where 2FA is the only thing still protecting the account; whoever logged in
  // first with the leaked password took the account over, and the owner got "wrong
  // password". Now such an account stops at require_2fa, and /api/login-2fa hands out the
  // password-change token (marked is_verified_2fa = 1) only after a valid code.
  if (user.totp_enabled === 1) {
    // Generate a temporary token, valid for 5 minutes
    const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
    return { status: 'require_2fa', tempToken };
  }

  if (user.force_password_change === 1) {
    const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
    return { status: 'force_password_change', tempToken };
  }

  // B-W4: forced 2FA applies to ALL users, admin included (the bypass was removed)
  const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
  const isForce2faEnabled = force2faRow && force2faRow.value === '1';
  const isUserForce2fa = user.force_2fa === 1;

  if (isForce2faEnabled || isUserForce2fa) {
    // Check the account age in UTC (only for the global enforcement; for an individual one
    // there is no grace period)
    const userCreated = user.created_at ? new Date(user.created_at + 'Z') : new Date();
    const hoursSinceCreation = (Date.now() - userCreated.getTime()) / (1000 * 60 * 60);

    if (isUserForce2fa || hoursSinceCreation > 24) {
      // Force 2FA setup at login - always with a FRESH secret (audit 2026-10-09, B-S2).
      // This used to reuse `user.totp_secret` when one was present, but with 2FA still off
      // (we only get here when totp_enabled = 0) a stored secret is by definition one nobody
      // finished enrolling - and POST /api/user/setup-2fa writes it before any verification.
      // A stolen session could call setup-2fa, read the secret from the response, and wait:
      // once an administrator forced 2FA, the owner was shown the attacker's secret as their
      // new authenticator, and both of them held a valid second factor from then on.
      const secret = authenticator.generateSecret();
      await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, user.id]);

      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
      const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

      return { status: 'setup_2fa', tempToken, qrCode: qrCodeDataUrl, secret };
    }
  }

  // Direct login without 2FA (enforcement off, or the account is younger than 24h)
  const permanentToken = await createSession(user.id, false);
  return { token: permanentToken };
}

router.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  // reserveAttempt counts this attempt BEFORE bcrypt runs - see services/loginAttempts.js
  // for the parallel-burst race that an isLocked()-then-recordFailure() pair allowed. A
  // failure below therefore records nothing more; a success gives the slots back.
  const lockedMs = await loginAttempts.reserveAttempt(req.ip, username);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, username]);
    if (!user) {
      // Burn the same bcrypt work a real account costs (audit 2026-10-09, B-N1). Without it
      // an unknown name answered in ~2 ms and a known one in ~75 ms, so the response time
      // alone said which usernames and e-mail addresses have an account here - no password
      // needed, and the per-name lockout never triggers for names that do not exist.
      await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH);
      logger.security(`Failed login attempt for account: ${username} (no such user)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    // The per-account counter is checked only once the row is known - the id does not exist
    // before that. The response is the same 429 the typed-identifier lockout produces, so an
    // attacker cannot tell the two counters apart, and a legitimate user sees one consistent
    // message whichever name they signed in with.
    //
    // Third counter: the same account key without the IP (see ACCOUNT_MAX_ATTEMPTS in
    // services/loginAttempts.js) - the only one a botnet cannot multiply by its address count.
    const userLockedMs = await loginAttempts.reserveAttempt(req.ip, loginAttemptKeyForUser(user.id))
      || await loginAttempts.reserveAccountAttempt(loginAttemptKeyForUser(user.id));
    if (userLockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(userLockedMs / 60000)} min.`
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      logger.security(`Failed login attempt for account: ${username} (wrong password)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    await loginAttempts.recordSuccess(req.ip, username);
    await loginAttempts.recordSuccess(req.ip, loginAttemptKeyForUser(user.id));
    await loginAttempts.recordAccountSuccess(loginAttemptKeyForUser(user.id));

    res.json(await completeLogin(user));
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Błąd logowania serwera.' });
  }
});

// Endpoint weryfikacji konfiguracji 2FA - Krok 2a
router.post('/api/verify-2fa-setup', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
  }

  try {
    // The session is resolved BEFORE the lockout check, because the counter is keyed by
    // user id and the id is only known once the tempToken has been validated. Answering
    // an unknown/expired token with a 401 ahead of the 429 costs nothing: no code was
    // guessed, so there is nothing to rate-limit yet.
    //
    // `force_password_change = 0`: an owed password change comes first. The login path hands
    // a user with that flag a temp token for /api/change-password-forced, and a temp token
    // does not record which step it was minted for - so without this guard the same token,
    // plus a TOTP code, came back from here (or from /api/login-2fa) as a full session and
    // the change an administrator forced (typically after a suspected compromise) simply
    // never happened.
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1 AND s.is_verified_2fa = 0
        AND COALESCE(u.force_password_change, 0) = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    // Per IP, then account-wide - the same pair as /api/login, see there.
    const lockedMs = await loginAttempts.reserveAttempt(req.ip, twoFactorAttemptKey(session.user_id))
      || await loginAttempts.reserveAccountAttempt(twoFactorAttemptKey(session.user_id));
    if (lockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
      });
    }

    // verifyTotpOnce also refuses a code already used once - see utils/totp.js.
    const isValid = await verifyTotpOnce(session.user_id, session.totp_secret, code);

    if (!isValid) {
      logger.security(`Niepoprawny kod 2FA podczas konfiguracji (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, twoFactorAttemptKey(session.user_id));
    await loginAttempts.recordAccountSuccess(twoFactorAttemptKey(session.user_id));

    // Activate 2FA for the user
    await db.run(`UPDATE users SET totp_enabled = 1, force_2fa = 0 WHERE id = ?`, [session.user_id]);

    // Issue a permanent session token (valid 7 days), already 2FA-verified
    const permanentToken = await createSession(session.user_id, true);

    // Remove the temporary session
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    res.json({ token: permanentToken });
  } catch (err) {
    console.error('2FA setup verification failed:', err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

// Endpoint logowania 2FA - Krok 2b
router.post('/api/login-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Tymczasowy token i kod są wymagane.' });
  }

  try {
    // Session first, then the lockout - see the comment in /api/verify-2fa-setup above.
    //
    // Unlike there, an owed password change does NOT exclude the account: since B-W1 (see
    // completeLogin) a 2FA account with force_password_change comes HERE first, and leaves
    // with a password-change token rather than a session (below). `totp_enabled = 1` is what
    // keeps the old hole shut instead: the temp token of an account WITHOUT 2FA is a
    // password-change token, and an account without 2FA can still carry an unverified
    // totp_secret (setup-2fa writes it before verification) - without this condition that
    // token plus a code for that secret would skip the forced change.
    const session = await db.get(`
      SELECT s.*, u.totp_secret, u.force_password_change
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1 AND s.is_verified_2fa = 0
        AND u.totp_enabled = 1
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    // Per IP, then account-wide - the same pair as /api/login, see there.
    const lockedMs = await loginAttempts.reserveAttempt(req.ip, twoFactorAttemptKey(session.user_id))
      || await loginAttempts.reserveAccountAttempt(twoFactorAttemptKey(session.user_id));
    if (lockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
      });
    }

    // verifyTotpOnce also refuses a code already used once - see utils/totp.js.
    const isValid = await verifyTotpOnce(session.user_id, session.totp_secret, code);

    if (!isValid) {
      logger.security(`Niepoprawny kod 2FA podczas logowania (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, twoFactorAttemptKey(session.user_id));
    await loginAttempts.recordAccountSuccess(twoFactorAttemptKey(session.user_id));

    // Remove the temporary session
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    // Both factors are proven, but the administrator still wants a new password. The token
    // for that step is a temp session with is_verified_2fa = 1 - the one marker that tells
    // /api/change-password-forced "this came through the second factor", and that keeps it
    // out of this route and /api/verify-2fa-setup (both require is_verified_2fa = 0).
    if (session.force_password_change === 1) {
      const changeToken = await createSession(session.user_id, true, TEMP_SESSION_TTL_DAYS);
      return res.json({ status: 'force_password_change', tempToken: changeToken });
    }

    // Issue a permanent session token (valid 7 days), already 2FA-verified
    const permanentToken = await createSession(session.user_id, true);

    res.json({ token: permanentToken });
  } catch (err) {
    console.error('2FA login failed:', err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

// Endpoint wylogowania
router.post('/api/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '');
    await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
  }
  res.json({ success: true });
});

router.post('/api/change-password-forced', async (req, res) => {
  const { tempToken, newPassword } = req.body;
  if (!tempToken || !newPassword) {
    return res.status(400).json({ error: 'Token i nowe hasło są wymagane.' });
  }
  const passError = validatePassword(newPassword);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  try {
    // `is_temp = 1` narrows this to the tokens actually minted for the forced-password-change
    // step. Without it a full 7-day session token could be replayed into this endpoint as a
    // "tempToken" (is_verified_2fa = 0 is true for ordinary sessions of users without 2FA)
    // and change the account password with no knowledge of the current one.
    //
    // `force_password_change = 1` narrows it further, to accounts that actually owe a
    // password change. `is_temp` alone does not say WHICH step a temp token was minted for,
    // and the login path mints the same kind of token for the 2FA step: a user with 2FA
    // receives one right after the password check, before any TOTP code. Without this guard
    // that token was accepted here, so a password alone - no second factor - was enough to
    // set a new password, revoke every session and every share link of the account, and lock
    // the owner out. 2FA protected the session but not the credential it was layered on.
    //
    // The last condition is the second half of that fix (B-W1, see completeLogin): an account
    // with 2FA gets its password-change token only from /api/login-2fa, marked
    // is_verified_2fa = 1. A token minted after the password alone (is_verified_2fa = 0) is
    // accepted only for an account that has no second factor to ask for.
    const session = await db.get(`
      SELECT s.*, u.username
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1
        AND u.force_password_change = 1
        AND (COALESCE(u.totp_enabled, 0) = 0 OR s.is_verified_2fa = 1)
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.run(`
      UPDATE users
      SET password_hash = ?, force_password_change = 0, password_set = 1
      WHERE id = ?
    `, [newHash, session.user_id]);

    // Same reasoning as POST /api/user/change-password in routes/account.js: a password
    // change that leaves the old sessions alive revokes nothing, and this path used to delete
    // only the tempToken it was handed. A forced change is often the FIRST thing that happens
    // after an administrator resets a compromised account - if any session from before the
    // reset survives it, the reset was theatre. The tempToken is kept for the few lines below
    // that still need it (2FA / setup_2fa branches delete it themselves).
    //
    // And the same cleanup as a voluntary change (audit round 2, N-W2): this path used to stop
    // at sessions and share links, so after the reset the summaries still went to the address
    // the attacker had set and the Apple Health webhook still took their data. The tempToken never changed anything, so an
    // e-mail change made from ANY real session of this account is undone.
    const { revokedSessions, revokedShares, emailRevert } = await cleanUpAfterCredentialReset(session.user_id, {
      keepSessionToken: tempToken
    });
    logger.security(
      `Forced password change: revoked ${revokedSessions} session(s) and ${revokedShares} share link(s), rotated sync token${emailRevert ? ', reverted e-mail change' : ''} (UID: ${session.user_id})`,
      'AUTH_PASSWORD_CHANGE',
      { userId: session.user_id, revokedSessions, revokedShares, emailReverted: !!emailRevert },
      req.ip,
      session.user_id
    );

    const user = await db.get(`SELECT totp_enabled, username, totp_secret, force_2fa FROM users WHERE id = ?`, [session.user_id]);
    
    if (user.totp_enabled === 1) {
      // Only reachable with a token from /api/login-2fa (see the WHERE above): the code was
      // checked a moment ago, on the way to this step. Asking for another one used to be the
      // flow when this step came first; now it would only make the user wait for the next
      // 30-second window (verifyTotpOnce refuses the same code twice).
      await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);
      const permanentToken = await createSession(session.user_id, true);
      res.json({ token: permanentToken });
    } else {
      const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
      const isForce2faEnabled = force2faRow && force2faRow.value === '1';
      const isUserForce2fa = user.force_2fa === 1;

      if (isForce2faEnabled || isUserForce2fa) {
        const secret = authenticator.generateSecret();
        await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, session.user_id]);

        const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
        const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    // B-W5: invalidate the old tempToken and issue a new one before setup_2fa
        await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);
        const newTempToken = await createSession(session.user_id, false, TEMP_SESSION_TTL_DAYS);
        res.json({
          status: 'setup_2fa',
          tempToken: newTempToken,
          qrCode: qrCodeDataUrl,
          secret: secret
        });
      } else {
        const permanentToken = await createSession(session.user_id, false);

    // Remove the temporary session
        await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

        res.json({
          token: permanentToken
        });
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zmiany wymuszonego hasła.' });
  }
});

// 6e. Check invitation status (for registration)
router.get('/api/invitation-status', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Token jest wymagany.' });
  }

  try {
    const user = await db.get(`SELECT email FROM users WHERE invitation_token = ? AND status = 'pending' AND datetime(invitation_expires_at) > datetime('now')`, [token]);
    if (!user) {
      return res.status(404).json({ error: 'Nieprawidłowy lub wygasły token zaproszenia.' });
    }
    res.json({ email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd sprawdzania statusu zaproszenia.' });
  }
});

// 6f. Rejestracja z zaproszenia
router.post('/api/register-invitation', async (req, res) => {
  const { token, username, password } = req.body;
  if (!token || !username || !password) {
    return res.status(400).json({ error: 'Wszystkie pola są wymagane.' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: USERNAME_RULE_MESSAGE });
  }
  const passError = validatePassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

// The registration endpoints (unlike /api/login, /api/login-2fa and /api/verify-2fa-setup)
// had no DEDICATED protection against automated mass account creation from one IP - only the
// general apiRateLimiter (120 requests/min) covered them. We reuse the loginAttempts
// mechanism, keyed per IP rather than per username, because at registration the username
// differs on every attempt. Every registration attempt counts towards the limit regardless
// of outcome, unlike login where only FAILED attempts count.
  const registerLockedMs = await loginAttempts.reserveAttempt(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }

  try {
    const user = await db.get(`SELECT id FROM users WHERE invitation_token = ? AND status = 'pending' AND datetime(invitation_expires_at) > datetime('now')`, [token]);
    if (!user) {
      return res.status(404).json({ error: 'Nieprawidłowy lub wygasły token zaproszenia.' });
    }

    const existingUsername = await db.get(`SELECT id FROM users WHERE username = ? AND id != ?`, [username, user.id]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Ta nazwa użytkownika jest już zajęta.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret();
    
    await db.run(`
      UPDATE users 
      SET username = ?, password_hash = ?, totp_secret = ?, totp_enabled = 0, status = 'active', invitation_token = NULL, invitation_expires_at = NULL
      WHERE id = ?
    `, [username, passwordHash, secret, user.id]);

    const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
    const isForce2faEnabled = force2faRow && force2faRow.value === '1';

    if (isForce2faEnabled) {
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
      const otpauth = authenticator.keyuri(username, 'Dietetyk AI', secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

      res.json({
        status: 'setup_2fa',
        tempToken: tempToken,
        qrCode: qrCodeDataUrl,
        secret: secret
      });
    } else {
      const permanentToken = await createSession(user.id, false);
      res.json({
        token: permanentToken
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji zaproszenia.' });
  }
});

// 6f-2. Public registration (without an invitation token)
router.post('/api/register-public', async (req, res) => {
// Round 17 (audit fix): this endpoint previously had NO enable/disable flag at all and
// bypassed the admin invitation system (/api/admin/invite) entirely. It is OFF by default -
// the `allow_public_registration` flag in app_config (the default '0' row is inserted in
// db.js, the same convention as `force_2fa`), managed by an administrator through
// GET/POST /api/admin/config.
  const allowPublicRegRow = await db.get(`SELECT value FROM app_config WHERE key = 'allow_public_registration'`);
  const isPublicRegistrationEnabled = allowPublicRegRow && allowPublicRegRow.value === '1';
  if (!isPublicRegistrationEnabled) {
    return res.status(403).json({ error: 'Rejestracja publiczna jest wyłączona. Skontaktuj się z administratorem, aby otrzymać zaproszenie.' });
  }

  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: USERNAME_RULE_MESSAGE });
  }
  const passError = validatePassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

    // See the comment in /api/register-invitation - the same per-IP anti-spam mechanism.
  const registerLockedMs = await loginAttempts.reserveAttempt(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }

  try {
    const existingUsername = await db.get(`SELECT id FROM users WHERE username = ?`, [username]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Ta nazwa użytkownika jest już zajęta.' });
    }

    if (email) {
      const existingEmail = await db.get(`SELECT id FROM users WHERE email = ?`, [email]);
      if (existingEmail) {
        return res.status(400).json({ error: 'Ten adres e-mail jest już zajęty.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret();
    const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

    const result = await db.run(`
      INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, totp_secret)
      VALUES (?, ?, ?, 0, ?, 'user', 'active', ?)
    `, [username, passwordHash, syncToken, email || null, secret]);

    // No targets are seeded (audit 2026-10-09, S2). Every account used to get the same
    // 2500 kcal / 150/250/80 g / BMR 1800, indistinguishable from values the user chose, and
    // e-mails, the PDF and the chat quoted them as "your goal". An account created from an
    // invitation never had them; the dashboard and Settings show "not set" until the user
    // enters their own.

    const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
    const isForce2faEnabled = force2faRow && force2faRow.value === '1';

    if (isForce2faEnabled) {
      const tempToken = await createSession(result.id, false, TEMP_SESSION_TTL_DAYS);
      const otpauth = authenticator.keyuri(username, 'Dietetyk AI', secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

      res.json({
        status: 'setup_2fa',
        tempToken: tempToken,
        qrCode: qrCodeDataUrl,
        secret: secret
      });
    } else {
      const permanentToken = await createSession(result.id, false);
      res.json({
        token: permanentToken
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rejestracji.' });
  }
});

module.exports = router;
