// Tests of the smaller credential-lifetime holes (audit 2026-10, L4).
//
// 1. A TOTP code was accepted for as long as it was valid, as many times as it was sent:
//    a code seen once (over a shoulder, or relayed live by a phishing page) was a second login.
// 2. Invitation tokens never expired - an `inv_` link sitting in a mailbox or a log stayed a
//    working "create this account" key, possibly for an admin account, for ever.
// 3. POST /api/user/verify-2fa (enabling 2FA from Settings) counted no failed attempts at all.
//
// Run with: node tests/test-2fa-replay-invitation.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-2fa-replay-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-2fa-replay';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-2fa-replay';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MAX_ATTEMPTS } = require('../services/loginAttempts');

const PASSWORD = 'Replay12345';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  app.use(require('../routes/account'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function call(baseUrl, method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function testTotpReplay(baseUrl) {
  console.log('\n--- TEST: a TOTP code works once ---');
  const secret = authenticator.generateSecret();
  const username = 'replay_' + Math.random().toString(36).substring(2, 8);
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status)
    VALUES (?, ?, ?, 1, ?, 'user', 'active')
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_replay_' + 'f'.repeat(24), secret]);

  // Both logins below must fall inside ONE 30-second TOTP step, or the test would be proving
  // that a code expires rather than that it is burned. Wait out the tail of a step if needed.
  const msIntoStep = Date.now() % 30000;
  if (msIntoStep > 25000) await new Promise((r) => setTimeout(r, 30000 - msIntoStep + 200));

  const code = authenticator.generate(secret);
  const first = await call(baseUrl, 'POST', '/api/login', { username, password: PASSWORD });
  const ok = await call(baseUrl, 'POST', '/api/login-2fa', { tempToken: first.body.tempToken, code });
  assert(ok.status === 200 && typeof ok.body.token === 'string', 'the first use of the code logs in');

  const second = await call(baseUrl, 'POST', '/api/login', { username, password: PASSWORD });
  const replay = await call(baseUrl, 'POST', '/api/login-2fa', { tempToken: second.body.tempToken, code });
  assert(replay.status === 400 && !replay.body.token, `the same code a second time is refused (got ${replay.status})`);
}

async function testInvitationExpiry(baseUrl) {
  console.log('\n--- TEST: invitations expire ---');
  const fresh = 'inv_fresh_' + 'a'.repeat(30);
  const stale = 'inv_stale_' + 'b'.repeat(30);
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, invitation_token, invitation_expires_at)
    VALUES ('pending_fresh', 'x', 'sync_pending_fresh_00000000', 0, 'fresh@example.invalid', 'user', 'pending', ?, datetime('now', '+7 days'))
  `, [fresh]);
  await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, invitation_token, invitation_expires_at)
    VALUES ('pending_stale', 'x', 'sync_pending_stale_00000000', 0, 'stale@example.invalid', 'user', 'pending', ?, datetime('now', '-1 day'))
  `, [stale]);

  const freshStatus = await call(baseUrl, 'GET', `/api/invitation-status?token=${fresh}`);
  assert(freshStatus.status === 200, 'a fresh invitation is recognised');
  const staleStatus = await call(baseUrl, 'GET', `/api/invitation-status?token=${stale}`);
  assert(staleStatus.status === 404, 'an expired invitation is answered like an unknown one');
  const staleRegister = await call(baseUrl, 'POST', '/api/register-invitation', { token: stale, username: 'late_user', password: 'Valid12345' });
  assert(staleRegister.status === 404, 'an expired invitation cannot be used to register');
}

async function testVerify2faIsLimited(baseUrl) {
  console.log('\n--- TEST: enabling 2FA from Settings counts failed codes ---');
  const username = 'enable2fa_' + Math.random().toString(36).substring(2, 8);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES (?, ?, ?, 0, 'user', 'active')
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_enable2fa_' + 'g'.repeat(20)]);
  const sessionToken = 'sess_enable2fa_' + 'h'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [sessionToken, result.id]);

  const setup = await call(baseUrl, 'POST', '/api/user/setup-2fa', {}, sessionToken);
  assert(setup.status === 200 && setup.body.tempToken, 'setup-2fa hands out a temp token');
  const current = authenticator.generate(setup.body.secret);

  const statuses = [];
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    let code = String(300000 + i);
    if (code === current) code = String(400000 + i);
    statuses.push((await call(baseUrl, 'POST', '/api/user/verify-2fa', { tempToken: setup.body.tempToken, code }, sessionToken)).status);
  }
  assert(statuses.slice(0, MAX_ATTEMPTS).every(s => s === 400), `the first ${MAX_ATTEMPTS} wrong codes are compared (400)`);
  assert(statuses[MAX_ATTEMPTS] === 429, `wrong code #${MAX_ATTEMPTS + 1} is locked out (got ${statuses[MAX_ATTEMPTS]})`);
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    await testTotpReplay(baseUrl);
    await testInvitationExpiry(baseUrl);
    await testVerify2faIsLimited(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 2FA REPLAY / INVITATION TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ 2FA REPLAY / INVITATION TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
