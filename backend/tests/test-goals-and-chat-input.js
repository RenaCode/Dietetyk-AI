// Two medium findings of the 2026-10-09 audit.
//
// S2  Silent default goals. Registration seeded every account with 2500 kcal / 150/250/80 g /
//     BMR 1800, indistinguishable from values the user chose, and services/summaries.js had a
//     second copy of the same defaults (`?? 2500` and so on). E-mails, the PDF for a doctor
//     and the chat then quoted those numbers as "your target". Now nothing is seeded, unset
//     goals come back as null, and every text a person reads says "brak celu".
// S6  POST /api/chat with a non-string `message` called .trim() outside the handler's try:
//     Express 4 does not catch a rejected async handler, so the request hung with no response
//     while counting against the AI limit. A malformed history entry produced a 500.
//
// Run with: node tests/test-goals-and-chat-input.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-goals-'));
process.env.DATABASE_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-goals';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-goals';

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
const prompts = [];
stubModule('config.js', {
  PORT: 0, genAI: {}, model: null,
  generateContentWithFallback: async (prompt) => { prompts.push(prompt); return 'stub reply'; },
  ACTIVE_GEMINI_MODEL: 'stub-model', DEFAULT_GEMINI_MODEL: 'stub-model',
  GEMINI_REQUEST_TIMEOUT_MS: 90000, GEMINI_WORST_CASE_MS: 180000
});
stubModule('services/mailgun.js', { sendMailgunEmail: async () => {} });
stubModule('utils/weatherContext.js', { getWeatherAndTimeContext: async () => '', getUserLocationOverride: async () => null });

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getUserSettings } = require('../services/summaries');
const { goalText } = require('../utils/defaultSettings');

async function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no response within ${ms} ms`)), ms))]);
}

async function run() {
  await db.initDb();
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use(require('../routes/auth'));
  app.use(require('../routes/chat'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n--- TEST (S2): registration seeds no goals, and unset goals read as "brak celu" ---');
    await db.run(`INSERT INTO app_config (key, value) VALUES ('allow_public_registration', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`);
    const reg = await fetch(`${baseUrl}/api/register-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'goals_user', password: 'goalspass123' })
    });
    assert(reg.status === 200 || reg.status === 201, `public registration succeeds (got ${reg.status})`);
    const user = await db.get(`SELECT id FROM users WHERE username = 'goals_user'`);
    const seeded = await db.all(`SELECT key FROM settings WHERE user_id = ? AND key IN ('target_calories', 'target_protein', 'target_carbs', 'target_fat', 'bmr')`, [user.id]);
    assert(seeded.length === 0, `no invented targets are stored (got ${seeded.map(r => r.key).join(', ') || 'none'})`);

    const goals = await getUserSettings(user.id);
    assert(goals.targetCalories === null && goals.bmr === null && goals.targetProtein === null, 'the e-mail/PDF settings say "not set", not 2500 / 1800 / 150');
    assert(goalText(goals.targetCalories, ' kcal') === 'brak celu (nieustawiony)', 'and the text a person reads says so');
    await db.run(`INSERT INTO settings (user_id, key, value) VALUES (?, 'target_calories', '1700')`, [user.id]);
    assert((await getUserSettings(user.id)).targetCalories === 1700, 'a goal the user set is used as is');

    console.log('\n--- TEST (S6): chat with a malformed message answers 400 instead of hanging ---');
    const token = 'sess_goals_chat_' + 'z'.repeat(30);
    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, absolute_expires_at, is_verified_2fa, is_temp)
      VALUES (?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'), 0, 0)
    `, [token, user.id]);
    const chat = (body) => withTimeout(fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    }), 3000);
    for (const [label, body] of [
      ['a number', { message: 123 }],
      ['an array', { message: ['a'] }],
      ['a null history entry', { message: 'hej', history: [null] }],
      ['a non-text history entry', { message: 'hej', history: [{ sender: 'user', text: 5 }] }],
      ['a non-array history', { message: 'hej', history: 'abc' }]
    ]) {
      const res = await chat(body);
      assert(res.status === 400, `${label} -> 400 (got ${res.status})`);
    }
    assert(prompts.length === 0, 'none of them reached the AI');

    const ok = await chat({ message: 'Jak mi idzie?', history: [{ sender: 'user', text: 'cześć' }, { sender: 'ai', text: 'Witaj' }] });
    assert(ok.status === 200, `a well-formed message still works (got ${ok.status})`);
    assert(/brak celu \(nieustawiony\)|nieustawiony przez użytkownika/.test(prompts[0] || ''), 'the chat prompt marks goals the user never set');
    assert(!/Białko: 150g/.test(prompts[0] || ''), 'and does not present 150 g of protein as the user\'s goal');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 GOALS AND CHAT INPUT TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ GOALS AND CHAT INPUT TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
