// Tests for the sessions.absolute_expires_at migration in db.js (audit 2026-09-23).
//
// middleware/auth.js renews a session by 7 days whenever fewer than 6 remain, and that
// renewal had no end: a token touched once a week lives for ever, so "sessions expire after
// 7 days" was true only of a token nobody uses - a stolen one being polled by a script is
// exactly the one that never expires. The middleware already clamps the renewal to
// sessions.absolute_expires_at; until the column existed that read `undefined` and the cap
// sat dormant while every test stayed green.
//
// tests/test-session-revocation.js covers the ENFORCEMENT. What is tested here is the
// migration's judgement call, which is the part that can go wrong silently and can only go
// wrong once, on real data:
//
//   - backfilling a PAST timestamp would be correct in theory and would log out every
//     signed-in user the moment the pod restarts;
//   - backfilling `now + full cap` would hand every existing session a brand-new maximum
//     lifetime - most of all to the ones that may already have leaked;
//   - backfilling the row's current expires_at logs nobody out, lets every pre-migration
//     session die within its remaining 7 days, and can only ever shorten a session.
//
// Run with: node tests/test-session-cap-migration.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-session-cap-'));
process.env.DATABASE_DIR = tmpDir;
process.env.NODE_ENV = 'test';

const db = require('../db');

const toSqlUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let nextToken = 0;
// Writes a session row the way routes/auth.js writes one TODAY - without the new column.
// That is not only the historical shape: this column ships before createSession starts
// filling it in, so rows of exactly this shape keep appearing until that change lands.
async function insertUncappedSession(expiresAtMs) {
  nextToken += 1;
  const token = `cap-test-${nextToken}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa, is_temp) VALUES (?, 1, ?, 1, 0)`,
    [token, toSqlUtc(expiresAtMs)]
  );
  return token;
}

function readSession(token) {
  return db.get(`SELECT expires_at, absolute_expires_at FROM sessions WHERE token = ?`, [token]);
}

async function testColumnExists() {
  console.log('\n--- TEST 1: the column exists ---');
  const columns = await db.all(`PRAGMA table_info(sessions)`);
  const column = columns.find(c => c.name === 'absolute_expires_at');
  assert.ok(column, 'sessions.absolute_expires_at is missing - the renewal cap in middleware/auth.js is dormant.');
  assert.strictEqual(column.type, 'TEXT', 'the cap must be TEXT, the same format as expires_at.');
  console.log('✅ sessions.absolute_expires_at exists as TEXT');
}

async function testBackfillDoesNotLogEveryoneOut() {
  console.log('\n--- TEST 2: the backfill caps existing sessions without ending them ---');
  const nowMs = Date.now();
  const fiveDaysOut = nowMs + 5 * 24 * 3600 * 1000;
  const token = await insertUncappedSession(fiveDaysOut);

  await db.initDb(); // the next pod start

  const row = await readSession(token);
  assert.strictEqual(
    row.absolute_expires_at,
    row.expires_at,
    `the cap should be the row's own expiry (got ${row.absolute_expires_at}, expires_at ${row.expires_at})`
  );

  const capMs = new Date(row.absolute_expires_at.replace(' ', 'T') + 'Z').getTime();
  assert.ok(
    capMs > nowMs,
    'the cap must be in the FUTURE - a past value would log every signed-in user out on deploy.'
  );
  assert.ok(
    capMs <= nowMs + 7 * 24 * 3600 * 1000 + 1000,
    'the cap must not exceed the 7-day renewal window - granting a fresh lifetime is the opposite of the fix.'
  );
  console.log('✅ existing sessions keep working and are bounded by their current expiry');
}

async function testTemporarySessionsAreNotExtended() {
  console.log('\n--- TEST 3: a 5-minute temporary session keeps its 5 minutes ---');
  const expiresMs = Date.now() + 5 * 60 * 1000;
  const token = await insertUncappedSession(expiresMs);
  await db.run(`UPDATE sessions SET is_temp = 1 WHERE token = ?`, [token]);

  await db.initDb();

  const row = await readSession(token);
  const capMs = new Date(row.absolute_expires_at.replace(' ', 'T') + 'Z').getTime();
  assert.ok(
    capMs <= Date.now() + 6 * 60 * 1000,
    `a temporary session must not be handed a longer life by the migration (cap ${row.absolute_expires_at}).`
  );
  console.log('✅ the cap never lengthens a session, only shortens it');
}

async function testRepairIsStandingAndIdempotent() {
  console.log('\n--- TEST 4: the repair is standing, and leaves written caps alone ---');
  // A session created AFTER this migration shipped but BEFORE routes/auth.js starts writing
  // the column - the deploy-order gap. It must not be left uncapped for ever.
  const gapToken = await insertUncappedSession(Date.now() + 3 * 24 * 3600 * 1000);
  await db.initDb();
  const gapRow = await readSession(gapToken);
  assert.ok(gapRow.absolute_expires_at, 'a session created in the deploy gap was left without a cap.');

  // ...and once createSession does write a cap, later starts must not touch it. Renewal
  // moves expires_at forward; re-deriving the cap from it on every start would restore the
  // unbounded renewal this migration exists to stop.
  const explicitCap = toSqlUtc(Date.now() + 30 * 24 * 3600 * 1000);
  await db.run(`UPDATE sessions SET absolute_expires_at = ? WHERE token = ?`, [explicitCap, gapToken]);
  await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`, [toSqlUtc(Date.now() + 7 * 24 * 3600 * 1000), gapToken]);

  await db.initDb();

  const after = await readSession(gapToken);
  assert.strictEqual(
    after.absolute_expires_at,
    explicitCap,
    'a cap that was written explicitly must survive every later start untouched.'
  );
  console.log('✅ uncapped rows are repaired, capped rows are never rewritten');
}

async function main() {
  console.log('=== SESSION CAP MIGRATION TESTS ===');
  try {
    await db.initDb();
    await testColumnExists();
    await testBackfillDoesNotLogEveryoneOut();
    await testTemporarySessionsAreNotExtended();
    await testRepairIsStandingAndIdempotent();
    console.log('\n🎉 SESSION CAP MIGRATION TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ' + (err && err.message ? err.message : err));
    console.error('❌ SESSION CAP MIGRATION TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
