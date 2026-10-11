const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const { sendMailgunEmail } = require('../services/mailgun');
const { getAppConfig } = require('../services/oauthHelpers');
const { APP_SECRET_CONFIG_KEYS, maskSecretValue, isMaskedSecretWrite } = require('../utils/secretKeys');
const { encrypt } = require('../utils/encryption');
const { confirmCurrentPassword } = require('../services/passwordConfirmation');
const logger = require('../services/logger');

// Every administrative action that changes accounts or the app's configuration needs the
// admin's own LOCAL password in the request (`currentPassword`), on top of the session (audit
// D-4, renacode-infra docs/sso-tozsamosc.md section 4). Before this the session alone was
// enough: an unlocked laptop, a stolen session token or - with single sign-on on - a borrowed
// Authelia cookie (it lives up to 12 hours, 7 days with "remember me") could reset a household
// member's 2FA, force a password change on them, delete their account with every health record
// it holds, invite a second admin, or switch public registration on. None of that asked for
// anything the attacker would not already have.
//
// An SSO session does NOT replace the password, for the same reason as in
// services/passwordConfirmation.js: Authelia's header proves a cookie, not a fresh login.
//
// The check is the one routes/account.js uses (confirmCurrentPassword), so it shares that
// file's per-account attempt budget: wrong guesses here and on the account's own password
// prompts count towards the same lockout, and an account without a known password
// (password_set = 0) gets the 409 without anything being counted. The status for a missing or
// wrong password is 403, never 401 - the panel logs out on any 401.
//
// Mounted AFTER requireAdmin, so a non-admin is refused before any password is compared or
// counted: a user's session cannot burn the attempts of their own account through these routes.
//
// tests/test-admin-password.js walks this router's stack and fails for any POST/PUT/PATCH/
// DELETE route without this middleware - a new admin action cannot quietly skip it. It walks
// the whole app too, so a requireAdmin action added to another routes/*.js is caught as well.
function requireAdminPassword(action) {
  const middleware = async (req, res, next) => {
    try {
      const password = req.body && req.body.currentPassword;
      const confirmed = await confirmCurrentPassword(req, res, password, `admin:${action}`, {
        status: 403,
        missingMessage: 'Potwierdź tę akcję swoim hasłem administratora.'
      });
      if (confirmed) next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Błąd weryfikacji hasła.' });
    }
  };
  // Read by the route-list test, see above.
  middleware.adminPasswordAction = action;
  return middleware;
}

// One app_logs row per performed admin action, so the weekly security report shows who did
// what to which account. Ids and key NAMES only: no e-mail addresses, no configuration values
// (some are secrets), no passwords.
function auditAdminAction(req, action, details = {}) {
  const target = details.targetUserId ? ` on UID ${details.targetUserId}` : '';
  return logger.security(
    `Admin action: ${action}${target} (admin UID: ${req.user.id})`,
    'ADMIN_ACTION',
    { action, adminUserId: req.user.id, ...details },
    req.ip,
    req.user.id
  );
}

// Google Fit keys - global to the whole application (unlike Oura/Withings, where each user
// brings their own developer app), so they are configured once here. The OAuth client used to
// be shared with Google sign-in, which was removed on 2026-10-11; it now serves Google Fit
// alone. google_fit_enabled is the switch for the whole integration ('1' on, anything else or
// missing = off - see isGoogleFitEnabled in services/oauthHelpers.js).
const GOOGLE_CONFIG_KEYS = ['google_client_id', 'google_client_secret', 'google_fit_enabled'];

router.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM app_config`);
    const config = {};
    rows.forEach(r => {
      if (r.key.startsWith('mailgun_') || r.key === 'app_url' || r.key === 'force_2fa' || r.key === 'allow_public_registration' || GOOGLE_CONFIG_KEYS.includes(r.key)) {
        config[r.key] = maskSecretValue(r.key, r.value, APP_SECRET_CONFIG_KEYS);
      }
    });
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania konfiguracji.' });
  }
});

router.post('/api/admin/config', requireAdmin, requireAdminPassword('config'), async (req, res) => {
  // The password travels in the same body as the settings; it is not a setting.
  const settings = { ...req.body };
  delete settings.currentPassword;
  const savedKeys = [];
  try {
    for (const [key, val] of Object.entries(settings)) {
      if (isMaskedSecretWrite(key, val, APP_SECRET_CONFIG_KEYS)) {
        continue;
      }
      if (!key.startsWith('mailgun_') && key !== 'app_url' && key !== 'force_2fa' && key !== 'allow_public_registration' && !GOOGLE_CONFIG_KEYS.includes(key)) {
        continue;
      }
      // Sekrety (mailgun_api_key, google_client_secret) trzymamy w bazie zaszyfrowane
      // (see utils/encryption.js) - encrypt() is a no-op for the remaining keys.
      const storedValue = APP_SECRET_CONFIG_KEYS.includes(key) ? encrypt(String(val)) : String(val);
      await db.run(`
        INSERT INTO app_config (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [key, storedValue]);
      savedKeys.push(key);
    }
    await auditAdminAction(req, 'config', { keys: savedKeys });
    res.json({ success: true, message: 'Konfiguracja została zapisana pomyślnie!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu konfiguracji.' });
  }
});

// 6h. User management (admin)
router.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    // B-N3: pagination - max limit 200, 100 by default
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const rows = await db.all(`
      SELECT id, username, email, role, status, totp_enabled, force_password_change, force_2fa
      FROM users
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania listy użytkowników.' });
  }
});

router.delete('/api/admin/users/:id', requireAdmin, requireAdminPassword('delete-user'), async (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'Nie możesz usunąć własnego konta administratora.' });
  }

  try {
    // NOTE: we check result.changes - without it, deleting a non-existent or already deleted
    // id returned "success: true" (a DELETE affecting zero rows is not an SQL error), so the
    // admin panel wrongly confirmed a deletion that never happened.
    const result = await db.run(`DELETE FROM users WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await auditAdminAction(req, 'delete-user', { targetUserId: Number(id) });
    res.json({ success: true, message: 'Użytkownik został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania użytkownika.' });
  }
});

