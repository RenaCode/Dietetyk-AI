// Tests that the brute-force limit holds under PARALLEL requests, not only sequential ones.
//
// The bug this pins down (audit 2026-10, M1): services/loginAttempts.js gated a password or
// TOTP comparison with isLocked() and counted the failure with recordFailure() only AFTER
// bcrypt - a read-modify-write with ~100 ms in the middle. Every request of a parallel burst
// read the counter before any of them had written a failure, so all of them reached the
// comparison. The audit PoC sent 120 parallel logins: 20 wrong passwords reached bcrypt
// against MAX_ATTEMPTS = 5, and the correct one (16th) logged in. The same race gave ~20 TOTP
// guesses per 15 minutes instead of 5.
//
// End-to-end over a real express app against a throwaway SQLite file, because the race lives
// between concurrent requests - no single-call unit test can show it.
//
// Run with: node tests/test-login-race.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-login-race-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-login-race';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-login-race';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MAX_ATTEMPTS } = require('../services/loginAttempts');

const PASSWORD = 'Correct123';
const BURST = 40;

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
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function post(baseUrl, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createUser(overrides = {}) {
  const username = 'race_' + Math.random().toString(36).substring(2, 9);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret, role, status)
    VALUES (?, ?, ?, ?, ?, 'user', 'active')
  `, [username, await bcrypt.hash(PASSWORD, 10), 'sync_' + Math.random().toString(36).substring(2), overrides.totp_enabled || 0, overrides.totp_secret || null]);
  return { id: result.id, username };
}

function countStatuses(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

async function testParallelPasswordBurst(baseUrl) {
  console.log('\n--- TEST: a parallel burst of wrong passwords is capped at MAX_ATTEMPTS ---');
  const user = await createUser();

  // The correct password is placed LAST in the burst - after the limit - exactly like the PoC's
  // 16th-of-120 that used to get in.
  const attempts = [];
  for (let i = 0; i < BURST; i++) {
    const password = i === BURST - 1 ? PASSWORD : `wrong${i}`;
    attempts.push(post(baseUrl, '/api/login', { username: user.username, password }));
  }
  const results = await Promise.all(attempts);
  const counts = countStatuses(results);
  console.log(`   status counts: ${JSON.stringify(counts)}`);

  const reachedBcrypt = (counts[401] || 0) + (counts[200] || 0);
  assert(reachedBcrypt <= MAX_ATTEMPTS, `at most ${MAX_ATTEMPTS} of ${BURST} parallel attempts reached the password check (got ${reachedBcrypt})`);
  assert(!counts[200], 'the correct password at the end of the burst did NOT log in - the account was already locked');
  assert((counts[429] || 0) >= BURST - MAX_ATTEMPTS, 'everything beyond the limit was refused with 429');
}

async function testParallelTotpBurst(baseUrl) {
  console.log('\n--- TEST: a parallel burst of wrong TOTP codes is capped at MAX_ATTEMPTS ---');
  const secret = authenticator.generateSecret();
  const user = await createUser({ totp_enabled: 1, totp_secret: secret });

  const login = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(login.body.status === 'require_2fa', 'the password step hands out a temp token');

  const current = authenticator.generate(secret);
  const attempts = [];
  for (let i = 0; i < BURST; i++) {
    // Six-digit codes that are guaranteed wrong.
    let code = String(100000 + i);
    if (code === current) code = String(200000 + i);
    attempts.push(post(baseUrl, '/api/login-2fa', { tempToken: login.body.tempToken, code }));
  }
  const results = await Promise.all(attempts);
  const counts = countStatuses(results);
  console.log(`   status counts: ${JSON.stringify(counts)}`);

  assert((counts[400] || 0) <= MAX_ATTEMPTS, `at most ${MAX_ATTEMPTS} of ${BURST} parallel TOTP guesses were compared (got ${counts[400] || 0})`);
}

async function testSequentialStillWorks(baseUrl) {
  console.log('\n--- TEST: the ordinary sequential flow is unchanged ---');
  const user = await createUser();
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const r = await post(baseUrl, '/api/login', { username: user.username, password: 'nope' + i });
    assert(r.status === 401, `wrong password #${i + 1} -> 401`);
  }
  const ok = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(ok.status === 200 && typeof ok.body.token === 'string', 'the correct password below the limit logs in');

  // A success gives the slots back: the counter starts again from zero.
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await post(baseUrl, '/api/login', { username: user.username, password: 'again' + i });
    assert(r.status === 401, `after a success, wrong password #${i + 1} is compared again (401, not 429)`);
  }
  const locked = await post(baseUrl, '/api/login', { username: user.username, password: PASSWORD });
  assert(locked.status === 429, `attempt #${MAX_ATTEMPTS + 1} after ${MAX_ATTEMPTS} failures is locked out, even with the right password`);
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    await testParallelPasswordBurst(baseUrl);
    await testParallelTotpBurst(baseUrl);
    await testSequentialStillWorks(baseUrl);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 LOGIN RACE TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ LOGIN RACE TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
