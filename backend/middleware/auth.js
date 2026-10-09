const db = require('../db');

// Deletes a user's session rows. With `keepToken` the caller's own session survives, which is
// what every "this was me, log everything else out" action wants: the user stays where they
// are, every other device is cut off.
//
// This exists because changing a password used to do NOTHING to existing sessions. A stolen
// session token (XSS against localStorage, a borrowed laptop, a token pulled out of an old
// log line) remained valid after the victim changed their password, and middleware/auth.js
// below re-extends any token used at least once a week - so the attacker's session simply
// never expired. `DELETE FROM sessions WHERE user_id` appeared ONLY in the three admin
// endpoints (routes/admin.js); no user-reachable path existed, which left the victim of a
// token leak with no way whatsoever to revoke it. The password change is the one action a
// user takes when they believe they have been compromised, so it must be the action that
// ends every other session.
async function revokeUserSessions(userId, keepToken = null) {
  const result = keepToken
    ? await db.run(`DELETE FROM sessions WHERE user_id = ? AND token != ?`, [userId, keepToken])
    : await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  return result.changes;
}

async function requireAuth(req, res, next) {
  // Exception for the public login/invitation/registration/callback routes
  if (
    req.path === '/login' ||
    req.path === '/verify-2fa-setup' ||
    req.path === '/login-2fa' ||
    req.path === '/invitation-status' ||
    req.path === '/register-invitation' ||
    req.path === '/change-password-forced' ||
    req.path === '/register-public' ||
    req.path === '/auth/oura/callback' ||
    req.path === '/auth/withings/callback' ||
    req.path === '/auth/google-fit/callback' ||
    req.path === '/auth/google' ||
    req.path === '/auth/google/enabled' ||
    req.path === '/auth/google/callback' ||
    req.path === '/auth/google/exchange' ||
    // Routes that INITIATE a connection to Oura/Withings/Google Fit, plus Google account
    // linking. The frontend navigates to these via window.location.href, because only a
    // top-level navigation can redirect the browser to the OAuth provider's consent
    // screen - a fetch() with an Authorization header cannot produce that redirect.
    // They are authorised by a one-time ?ticket= (services/authTickets.js) minted by an
    // authenticated POST /api/auth/ticket, NOT by the Bearer header and no longer by the
    // session token in the query string, which ended up in the nginx access log. Each of
    // these four routes consumes the ticket itself and does not use req.user.
    req.path === '/auth/oura' ||
    req.path === '/auth/withings' ||
    req.path === '/auth/google-fit' ||
    req.path === '/auth/google/link' ||
    req.path === '/auth/google/reauth'
  ) {
    return next();
  }

  // The token is accepted ONLY from the Authorization header. There used to be a
  // fallback to req.query.token, but a session token in the query string ended up
  // unencrypted in morgan('dev') logs (which log the full request URL), in browser
  // history and in the Referer header. The frontend (App.jsx) always sends the token via
  // the Bearer header anyway - the fallback was dead code that widened the attack surface
  // without being a feature anyone used.
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    token = authHeader.replace('Bearer ', '');
  }

  if (!token) {
    return res.status(401).json({ error: 'Brak autoryzacji. Zaloguj się.' });
  }
  try {
    const session = await db.get(`
      SELECT s.*, u.username, u.totp_enabled, u.role, u.first_name, u.last_name
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
    `, [token]);

    if (!session) {
      return res.status(401).json({ error: 'Sesja wygasła lub jest niepoprawna. Zaloguj się ponownie.' });
    }

    // A temporary session authorises exactly one thing: finishing the step it was issued
    // for. Those steps live on the exception list at the top of this function
    // (/verify-2fa-setup, /login-2fa, /change-password-forced), which validates the token
    // from the request body itself - so nothing reachable from here should ever accept one.
    //
    // This check must come from the session row, not from `totp_enabled` below and not from
    // the token's 'temp_' prefix. The totp_enabled path was the actual hole: a user being
    // forced through 2FA setup has totp_enabled = 0 by definition, so the check underneath
    // never fired and Bearer temp_… returned /api/user/profile and /api/settings with a
    // 200. Once the 5 minutes ran out the attacker just logged in again for a fresh one,
    // which made force_2fa purely decorative. Matching on the prefix instead would test a
    // property of the string rather than of the session, and would fail open the day the
    // token format changes.
    if (session.is_temp === 1) {
      return res.status(401).json({ error: 'Sesja tymczasowa. Dokończ logowanie (2FA / zmiana hasła).' });
    }

    // Deny access when the user has 2FA enabled but the session is not yet verified.
    // Still needed alongside is_temp: a full 7-day session issued while the account had no
    // 2FA keeps is_verified_2fa = 0, so enabling 2FA later (Settings) must invalidate it.
    if (session.totp_enabled === 1 && session.is_verified_2fa === 0) {
      return res.status(401).json({ error: 'Wymagana weryfikacja 2FA. Uzupełnij kod.' });
    }

    // Extend the session by 7 days only when fewer than 6 days remain before expiry
    // (this avoids writing to SQLite on every single API request, which could cause
    // SQLITE_BUSY locks under the dashboard's parallel requests).
    //
    // The extension has no self-imposed end: a token used once a week is renewed for another
    // seven days, for ever. "The session expires after 7 days" is therefore true only of a
    // token nobody touches - a stolen token being polled by a script is precisely the one
    // that never expires. The cap below is what makes the 7 days mean something, and it is
    // read from the session row rather than computed here: only the row knows when the
    // session was born.
    //
    // `sessions.absolute_expires_at` is created and backfilled in db.js and written once by
    // createSession() in routes/auth.js, in the same 'YYYY-MM-DD HH:MM:SS' UTC text format as
    // expires_at. A row without it (NULL) gets no cap - the branch below is kept for that case.
    const expiresAtMs = new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime();
    const nowMs = Date.now();
    const remainingTimeMs = expiresAtMs - nowMs;
    const sixDaysInMs = 6 * 24 * 60 * 60 * 1000;
    const absoluteCapMs = session.absolute_expires_at
      ? new Date(String(session.absolute_expires_at).replace(' ', 'T') + 'Z').getTime()
      : null;

    if (absoluteCapMs !== null && Number.isFinite(absoluteCapMs) && absoluteCapMs <= nowMs) {
      // Past the hard limit the row is not merely unusable, it is deleted: leaving it in
      // place would keep answering "session expired" while still being a live row that a
      // future change to this query could re-admit.
      await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
      return res.status(401).json({ error: 'Sesja wygasła lub jest niepoprawna. Zaloguj się ponownie.' });
    }

    if (remainingTimeMs < sixDaysInMs) {
      let nextExpiryMs = nowMs + 7 * 24 * 60 * 60 * 1000;
      if (absoluteCapMs !== null && Number.isFinite(absoluteCapMs)) {
        nextExpiryMs = Math.min(nextExpiryMs, absoluteCapMs);
      }
      // Never move expiry backwards: with the cap less than 7 days away the renewal would
      // otherwise SHORTEN a session that is still legitimately valid.
      if (nextExpiryMs > expiresAtMs) {
        const nextExpiry = new Date(nextExpiryMs).toISOString().replace('T', ' ').slice(0, 19);
        await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [nextExpiry, token]);
      }
    }

    // The routes need the token that authenticated this request, so that "log out everywhere
    // else" and the post-password-change revocation can keep exactly this session alive while
    // deleting the rest. Reading the Authorization header again inside each route would
    // duplicate the 'Bearer ' handling above and drift from it.
    req.sessionToken = token;

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      // First/last name (optional, set in Settings) - used to personalise the AI
      // dietician's phrasing ("Hi Marcin" rather than the username).
      first_name: session.first_name,
      last_name: session.last_name
    };
    next();
  } catch (err) {
    console.error('Error in the requireAuth middleware:', err);
    res.status(500).json({ error: 'Błąd autoryzacji serwera.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Brak uprawnień administratora.' });
}

module.exports = {
  requireAuth,
  requireAdmin,
  revokeUserSessions
};
