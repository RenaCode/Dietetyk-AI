// Tests of the "is Google configured" flag the UI uses to hide Google sign-in and Google Fit.
//
// Audit 2026-10-03 (D1): the instance had no Google client, GET /api/auth/google answered 400,
// and the login screen still offered "Sign in with Google" to everyone. The frontend now asks
// GET /api/auth/google/enabled (public - it is called from the login screen) and Settings reads
// `google_configured` from the profile; both must say false until BOTH the Client ID and the
// secret are set, and the public endpoint must never echo the Client ID itself.
//
// Run with: node tests/test-google-enabled.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-google-enabled-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-google-enabled';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-google-enabled';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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

async function setConfig(key, value) {
  await db.run(`
    INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, value]);
}

async function createUserWithSession() {
  const username = 'gflag_' + Math.random().toString(36).substring(2, 8);
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, role, status)
    VALUES (?, 'x', ?, 0, 'user', 'active')
  `, [username, 'sync_' + 'd'.repeat(40) + Math.random().toString(36).substring(2, 6)]);
  const token = 'sess_' + Math.random().toString(36).substring(2) + 'y'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, result.id]);
  return token;
}

async function flags(baseUrl, token) {
  const pub = await fetch(`${baseUrl}/api/auth/google/enabled`);
  const pubText = await pub.text();
  const profile = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${token}` } });
  const profileBody = await profile.json();
  return { pubStatus: pub.status, pubText, pub: JSON.parse(pubText), profile: profileBody };
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    const token = await createUserWithSession();

    let f = await flags(baseUrl, token);
    assert(f.pubStatus === 200, 'GET /api/auth/google/enabled is public (no session needed)');
    assert(f.pub.enabled === false, 'no Google client -> enabled: false');
    assert(f.profile.google_configured === false, 'no Google client -> profile google_configured: false');

    await setConfig('google_client_id', 'test-client-id-123');
    f = await flags(baseUrl, token);
    assert(f.pub.enabled === false, 'Client ID without the secret -> still disabled');
    assert(f.profile.google_configured === false, 'Client ID without the secret -> profile flag still false');

    await setConfig('google_client_secret', 'test-client-secret');
    f = await flags(baseUrl, token);
    assert(f.pub.enabled === true, 'Client ID + secret -> enabled: true');
    assert(f.profile.google_configured === true, 'Client ID + secret -> profile google_configured: true');
    assert(!f.pubText.includes('test-client-id-123'), 'the public endpoint does not reveal the Client ID');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOOGLE ENABLED FLAG TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ GOOGLE ENABLED FLAG TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
