const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const loginAttempts = require('../services/loginAttempts');
const logger = require('../services/logger');
const { getAppConfig, generateOAuthState, verifyOAuthState, getVerifiedSessionByToken } = require('../services/oauthHelpers');
const { revokeUserSessions } = require('../middleware/auth');
const { revokeAllSharesForUser } = require('../services/sharedReports');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

// Helper for creating a session (temporary or permanent) - extracted because the same
// pattern (generate a token, compute expires_at, insert a sessions row) was repeated
// separately in a dozen places in this file (force_password_change, require_2fa, setup_2fa,
// login without 2FA, Google login, 2FA verification, registration and so on) with identical
// logic apart from the validity period and the is_verified_2fa flag.
// `ttlDays` also accepts fractional values (5-minute temporary sessions, see
// TEMP_SESSION_TTL_DAYS below) - it is computed in milliseconds anyway.
// The token prefix ('temp_' for short-lived verification sessions, 'sess_' for real login
// sessions) is kept only so that tokens stay recognisable to a human reading a log or a
// database row. NOTHING may authorise on it: the authoritative marker is the is_temp column
// written below and read by middleware/auth.js and getVerifiedSessionByToken.
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
// `alice@firma.pl`: ten guesses where the limit says five, and more still if a second address
// ever reaches that row. The account id is the one identifier that does not multiply.
const loginAttemptKeyForUser = (userId) => `login_user:${userId}`;

// ===== Binding the Google sign-in flow to the browser that started it =====
// The `state` of the sign-in flow has to be tied to ONE browser, otherwise the flow is
// login-CSRF-able: the attacker starts it themselves, approves Google consent on their OWN
// Google account, and then hands the victim the callback URL carrying the attacker's `code`
// and a state the backend accepts. The victim's browser is handed a session for the
// attacker's account and the victim goes on logging meals, weight and Oura/Withings data
// into an account the attacker can read at will.
//
// The previous binding was `sha256(req.ip + User-Agent)` and it bound nothing. req.ip is
// 10.42.0.1 for every request from the internet (measured on production - see the long note
// above `app.set('trust proxy', ...)` in server.js), and the User-Agent is a header the
// attacker chooses when GENERATING the state, so reproducing the victim's fingerprint means
// sending one common header value. No change inside this file could have fixed it: the
// address never enters the cluster.
//
// A short-lived HttpOnly cookie is the one thing here the attacker cannot reproduce in the
// victim's browser: it is set on the response to GET /api/auth/google and only the browser
// that made THAT request ever stores it. SameSite=Lax still sends it on the top-level GET
// navigation Google performs back to the callback (Lax excludes cross-site POSTs and
// subresources, not top-level GETs), which is exactly the one case we need it in.
const GOOGLE_LOGIN_NONCE_COOKIE = 'dai_google_login';
// Scoped to the sign-in routes rather than '/', so the cookie is not attached to every
// request to the application for the ten minutes it lives.
const GOOGLE_LOGIN_COOKIE_PATH = '/api/auth/google';
const GOOGLE_LOGIN_NONCE_TTL_MS = 10 * 60 * 1000;

// Minimal cookie reader. cookie-parser is not a dependency of this project and the
// project deliberately keeps its dependency surface small (see CLAUDE.md); one header,
// parsed once, does not justify a package.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// Only the HASH of the nonce travels in `state`; the nonce itself never leaves the cookie.
// The state is visible to Google, to the address bar and to anything that logs the callback
// URL, so a state that carried the raw nonce would hand back the very secret that proves
// "this browser started the flow".
function googleLoginService(nonce) {
  return `google_login:${crypto.createHash('sha256').update(nonce).digest('hex')}`;
}

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

