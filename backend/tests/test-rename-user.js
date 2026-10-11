// scripts/rename-user.js: dry run by default, case-insensitive uniqueness, the username rule,
// an audit row on success.
//
// Run with: node tests/test-rename-user.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-rename-user-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-rename-user';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-rename-user';

const db = require('../db');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'rename-user.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const rename = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: process.env, encoding: 'utf8' });
const nameOf = async (id) => (await db.get(`SELECT username FROM users WHERE id = ?`, [id])).username;

async function run() {
  await db.initDb();
  const add = (id, username) => db.run(
    `INSERT INTO users (id, username, password_hash, sync_token, role, status) VALUES (?, ?, 'x', ?, 'user', 'active')`,
    [id, username, `sync_${username}_0000000000000000`]
  );
  await add(20, 'MixedCase');
  await add(21, 'other');

  const dry = rename('MixedCase', 'mixedcase2');
  assert(dry.status === 0 && /Dry run/.test(dry.stdout), 'without --apply it is a dry run');
  assert(await nameOf(20) === 'MixedCase', 'and nothing changed');

  const clash = rename('MixedCase', 'OTHER', '--apply');
  assert(clash.status === 1 && /taken/.test(clash.stderr), 'a name taken by another account in any case is refused');
  const bad = rename('MixedCase', 'a@b', '--apply');
  assert(bad.status === 2, 'a name breaking the username rule is refused');
  const missing = rename('nobody', 'someone', '--apply');
  assert(missing.status === 1, 'an unknown account is refused');
  assert(await nameOf(20) === 'MixedCase', 'still nothing changed');

  const ok = rename('MixedCase', 'mixedcase', '--apply');
  assert(ok.status === 0, `a free name is applied (got ${ok.status} ${ok.stderr})`);
  assert(await nameOf(20) === 'mixedcase', 'the account is renamed (a case-only change of its own name is allowed)');
  const audit = await db.get(`SELECT details FROM app_logs WHERE category = 'AUTH_USERNAME_CHANGE' AND user_id = 20`);
  assert(audit && /"from":"MixedCase","to":"mixedcase"/.test(audit.details), 'the rename is in app_logs');
}

run()
  .then(() => {
    console.log('\n🎉 RENAME USER TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ RENAME USER TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
