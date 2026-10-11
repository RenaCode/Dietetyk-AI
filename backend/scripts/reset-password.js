#!/usr/bin/env node

// Issues a one-time password for an account and forces a password change at its next login.
//
// Why this exists: "Sign in with Google" was removed on 2026-10-11, and with it the only way
// an account created through Google (users.password_set = 0, a random hash nobody knows) could
// get a password - set one after re-authenticating with Google. The application deliberately
// has no in-app replacement: setting a password on the strength of a session alone is exactly
// what a stolen session must not be able to do. This script needs a shell in the backend
// container, i.e. access that already reaches the whole database, so it adds no new way in.
//
// What happens next is the ordinary forced-change path, nothing special-cased here: the user
// logs in with the printed password, a second factor is asked for first if the account has
// one (completeLogin in routes/auth.js), and POST /api/change-password-forced sets their own
// password, sets password_set = 1 and runs the full cleanup (sessions, share links, a
// redirected e-mail, the Apple Health sync token - services/accountCleanup.js).
//
// Every session of the account is revoked right away, not only at that change: an
// administrator reaching for this script may well be doing so because the account is in the
// wrong hands.
//
// The password is printed once and never stored or logged anywhere else.
//
// Usage (in production, INSIDE the backend container so DATABASE_DIR is right):
//   node scripts/reset-password.js <username or e-mail>

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

// A letter in front and a digit at the end, so the one-time password satisfies the same
// letter+digit rule as every other password even in the (astronomically unlikely) case that
// the hex part is all digits or all letters.
function generateOneTimePassword() {
  return 'R' + crypto.randomBytes(12).toString('hex') + '7';
}

async function run() {
  const login = process.argv[2];
  if (!login) {
    console.error('Usage: node scripts/reset-password.js <username or e-mail>');
    process.exit(2);
  }

  await db.initDb();
  const user = await db.get(`SELECT id, username, status, totp_enabled FROM users WHERE username = ? OR email = ?`, [login, login]);
  if (!user) {
    console.error(`No account with username or e-mail "${login}".`);
    process.exit(1);
  }

  const oneTimePassword = generateOneTimePassword();
  const hash = await bcrypt.hash(oneTimePassword, 10);
  await db.run(`UPDATE users SET password_hash = ?, force_password_change = 1 WHERE id = ?`, [hash, user.id]);
  const revoked = await db.run(`DELETE FROM sessions WHERE user_id = ?`, [user.id]);
  // Written directly rather than through services/logger.js, whose insert is fire-and-forget:
  // process.exit() below could end the process before it lands, and this row is the only
  // trace in the weekly security report that a password was reset outside the application.
  await db.run(
    `INSERT INTO app_logs (level, category, message, user_id, details) VALUES ('SECURITY', 'AUTH_PASSWORD_RESET', ?, ?, ?)`,
    [
      `One-time password issued from the command line, password change forced, ${revoked.changes} session(s) revoked (UID: ${user.id})`,
      user.id,
      JSON.stringify({ userId: user.id, revokedSessions: revoked.changes, via: 'scripts/reset-password.js' })
    ]
  );

  console.log(`Account: ${user.username} (id ${user.id})`);
  console.log(`One-time password: ${oneTimePassword}`);
  console.log(`Revoked sessions: ${revoked.changes}`);
  console.log('At the next login the user has to set their own password.');
  if (user.totp_enabled === 1) {
    console.log('The account has 2FA: the login still asks for the code first. Reset 2FA in the Admin Panel only if the authenticator is lost.');
  }
  if (user.status !== 'active') {
    console.log(`WARNING: the account status is "${user.status}", and only active accounts can log in.`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Resetting the password failed:', err);
  process.exit(1);
});