// ===== Google sign-in =====
// configured globally by an administrator (Admin Panel), because sign-in applies to the
// whole application rather than being a per-user integration like Oura or Withings.
router.get('/api/auth/google', async (req, res) => {
  try {
    const clientId = await getAppConfig('google_client_id');
    if (!clientId) {
      return res.status(400).send('Logowanie przez Google nie jest skonfigurowane. Administrator musi wpisać Client ID/Secret w Panelu Admina.');
    }

    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    // See the comment on GOOGLE_LOGIN_NONCE_COOKIE: the cookie is what ties this flow to
    // this browser. The state only carries its hash.
    const loginNonce = crypto.randomBytes(32).toString('hex');
    const state = generateOAuthState(0, googleLoginService(loginNonce));

    res.cookie(GOOGLE_LOGIN_NONCE_COOKIE, loginNonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: GOOGLE_LOGIN_NONCE_TTL_MS,
      path: GOOGLE_LOGIN_COOKIE_PATH
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile')}&state=${state}&prompt=select_account`;
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE LOGIN ERROR]', err);
    res.status(500).send('Błąd serwera.');
  }
});

// Step 1b: as above, but for a user who is ALREADY LOGGED IN and explicitly wants to link
// their existing account to Google (Settings -> 'Connect with Google') rather than sign in
// afresh. Google sign-in above already links accounts by email as a side effect, but only
// when the email matches - this flow works regardless of the email address, because the user
// is already verified by their session.
// `state` is HMAC-signed here (generateOAuthState), unlike ordinary Google sign-in where
// state is just a random string with no verification - that is how the callback tells the
// two flows apart.
router.get('/api/auth/google/link', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await getVerifiedSessionByToken(token);
    if (!session) {
      return res.status(401).send('Sesja wygasła lub wymaga weryfikacji 2FA.');
    }

    const clientId = await getAppConfig('google_client_id');
    if (!clientId) {
      return res.status(400).send('Logowanie przez Google nie jest skonfigurowane. Administrator musi wpisać Client ID/Secret w Panelu Admina.');
    }

    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const state = generateOAuthState(session.user_id, 'google_link');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile')}&state=${state}&prompt=select_account`;
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE LINK ERROR]', err);
    res.status(500).send('Błąd serwera.');
  }
});

