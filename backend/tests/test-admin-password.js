// Administrative actions need the admin's own password, not only the session (audit D-4,
// renacode-infra docs/sso-tozsamosc.md section 4), end to end over the REAL app (app.js)
// against a throwaway SQLite file.
//
// What breaks if this goes wrong, and therefore what is pinned down here:
//   - every POST/PUT/PATCH/DELETE route in routes/admin.js carries requireAdminPassword, read
//     off the router itself - a new admin action added without it fails this test, not a
//     later audit;
//   - for each of them: no password and a wrong password are refused (403, never 401, which
//     would log the panel out) and change nothing; a wrong one is counted and logged; the
//     right one performs the action and leaves one ADMIN_ACTION row in app_logs with no
//     e-mail address or configuration value in it;
//   - the attempts share the per-account budget of the account's own password prompts and
//     lock out after five; an account without a known password gets 409 and nothing counted;
//   - a non-admin is refused before any password is compared or counted;
//   - an SSO session is not a substitute for the password.
//
// Run with: node tests/test-admin-password.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-admin-password-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-admin-password';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-admin-password';
delete process.env.SSO_NAGLOWKI;
delete process.env.SSO_LOGOUT_URL;
delete process.env.SSO_GRUPY;

const BACKEND_DIR = path.join(__dirname, '..');
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
const mailsSent = [];
stubModule('services/mailgun.js', { sendMailgunEmail: async (msg) => { mailsSent.push(msg.to); } });

const bcrypt = require('bcryptjs');
const express = require('express');
const db = require('../db');
const app = require('../app');
const adminRouter = require('../routes/admin');

const PASSWORD = 'adminpass123';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

let baseUrl;
function call(method, urlPath, { body, raw, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + urlPath, { method }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setHeader('Content-Type', 'application/json');
    if (token) req.setHeader('Authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
    // An explicit length: without it Node's client sends a DELETE body chunked, and the
    // server's parser answers that with a bare 400 before express ever sees the request.
    // `raw` sends the text as it is - a body the JSON parser has to reject.
    const payload = method === 'GET' ? undefined : (raw !== undefined ? raw : JSON.stringify(body || {}));
    if (payload !== undefined) req.setHeader('Content-Length', Buffer.byteLength(payload));
    req.end(payload);
  });
}

async function createUser({ role = 'user', totp = false, passwordSet = true } = {}) {
  const username = 'adm_' + Math.random().toString(36).substring(2, 9);
  const email = `${username}@owner.invalid`;
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, email, password_set)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_' + username + 'x'.repeat(16), totp ? 1 : 0, totp ? 'JBSWY3DPEHPK3PXP' : null, role, email, passwordSet ? 1 : 0]);
  return { id: result.id, username, email };
}

const login = async (username) => (await call('POST', '/api/login', { body: { username, password: PASSWORD } })).body.token;
const newAdmin = async (opts = {}) => {
  const admin = await createUser({ role: 'admin', ...opts });
  return { ...admin, token: await login(admin.username) };
};
const attemptRows = async (userId) => (await db.get(`SELECT COALESCE(SUM(count), 0) AS n FROM login_attempts WHERE key LIKE ?`, [`%pwcheck_user:${userId}`])).n;
const logRows = async (category, userId) => db.all(`SELECT message, details FROM app_logs WHERE category = ? AND user_id IS ? ORDER BY id`, [category, userId]);
const failureRows = async (userId) => (await db.all(`SELECT details FROM app_logs WHERE category = 'AUTH_PASSWORD_FAILURE'`))
  .filter((r) => JSON.parse(r.details || '{}').userId === userId);
// logger writes in the background; give it a tick before reading app_logs.
const settle = () => new Promise((r) => setTimeout(r, 50));

