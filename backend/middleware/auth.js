const db = require('../db');

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
    req.path === '/auth/google/callback' ||
    // Routes that INITIATE a connection to Oura/Withings/Google Fit, plus Google account
    // linking. The frontend navigates to these via window.location.href, because only a
    // top-level navigation can redirect the browser to the OAuth provider's consent
    // screen - a fetch() with an Authorization header cannot produce that redirect.
    // The token therefore reaches them through ?token= in the query string, NOT through
    // the Bearer header. Each of these four routes validates req.query.token against the
    // sessions table itself (see routes/integrations.js and routes/auth.js) and does not
    // use req.user, so requiring an Authorization header here only blocked them - a
    // regression introduced together with removing the general query.token fallback
    // below.
    req.path === '/auth/oura' ||
    req.path === '/auth/withings' ||
    req.path === '/auth/google-fit' ||
    req.path === '/auth/google/link'
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

    // Deny access when the user has 2FA enabled but the session is not yet verified
    if (session.totp_enabled === 1 && session.is_verified_2fa === 0) {
      return res.status(401).json({ error: 'Wymagana weryfikacja 2FA. Uzupełnij kod.' });
    }

    // Extend the session by 7 days only when fewer than 6 days remain before expiry
    // (this avoids writing to SQLite on every single API request, which could cause
    // SQLITE_BUSY locks under the dashboard's parallel requests).
    const expiresAtMs = new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime();
    const nowMs = Date.now();
    const remainingTimeMs = expiresAtMs - nowMs;
    const sixDaysInMs = 6 * 24 * 60 * 60 * 1000;

    if (remainingTimeMs < sixDaysInMs) {
      const nextWeek = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [nextWeek, token]);
    }

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
  requireAdmin
};