// Krok 2: callback - wymiana kodu na token, pobranie profilu, znalezienie/utworzenie konta
// (or, when `state` indicates the account-linking flow above, simply assigning google_id to
// the already logged-in user).
router.get('/api/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const verified = verifyOAuthState(state);

  // The sign-in flow is accepted only when the browser presents the nonce cookie whose hash
  // is inside the signed state. An attacker can mint a state (the route is public) but cannot
  // put their cookie into the victim's browser, so the victim's callback request simply does
  // not match and ends as csrf_failed - before any code is exchanged for a session.
  const loginNonce = readCookie(req, GOOGLE_LOGIN_NONCE_COOKIE);
  const isLoginFlow = !!(verified && verified.userId === 0 && loginNonce && verified.service === googleLoginService(loginNonce));
  const isLinkFlow = !!(verified && verified.userId > 0 && verified.service === 'google_link');

  // One cookie, one flow: whatever happens below, this nonce must not stay usable for a
  // second callback. Cleared for every state that claims to be a sign-in - including a
  // rejected one - so a failed attempt cannot leave a live binding behind.
  if (loginNonce) {
    res.clearCookie(GOOGLE_LOGIN_NONCE_COOKIE, { path: GOOGLE_LOGIN_COOKIE_PATH });
  }

  if (error) {
    console.error('[GOOGLE LOGIN CALLBACK ERROR]', error);
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=auth_failed' : '/?google_error=auth_failed');
  }
  if (!code || !verified || (!isLoginFlow && !isLinkFlow)) {
    return res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=csrf_failed' : '/?google_error=csrf_failed');
  }

  try {
    const clientId = await getAppConfig('google_client_id');
    const clientSecret = await getAppConfig('google_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google/callback`;

    const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Wymiana kodu Google nieudana: ${errText}`);
    }
    const tokenData = await tokenRes.json();

    const userInfoRes = await fetchWithTimeout('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!userInfoRes.ok) {
      throw new Error('Nie udało się pobrać profilu użytkownika Google.');
    }
    const profile = await userInfoRes.json(); // { sub, email, name, picture, email_verified, ... }

    if (!profile.sub) {
      throw new Error('Odpowiedź Google nie zawiera identyfikatora użytkownika (sub).');
    }

      // Account-linking flow (Settings -> 'Connect with Google'): the user is already logged
      // in, verified by the signed `state`, so we only assign google_id to THEIR account - no
      // sign-in, no new account, no new session. We block account takeover if the same
      // google_id is already assigned to a different user.
    if (isLinkFlow) {
      const conflictingUser = await db.get(`SELECT id FROM users WHERE google_id = ? AND id != ?`, [profile.sub, verified.userId]);
      if (conflictingUser) {
        return res.redirect('/?tab=settings&google_link_error=already_linked');
      }
      await db.run(`UPDATE users SET google_id = ? WHERE id = ?`, [profile.sub, verified.userId]);
      return res.redirect('/?tab=settings&google_link=success');
    }

      // 1. Look for a user already linked to this Google account
    let user = await db.get(`SELECT * FROM users WHERE google_id = ?`, [profile.sub]);

    if (!user && profile.email) {
      // 2. If none was found but the email matches an existing account (password login),
      // we do NOT link automatically, for security reasons - that would allow account takeover
      // via a forged email address. We direct the user to sign in with their password and link
      const existingByEmail = await db.get(`SELECT * FROM users WHERE email = ?`, [profile.email]);
      if (existingByEmail) {
        return res.redirect('/?google_error=email_exists');
      }
    }

    if (!user) {
        // 3. No account - create one. A Google account has no known password, so we generate
        // a random, unused hash (the schema requires NOT NULL) to make password login for
        // this account genuinely impossible until the user sets a password themselves in
        // Settings.
      const randomPassword = crypto.randomBytes(24).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);
      const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

      let baseUsername = (profile.email ? profile.email.split('@')[0] : profile.name || 'user').replace(/[^a-zA-Z0-9_.-]/g, '') || 'user';
      let username = baseUsername;
      let suffix = 0;
      while (await db.get(`SELECT id FROM users WHERE username = ?`, [username])) {
        suffix += 1;
        username = `${baseUsername}${suffix}`;
      }

      const result = await db.run(`
        INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, google_id)
        VALUES (?, ?, ?, 0, ?, 'user', 'active', ?)
      `, [username, passwordHash, syncToken, profile.email || null, profile.sub]);

      const defaultSettings = [
        { key: 'target_calories', value: '2500' },
        { key: 'target_protein', value: '150' },
        { key: 'target_carbs', value: '250' },
        { key: 'target_fat', value: '80' },
        { key: 'bmr', value: '1800' }
      ];
      for (const s of defaultSettings) {
        await db.run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)`, [result.id, s.key, s.value]);
      }

      user = await db.get(`SELECT * FROM users WHERE id = ?`, [result.id]);
    }

    if (user.status !== 'active') {
      return res.redirect('/?google_error=account_inactive');
    }

      // Respect 2FA if the user enabled it earlier - Google sign-in does not bypass 2FA
    if (user.totp_enabled === 1) {
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);
      // The token goes in the URL fragment (#), NOT the query string: a fragment is never
      // sent by the browser to the server on a subsequent request (a plain GET /, say), so a
      // live session token does not reach morgan('dev') logs, which record the full request
      // URL, nor the Referer header or browser history.
      return res.redirect(`/#google_temp_token=${tempToken}`);
    }

    const permanentToken = await createSession(user.id, false);
    res.redirect(`/#google_token=${permanentToken}`);
  } catch (err) {
    console.error('[GOOGLE LOGIN CALLBACK ERROR]', err.message);
    res.redirect(isLinkFlow ? '/?tab=settings&google_link_error=exchange_failed' : '/?google_error=exchange_failed');
  }
});