// The mutating routes of a router or a whole app, read off its stack - descending into the
// routers mounted with app.use(), as app.js mounts every routes/*.js: [{ method, path, handles }].
function mutatingRoutes(routerOrApp) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (!layer.route) {
        if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack);
        continue;
      }
      for (const method of Object.keys(layer.route.methods)) {
        if (['post', 'put', 'patch', 'delete'].includes(method)) {
          out.push({ method: method.toUpperCase(), path: layer.route.path, handles: layer.route.stack.map((l) => l.handle) });
        }
      }
    }
  };
  // Express 5: the app's router is the public `app.router` (Express 4 had the private `_router`).
  walk(routerOrApp.stack || routerOrApp.router.stack);
  return out;
}

// Routes lacking the password middleware, or carrying it before requireAdmin (where a
// non-admin's session could burn its own account's attempts).
function routesWithoutPassword(router) {
  const { requireAdmin } = require('../middleware/auth');
  return mutatingRoutes(router).filter(({ handles }) => {
    const pw = handles.findIndex((h) => typeof h.adminPasswordAction === 'string');
    const admin = handles.indexOf(requireAdmin);
    return pw === -1 || admin === -1 || pw < admin;
  }).map((r) => `${r.method} ${r.path}`);
}

// One case per mutating route: how to aim it at a fresh target and how to tell it happened.
// A mutating route with no case here fails testEveryRouteIsCovered - the case is the test.
const CASES = {
  'POST /api/admin/config': {
    setup: async () => {
      await db.run(`INSERT INTO app_config (key, value) VALUES ('allow_public_registration', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`);
      return {};
    },
    url: () => '/api/admin/config',
    body: () => ({ allow_public_registration: '1' }),
    done: async () => (await db.get(`SELECT value FROM app_config WHERE key = 'allow_public_registration'`)).value === '1'
  },
  'DELETE /api/admin/users/:id': {
    setup: async () => ({ target: await createUser() }),
    url: ({ target }) => `/api/admin/users/${target.id}`,
    body: () => ({}),
    done: async ({ target }) => !(await db.get(`SELECT id FROM users WHERE id = ?`, [target.id]))
  },
  'POST /api/admin/users/:id/reset-2fa': {
    setup: async () => ({ target: await createUser({ totp: true }) }),
    url: ({ target }) => `/api/admin/users/${target.id}/reset-2fa`,
    body: () => ({}),
    done: async ({ target }) => (await db.get(`SELECT totp_enabled FROM users WHERE id = ?`, [target.id])).totp_enabled === 0
  },
  'POST /api/admin/users/:id/force-2fa': {
    setup: async () => ({ target: await createUser() }),
    url: ({ target }) => `/api/admin/users/${target.id}/force-2fa`,
    body: () => ({}),
    done: async ({ target }) => (await db.get(`SELECT force_2fa FROM users WHERE id = ?`, [target.id])).force_2fa === 1
  },
  'POST /api/admin/users/:id/force-password-change': {
    setup: async () => ({ target: await createUser() }),
    url: ({ target }) => `/api/admin/users/${target.id}/force-password-change`,
    body: () => ({}),
    done: async ({ target }) => (await db.get(`SELECT force_password_change FROM users WHERE id = ?`, [target.id])).force_password_change === 1
  },
  'POST /api/admin/invite': {
    setup: async () => ({ email: `inv_${Math.random().toString(36).substring(2, 9)}@owner.invalid` }),
    url: () => '/api/admin/invite',
    body: ({ email }) => ({ email, role: 'admin', confirm_admin: true }),
    done: async ({ email }) => !!(await db.get(`SELECT id FROM users WHERE email = ? AND role = 'admin'`, [email]))
  }
};

