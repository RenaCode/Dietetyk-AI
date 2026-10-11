// Single sign-on through Authelia's identity headers (renacode-infra docs/sso-tozsamosc.md),
// end to end over the REAL app (app.js) against a throwaway SQLite file.
//
// What breaks if this goes wrong, and therefore what is pinned down here:
//   - with SSO_NAGLOWKI unset, a forged `Remote-User` must change nothing - on a router without
//     the header-stripping middleware it arrives from anybody;
//   - with the flag on, the header maps onto an EXISTING account by e-mail (case-insensitive),
//     never creates one, demands an allowed group, and never grants the admin role;
//   - an SSO session skips the app's own TOTP (Authelia enforced 2FA) but is worthless without
//     the headers, and a session of another account than Authelia names is refused;
//   - the e-mail address is the SSO login, so changing it through Authelia is refused, and a
//     break-glass change is not undone by a later "log out other devices";
//   - password-confirmed actions still need the password from an SSO session.
//
// Raw `http` rather than fetch: fetch folds a repeated header into one "a, b" line, and the
// repeated header is one of the cases under test.
//
// Run with: node tests/test-sso-identity.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-sso-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-sso';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-sso';
delete process.env.SSO_NAGLOWKI;
delete process.env.SSO_LOGOUT_URL;

const BACKEND_DIR = path.join(__dirname, '..');
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });

const bcrypt = require('bcryptjs');
const db = require('../db');
const app = require('../app');

const PASSWORD = 'ownerpass123';
const LOGOUT_URL = 'https://auth.renacode.com/logout?rd=https%3A%2F%2Fdietetyk.example%2F';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const flagOn = () => { process.env.SSO_NAGLOWKI = '1'; process.env.SSO_LOGOUT_URL = LOGOUT_URL; };
const flagOff = () => { delete process.env.SSO_NAGLOWKI; delete process.env.SSO_LOGOUT_URL; };

let baseUrl;
function call(method, urlPath, { body, token, headers = {} } = {}) {
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
    // An array value goes out as one header line per element - the repeated-header case.
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
    req.end(method === 'GET' ? undefined : JSON.stringify(body || {}));
  });
}

const identity = (user, email, groups = 'dietetyk') => ({
  'Remote-User': user,
  'Remote-Email': email,
  'Remote-Groups': groups,
  'Remote-Name': user
});

async function createUser({ role = 'user', totp = false, status = 'active' } = {}) {
  const username = 'sso_' + Math.random().toString(36).substring(2, 9);
  const email = `${username}@owner.invalid`;
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status, email, password_set)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_' + username + 'x'.repeat(16), totp ? 1 : 0, totp ? 'JBSWY3DPEHPK3PXP' : null, role, status, email]);
  return { id: result.id, username, email };
}

const passwordLogin = async (username) => (await call('POST', '/api/login', { body: { username, password: PASSWORD } })).body;
const ssoLogin = (headers) => call('POST', '/api/auth/sso', { headers });
const sessionCount = async (userId) => (await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [userId])).n;
const logCount = async (category, userId = null) => (await db.get(
  `SELECT COUNT(*) AS n FROM app_logs WHERE category = ?${userId ? ' AND user_id = ?' : ''}`,
  userId ? [category, userId] : [category]
)).n;
// logger.security writes in the background; give it a tick before reading app_logs.
const settle = () => new Promise((r) => setTimeout(r, 50));

