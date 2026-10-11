// The admin guarantee at start (db.js initDb): "at least one ACTIVE admin exists; if none,
// promote id 1" - no longer "id 1 is rewritten to username 'admin', role 'admin' on every
// start". The old rule made it impossible to turn the owner's everyday account (id 1, the one
// with the history) into an ordinary user once administration moved to a separate account
// for single sign-on: a demotion lasted until the next pod restart.
//
// Each "restart" is a fresh process running initDb against the same database file, which is
// what a pod restart does.
//
// Run with: node tests/test-admin-bootstrap.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-admin-bootstrap-'));
const BACKEND_DIR = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// Runs initDb in a new process, then the given SQL statements, and prints the users table.
function restart(sqlAfter = []) {
  const script = `
    const db = require(${JSON.stringify(path.join(BACKEND_DIR, 'db.js'))});
    (async () => {
      await db.initDb();
      for (const sql of ${JSON.stringify(sqlAfter)}) await db.run(sql);
      const users = await db.all('SELECT id, username, role, status, email FROM users ORDER BY id');
      const alerts = await db.all("SELECT message FROM app_logs WHERE message LIKE '%promoted to admin%'");
      process.stdout.write('@@' + JSON.stringify({ users, alerts: alerts.length }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const env = { ...process.env, DATABASE_DIR: tmpDbDir, NODE_ENV: 'test' };
  delete env.ADMIN_EMAIL;
  env.APP_PASSWORD = env.APP_PASSWORD || 'test-app-password-for-admin-bootstrap';
  env.OAUTH_STATE_SECRET = env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-admin-bootstrap';
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`initDb failed: ${r.stderr}`);
  return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('@@') + 2));
}

const byId = (state, id) => state.users.find(u => u.id === id);
const addUser = (id, username, role, status = 'active') =>
  `INSERT INTO users (id, username, password_hash, sync_token, role, status, email) VALUES (${id}, '${username}', 'x', 'sync_${username}_0000000000000000', '${role}', '${status}', '${username}@example.invalid')`;

function run() {
  console.log('\n--- TEST (c): a fresh database gets its admin as before ---');
  let state = restart();
  assert(state.users.length === 1, 'exactly one account is created');
  assert(byId(state, 1).username === 'admin' && byId(state, 1).role === 'admin' && byId(state, 1).status === 'active', 'id 1, username admin, role admin, active');
  assert(state.alerts === 0, 'and no "promoted" alert - nothing was missing');

  console.log('\n--- TEST (a): admin moved to id 2, id 1 demoted and renamed - a restart keeps it so ---');
  restart([
    addUser(2, 'appadmin', 'admin'),
    `UPDATE users SET role = 'user', username = 'owner1' WHERE id = 1`
  ]);
  state = restart();
  assert(byId(state, 1).role === 'user', `id 1 stays a user (got ${byId(state, 1).role})`);
  assert(byId(state, 1).username === 'owner1', `id 1 keeps its username (got ${byId(state, 1).username})`);
  assert(byId(state, 2).role === 'admin', 'id 2 stays the admin');
  state = restart();
  assert(byId(state, 1).role === 'user' && byId(state, 1).username === 'owner1', 'and again after a second restart');

  console.log('\n--- TEST: a pending admin invitation is not an admin yet ---');
  restart([`UPDATE users SET role = 'user' WHERE id = 2`, addUser(3, 'invited', 'admin', 'pending')]);
  state = restart();
  assert(byId(state, 1).role === 'admin', 'with only a pending admin, id 1 is promoted - nobody is locked out');
  assert(byId(state, 1).username === 'admin', 'and gets the name admin back, which is free');
  assert(state.alerts >= 1, 'the promotion is reported in app_logs');

  console.log('\n--- TEST (b): no admin at all - id 1 is promoted ---');
  restart([
    `UPDATE users SET role = 'user', username = 'owner1' WHERE id = 1`,
    `DELETE FROM users WHERE id = 3`,
    addUser(4, 'admin', 'user')
  ]);
  state = restart();
  assert(byId(state, 1).role === 'admin', `id 1 is the admin again (got ${byId(state, 1).role})`);
  assert(byId(state, 1).username === 'owner1', 'its name stays when "admin" belongs to another account - no UNIQUE failure at start');
  assert(byId(state, 4).role === 'user', 'the account named admin gets no role from its name');
}

try {
  run();
  console.log('\n🎉 ADMIN BOOTSTRAP TESTS PASSED\n');
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n' + (err.stack || err.message || err));
  console.error('❌ ADMIN BOOTSTRAP TESTS FAILED');
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  process.exit(1);
}