function testEveryRouteIsCovered() {
  console.log('\n--- TEST: every mutating admin route requires the password ---');
  const routes = mutatingRoutes(adminRouter).map((r) => `${r.method} ${r.path}`);
  assert(routes.length >= 6, `the router exposes the known admin actions (${routes.join(', ')})`);
  const missing = routesWithoutPassword(adminRouter);
  assert(missing.length === 0, `each one has requireAdminPassword after requireAdmin (missing: ${missing.join(', ') || 'none'})`);
  const uncovered = routes.filter((r) => !CASES[r]);
  assert(uncovered.length === 0, `each one has a behavioural case in this file (uncovered: ${uncovered.join(', ') || 'none'})`);

  // The detector itself: a router with a route that skips the password must be flagged, or
  // the silence above proves nothing.
  const { requireAdmin } = require('../middleware/auth');
  const bad = express.Router();
  bad.post('/api/admin/new-action', requireAdmin, (req, res) => res.json({}));
  bad.delete('/api/admin/other', (req, res) => res.json({}));
  const flagged = routesWithoutPassword(bad);
  assert(flagged.includes('POST /api/admin/new-action') && flagged.includes('DELETE /api/admin/other'),
    `a route added without the password is caught (${flagged.join(', ')})`);

  // requireAdmin is not confined to routes/admin.js by anything but habit: an admin-only action
  // added to routes/account.js or routes/dashboard.js would skip the router walked above. So
  // the whole app is walked as well, every router app.js mounts, for any mutating route that
  // carries requireAdmin.
  const adminAnywhere = (routes) => routes.filter(({ handles }) => handles.includes(requireAdmin));
  const appWide = adminAnywhere(mutatingRoutes(app));
  const appUncovered = appWide.map((r) => `${r.method} ${r.path}`).filter((r) => !CASES[r]);
  assert(appWide.length >= routes.length && appUncovered.length === 0,
    `every requireAdmin action in the app has a behavioural case here (${appWide.length} found, uncovered: ${appUncovered.join(', ') || 'none'})`);
  const appMissing = routesWithoutPassword(app).filter((r) => appWide.some((a) => `${a.method} ${a.path}` === r));
  assert(appMissing.length === 0, `and each requireAdmin action in the app has the password (missing: ${appMissing.join(', ') || 'none'})`);

  const badApp = express();
  const elsewhere = express.Router();
  elsewhere.post('/api/user/admin-thing', requireAdmin, (req, res) => res.json({}));
  badApp.use(express.Router());
  badApp.use(elsewhere);
  const elsewhereFlagged = adminAnywhere(mutatingRoutes(badApp)).map((r) => `${r.method} ${r.path}`);
  assert(elsewhereFlagged.includes('POST /api/user/admin-thing'),
    `an admin action in another router is found by the app-wide walk (${elsewhereFlagged.join(', ')})`);
}

async function testEachAction() {
  for (const [name, c] of Object.entries(CASES)) {
    console.log(`\n--- TEST: ${name} ---`);
    const admin = await newAdmin();
    const ctx = await c.setup();

    const none = await call(name.split(' ')[0], c.url(ctx), { token: admin.token, body: c.body(ctx) });
    assert(none.status === 403 && none.body.requirePassword === true, `without the password: 403 requirePassword (got ${none.status})`);
    assert(!(await c.done(ctx)), 'and nothing happened');
    assert(await attemptRows(admin.id) === 0, 'a missing password is not counted as a guess');

    const wrong = await call(name.split(' ')[0], c.url(ctx), { token: admin.token, body: { ...c.body(ctx), currentPassword: 'not-the-password1' } });
    assert(wrong.status === 403 && wrong.body.requirePassword === true, `with a wrong password: 403 (got ${wrong.status})`);
    assert(!(await c.done(ctx)), 'and nothing happened');
    assert(await attemptRows(admin.id) > 0, 'the wrong password counts towards the lockout');
    await settle();
    assert((await failureRows(admin.id)).length === 1, 'and is logged as AUTH_PASSWORD_FAILURE');

    const ok = await call(name.split(' ')[0], c.url(ctx), { token: admin.token, body: { ...c.body(ctx), currentPassword: PASSWORD } });
    assert(ok.status === 200, `with the admin's password the action goes through (got ${ok.status} ${JSON.stringify(ok.body)})`);
    assert(await c.done(ctx), 'and took effect');
    await settle();
    const audit = await logRows('ADMIN_ACTION', admin.id);
    assert(audit.length === 1, `one ADMIN_ACTION row in app_logs (got ${audit.length})`);
    const auditText = audit[0].message + audit[0].details;
    assert(!/@/.test(auditText) && !auditText.includes(PASSWORD), `with no address or password in it (${auditText})`);
  }
}

