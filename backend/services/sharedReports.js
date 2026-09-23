const crypto = require('crypto');
const db = require('../db');
const { PDF_REPORT_MAX_DAYS, PDF_REPORT_DEFAULT_DAYS } = require('./pdfReport');

// Sharing a PDF report by link (read-only, no account required) - extends the PDF export
// for a doctor or dietician (services/pdfReport.js) with a "send a link" variant instead
// of "download the file and send it yourself". The token in the URL identifies both the
// user and the specific share, with no session or cookie, because the recipient has no
// account in the app and should not need one.
//
// Uses only the existing PDF generation path (buildHealthReportPdf) - no new data
// sources.

// Link validity options - short by default (a link should live about as long as a single
// appointment or consultation needs), with a longer option for cases such as sending a
// link ahead of a visit scheduled a few weeks out.
const VALIDITY_OPTIONS_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30
};
const DEFAULT_VALIDITY_KEY = '7d';

// How many links a single user may have live at once. Nothing bounded this before: each
// POST /api/user/shared-reports inserted a row, and every one of those rows is an
// unauthenticated URL that renders the full health report (up to 180 days of meals, weight,
// sleep and body composition) for anyone holding it - so an account whose session token
// leaked could quietly mint thousands of permanent-looking read handles to the victim's
// medical data, which survive both a password change and a log-out. A person sharing a
// report with a doctor, a dietician and a physiotherapist needs a handful; 20 is far above
// any real use and still a number, which is the point.
const MAX_ACTIVE_SHARES_PER_USER = 20;

function resolveValidityHours(validityKey) {
  return VALIDITY_OPTIONS_HOURS[validityKey] || VALIDITY_OPTIONS_HOURS[DEFAULT_VALIDITY_KEY];
}

// Creates a new link sharing a user's PDF report. `days` is the data period covered by
// the report itself (as in buildHealthReportPdf) - independent of `validityKey`, which
// controls how long the LINK stays usable.
async function createShareLink(userId, requestedDays, validityKey) {
  const days = Math.min(Math.max(parseInt(requestedDays, 10) || PDF_REPORT_DEFAULT_DAYS, 1), PDF_REPORT_MAX_DAYS);
  const validityHours = resolveValidityHours(validityKey);

  // Counted over links that still work (not revoked, not expired), so the limit never turns
  // into "you have shared 20 reports in your life and may never share another".
  const active = await db.get(
    `SELECT COUNT(*) AS count FROM shared_reports
     WHERE user_id = ? AND revoked = 0 AND expires_at > ?`,
    [userId, new Date().toISOString()]
  );
  if (active && active.count >= MAX_ACTIVE_SHARES_PER_USER) {
    const err = new Error(`Active share limit reached (${MAX_ACTIVE_SHARES_PER_USER}) for user ${userId}`);
    err.code = 'SHARE_LIMIT_REACHED';
    throw err;
  }

  const token = 'share_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + validityHours * 60 * 60 * 1000).toISOString();

  await db.run(
    `INSERT INTO shared_reports (user_id, token, days, expires_at) VALUES (?, ?, ?, ?)`,
    [userId, token, days, expiresAt]
  );

  return { token, days, expiresAt };
}

// A user's shares, for display in Settings - both active and expired/revoked, so the
// user sees the history rather than only what currently works. The frontend decides how
// to present it; the status is computed here so the "has it expired" logic is not
// duplicated in two places.
async function listSharesForUser(userId) {
  const rows = await db.all(
    `SELECT id, token, days, created_at, expires_at, revoked
     FROM shared_reports WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  const nowIso = new Date().toISOString();
  return rows.map((r) => ({
    id: r.id,
    days: r.days,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revoked: !!r.revoked,
    // Status for display - we deliberately do not return the token again (it is shown to
    // the user exactly once, when the link is created; see routes/account.js), so that
    // the share list cannot become a second place to recover a working link without the
    // owner realising.
    status: r.revoked ? 'revoked' : (r.expires_at < nowIso ? 'expired' : 'active')
  }));
}

// Revoking a link - only the owner can revoke their own link, enforced by including
// user_id in the WHERE clause rather than matching on id alone. Returns true when a row
// was actually changed.
async function revokeShare(userId, shareId) {
  const result = await db.run(
    `UPDATE shared_reports SET revoked = 1 WHERE id = ? AND user_id = ?`,
    [shareId, userId]
  );
  return result.changes > 0;
}

// Revokes every still-usable link of one user, and reports how many it actually hit.
//
// Called when the account's password changes. A share link is an unauthenticated URL that
// renders the owner's full health report for up to 30 days, and it is tied to no session at
// all - so revoking sessions on a password change, without this, would leave an attacker who
// had time to press "share" holding a working read handle to the victim's medical data long
// after they were locked out of the account. The cost is real and was weighed: a link the
// user had honestly sent to their doctor stops working and has to be re-sent. That trade is
// taken deliberately - a password change is the action a user performs when they believe
// they have been compromised, and "everything that was handed out under the old password
// stops working" is the only behaviour that makes it a meaningful defence. The user sees
// the revoked links in Settings (listSharesForUser returns the history with a status), so
// this is visible, not silent.
async function revokeAllSharesForUser(userId) {
  const result = await db.run(
    `UPDATE shared_reports SET revoked = 1
     WHERE user_id = ? AND revoked = 0 AND expires_at > ?`,
    [userId, new Date().toISOString()]
  );
  return result.changes;
}

// Validates a token from the public endpoint (routes/sharedReport.js) - returns
// what is needed to generate the PDF (userId, days), or null when the token does not
// exist, was revoked, or expired. The HTTP response does not distinguish those three
// cases (see routes/sharedReport.js) - to anyone guessing tokens, "not found" and
// "expired" must look identical.
async function getActiveShareByToken(token) {
  const row = await db.get(
    `SELECT user_id, days, expires_at, revoked FROM shared_reports WHERE token = ?`,
    [token]
  );
  if (!row || row.revoked) return null;
  if (row.expires_at < new Date().toISOString()) return null;
  return { userId: row.user_id, days: row.days };
}

module.exports = {
  createShareLink,
  listSharesForUser,
  revokeShare,
  revokeAllSharesForUser,
  getActiveShareByToken,
  VALIDITY_OPTIONS_HOURS,
  DEFAULT_VALIDITY_KEY,
  MAX_ACTIVE_SHARES_PER_USER
};
