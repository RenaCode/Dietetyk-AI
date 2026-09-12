const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getAppConfig, getUserSetting, generateOAuthState, verifyOAuthState, getVerifiedSessionByToken } = require('../services/oauthHelpers');
const { syncOura, syncWithings, syncGoogleFit } = require('../services/sync');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { encrypt } = require('../utils/encryption');

router.get('/api/auth/oura', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await getVerifiedSessionByToken(token);
    if (!session) {
      return res.status(401).send('Sesja wygasła lub wymaga weryfikacji 2FA.');
    }

    const clientId = await getUserSetting(session.user_id, 'oura_client_id');
    if (!clientId) {
      return res.status(400).send('Integracja z Oura nie jest skonfigurowana. Wpisz Client ID w Ustawieniach.');
    }

    const state = generateOAuthState(session.user_id);
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/oura/callback`;

    const authUrl = `https://cloud.ouraring.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=daily%20heartrate%20personal`;
    res.redirect(authUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

// Trasa OAuth: Callback Oura
router.get('/api/auth/oura/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (!code && !state) {
    return res.status(200).send('Callback URL verification OK');
  }
  if (error) {
    console.error('[OAUTH CALLBACK ERROR]', error);
    return res.redirect('/?tab=setup&error=auth_failed');
  }

  const verified = verifyOAuthState(state);
  if (!verified) {
    return res.status(400).send('Nieprawidłowy parametr state (zabezpieczenie CSRF).');
  }

  const { userId, service } = verified;

  if (service === 'withings') {
    try {
      const clientId = await getUserSetting(userId, 'withings_client_id');
      const clientSecret = await getUserSetting(userId, 'withings_client_secret');
      const appUrl = await getAppConfig('app_url');
      const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
      const redirectUri = `${base}${req.path}`; // dynamiczny matching: /api/auth/oura/callback

      const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          redirect_uri: redirectUri
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Wymiana kodu Withings nieudana: ${errText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
        throw new Error(`Withings API błąd: ${resJson.error || resJson.status}`);
      }

      const data = resJson.body;
      const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

      await db.run(`
        INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
        VALUES (?, 'withings', ?, ?, ?)
        ON CONFLICT(user_id, service) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at
      `, [userId, encrypt(data.access_token), encrypt(data.refresh_token), expiresAt]);

      await syncWithings(userId);
      return res.redirect('/?tab=setup&success=withings');
    } catch (err) {
      console.error('[OAUTH WITHINGS CALLBACK VIA OURA ERROR]', err.message);
      return res.redirect('/?tab=setup&error=withings_exchange_failed');
    }
  }

  try {
    const clientId = await getUserSetting(userId, 'oura_client_id');
    const clientSecret = await getUserSetting(userId, 'oura_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/oura/callback`;

    const response = await fetchWithTimeout('https://api.ouraring.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Wymiana kodu Oura nieudana: ${errText}`);
    }

    const data = await response.json();
      // NOTE: we do not log access_token/refresh_token here, not even partially masked - the
      // first characters of a secret in container logs are still an unnecessary exposure of
      // credentials. For consistency with the Withings and Google Fit callbacks (which never
      // did this) we log only that it succeeded, with no fragment of the token.
    console.log(`[OAUTH OURA CALLBACK SUCCESS] Token wymieniony pomyślnie dla użytkownika ${userId}.`);
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.run(`
      INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, 'oura', ?, ?, ?)
      ON CONFLICT(user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `, [userId, encrypt(data.access_token), encrypt(data.refresh_token), expiresAt]);

    await syncOura(userId);
    res.redirect('/?tab=setup&success=oura');
  } catch (err) {
    console.error('[OAUTH OURA CALLBACK ERROR]', err.message);
    res.redirect('/?tab=setup&error=oura_exchange_failed');
  }
});

// OAuth route: disconnect Oura
router.post('/api/auth/oura/disconnect', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    res.json({ success: true, message: 'Rozłączono z Oura Ring.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rozłączania Oura.' });
  }
});

