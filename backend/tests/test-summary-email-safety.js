// Tests that the summary emails cannot be turned into a phishing tool, and that a failing
// send does not leak provider details to the client.
//
// The bugs these pin down (audit 2026-10):
//
// M6. The username was interpolated raw into the HTML of the summary emails, and there was no
//     rule on what a username may contain. Together with the "send a test summary to this
//     address" endpoints, a username like `<a href="https://evil">Zweryfikuj konto</a>` sent
//     a phishing link from the application's own Mailgun domain to any address.
// L6. The send-*-summary endpoints appended err.message to the response - for Mailgun, the
//     raw API answer (`Mailgun API error: <status> - <body>`).
//
// Mailgun is replaced by a stub that records what would have been sent; with no meals or
// metrics the summary uses its fixed fallback text, so Gemini is never called.
//
// Run with: node tests/test-summary-email-safety.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-summary-safety-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-summary-safety';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-summary-safety';

const BACKEND_DIR = path.join(__dirname, '..');
const sent = [];
let mailgunFailure = null;
function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
stubModule('services/mailgun.js', {
  sendMailgunEmail: async (message) => {
    if (mailgunFailure) throw mailgunFailure;
    sent.push(message);
  }
});

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendDailySummaryForUser, sendWeeklySummaryForUser, sendMonthlySummaryForUser } = require('../services/summaries');

const EVIL_USERNAME = '<a href="https://evil.example">Zweryfikuj konto</a>';

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

async function post(baseUrl, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function testUsernameIsEscaped() {
  console.log('\n--- TEST: the username is escaped in every summary email ---');
  // A row that predates the username rule - the templates must be safe on their own.
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status)
    VALUES (?, 'x', 'sync_summary_safety_0000000000', 0, 'owner@example.invalid', 'user', 'active')
  `, [EVIL_USERNAME]);

  for (const [label, send] of [['daily', sendDailySummaryForUser], ['weekly', sendWeeklySummaryForUser], ['monthly', sendMonthlySummaryForUser]]) {
    sent.length = 0;
    await send(result.id, 'victim@example.invalid');
    const html = sent[0] && sent[0].html;
    assert(typeof html === 'string', `the ${label} summary was rendered`);
    assert(!html.includes('<a href="https://evil.example">'), `the ${label} summary contains no live link from the username`);
    assert(html.includes('&lt;a href=&quot;https://evil.example&quot;&gt;'), `the ${label} summary shows the username as escaped text`);
  }
  return result.id;
}

async function testRegistrationRejectsMarkup(baseUrl) {
  console.log('\n--- TEST: registration refuses a username that is not a plain name ---');
  await db.run(`INSERT INTO app_config (key, value) VALUES ('allow_public_registration', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const bad of [EVIL_USERNAME, 'someone@example.com', 'ab', 'x'.repeat(33)]) {
    const r = await post(baseUrl, '/api/register-public', { username: bad, password: 'Valid12345' });
    assert(r.status === 400, `register-public rejects ${JSON.stringify(bad.slice(0, 30))} (got ${r.status})`);
  }
  const good = await post(baseUrl, '/api/register-public', { username: 'jan.kowalski_1', password: 'Valid12345' });
  assert(good.status === 200, `a plain username still registers (got ${good.status})`);
}

async function testErrorDetailNotReturned(baseUrl, userId) {
  console.log('\n--- TEST: a Mailgun failure does not reach the client verbatim ---');
  const token = 'sess_summary_safety_' + 'e'.repeat(30);
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
    VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
  `, [token, userId]);

  mailgunFailure = new Error('Mailgun API error: 401 - Forbidden for domain mg.secret-config.example');
  const r = await post(baseUrl, '/api/user/send-daily-summary', {}, token);
  assert(r.status === 500, 'the failed send is a 500');
  assert(!JSON.stringify(r.body).includes('secret-config'), `the provider's message is not in the response (${r.body.error})`);

  mailgunFailure = Object.assign(new Error('Silnik e-mail (Mailgun) nie został jeszcze skonfigurowany przez administratora.'), { expose: true });
  const exposed = await post(baseUrl, '/api/user/send-daily-summary', {}, token);
  assert((exposed.body.error || '').includes('nie został jeszcze skonfigurowany'), 'an error marked `expose` still tells the user what to do');
  mailgunFailure = null;
}

async function run() {
  await db.initDb();
  const { server, baseUrl } = await startServer();
  try {
    const userId = await testUsernameIsEscaped();
    await testRegistrationRejectsMarkup(baseUrl);
    await testErrorDetailNotReturned(baseUrl, userId);
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 SUMMARY EMAIL SAFETY TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ SUMMARY EMAIL SAFETY TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
