const crypto = require('crypto');
const db = require('../db');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { encrypt, decrypt } = require('../utils/encryption');

// Secret used to sign (HMAC) the `state` parameter in the OAuth flow. REQUIRED, with no
// fallback to any other variable.
//
// Two earlier versions of this line were wrong in the same way. The first fell back to a fixed
// 'default_secret' literal visible in the source; the second fell back to APP_PASSWORD. The
// second looked safe - APP_PASSWORD is required for the backend to start anyway - but it made a
// single value both the OAuth signing key and the key material for encrypting the database
// (utils/encryption.js), and backend/.env.example shipped a CONCRETE value for it, committed to
// the repository. Anyone who read the repo could therefore sign
// `<victimId>:google_link:<salt>:<hmac>`, complete the Google consent screen on their OWN Google
// account, and routes/auth.js would write that Google account onto the victim's user row - after
// which the ordinary "Sign in with Google" button issues a session for the victim's account.
//
// Hence fail-fast instead of a quiet downgrade: a deployment that silently signs state with a
// weaker (or publicly known) secret looks perfectly healthy while its CSRF protection is
// forgeable, and nothing in the logs would ever say so. Refusing to start is the louder, safer
// failure.
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET;
if (!OAUTH_STATE_SECRET) {
  throw new Error(
    'OAUTH_STATE_SECRET is missing from the environment. It signs the `state` parameter of the ' +
    'OAuth flow (Oura/Withings/Google) and must be a dedicated random value - NOT APP_PASSWORD ' +
    'and not any other secret reused elsewhere. Generate one with `openssl rand -hex 32` and add ' +
    'OAUTH_STATE_SECRET=<value> to backend/.env (see backend/docs/secret-rotation.md).'
  );
}

// Helper for reading configuration from the app_config table. decrypt() is safe to call for
// EVERY key, not only the secret ones in APP_SECRET_CONFIG_KEYS - for values never encrypted
// by encrypt() (see utils/encryption.js) it is
// no-opem, bo brakuje im rozpoznawalnego prefiksu.
async function getAppConfig(key) {
  if (key === 'app_url' && process.env.APP_URL) {
    return process.env.APP_URL;
  }
  const row = await db.get(`SELECT value FROM app_config WHERE key = ?`, [key]);
  return row ? decrypt(row.value) : null;
}

