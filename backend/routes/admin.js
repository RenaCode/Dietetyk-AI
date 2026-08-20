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

// Google sign-in keys - global to the whole application (unlike Oura/Withings): Google
// sign-in authenticates access to the app itself, so it is configured once
const GOOGLE_CONFIG_KEYS = ['google_client_id', 'google_client_secret'];

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

router.post('/api/admin/config', requireAdmin, async (req, res) => {
  const settings = req.body;
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
    }
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

router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
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
    res.json({ success: true, message: 'Użytkownik został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania użytkownika.' });
  }
});

router.post('/api/admin/users/:id/reset-2fa', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, force_2fa = 0 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Zabezpieczenie 2FA zostało zresetowane i cofnięto wymuszenie.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd resetowania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-2fa', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET force_2fa = 1 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Wymuszono 2FA dla użytkownika przy kolejnym logowaniu.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania 2FA.' });
  }
});

router.post('/api/admin/users/:id/force-password-change', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`UPDATE users SET force_password_change = 1 WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    res.json({ success: true, message: 'Wymuszono zmianę hasła na użytkowniku.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wymuszania zmiany hasła.' });
  }
});

router.post('/api/admin/invite', requireAdmin, async (req, res) => {
  const { email, role, confirm_admin } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Adres e-mail jest wymagany.' });
  }

    // Explicitly require an extra confirmation (confirm_admin: true) for the admin role, so
    // an admin account cannot be created by a UI slip (a select defaulting to admin) or by a
    // faulty integration sending the request automatically.
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

    await db.run(`
      INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, invitation_token)
      VALUES (?, ?, ?, 0, ?, ?, 'pending', ?)
    `, [tempUsername, dummyPassword, syncToken, email, roleToUse, token]);

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
    res.status(500).json({ error: 'Błąd zapraszania użytkownika: ' + err.message });
  }
});

module.exports = router;
