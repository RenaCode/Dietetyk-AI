// Tests the account-wide brute-force counter that does not depend on the client IP.
//
// The bug this pins down (audit 2026-10-04, D-3): every key in services/loginAttempts.js
// contained the IP. While all traffic reached the backend as Traefik's 10.42.0.1 that made the
// per-account key an accidental global limit; once Traefik switched to
// externalTrafficPolicy: Local (03.10.2026) each client address got its own 5 guesses per
// account per 15 minutes, so N addresses meant 5*N guesses. The fix adds a third counter keyed
// on the account alone (ACCOUNT_MAX_ATTEMPTS).
//
// The test app trusts X-Forwarded-For outright so each request can pose as a different client;
// the production trust-proxy setting is tested separately in tests/test-trust-proxy.js.
//
// Run with: node tests/test-login-attempts.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-login-attempts-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-login-attempts';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-login-attempts';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MAX_ATTEMPTS, ACCOUNT_MAX_ATTEMPTS } = require('../services/loginAttempts');

const PASSWORD = 'Correct123';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let ipSeq = 0;
// A fresh documentation-range address (RFC 5737) per call unless one is given.
function nextIp() {
  ipSeq += 1;
  return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

async function login(baseUrl, username, password, ip = nextIp()) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password })
  });
  return res.status;
}

async function createUser() {
  const username = 'att_' + Math.random().toString(36).substring(2, 9);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, role, status)
    VALUES (?, ?, ?, 'user', 'active')
  `, [username, await bcrypt.hash(PASSWORD, 4), 'sync_' + Math.random().toString(36).substring(2)]);
  return { id: result.id, username };
}

async function testDistributedGuessingIsCapped(baseUrl) {
  console.log(`\n--- TEST 1: ${ACCOUNT_MAX_ATTEMPTS} wrong passwords from ${ACCOUNT_MAX_ATTEMPTS} different IPs lock the account ---`);
  const user = await createUser();
  for (let i = 0; i < ACCOUNT_MAX_ATTEMPTS; i++) {
    const status = await login(baseUrl, user.username, 'Wrong' + i);
    if (status !== 401) throw new Error(`❌ attempt ${i + 1} should be a plain 401, got ${status}`);
  }
  console.log(`✅ ${ACCOUNT_MAX_ATTEMPTS} attempts from distinct IPs were each answered 401`);
  assert(await login(baseUrl, user.username, 'WrongAgain') === 429, 'the next wrong password from a NEW IP gets 429');
  assert(await login(baseUrl, user.username, PASSWORD) === 429, 'even the correct password from a new IP is refused while the account is locked');
}

async function testSuccessResetsAccountCounter(baseUrl) {
  console.log('\n--- TEST 2: a correct password after spread-out failures logs in and resets the counter ---');
  const user = await createUser();
  const homeIp = nextIp();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await login(baseUrl, user.username, 'Wrong' + i, homeIp);
  }
  for (let i = 0; i < ACCOUNT_MAX_ATTEMPTS - MAX_ATTEMPTS - 1; i++) {
    await login(baseUrl, user.username, 'Wrong' + i);
  }
  assert(await login(baseUrl, user.username, PASSWORD) === 200, `the correct password succeeds after ${ACCOUNT_MAX_ATTEMPTS - 1} spread-out failures`);
  const left = await db.get(`SELECT COUNT(*) AS n FROM login_attempts WHERE key = ?`, [`*::login_user:${user.id}`]);
  assert(left.n === 0, 'the account-wide counter is cleared by the successful login');
  for (let i = 0; i < ACCOUNT_MAX_ATTEMPTS - 1; i++) {
    await login(baseUrl, user.username, 'Wrong' + i);
  }
  assert(await login(baseUrl, user.username, PASSWORD) === 200, 'after the reset the account again tolerates a full window of failures');
}

async function testLockIsPerAccount(baseUrl) {
  console.log('\n--- TEST 3: locking account A does not lock account B ---');
  const a = await createUser();
  const b = await createUser();
  for (let i = 0; i <= ACCOUNT_MAX_ATTEMPTS; i++) {
    await login(baseUrl, a.username, 'Wrong' + i);
  }
  assert(await login(baseUrl, a.username, PASSWORD) === 429, 'account A is locked');
  assert(await login(baseUrl, b.username, PASSWORD) === 200, 'account B still logs in');
}

async function testPerIpLimitStillApplies(baseUrl) {
  console.log('\n--- TEST 4: the per-IP limit still triggers first for a single source ---');
  const user = await createUser();
  const ip = nextIp();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await login(baseUrl, user.username, 'Wrong' + i, ip);
  }
  assert(await login(baseUrl, user.username, PASSWORD, ip) === 429, `the same IP is locked after ${MAX_ATTEMPTS} failures`);
  assert(await login(baseUrl, user.username, PASSWORD, nextIp()) === 200, 'another IP is not (the account-wide limit is far away)');
}

async function main() {
  console.log('=== LOGIN ATTEMPTS (ACCOUNT-WIDE) TESTS ===');
  let server;
  try {
    await db.initDb();
    const started = await startServer();
    server = started.server;
    await testDistributedGuessingIsCapped(started.baseUrl);
    await testSuccessResetsAccountCounter(started.baseUrl);
    await testLockIsPerAccount(started.baseUrl);
    await testPerIpLimitStillApplies(started.baseUrl);
    console.log('\n🎉 LOGIN ATTEMPTS TESTS PASSED\n');
    server.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ LOGIN ATTEMPTS TESTS FAILED');
    if (server) server.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
