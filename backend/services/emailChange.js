const crypto = require('crypto');
const db = require('../db');
const logger = require('./logger');
const { sendMailgunEmail } = require('./mailgun');
const { escapeHtml } = require('../utils/html');

const sessionFingerprint = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// How long an e-mail change stays undoable by revoking the session that made it. Equal to
// the absolute session lifetime (ABSOLUTE_SESSION_TTL_DAYS in routes/auth.js): after that the
// session that made the change has expired on its own, and "the session being thrown out"
// no longer identifies anything.
const EMAIL_CHANGE_REVERT_DAYS = 30;

// The other half of B-W2 (audit 2026-10-09). A stolen session used to be able to point
// users.email - where the daily, weekly and monthly summaries full of health data are sent -
// at the attacker's mailbox, switch the summaries on, and keep receiving them after the owner
// changed the password and logged out every other device: those revoked the session, not
// what the session had done. Changing the address now needs the password, but an attacker
// who had both, and anything changed before this fix, still needs undoing - so when the
// session that made the latest change is among the ones being revoked, the previous address
// comes back. The owner's own change from the session they are standing in is left alone.
// Returns the restored address, or null when there was nothing to undo.
async function revertEmailChangedByRevokedSession(userId, keptSessionToken) {
  const row = await db.get(
    `SELECT email, previous_email, email_changed_at, email_changed_by_session FROM users WHERE id = ?`,
    [userId]
  );
  if (!row || !row.email_changed_by_session || !row.email_changed_at) return null;
  if (keptSessionToken && row.email_changed_by_session === sessionFingerprint(keptSessionToken)) return null;
  const changedAtMs = new Date(row.email_changed_at.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(changedAtMs) || Date.now() - changedAtMs > EMAIL_CHANGE_REVERT_DAYS * 24 * 60 * 60 * 1000) return null;

  // The previous address may have been taken by another account in the meantime (the
  // partial UNIQUE index on users.email would refuse the write); clearing the field is the
  // safe fallback - summaries then stop instead of going to the address being undone.
  const restored = row.previous_email || null;
  const taken = restored
    ? await db.get(`SELECT id FROM users WHERE email = ? AND id != ?`, [restored, userId])
    : null;
  await db.run(
    `UPDATE users SET email = ?, previous_email = NULL, email_changed_at = NULL, email_changed_by_session = NULL WHERE id = ?`,
    [taken ? null : restored, userId]
  );
  logger.security(
    `E-mail change made from a revoked session was undone (UID: ${userId})`,
    'AUTH_EMAIL_REVERT',
    { userId, restored: !taken && !!restored },
    null,
    userId
  );
  return { restoredEmail: taken ? null : restored };
}

function emailRevertMessage(revert) {
  return revert.restoredEmail
    ? `adres e-mail zmieniony z wylogowanego urządzenia został przywrócony na ${revert.restoredEmail}`
    : 'adres e-mail zmieniony z wylogowanego urządzenia został usunięty - ustaw go ponownie w profilu';
}

// Tells the OLD address that the account's address changed - the one channel the owner still
// reads when the change was not theirs. Best effort: Mailgun may not be configured on this
// instance (services/mailgun.js throws then), and failing the profile save because a
// courtesy e-mail could not go out would be the wrong trade.
async function notifyEmailChanged(oldEmail, newEmail, username) {
  if (!oldEmail) return;
  try {
    await sendMailgunEmail({
      to: oldEmail,
      subject: 'Dietetyk AI: zmieniono adres e-mail konta',
      html: `<p>Adres e-mail konta <strong>${escapeHtml(username)}</strong> w Dietetyk AI został zmieniony na <strong>${escapeHtml(newEmail || '(brak)')}</strong>.</p>`
        + '<p>Jeśli to nie Ty: zaloguj się, zmień hasło i użyj „Wyloguj pozostałe urządzenia” w Ustawieniach - poprzedni adres zostanie przywrócony. '
        + 'Jeśli nie możesz się zalogować, skontaktuj się z administratorem.</p>'
    });
  } catch (err) {
    console.error('[PROFILE] Failed to notify the previous address about an e-mail change:', err.message);
  }
}

module.exports = {
  sessionFingerprint,
  revertEmailChangedByRevokedSession,
  emailRevertMessage,
  notifyEmailChanged,
  EMAIL_CHANGE_REVERT_DAYS
};