router.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane.' });
  }

  const lockedMs = await loginAttempts.isLocked(req.ip, username);
  if (lockedMs > 0) {
    return res.status(429).json({
      error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
    });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, username]);
    if (!user) {
      await loginAttempts.recordFailure(req.ip, username);
      logger.security(`Nieudana próba logowania na konto: ${username} (użytkownik nie istnieje)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    // The per-account counter is checked only once the row is known - the id does not exist
    // before that. The response is the same 429 the typed-identifier lockout produces, so an
    // attacker cannot tell the two counters apart, and a legitimate user sees one consistent
    // message whichever name they signed in with.
    const userLockedMs = await loginAttempts.isLocked(req.ip, loginAttemptKeyForUser(user.id));
    if (userLockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób logowania. Spróbuj ponownie za ${Math.ceil(userLockedMs / 60000)} min.`
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      await loginAttempts.recordFailure(req.ip, username);
      await loginAttempts.recordFailure(req.ip, loginAttemptKeyForUser(user.id));
      logger.security(`Nieudana próba logowania na konto: ${username} (błędne hasło)`, 'AUTH_LOGIN_FAILURE', { username }, req.ip);
      return res.status(401).json({ error: 'Niepoprawny użytkownik lub hasło.' });
    }

    await loginAttempts.recordSuccess(req.ip, username);
    await loginAttempts.recordSuccess(req.ip, loginAttemptKeyForUser(user.id));

    // Check whether a password change is being forced
    if (user.force_password_change === 1) {
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

      return res.json({
        status: 'force_password_change',
        tempToken: tempToken
      });
    }

    if (user.totp_enabled === 1) {
      // Generate a temporary token, valid for 5 minutes
      const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

      return res.json({
        status: 'require_2fa',
        tempToken: tempToken
      });
    } else {
    // B-W4: forced 2FA applies to ALL users, admin included (the bypass was removed)
      const force2faRow = await db.get(`SELECT value FROM app_config WHERE key = 'force_2fa'`);
      const isForce2faEnabled = force2faRow && force2faRow.value === '1';
      const isUserForce2fa = user.force_2fa === 1;

      if (isForce2faEnabled || isUserForce2fa) {
    // Check the account age in UTC (only for the global enforcement; for an individual one
        const userCreated = user.created_at ? new Date(user.created_at + 'Z') : new Date();
        const hoursSinceCreation = (Date.now() - userCreated.getTime()) / (1000 * 60 * 60);

        if (isUserForce2fa || hoursSinceCreation > 24) {
      // Force 2FA setup at login
          const secret = user.totp_secret || authenticator.generateSecret();
          if (!user.totp_secret) {
            await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, user.id]);
          }

          const tempToken = await createSession(user.id, false, TEMP_SESSION_TTL_DAYS);

          const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
          const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

          return res.json({
            status: 'setup_2fa',
            tempToken: tempToken,
            qrCode: qrCodeDataUrl,
            secret: secret
          });
        }
      }

    // Direct login without 2FA (enforcement off, or the account is younger than 24h)
      const permanentToken = await createSession(user.id, false);

      return res.json({
        token: permanentToken
      });
    }
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
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1 AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const lockedMs = await loginAttempts.isLocked(req.ip, twoFactorAttemptKey(session.user_id));
    if (lockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
      });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      await loginAttempts.recordFailure(req.ip, twoFactorAttemptKey(session.user_id));
      logger.security(`Niepoprawny kod 2FA podczas konfiguracji (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, twoFactorAttemptKey(session.user_id));

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
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1 AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const lockedMs = await loginAttempts.isLocked(req.ip, twoFactorAttemptKey(session.user_id));
    if (lockedMs > 0) {
      return res.status(429).json({
        error: `Za dużo nieudanych prób. Spróbuj ponownie za ${Math.ceil(lockedMs / 60000)} min.`
      });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      await loginAttempts.recordFailure(req.ip, twoFactorAttemptKey(session.user_id));
      logger.security(`Niepoprawny kod 2FA podczas logowania (UID: ${session.user_id})`, 'AUTH_2FA_FAILURE', { userId: session.user_id }, req.ip);
      return res.status(400).json({ error: 'Niepoprawny kod 2FA. Spróbuj ponownie.' });
    }

    await loginAttempts.recordSuccess(req.ip, twoFactorAttemptKey(session.user_id));

    // Issue a permanent session token (valid 7 days), already 2FA-verified
    const permanentToken = await createSession(session.user_id, true);

    // Remove the temporary session
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

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
    const session = await db.get(`
      SELECT s.*, u.username
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND s.is_temp = 1 AND s.is_verified_2fa = 0
    `, [tempToken]);

    if (!session) {
      return res.status(401).json({ error: 'Tymczasowa sesja wygasła. Zaloguj się ponownie.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.run(`
      UPDATE users
      SET password_hash = ?, force_password_change = 0
      WHERE id = ?
    `, [newHash, session.user_id]);

    // Same reasoning as POST /api/user/change-password in routes/account.js: a password
    // change that leaves the old sessions alive revokes nothing, and this path used to delete
    // only the tempToken it was handed. A forced change is often the FIRST thing that happens
    // after an administrator resets a compromised account - if any session from before the
    // reset survives it, the reset was theatre. The tempToken is kept for the few lines below
    // that still need it (2FA / setup_2fa branches delete it themselves).
    const revokedSessions = await revokeUserSessions(session.user_id, tempToken);
    const revokedShares = await revokeAllSharesForUser(session.user_id);
    logger.security(
      `Forced password change: revoked ${revokedSessions} session(s) and ${revokedShares} share link(s) (UID: ${session.user_id})`,
      'AUTH_PASSWORD_CHANGE',
      { userId: session.user_id, revokedSessions, revokedShares },
      req.ip,
      session.user_id
    );

    const user = await db.get(`SELECT totp_enabled, username, totp_secret, force_2fa FROM users WHERE id = ?`, [session.user_id]);
    
    if (user.totp_enabled === 1) {
    // B-W5: invalidate the old tempToken and issue a new one after a password change
      await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);
      const newTempToken = await createSession(session.user_id, false, TEMP_SESSION_TTL_DAYS);
      res.json({
        status: 'require_2fa',
        tempToken: newTempToken
      });
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
    const user = await db.get(`SELECT email FROM users WHERE invitation_token = ? AND status = 'pending'`, [token]);
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
  const registerLockedMs = await loginAttempts.isLocked(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }
  await loginAttempts.recordFailure(req.ip, 'register_endpoint');

  try {
    const user = await db.get(`SELECT id FROM users WHERE invitation_token = ? AND status = 'pending'`, [token]);
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
      SET username = ?, password_hash = ?, totp_secret = ?, totp_enabled = 0, status = 'active', invitation_token = NULL
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
  const passError = validatePassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

    // See the comment in /api/register-invitation - the same per-IP anti-spam mechanism.
  const registerLockedMs = await loginAttempts.isLocked(req.ip, 'register_endpoint');
  if (registerLockedMs > 0) {
    return res.status(429).json({ error: `Za dużo prób rejestracji z tego adresu IP. Spróbuj ponownie za ${Math.ceil(registerLockedMs / 60000)} min.` });
  }
  await loginAttempts.recordFailure(req.ip, 'register_endpoint');

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

    // Insert the default targets for the new user
    const defaultSettings = [
      { key: 'target_calories', value: '2500' },
      { key: 'target_protein', value: '150' },
      { key: 'target_carbs', value: '250' },
      { key: 'target_fat', value: '80' },
      { key: 'bmr', value: '1800' }
    ];
    for (const s of defaultSettings) {
      await db.run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)`, [result.id, s.key, s.value]);
    }

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