// Trasy OAuth: Inicjalizacja Withings
router.get('/api/auth/withings', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await getVerifiedSessionByToken(token);
    if (!session) {
      return res.status(401).send('Sesja wygasła lub wymaga weryfikacji 2FA.');
    }

    const clientId = await getUserSetting(session.user_id, 'withings_client_id');
    if (!clientId) {
      return res.status(400).send('Integracja z Withings nie jest skonfigurowana. Wpisz Client ID w Ustawieniach.');
    }

    const state = generateOAuthState(session.user_id, 'withings');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const dbRedirectUri = await getUserSetting(session.user_id, 'withings_redirect_uri');
    const redirectUri = dbRedirectUri || process.env.WITHINGS_REDIRECT_URI || `${base}/api/auth/withings/callback`;

    const authUrl = `https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=user.metrics,user.activity`;
    res.redirect(authUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

// Trasa OAuth: Callback Withings
router.get('/api/auth/withings/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (!code && !state) {
    return res.status(200).send('Callback URL verification OK');
  }
  if (error) {
    console.error('[OAUTH WITHINGS CALLBACK ERROR]', error);
    return res.redirect('/?tab=setup&error=withings_auth_failed');
  }

  const verified = verifyOAuthState(state);
  if (!verified) {
    return res.status(400).send('Nieprawidłowy parametr state (zabezpieczenie CSRF).');
  }
  const { userId } = verified;

  try {
    const clientId = await getUserSetting(userId, 'withings_client_id');
    const clientSecret = await getUserSetting(userId, 'withings_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}${req.path}`;

    const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken',
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Wymiana kodu Withings nieudana: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API błąd: ${resJson.error || resJson.status}`);
    }

    const data = resJson.body;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.run(`
      INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, 'withings', ?, ?, ?)
      ON CONFLICT(user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `, [userId, encrypt(data.access_token), encrypt(data.refresh_token), expiresAt]);

    await syncWithings(userId);
    res.redirect('/?tab=setup&success=withings');
  } catch (err) {
    console.error('[OAUTH WITHINGS CALLBACK ERROR]', err.message);
    res.redirect('/?tab=setup&error=withings_exchange_failed');
  }
});

// OAuth route: disconnect Withings
router.post('/api/auth/withings/disconnect', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);
    res.json({ success: true, message: 'Rozłączono z Withings.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rozłączania Withings.' });
  }
});

// ===== Google Fit (data source: steps, active calories) =====
// Unlike Oura and Withings, Google Fit uses the GLOBAL Google configuration, so it does not
// require the user to supply their own developer credentials.
router.get('/api/auth/google-fit', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('Brak tokenu autoryzacji.');

  try {
    const session = await getVerifiedSessionByToken(token);
    if (!session) {
      return res.status(401).send('Sesja wygasła lub wymaga weryfikacji 2FA.');
    }

    const clientId = await getAppConfig('google_client_id');
    if (!clientId) {
      return res.status(400).send('Integracja z Google Fit nie jest skonfigurowana. Administrator musi wpisać Client ID/Secret w Panelu Admina.');
    }

    const state = generateOAuthState(session.user_id, 'google_fit');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google-fit/callback`;

  // access_type=offline and prompt=consent are required for Google to return a refresh_token
  // (without prompt=consent, subsequent sign-ins with the same account receive no new
  // refresh_token once the user has already granted consent).
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('https://www.googleapis.com/auth/fitness.activity.read')}&state=${state}&access_type=offline&prompt=consent`;
    res.redirect(authUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

router.get('/api/auth/google-fit/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (!code && !state) {
    return res.status(200).send('Callback URL verification OK');
  }
  if (error) {
    console.error('[OAUTH GOOGLE FIT CALLBACK ERROR]', error);
    return res.redirect('/?tab=setup&error=google_fit_auth_failed');
  }

  const verified = verifyOAuthState(state);
  if (!verified || verified.service !== 'google_fit') {
    return res.status(400).send('Nieprawidłowy parametr state (zabezpieczenie CSRF).');
  }
  const { userId } = verified;

  try {
    const clientId = await getAppConfig('google_client_id');
    const clientSecret = await getAppConfig('google_client_secret');
    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const redirectUri = `${base}/api/auth/google-fit/callback`;

    const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
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

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Wymiana kodu Google Fit nieudana: ${errText}`);
    }

    const data = await response.json();
    if (!data.refresh_token) {
        // This can happen if the user previously connected this Google account to any OAuth
        // application and Google does not reissue a refresh_token without forcing the consent
        // screen - prompt=consent above should prevent it, but we leave a clear message in
        // case of exceptions.
      console.warn(`[OAUTH GOOGLE FIT] Brak refresh_token w odpowiedzi dla użytkownika ${userId} - synchronizacja przestanie działać po wygaśnięciu access_token.`);
    }
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.run(`
      INSERT INTO oauth_tokens (user_id, service, access_token, refresh_token, expires_at)
      VALUES (?, 'google_fit', ?, ?, ?)
      ON CONFLICT(user_id, service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, refresh_token),
        expires_at = excluded.expires_at
    `, [userId, encrypt(data.access_token), encrypt(data.refresh_token) || null, expiresAt]);

    await syncGoogleFit(userId);
    res.redirect('/?tab=setup&success=google_fit');
  } catch (err) {
    console.error('[OAUTH GOOGLE FIT CALLBACK ERROR]', err.message);
    res.redirect('/?tab=setup&error=google_fit_exchange_failed');
  }
});

router.post('/api/auth/google-fit/disconnect', requireAuth, async (req, res) => {
  try {
    await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = 'google_fit'`, [req.user.id]);
    res.json({ success: true, message: 'Rozłączono z Google Fit.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd rozłączania Google Fit.' });
  }
});

// Manual sync of Oura, Withings and Google Fit data for the logged-in user
router.post('/api/sync/manual', requireAuth, async (req, res) => {
  const userId = req.user.id;
  let ouraSuccess = false;
  let withingsSuccess = false;
  let googleFitSuccess = false;
  let ouraError = null;
  let withingsError = null;
  let googleFitError = null;

  // Sprawdzamy czy ma tokeny Oura
  const hasOura = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [userId]);
  if (hasOura) {
    try {
      const result = await syncOura(userId);
      ouraSuccess = result.success;
      ouraError = result.success ? null : result.error;
    } catch (err) {
      ouraError = err.message;
    }
  }

  // Sprawdzamy czy ma tokeny Withings
  const hasWithings = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [userId]);
  if (hasWithings) {
    try {
      const result = await syncWithings(userId);
      withingsSuccess = result.success;
      withingsError = result.success ? null : result.error;
    } catch (err) {
      withingsError = err.message;
    }
  }

  // Sprawdzamy czy ma tokeny Google Fit
  const hasGoogleFit = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'google_fit'`, [userId]);
  if (hasGoogleFit) {
    try {
      const result = await syncGoogleFit(userId);
      googleFitSuccess = result.success;
      googleFitError = result.success ? null : result.error;
    } catch (err) {
      googleFitError = err.message;
    }
  }

  res.json({
    success: true,
    oura: hasOura ? { success: ouraSuccess, error: ouraError } : null,
    withings: hasWithings ? { success: withingsSuccess, error: withingsError } : null,
    google_fit: hasGoogleFit ? { success: googleFitSuccess, error: googleFitError } : null,
    message: 'Zakończono proces manualnej synchronizacji.'
  });
});

module.exports = router;
