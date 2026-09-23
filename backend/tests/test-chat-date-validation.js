// Tests for how POST /api/chat handles the `date` field of the request body
// (routes/chat.js).
//
// The bug: `date` was taken straight from req.body and never validated. Anything that is not
// YYYY-MM-DD made `new Date(queryDate)` an Invalid Date, so the history-window arithmetic
// threw a RangeError out of toISOString(); the catch at the bottom of the handler turned
// that into a 500 with the message "Nie udało się uzyskać odpowiedzi od Dietetyka AI". The
// user was told the AI had failed when in fact their client had sent a malformed field - and
// no amount of retrying would have helped. routes/dashboard.js has guarded its ?date= this
// way for a while (resolveQueryDate); the chat simply never adopted it.
//
// Run with: node tests/test-chat-date-validation.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-chat-date-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-chat-date';
process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-chat-date';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

const TEST_USER_ID = 1;
const captured = { prompts: [] };

stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async (prompt) => {
    captured.prompts.push(prompt);
    return 'stubbed reply';
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});
stubModule('utils/weatherContext.js', {
  getWeatherAndTimeContext: async () => '',
  getUserLocationOverride: async () => null
});
// routes/chat.js applies requireAuth itself (unlike the dashboard router, which relies on
// server.js mounting it). The identity is not what is under test here, so the middleware is
// replaced with one that simply declares the test user.
stubModule('middleware/auth.js', {
  requireAuth: (req, res, next) => { req.user = { id: TEST_USER_ID, username: 'chat_date_test', role: 'admin' }; next(); },
  requireAdmin: (req, res, next) => next()
});
// The AI rate limiter counts per user and this file sends a dozen messages in a row; the
// module already exempts a test run, so we only have to say that this is one.
process.env.NODE_ENV = 'test';

const express = require('express');
const db = require('../db');
let server;
let baseUrl;

function todayWarsaw() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function postJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      `${baseUrl}${pathname}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            reject(new Error(`Response is not JSON (status ${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function startServer() {
  await db.initDb();
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, role, status)
     VALUES (?, 'chat_date_test', 'chatdate@example.com', 'x', 'admin', 'active')`,
    [TEST_USER_ID]
  );
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: TEST_USER_ID, username: 'chat_date_test', role: 'admin' }; next(); });
  app.use(require('../routes/chat'));

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function testMalformedDateDoesNotLookLikeAnAiFailure() {
  console.log('\n--- TEST: a date that is not YYYY-MM-DD ---');
  const today = todayWarsaw();

  for (const badDate of ['abc', '23.09.2026', '2026-9-3', '', '2026-13-45', 12345, { nope: true }]) {
    captured.prompts.length = 0;
    const res = await postJson('/api/chat', { message: 'Co dziś zjeść?', date: badDate });
    const shown = typeof badDate === 'object' ? JSON.stringify(badDate) : String(badDate);
    assert(res.status === 200, `date=${shown || '(empty)'} answers 200, not a 500 blamed on the AI`);
    assert(captured.prompts.length === 1, `date=${shown || '(empty)'} still reaches the model exactly once`);
    assert(captured.prompts[0].includes(`na dzień ${today}`),
      `date=${shown || '(empty)'} falls back to today, the same as sending no date at all`);
  }
}

async function testValidDateIsStillHonoured() {
  console.log('\n--- TEST: a well-formed date is used as given ---');
  captured.prompts.length = 0;
  const res = await postJson('/api/chat', { message: 'Co jadłem?', date: '2026-03-15' });
  assert(res.status === 200, 'a well-formed past date is answered normally');
  assert(captured.prompts[0].includes('na dzień 2026-03-15'),
    'the requested date, not today, is what the prompt describes - the validation must not flatten every request onto today');
}

async function testMissingDateStillDefaultsToToday() {
  console.log('\n--- TEST: no date field at all ---');
  captured.prompts.length = 0;
  const res = await postJson('/api/chat', { message: 'Cześć' });
  assert(res.status === 200, 'a request without a date is answered normally');
  assert(captured.prompts[0].includes(`na dzień ${todayWarsaw()}`), 'it defaults to today, as before');
}

async function run() {
  try {
    await startServer();
    await testMalformedDateDoesNotLookLikeAnAiFailure();
    await testValidDateIsStillHonoured();
    await testMissingDateStillDefaultsToToday();
    console.log('\n✅ ALL CHAT DATE VALIDATION TESTS PASSED');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
}

run();