async function testConfigDoesNotStoreThePassword() {
  console.log('\n--- TEST: the password sent with the config is not saved as a setting ---');
  const admin = await newAdmin();
  const res = await call('POST', '/api/admin/config', { token: admin.token, body: { mailgun_api_key: 'key-secret-value', currentPassword: PASSWORD } });
  assert(res.status === 200, `saved (got ${res.status})`);
  const row = await db.get(`SELECT key FROM app_config WHERE key = 'currentPassword' OR value = ?`, [PASSWORD]);
  assert(!row, 'no app_config row holds the password');
  await settle();
  const audit = await logRows('ADMIN_ACTION', admin.id);
  assert(audit.length === 1 && !audit[0].details.includes('key-secret-value') && audit[0].details.includes('mailgun_api_key'),
    'the audit row names the key, not the secret value');
}

async function testInviteStillNeedsTheAdminFlag() {
  console.log('\n--- TEST: an admin invitation needs confirm_admin on top of the password ---');
  const admin = await newAdmin();
  const email = 'flag_check@owner.invalid';
  const res = await call('POST', '/api/admin/invite', { token: admin.token, body: { email, role: 'admin', currentPassword: PASSWORD } });
  assert(res.status === 400, `refused without confirm_admin (got ${res.status})`);
  assert(!(await db.get(`SELECT id FROM users WHERE email = ?`, [email])), 'no account was created');
}

async function testLockoutSharedWithAccountPrompts() {
  console.log('\n--- TEST: five wrong passwords lock the admin actions, the account prompts included ---');
  const admin = await newAdmin();
  const target = await createUser();
  // Two wrong guesses on the account's own prompt, three on admin actions: one budget.
  for (let i = 0; i < 2; i++) {
    await call('POST', '/api/user/disable-2fa', { token: admin.token, body: { password: 'wrong-guess-' + i } });
  }
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', `/api/admin/users/${target.id}/force-2fa`, { token: admin.token, body: { currentPassword: 'wrong-guess-x' + i } });
    assert(r.status === 403, `admin guess ${i + 1} refused (got ${r.status})`);
  }
  const locked = await call('POST', `/api/admin/users/${target.id}/force-2fa`, { token: admin.token, body: { currentPassword: PASSWORD } });
  assert(locked.status === 429, `the sixth attempt is locked out even with the right password (got ${locked.status})`);
  const row = await db.get(`SELECT force_2fa FROM users WHERE id = ?`, [target.id]);
  assert(row.force_2fa === 0, 'and the action did not happen');
}

async function testNonAdminNotCounted() {
  console.log('\n--- TEST: a non-admin is refused before any password is compared ---');
  const user = await createUser();
  const token = await login(user.username);
  const target = await createUser();
  const res = await call('DELETE', `/api/admin/users/${target.id}`, { token, body: { currentPassword: 'some-guess-123' } });
  assert(res.status === 403 && !res.body.requirePassword, `403 from requireAdmin (got ${res.status} ${JSON.stringify(res.body)})`);
  assert(await attemptRows(user.id) === 0, 'nothing was counted against the account');
  assert(!!(await db.get(`SELECT id FROM users WHERE id = ?`, [target.id])), 'the target still exists');
}

