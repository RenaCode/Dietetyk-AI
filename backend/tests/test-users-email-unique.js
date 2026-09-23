// Tests for the UNIQUE constraint on users.email and the migration that installs it
// (db.js, audit 2026-09-23).
//
// Why it matters: `users.email` was created as a plain `email TEXT`, and POST /api/login
// resolves an account with `WHERE username = ? OR email = ?` and takes the first row. With
// no uniqueness, registering a second account on somebody else's address is enough to stand
// in front of their login - which row comes first is decided by the query planner, not by
// intent.
//
// Why a migration needs its own test: it is the one piece of code that runs before
// everything else and can only fail in production, on data nobody has in development. The
// three ways this particular migration could make things worse are each pinned down below:
//
//  1. It must not lock out accounts that legitimately have no address. Blanks ('' - which
//     routes/account.js writes whenever a user clears the field) and NULLs must stay
//     unconstrained, or the SECOND user to clear their email gets a constraint error and a
//     500 where they used to get a saved profile.
//  2. It must actually close the hole for case and whitespace variants, since the login
//     lookup compares exactly while mailboxes do not.
//  3. It must NOT stop the application from starting on a database that already contains
//     duplicates - a crash-loop means nobody can log in to fix the data - and it must not
//     stay quiet about them either.
//
// Run with: node tests/test-users-email-unique.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-email-unique-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';

const db = require('../db');

const INDEX_NAME = 'idx_users_email_unique';

let nextUser = 0;
async function addUser(email) {
  nextUser += 1;
  return db.run(
    `INSERT INTO users (username, password_hash, sync_token, email) VALUES (?, 'x', ?, ?)`,
    [`user${nextUser}`, `token${nextUser}`, email]
  );
}

async function expectRejected(promise, what) {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    assert.ok(
      /UNIQUE constraint failed/i.test(err.message),
      `${what}: expected a UNIQUE constraint error, got "${err.message}"`
    );
  }
  assert.ok(threw, `${what}: the insert was ACCEPTED - the address is not protected.`);
}

function indexRow() {
  return db.get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`, [INDEX_NAME]);
}

async function testIndexExists() {
  console.log('\n--- TEST 1: the unique index is installed ---');
  assert.ok(await indexRow(), `${INDEX_NAME} was not created on a clean database.`);
  console.log(`✅ ${INDEX_NAME} exists.`);
}

async function testDuplicateAddressIsRejected() {
  console.log('\n--- TEST 2: a second account cannot take an address already in use ---');
  await addUser('ala@example.com');

  await expectRejected(addUser('ala@example.com'), 'exact duplicate');
  // The login lookup compares exactly, so a case variant is a DIFFERENT row matching the
  // same mailbox - the impersonation vector, plus every password-reset mail landing in the
  // victim's inbox.
  await expectRejected(addUser('ALA@Example.COM'), 'case variant');
  await expectRejected(addUser('  ala@example.com  '), 'whitespace variant');

  console.log('✅ Exact, case and whitespace duplicates are all rejected.');
}

async function testAccountsWithoutAnAddressAreNotConstrained() {
  console.log('\n--- TEST 3: accounts with no address are not constrained ---');
  // Invitations are created without an address, and routes/account.js writes '' when a user
  // clears the field. Neither may collide - the second such account must still save.
  await addUser(null);
  await addUser(null);
  await addUser('');
  await addUser('');

  const counts = await db.get(`
    SELECT
      SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) AS nulls,
      SUM(CASE WHEN email = '' THEN 1 ELSE 0 END) AS blanks
    FROM users
  `);
  assert.ok(counts.nulls >= 2, 'Two address-less accounts should coexist.');
  assert.strictEqual(counts.blanks, 2, 'Two accounts with a cleared address should coexist.');
  console.log('✅ NULL and blank addresses coexist freely.');
}

async function testStartupNormalisation() {
  console.log('\n--- TEST 4: startup normalises blank and untrimmed addresses ---');
  await addUser('   ');
  await addUser('  Spaced@Example.com  ');

  await db.initDb();

  const blank = await db.get(`SELECT email FROM users WHERE username = ?`, ['user9']);
  const spaced = await db.get(`SELECT email FROM users WHERE username = ?`, ['user10']);
  assert.strictEqual(blank.email, null, 'A whitespace-only address should be normalised to NULL.');
  assert.strictEqual(spaced.email, 'Spaced@Example.com', 'A stored address should be trimmed.');
  assert.ok(await indexRow(), 'The index should survive a second start.');
  console.log('✅ Blanks become NULL, addresses are trimmed, the index survives a restart.');
}

// The important one: the migration meets a database that ALREADY holds the duplicates the
// index is meant to prevent. That is the state production is in - the hole has been open for
// the life of the column.
async function testExistingDuplicatesDoNotBlockStartup() {
  console.log('\n--- TEST 5: pre-existing duplicates do not stop the application ---');
  await db.run(`DROP INDEX ${INDEX_NAME}`);
  await addUser('clash@example.com');
  await addUser('CLASH@example.com');
  await db.run(`DELETE FROM app_logs`);

  // Must not throw: start() in server.js turns a throw into a non-zero exit, so a migration
  // that insisted here would crash-loop the pod and leave nobody able to log in and merge
  // the accounts.
  await db.initDb();

  assert.strictEqual(
    await indexRow(),
    undefined,
    'The index must be skipped while the data still contains duplicates - creating it would fail.'
  );

  // ...and it must not be quiet about it. console.error alone dies with the container;
  // app_logs is what the weekly administrator report reads.
  const alert = await db.get(`
    SELECT message FROM app_logs
    WHERE level = 'ERROR' AND message LIKE '%${INDEX_NAME}%'
    ORDER BY id DESC LIMIT 1
  `);
  assert.ok(alert, 'The skipped index was not recorded in app_logs.');
  assert.ok(
    alert.message.includes('clash@example.com'),
    `The alert should name the clashing address, got: ${alert.message}`
  );

  // The rest of the schema still came up.
  const health = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_metrics'`);
  assert.ok(health, 'The rest of the migration did not run.');
  console.log('✅ Startup survives, the index is skipped, and the conflict is recorded durably.');
}

async function main() {
  console.log('=== USERS.EMAIL UNIQUENESS TESTS ===');
  try {
    await db.initDb();
    await testIndexExists();
    await testDuplicateAddressIsRejected();
    await testAccountsWithoutAnAddressAreNotConstrained();
    await testStartupNormalisation();
    await testExistingDuplicatesDoNotBlockStartup();
    console.log('\n✅ ALL USERS.EMAIL UNIQUENESS TESTS PASSED.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();