// Helper for reading a specific user's settings - decrypt() as above, safe for non-secret
// values (a no-op without the enc:v1: prefix).
async function getUserSetting(userId, key) {
  const row = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = ?`, [userId, key]);
  return row ? decrypt(row.value) : null;
}

// Session token verification for the OAuth routes that INITIATE a connection
// (Oura/Withings/Google Fit/Google link) and receive the token through ?token= in the query
// string, because they are reached by a top-level navigation rather than a fetch with an
// Authorization header (see the comment in middleware/auth.js). Those routes are on
// requireAuth's exception list, so they are responsible for full verification themselves -
// and they used to check ONLY that the session token was valid, without checking whether a
// user with 2FA enabled had actually completed the code verification (a temporary session
// with is_verified_2fa=0 and a short TTL could in theory initiate linking an external
// account). This function replicates exactly the same checks requireAuth applies to routes
// behind the Authorization header, so both paths offer the same level of security.
async function getVerifiedSessionByToken(token) {
  if (!token) return null;
  const session = await db.get(`
    SELECT s.user_id, s.expires_at, s.is_verified_2fa, s.is_temp, u.totp_enabled
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `, [token]);

  if (!session) return null;
  if (new Date(session.expires_at.replace(' ', 'T') + 'Z') < new Date()) return null;
  // A temporary verification session (5-minute 2FA setup / 2FA login / forced password
  // change) may never link an external account. The totp_enabled check below does not
  // cover it: a user being forced INTO 2FA setup still has totp_enabled = 0, which is
  // precisely the gap that let a temporary token pass for a full one - see the longer
  // note in middleware/auth.js.
  if (session.is_temp === 1) return null;
  if (session.totp_enabled === 1 && session.is_verified_2fa === 0) return null;

  return session;
}

// Bezpieczne generowanie i weryfikacja stanu OAuth (stateless)
function generateOAuthState(userId, service = 'oura') {
// crypto.randomBytes (a CSPRNG) rather than Math.random() (a non-cryptographic PRNG,
// predictable if the generator state is known). The HMAC alone still prevents forging state
// without knowing OAUTH_STATE_SECRET, but the salt/nonce in an anti-CSRF flow should be
// generated by a cryptographically secure generator.
  const salt = crypto.randomBytes(16).toString('hex');
  const data = `${userId}:${service}:${salt}`;
  const hmac = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(data).digest('hex');
  return `${userId}:${service}:${salt}:${hmac}`;
}

function verifyOAuthState(state) {
  if (!state) return null;
  // The format is userId:service:salt:hmac - but `service` may itself contain colons, so the
  // field count is NOT fixed and the parts must be read from both ends, never by position
  // from the left alone.
  //
  // This is the bug that made "Sign in with Google" impossible to complete. routes/auth.js
  // binds the sign-in state to the client by passing `google_login:<sha256 fingerprint>` as
  // the service, which makes the state FIVE colon-separated fields instead of four. The old
  // `if (parts.length === 4)` check simply fell through for every one of them, so
  // verifyOAuthState returned null on every legitimate callback and the flow ended at
  // `/?google_error=csrf_failed` - a CSRF rejection of the application's own state. The
  // account-linking flow (service 'google_link', no colon) kept working, which is why this
  // looked like "Google sign-in is broken" rather than "state verification is broken".
  //
  // Reading userId from the front and salt/hmac from the back keeps every state that
  // generateOAuthState can produce verifiable, whatever the service string contains, and
  // stays compatible with the four-field states already in flight.
  const parts = state.split(':');
  if (parts.length >= 4) {
    const userId = parts[0];
    const service = parts.slice(1, -2).join(':');
    const salt = parts[parts.length - 2];
    const hmac = parts[parts.length - 1];
    const expectedHmac = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(`${userId}:${service}:${salt}`).digest('hex');
  // Bug fix: comparing HMACs with `===` compares the strings byte by byte and stops at the
  // first difference, which in theory leaks through response timing how many leading
  // characters match the expected HMAC (a timing attack) - the same class of risk the rest of
  // this file deliberately guards against (see the CSPRNG comment in generateOAuthState).
  // crypto.timingSafeEqual compares in constant time; it requires buffers of equal length, so
  // we compare the length first (the length of a SHA-256 HMAC in hex is fixed and not a
  // secret).
    const hmacBuf = Buffer.from(hmac, 'utf8');
    const expectedBuf = Buffer.from(expectedHmac, 'utf8');
    const hmacValid = hmacBuf.length === expectedBuf.length && crypto.timingSafeEqual(hmacBuf, expectedBuf);
    if (hmacValid) {
      return { userId: parseInt(userId, 10), service };
    }
  }
  return null;
}

// Fetching and refreshing an OAuth token
async function getOrRefreshToken(userId, service) {
  const token = await db.get(`SELECT * FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
  if (!token) return null;
  // Decrypt immediately after reading - the rest of the function below treats
  // token.access_token/refresh_token as if they had always been plaintext.
  token.access_token = decrypt(token.access_token);
  token.refresh_token = decrypt(token.refresh_token);

  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // If the token is valid for more than 5 minutes, return it as is
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  console.log(`[OAUTH] Refreshing token for user ${userId}, service: ${service}...`);
  let isPermanentFailure = false;

  try {
    if (service === 'oura') {
      const clientId = await getUserSetting(userId, 'oura_client_id');
      const clientSecret = await getUserSetting(userId, 'oura_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Oura.');
      }

      const response = await fetchWithTimeout('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Oura (Status ${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'oura'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'withings') {
      const clientId = await getUserSetting(userId, 'withings_client_id');
      const clientSecret = await getUserSetting(userId, 'withings_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Withings.');
      }

      const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Withings (Status ${response.status}): ${errorText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
      // Withings error statuses: 100 (invalid token), 200 (invalid client) and so on.
      // Transient errors (503 or 601) are excluded - for those we do not delete the token.
        if (resJson.status === 100 || resJson.status === 200 || resJson.status === 501) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd Withings API: ${resJson.error || 'Status ' + resJson.status}`);
      }

      const data = resJson.body;
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'withings'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'google_fit') {
      const clientId = await getAppConfig('google_client_id');
      const clientSecret = await getAppConfig('google_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Google (konfiguracja globalna).');
      }

      const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Google Fit (Status ${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'google_fit'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    }
  } catch (err) {
    console.error(`[OAUTH ERROR] Failed to refresh the token for ${service} (user ${userId}):`, err.message);
    if (isPermanentFailure) {
      console.warn(`[OAUTH] Deleting the invalid token from the database for ${service} (user ${userId}) because the authorisation is permanently invalid.`);
      await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
    } else {
      console.log(`[OAUTH] Keeping the token for ${service} (user ${userId}) in the database - the error looks transient.`);
    }
    return null;
  }
  return null;
}

module.exports = {
  getAppConfig,
  getUserSetting,
  generateOAuthState,
  verifyOAuthState,
  getOrRefreshToken,
  getVerifiedSessionByToken
};