async function testFlagOffIgnoresHeaders() {
  console.log('\n--- TEST: SSO_NAGLOWKI unset - identity headers are ignored completely ---');
  flagOff();
  const victim = await createUser({ role: 'admin' });
  const attacker = await createUser();

  const sso = await ssoLogin(identity('marcin', victim.email, 'admins'));
  assert(sso.status === 404 && sso.body.ssoEnabled === false, `POST /api/auth/sso is a 404 without the flag (got ${sso.status})`);
  assert(await sessionCount(victim.id) === 0, 'no session was created for the account the forged header names');

  const anon = await call('GET', '/api/user/profile', { headers: identity('marcin', victim.email, 'admins') });
  assert(anon.status === 401, `a forged header without a token is still 401 (got ${anon.status})`);

  const token = (await passwordLogin(attacker.username)).token;
  const mixed = await call('GET', '/api/user/profile', { token, headers: identity('marcin', victim.email, 'admins') });
  assert(mixed.status === 200 && mixed.body.username === attacker.username, 'a password session with a forged header stays its own account');
  assert(mixed.body.email_managed_by_sso === false, 'and the profile does not claim SSO');
  const dup = await call('GET', '/api/user/profile', { token, headers: { 'Remote-User': ['a', 'b'] } });
  assert(dup.status === 200, `even a malformed header is not read at all (got ${dup.status})`);
  const admin = await call('GET', '/api/admin/users', { token, headers: identity('marcin', victim.email, 'admins') });
  assert(admin.status === 403, `Remote-Groups: admins does not open the admin panel (got ${admin.status})`);
}