async function testAccountWithoutPassword() {
  console.log('\n--- TEST: an admin account without a known password gets 409, nothing counted ---');
  const admin = await createUser({ role: 'admin', passwordSet: false });
  // A session row directly: such an account has no password to log in with.
  const token = 'tok_' + Math.random().toString(36).substring(2) + 'x'.repeat(20);
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`, [token, admin.id]);
  const target = await createUser();
  const res = await call('POST', `/api/admin/users/${target.id}/force-password-change`, { token, body: { currentPassword: 'anything-123' } });
  assert(res.status === 409 && res.body.requirePasswordSetup === true, `409 requirePasswordSetup (got ${res.status} ${JSON.stringify(res.body)})`);
  assert(await attemptRows(admin.id) === 0, 'and the attempt is not counted');
}

async function testMalformedBodyDoesNotLogThePassword() {
  console.log('\n--- TEST: a body the JSON parser rejects does not put the password in a log ---');
  const admin = await newAdmin();
  const target = await createUser();
  // Unquoted, so V8's message quotes the text around it ("Unexpected token 'Z', ...").
  const secret = 'Zgadnij-To-Haslo-77';
  const printed = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(original)) {
    console[name] = (...args) => { printed.push(require('util').format(...args)); };
  }
  let res;
  try {
    res = await call('POST', `/api/admin/users/${target.id}/force-2fa`, { token: admin.token, raw: `{"currentPassword":${secret}}` });
    await settle();
  } finally {
    Object.assign(console, original);
  }
  assert(res.status === 400, `the request is refused (got ${res.status})`);
  const leakedRows = await db.all(`SELECT category FROM app_logs WHERE message LIKE ? OR details LIKE ?`, ['%Zgadnij%', '%Zgadnij%']);
  assert(leakedRows.length === 0, `no app_logs row quotes the password (${leakedRows.map((r) => r.category).join(', ') || 'none'})`);
  assert(!printed.some((line) => line.includes('Zgadnij')), 'and nothing printed to stdout/stderr does');
  assert(printed.some((line) => line.includes('HTTP_SERVER')), 'while the rejected request is still logged');
}

async function testSsoSessionNeedsThePassword() {
  console.log('\n--- TEST: an SSO session does not replace the admin password ---');
  process.env.SSO_NAGLOWKI = '1';
  process.env.SSO_LOGOUT_URL = 'https://auth.example.invalid/logout';
  try {
    const admin = await createUser({ role: 'admin' });
    const headers = { 'Remote-User': 'adminuser', 'Remote-Email': admin.email, 'Remote-Groups': 'admins', 'Remote-Name': 'adminuser' };
    const sso = await call('POST', '/api/auth/sso', { headers });
    assert(sso.status === 200 && sso.body.token, `SSO login (got ${sso.status})`);
    const target = await createUser();
    const without = await call('POST', `/api/admin/users/${target.id}/force-2fa`, { token: sso.body.token, headers, body: {} });
    assert(without.status === 403 && without.body.requirePassword === true, `refused without the password (got ${without.status})`);
    const withPw = await call('POST', `/api/admin/users/${target.id}/force-2fa`, { token: sso.body.token, headers, body: { currentPassword: PASSWORD } });
    assert(withPw.status === 200, `goes through with it (got ${withPw.status})`);
  } finally {
    delete process.env.SSO_NAGLOWKI;
    delete process.env.SSO_LOGOUT_URL;
  }
}

async function run() {
  await db.initDb();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    testEveryRouteIsCovered();
    await testEachAction();
    await testConfigDoesNotStoreThePassword();
    await testInviteStillNeedsTheAdminFlag();
    await testLockoutSharedWithAccountPrompts();
    await testNonAdminNotCounted();
    await testAccountWithoutPassword();
    await testMalformedBodyDoesNotLogThePassword();
    await testSsoSessionNeedsThePassword();
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 ADMIN PASSWORD TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ ADMIN PASSWORD TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
