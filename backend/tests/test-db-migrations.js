// Tests for the column migrations in db.js.
//
// The bug these pin down: every `ALTER TABLE ... ADD COLUMN` in initDb() was wrapped in
// `try { ... } catch (e) {}`. SQLite has no ADD COLUMN IF NOT EXISTS, so the ALTER is expected
// to fail on every start after the first - but an empty catch makes that expected failure
// indistinguishable from a real one (SQLITE_BUSY from the db-viewer sidecar or a second pod
// during a rolling update, SQLITE_READONLY from a full or read-only volume, a typo in the SQL).
// Startup then carried on with an incomplete schema, the health check passed, and the missing
// column surfaced much later as one feature failing, far from anything that pointed at a
// migration.
//
// The third test is the one that matters: it feeds addColumn a migration that genuinely cannot
// succeed and requires it to throw. Without that, "the migrations no longer swallow errors"
// would rest on the silence of the other two tests, which is no evidence at all - the old
// empty-catch code passes both of them.
//
// Run with: node tests/test-db-migrations.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-migrations-'));
process.env.DATABASE_DIR = tmpDir;

const db = require('../db');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function columnNames(table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function run() {
  console.log('\n--- TESTS: db.js column migrations ---');

  await db.initDb();

  // A column that only exists because a migration added it, not because it is in the original
  // CREATE TABLE - so its presence proves the migration path ran, not just the table creation.
  const sessionCols = await columnNames('sessions');
  assert(sessionCols.includes('is_temp'), 'initDb on an empty database applies the column migrations (sessions.is_temp exists)');
  const mealCols = await columnNames('meals');
  assert(mealCols.includes('fiber') && mealCols.includes('sodium'), 'the later meal micronutrient migrations ran too (meals.fiber, meals.sodium)');

  // The expected failure: on an already-migrated database every ALTER raises "duplicate column
  // name", and that one error - and only that one - must still be absorbed.
  await db.initDb();
  console.log('✅ a second initDb over the same database completes (duplicate-column errors are still tolerated)');

  assert(
    (await db.addColumn(`ALTER TABLE sessions ADD COLUMN is_temp INTEGER DEFAULT 0`)) === false,
    'addColumn reports false for a column that is already present, so one-time backfills do not re-run'
  );
  assert(
    (await db.addColumn(`ALTER TABLE sessions ADD COLUMN audit_probe_column TEXT`)) === true,
    'addColumn reports true for a column it actually added, which is what gates those backfills'
  );

  // KNOWN-BAD SAMPLE. "no such table" is a real migration failure, indistinguishable from a
  // typo'd table name or a table that an earlier failed step never created. The old
  // `catch (e) {}` returned normally here and startup carried on; this must now throw.
  let threw = null;
  try {
    await db.addColumn(`ALTER TABLE table_that_does_not_exist ADD COLUMN c TEXT`);
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'a migration against a missing table THROWS instead of being swallowed (known-bad sample)');
  assert(
    /no such table/i.test(threw.message),
    `the error that propagates is the real SQLite one, not a rewrapped or generic message (got: ${threw && threw.message})`
  );

  // A second known-bad shape: valid table, invalid column definition. Catching only
  // "duplicate column name" must not accidentally cover syntax errors either.
  let threwSyntax = null;
  try {
    await db.addColumn(`ALTER TABLE sessions ADD COLUMN`);
  } catch (err) {
    threwSyntax = err;
  }
  assert(threwSyntax !== null, 'a malformed ALTER statement also throws (known-bad sample)');
}

run()
  .then(() => {
    console.log('\n🎉 DB MIGRATION TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ DB MIGRATION TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