async function testSsoLoginByEmail() {
  console.log('\n--- TEST: flag on - an existing account by e-mail, any case, no password, no app TOTP ---');
  flagOn();
  const user = await createUser({ totp: true });
  // Global forced 2FA too: neither it nor the account's own TOTP may stop an SSO session.
  await db.run(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('force_2fa', '1')`);
  try {
    const headers = identity('ania', user.email.toUpperCase());
    const sso = await ssoLogin(headers);
    assert(sso.status === 200 && typeof sso.body.token === 'string', `SSO login answers with a session token (got ${sso.status} ${JSON.stringify(sso.body)})`);
    assert(sso.body.authMethod === 'sso' && sso.body.logoutUrl === LOGOUT_URL, 'the answer names the method and the portal logout URL');
    const row = await db.get(`SELECT auth_method, is_verified_2fa, is_temp FROM sessions WHERE token = ?`, [sso.body.token]);
    assert(row.auth_method === 'sso' && row.is_verified_2fa === 1 && row.is_temp === 0, 'the session row is marked sso, 2FA verified (by Authelia), not temporary');

    const profile = await call('GET', '/api/user/profile', { token: sso.body.token, headers });
    assert(profile.status === 200 && profile.body.username === user.username, `the SSO session opens the account without its TOTP (got ${profile.status})`);
    assert(profile.body.email_managed_by_sso === true, 'the profile says the address is managed by SSO');

    await settle();
    const audit = await db.get(`SELECT message, details FROM app_logs WHERE category = 'AUTH_SSO_LOGIN' AND user_id = ? ORDER BY id DESC`, [user.id]);
    assert(audit && /ania/.test(audit.message) && /"groups":\["dietetyk"\]/.test(audit.details), 'the SSO login is in app_logs with the Authelia user and groups');

    // The break-glass path keeps the app's own second factor.
    const local = await passwordLogin(user.username);
    assert(local.status === 'require_2fa' && !local.token, 'the password login of the same account still stops at its TOTP');
  } finally {
    await db.run(`UPDATE app_config SET value = '0' WHERE key = 'force_2fa'`);
  }
  return user;
}

async function testRefusals() {
  console.log('\n--- TEST: flag on - refusals ---');
  flagOn();
  const before = (await db.get(`SELECT COUNT(*) AS n FROM users`)).n;
  const unknown = await ssoLogin(identity('obcy', 'nobody@nowhere.invalid'));
  assert(unknown.status === 403 && unknown.body.ssoDenied === 'no_account', `an unknown e-mail is 403 (got ${unknown.status})`);
  assert(/nobody@nowhere\.invalid/.test(unknown.body.error), 'with a message naming the address');
  assert((await db.get(`SELECT COUNT(*) AS n FROM users`)).n === before, 'and no account is created on the fly');
  await settle();
  assert(await logCount('AUTH_SSO_DENIED') >= 1, 'the refusal is in app_logs');

  const user = await createUser();
  const noGroup = await ssoLogin(identity('ania', user.email, 'rodzina'));
  assert(noGroup.status === 403 && noGroup.body.ssoDenied === 'group', `a user outside wlasciciel/admins/dietetyk is 403 (got ${noGroup.status})`);
  const wrongGroups = await ssoLogin(identity('ania', user.email, 'rodzina, wlasciciele,dietetyka'));
  assert(wrongGroups.status === 403, `group names must match exactly, not by prefix (got ${wrongGroups.status})`);
  const emptyGroups = await ssoLogin({ 'Remote-User': 'ania', 'Remote-Email': user.email });
  assert(emptyGroups.status === 403, `no Remote-Groups at all is 403 (got ${emptyGroups.status})`);
  assert(await sessionCount(user.id) === 0, 'neither refusal created a session');

  const dupUser = await ssoLogin({ ...identity('ania', user.email), 'Remote-User': ['ania', 'marcin'] });
  assert(dupUser.status === 400, `a repeated Remote-User is 400 (got ${dupUser.status})`);
  for (const bad of ['Ania', 'an ia', 'ania;rm', '']) {
    const r = await ssoLogin(identity(bad, user.email));
    // '' is "no header" to an HTTP client that drops empty values; either way, no session.
    assert(r.status === 400 || r.status === 401, `Remote-User "${bad}" is refused (got ${r.status})`);
  }
  const dupEmail = await ssoLogin({ ...identity('ania', user.email), 'Remote-Email': [user.email, 'x@evil.invalid'] });
  assert(dupEmail.status === 400, `a repeated Remote-Email is 400 (got ${dupEmail.status})`);
  assert(await sessionCount(user.id) === 0, 'still no session');

  const pending = await createUser({ status: 'pending' });
  const pend = await ssoLogin(identity('nowy', pending.email));
  assert(pend.status === 403 && pend.body.ssoDenied === 'inactive', `a pending invitation is not an account yet (got ${pend.status})`);

  // The owner's two Authelia users (decision 2026-10-11): `marcin` in `wlasciciel` maps to the
  // private everyday account, `admin` in `admins` to the account that is admin IN THE DATABASE.
  const ownerPrivate = await createUser();
  const ownerSso = await ssoLogin(identity('marcin', ownerPrivate.email, 'wlasciciel'));
  assert(ownerSso.status === 200, `the owner group admits to the host (got ${ownerSso.status})`);
  const ownerHeaders = identity('marcin', ownerPrivate.email, 'wlasciciel');
  const ownerProfile = await call('GET', '/api/user/profile', { token: ownerSso.body.token, headers: ownerHeaders });
  assert(ownerProfile.status === 200 && ownerProfile.body.username === ownerPrivate.username && ownerProfile.body.role === 'user', 'as the private account, with its own role');
  const ownerAdmin = await call('GET', '/api/admin/users', { token: ownerSso.body.token, headers: ownerHeaders });
  assert(ownerAdmin.status === 403, `the owner group grants no admin rights in the app (got ${ownerAdmin.status})`);

  const plain = await createUser();
  const asAdminsGroup = await ssoLogin(identity('ania', plain.email, 'admins'));
  assert(asAdminsGroup.status === 200, 'membership of `admins` in Authelia admits to the host');
  const adminPanel = await call('GET', '/api/admin/users', { token: asAdminsGroup.body.token, headers: identity('ania', plain.email, 'admins') });
  assert(adminPanel.status === 403, `but the admin role still comes from the database (got ${adminPanel.status})`);
  const realAdmin = await createUser({ role: 'admin' });
  const adminSso = await ssoLogin(identity('marcin', realAdmin.email, 'admins'));
  const adminOk = await call('GET', '/api/admin/users', { token: adminSso.body.token, headers: identity('marcin', realAdmin.email, 'admins') });
  assert(adminOk.status === 200, `an account that IS admin in the database keeps its role over SSO (got ${adminOk.status})`);
}

async function testSessionBinding() {
  console.log('\n--- TEST: an SSO session is worth nothing without the matching identity ---');
  flagOn();
  const a = await createUser();
  const b = await createUser();
  const aHeaders = identity('ania', a.email);
  const bHeaders = identity('bartek', b.email);
  const aToken = (await ssoLogin(aHeaders)).body.token;

  const bare = await call('GET', '/api/user/profile', { token: aToken });
  assert(bare.status === 401 && bare.body.ssoReauth === true, `the SSO token without headers (port-forward, copied token) is 401 (got ${bare.status})`);

  const switched = await call('GET', '/api/user/profile', { token: aToken, headers: bHeaders });
  assert(switched.status === 401 && switched.body.ssoReauth === true, `A's token under B's identity is refused (got ${switched.status})`);
  const bLogin = await ssoLogin(bHeaders);
  const bProfile = await call('GET', '/api/user/profile', { token: bLogin.body.token, headers: bHeaders });
  assert(bProfile.status === 200 && bProfile.body.username === b.username, 'and the new identity gets a session of its own account');

  const aPassword = (await passwordLogin(a.username)).token;
  const pwSwitched = await call('GET', '/api/user/profile', { token: aPassword, headers: bHeaders });
  assert(pwSwitched.status === 401 && pwSwitched.body.ssoReauth === true, 'a PASSWORD session of another account than Authelia names is refused too');
  const pwSame = await call('GET', '/api/user/profile', { token: aPassword, headers: aHeaders });
  assert(pwSame.status === 200, 'a password session of the same account passes');
  const pwBreakGlass = await call('GET', '/api/user/profile', { token: aPassword });
  assert(pwBreakGlass.status === 200, 'and works without headers (break-glass)');
  const malformed = await call('GET', '/api/user/profile', { token: aPassword, headers: { ...aHeaders, 'Remote-User': ['ania', 'ania'] } });
  assert(malformed.status === 400, `a repeated identity header on a protected route is 400 (got ${malformed.status})`);

  flagOff();
  const afterOff = await call('GET', '/api/user/profile', { token: aToken, headers: aHeaders });
  assert(afterOff.status === 401, `an SSO session does not outlive the flag (got ${afterOff.status})`);
  const pwAfterOff = await call('GET', '/api/user/profile', { token: aPassword });
  assert(pwAfterOff.status === 200, 'while password sessions carry on');

  console.log('\n--- TEST: machine routes ignore a forged identity ---');
  flagOn();
  const webhook = await call('POST', '/api/integrations/apple-health/sync_doesnotexist_00000000', { headers: aHeaders, body: { data: {} } });
  assert(webhook.status === 404, `the Apple Health webhook answers by its token alone (got ${webhook.status})`);
  const shared = await call('GET', '/api/public/shared-reports/doesnotexist0000000000', { headers: aHeaders });
  assert(shared.status === 404, `the shared report answers by its token alone (got ${shared.status})`);
}

async function testLogout() {
  console.log('\n--- TEST: logout goes through the portal ---');
  flagOn();
  const user = await createUser();
  const headers = identity('ania', user.email);
  const token = (await ssoLogin(headers)).body.token;
  const out = await call('POST', '/api/logout', { token, headers });
  assert(out.status === 200 && out.body.logoutUrl === LOGOUT_URL, `an SSO logout answers with the portal URL (got ${JSON.stringify(out.body)})`);
  assert(!(await db.get(`SELECT 1 FROM sessions WHERE token = ?`, [token])), 'and the app session is deleted');

  delete process.env.SSO_LOGOUT_URL;
  process.env.APP_URL = 'https://dietetyk.example';
  try {
    const t2 = (await ssoLogin(headers)).body.token;
    const out2 = await call('POST', '/api/logout', { token: t2, headers });
    assert(out2.body.logoutUrl === 'https://auth.renacode.com/logout?rd=https%3A%2F%2Fdietetyk.example%2F', `without SSO_LOGOUT_URL it is built from APP_URL (got ${out2.body.logoutUrl})`);
  } finally {
    delete process.env.APP_URL;
  }

  const breakGlass = (await passwordLogin(user.username)).token;
  const out3 = await call('POST', '/api/logout', { token: breakGlass });
  assert(out3.status === 200 && out3.body.logoutUrl === undefined, 'a break-glass logout has no portal to go to');

  flagOff();
  const plain = (await passwordLogin(user.username)).token;
  const out4 = await call('POST', '/api/logout', { token: plain, headers });
  assert(out4.status === 200 && out4.body.logoutUrl === undefined, 'with the flag off a forged header earns no redirect');
}

async function testEmailIsTheLogin() {
  console.log('\n--- TEST: the e-mail address is the SSO login ---');
  flagOn();
  const user = await createUser();
  const headers = identity('ania', user.email);
  const token = (await ssoLogin(headers)).body.token;
  const pwRowsBefore = (await db.get(`SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE ?`, [`%pwcheck_user:${user.id}`])).n;
  const change = await call('POST', '/api/user/profile', { token, headers, body: { email: 'new@owner.invalid', currentPassword: PASSWORD } });
  assert(change.status === 409 && change.body.ssoManagedEmail === true, `changing the address through Authelia is refused even with the password (got ${change.status})`);
  assert(/Authelii/.test(change.body.error), 'with a message pointing at Authelia');
  assert((await db.get(`SELECT email FROM users WHERE id = ?`, [user.id])).email === user.email, 'the address is unchanged');
  const pwRowsAfter = (await db.get(`SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE ?`, [`%pwcheck_user:${user.id}`])).n;
  assert(pwRowsAfter === pwRowsBefore, 'and no password attempt was counted');
  const same = await call('POST', '/api/user/profile', { token, headers, body: { email: user.email, first_name: 'Ania' } });
  assert(same.status === 200, `re-sending the unchanged address with the rest of the form still saves (got ${same.status})`);
  const pwSession = (await passwordLogin(user.username)).token;
  const viaPw = await call('POST', '/api/user/profile', { token: pwSession, headers, body: { email: 'new@owner.invalid', currentPassword: PASSWORD } });
  assert(viaPw.status === 409, 'a password session that came through Authelia is refused the same way');

  console.log('\n--- TEST: a break-glass change follows Authelia and is not undone later ---');
  const newEmail = `moved_${user.username}@owner.invalid`;
  const breakGlass = (await passwordLogin(user.username)).token;
  const moved = await call('POST', '/api/user/profile', { token: breakGlass, body: { email: newEmail, currentPassword: PASSWORD } });
  assert(moved.status === 200, `without identity headers (port-forward) the change goes through with the password (got ${moved.status})`);
  const hist = await db.get(`SELECT email, previous_email, email_changed_by_session FROM users WHERE id = ?`, [user.id]);
  assert(hist.email === newEmail && hist.previous_email === null && hist.email_changed_by_session === null, 'and is not recorded as undoable');
  const newHeaders = identity('ania', newEmail);
  const ssoAfter = (await ssoLogin(newHeaders)).body.token;
  const logoutAll = await call('POST', '/api/user/logout-all', { token: ssoAfter, headers: newHeaders });
  assert(logoutAll.status === 200 && logoutAll.body.emailReverted === false, `"log out other devices" from SSO does not revert it (got ${JSON.stringify(logoutAll.body)})`);
  assert((await db.get(`SELECT email FROM users WHERE id = ?`, [user.id])).email === newEmail, 'the address still matches Authelia');
  assert(/portalu logowania/.test(logoutAll.body.message), 'and the answer says SSO devices will come back by themselves');
  const still = await call('GET', '/api/user/profile', { token: ssoAfter, headers: newHeaders });
  assert(still.status === 200, 'the SSO session that asked keeps working');

  flagOff();
  const off = await createUser();
  const offToken = (await passwordLogin(off.username)).token;
  const offChange = await call('POST', '/api/user/profile', { token: offToken, headers: identity('x', off.email), body: { email: `n_${off.email}`, currentPassword: PASSWORD } });
  assert(offChange.status === 200, 'with the flag off the e-mail change works as before');
  const offHist = await db.get(`SELECT previous_email FROM users WHERE id = ?`, [off.id]);
  assert(offHist.previous_email === off.email, 'and stays undoable as before');
}

async function testSensitiveActionsNeedThePassword() {
  console.log('\n--- TEST: an SSO session is not a fresh authentication ---');
  flagOn();
  const user = await createUser();
  const headers = identity('ania', user.email);
  const token = (await ssoLogin(headers)).body.token;

  const pw = await call('POST', '/api/user/change-password', { token, headers, body: { newPassword: 'brandnew123' } });
  assert(pw.status === 400, `changing the password needs the current one (got ${pw.status})`);
  const setup = await call('POST', '/api/user/setup-2fa', { token, headers, body: {} });
  assert(setup.status === 400 && setup.body.requirePassword === true, `enabling the app's 2FA needs the password (got ${setup.status})`);
  const elsewhere = await call('POST', '/api/user/send-weekly-summary', { token, headers, body: { email: 'x@evil.invalid' } });
  assert(elsewhere.status === 400 && elsewhere.body.requirePassword === true, `a summary to another address needs the password (got ${elsewhere.status})`);
  const del = await call('DELETE', '/api/user/account', { token, headers, body: {} });
  assert(del.status === 400, `deleting the account needs the password (got ${del.status})`);

  const ok = await call('POST', '/api/user/change-password', { token, headers, body: { currentPassword: PASSWORD, newPassword: 'brandnew123' } });
  assert(ok.status === 200 && /portalu logowania/.test(ok.body.message), 'with it the change goes through, and says SSO devices are not cut off');
  const still = await call('GET', '/api/user/profile', { token, headers });
  assert(still.status === 200, 'the SSO session that changed it survives, like a password session would');
}

function testDotenvCannotSetTheFlag() {
  console.log('\n--- TEST: SSO_NAGLOWKI comes only from the pod spec, never from .env ---');
  // dotenv stubbed to do what a .env line `SSO_NAGLOWKI=1` would do.
  const script = `
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'dotenv') return { config: () => { process.env.SSO_NAGLOWKI = '1'; } };
      return orig.call(this, request, ...rest);
    };
    require(${JSON.stringify(path.join(BACKEND_DIR, 'config.js'))});
    process.stdout.write(String(process.env.SSO_NAGLOWKI));
  `;
  const env = { ...process.env };
  delete env.SSO_NAGLOWKI;
  const fromDotenv = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert(fromDotenv.stdout === 'undefined', `a value loaded from .env is dropped (got ${fromDotenv.stdout} ${fromDotenv.stderr})`);
  const fromPod = spawnSync(process.execPath, ['-e', script], { env: { ...env, SSO_NAGLOWKI: '1' }, encoding: 'utf8' });
  assert(fromPod.stdout === '1', `the pod's own variable is kept (got ${fromPod.stdout})`);
}

async function run() {
  await db.initDb();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await testFlagOffIgnoresHeaders();
    await testSsoLoginByEmail();
    await testRefusals();
    await testSessionBinding();
    await testLogout();
    await testEmailIsTheLogin();
    await testSensitiveActionsNeedThePassword();
    testDotenvCannotSetTheFlag();
  } finally {
    flagOff();
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 SSO IDENTITY TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ SSO IDENTITY TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
