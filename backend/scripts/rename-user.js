#!/usr/bin/env node

// Renames an account's username (its login for the app's own password form).
//
// Why this exists: with single sign-on the username no longer has to match anything - SSO
// maps by e-mail (services/ssoIdentity.js) - but the break-glass password login still uses
// it, and usernames chosen over the years ("admin" on the owner's everyday account, mixed
// case on others) are worth tidying once SSO is in place. There is no endpoint for it on
// purpose: renaming changes what a person types to log in, which is an administrator's
// decision, taken with a shell in the backend container.
//
// Safe by default: without --apply it only says what it WOULD do. With --apply the write is a
// single UPDATE that re-checks uniqueness itself (case-insensitively - `Admin` and `admin`
// would be two different logins to SQLite but one to a person), so a name taken between the
// check and the write is refused rather than duplicated.
//
// What does not change: the account id, its data, sessions, 2FA (an authenticator app keeps
// showing the old name as its label - cosmetic), and the SSO mapping, which is the e-mail.
//
// Account id 1 keeps a new name across restarts as long as SOME active admin exists - the
// admin guarantee in db.js renames it back to "admin" (when that name is free) only when it
// has to promote id 1 because no active admin is left.
//
// Usage (in production, INSIDE the backend container so DATABASE_DIR is right):
//   node scripts/rename-user.js <current username> <new username>           # dry run
//   node scripts/rename-user.js <current username> <new username> --apply   # write

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../db');
const { isValidUsername, USERNAME_RULE_MESSAGE } = require('../utils/username');

async function run() {
  const [from, to] = process.argv.slice(2).filter(a => a !== '--apply');
  const apply = process.argv.includes('--apply');
  if (!from || !to) {
    console.error('Usage: node scripts/rename-user.js <current username> <new username> [--apply]');
    process.exit(2);
  }
  if (!isValidUsername(to)) {
    console.error(`Invalid new username "${to}": ${USERNAME_RULE_MESSAGE}`);
    process.exit(2);
  }

  await db.initDb();
  const user = await db.get(`SELECT id, username, role, status FROM users WHERE username = ?`, [from]);
  if (!user) {
    console.error(`No account with username "${from}" (exact match).`);
    process.exit(1);
  }
  if (user.username === to) {
    console.log(`Account id ${user.id} is already called "${to}" - nothing to do.`);
    return;
  }
  const taken = await db.get(`SELECT id, username FROM users WHERE lower(username) = lower(?) AND id != ?`, [to, user.id]);
  if (taken) {
    console.error(`"${to}" is taken (case-insensitively) by account id ${taken.id} ("${taken.username}"). Nothing changed.`);
    process.exit(1);
  }

  console.log(`Account id ${user.id} (role ${user.role}, status ${user.status}): "${user.username}" -> "${to}"`);
  if (!apply) {
    console.log('Dry run - nothing written. Add --apply to rename.');
    return;
  }

  const result = await db.run(
    `UPDATE users SET username = ? WHERE id = ? AND username = ?
       AND NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower(?) AND id != ?)`,
    [to, user.id, from, to, user.id]
  );
  if (result.changes !== 1) {
    console.error('The rename did not happen (the name was taken or the account changed meanwhile). Nothing changed.');
    process.exit(1);
  }
  // Directly, not through services/logger.js - see scripts/reset-password.js for why.
  await db.run(
    `INSERT INTO app_logs (level, category, message, user_id, details) VALUES ('SECURITY', 'AUTH_USERNAME_CHANGE', ?, ?, ?)`,
    [
      `Username changed from the command line (UID: ${user.id})`,
      user.id,
      JSON.stringify({ userId: user.id, from: user.username, to, via: 'scripts/rename-user.js' })
    ]
  );
  console.log(`Renamed. The password login now uses "${to}"; sessions and SSO are unaffected.`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Renaming failed:', err);
  process.exit(1);
});