router.post('/api/admin/users/:id/reset-2fa', requireAdmin, requireAdminPassword('reset-2fa'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, force_2fa = 0 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    await auditAdminAction(req, 'reset-2fa', { targetUserId: Number(id) });
    res.json({ success: true, message: 'Zabezpieczenie 2FA zostało zresetowane i cofnięto wymuszenie.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd resetowania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-2fa', requireAdmin, requireAdminPassword('force-2fa'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET force_2fa = 1 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    await auditAdminAction(req, 'force-2fa', { targetUserId: Number(id) });
    res.json({ success: true, message: 'Wymuszono 2FA dla użytkownika przy kolejnym logowaniu.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-password-change', requireAdmin, requireAdminPassword('force-password-change'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET force_password_change = 1 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    await auditAdminAction(req, 'force-password-change', { targetUserId: Number(id) });
    res.json({ success: true, message: 'Wymuszono zmianę hasła na użytkowniku.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania zmiany hasła.' });
  }
});

// How long an invitation link stays usable. A week covers "I will do it at the weekend"
// without leaving a link that creates an account - possibly an admin one - working for ever
// in somebody's mailbox. An expired invitation is answered like an unknown one; the admin
// simply sends a new one.
const INVITATION_TTL_DAYS = 7;

router.post('/api/admin/invite', requireAdmin, requireAdminPassword('invite'), async (req, res) => {
  const { email, role, confirm_admin } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Adres e-mail jest wymagany.' });
  }

    // Explicitly require an extra confirmation (confirm_admin: true) for the admin role, so
    // an admin account cannot be created by a UI slip (a select defaulting to admin) or by a
    // faulty integration sending the request automatically. Kept next to the password
    // (requireAdminPassword above): the password proves WHO asks, this flag that they meant
    // the admin role - the panel sends it only from a dialog that names the role.
  if (role === 'admin' && confirm_admin !== true) {
    return res.status(400).json({ error: 'Tworzenie konta z rolą administratora wymaga potwierdzenia (confirm_admin: true).' });
  }

  const roleToUse = role === 'admin' ? 'admin' : 'user';

  try {
    const existing = await db.get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) {
      return res.status(400).json({ error: 'Użytkownik o tym adresie e-mail już istnieje.' });
    }

    // invitation_token is the only thing standing between an invitation email and account
    // creation - potentially with the admin role - so it must be unpredictable.
    const token = 'inv_' + crypto.randomBytes(24).toString('hex');
    const tempUsername = 'pending_' + crypto.randomBytes(6).toString('hex');
    const dummyPassword = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const syncToken = 'sync_' + crypto.randomBytes(24).toString('hex');

    const inserted = await db.run(`
      INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, invitation_token, invitation_expires_at)
      VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, datetime('now', ?))
    `, [tempUsername, dummyPassword, syncToken, email, roleToUse, token, `+${INVITATION_TTL_DAYS} days`]);
    // Logged once the account row exists, before the mail goes out: a Mailgun failure below
    // still leaves a pending account (with the role) that the log must account for.
    await auditAdminAction(req, 'invite', { targetUserId: inserted.id, role: roleToUse });

    // Round 12 (security audit): origin used to be taken from req.headers.referer/origin/host
    // - ALL fully controlled by the client. That allowed forging a registration link, carrying
    // a real working invitation token, pointing at any attacker domain, emailed in the
    // application's name. Now: the app_url configured by an administrator (as in
    // integrations.js and auth.js), falling back to req.get('host') only when app_url is unset.
    const appUrl = await getAppConfig('app_url');
    const origin = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const registrationLink = `${origin}/register?token=${token}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.05);">
        <h2 style="color: #38bdf8; text-align: center;">Zaproszenie do Dietetyk AI</h2>
        <p>Witaj,</p>
        <p>Zostałeś zaproszony do utworzenia konta w aplikacji <strong>Dietetyk AI</strong>.</p>
        <p>Kliknij poniższy przycisk, aby dokończyć rejestrację, wybrać swoją nazwę użytkownika, hasło i skonfigurować weryfikację 2FA:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${registrationLink}" style="background-color: #38bdf8; color: #0f172a; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 1rem;">Dokończ Rejestrację</a>
        </div>
        <p style="font-size: 0.85rem; color: #64748b; text-align: center;">
          Jeśli przycisk nie działa, skopiuj i wklej ten odnośnik w przeglądarce:<br/>
          <a href="${registrationLink}" style="color: #38bdf8;">${registrationLink}</a>
        </p>
      </div>
    `;

    console.log(`[MAILGUN] Wysyłanie zaproszenia do ${email}...`);
    await sendMailgunEmail({
      to: email,
      subject: 'Dietetyk AI - Zaproszenie do rejestracji',
      html: emailHtml
    });

    res.json({ success: true, message: 'Zaproszenie zostało wysłane pomyślnie.' });
  } catch (err) {
    console.error(err);
    // err.message is not returned: from Mailgun it carries the raw API response (see
    // sendSummaryErrorResponse in routes/account.js); the detail stays in the log above.
    res.status(500).json({ error: err && err.expose ? `Błąd zapraszania użytkownika: ${err.message}` : 'Błąd zapraszania użytkownika.' });
  }
});

module.exports = router;
