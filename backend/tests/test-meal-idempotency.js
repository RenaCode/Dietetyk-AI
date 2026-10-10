// Idempotency of POST /api/meals (audit 2026-10-09, W2).
//
// Production, 08.10.2026: a phone dropped the connection during a photo analysis, the server
// finished and saved the meal anyway, the app said "could not connect", and the user sent the
// same photo again - a second meal with a different estimate (447 vs 525 kcal), counted twice
// until they deleted it by hand. The in-memory 15-second duplicate window could not catch it:
// it starts when the first request FINISHES, and the analysis itself took 15-28 s.
//
// Now the browser sends one idempotency key per form submission and re-sends it on retry.
// These tests drive the real route with Gemini stubbed: a retry with the same key - after the
// first request finished, or while it is still running - never produces a second meal, and a
// failed analysis frees the key for a real retry.
//
// Run with: node tests/test-meal-idempotency.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-meal-idempotency-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-meal-idempotency';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-meal-idempotency';

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

const gemini = { calls: 0, delayMs: 0, failNext: false };
stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async () => {
    gemini.calls++;
    if (gemini.delayMs) await new Promise(r => setTimeout(r, gemini.delayMs));
    if (gemini.failNext) {
      gemini.failNext = false;
      throw new Error('stubbed Gemini failure');
    }
    // A different estimate on every call, as the real model gives for the same photo.
    return JSON.stringify({ calories: 440 + gemini.calls * 10, protein: 30, carbs: 50, fat: 20, food_items: [] });
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});

const express = require('express');
const db = require('../db');

// The route's own 15-second in-memory duplicate window is real, and it would hide the bug for
// retries that come quickly. Production's retry came after the first request had finished
// AND after that window; advancing the clock reproduces it.
const realNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;
const advanceClock = (ms) => { clockOffsetMs += ms; };

let USER_ID;

async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/meals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const mealCount = async () => (await db.get(`SELECT COUNT(*) AS n FROM meals WHERE user_id = ?`, [USER_ID])).n;
const newKey = () => require('crypto').randomUUID();

async function run() {
  await db.initDb();
  USER_ID = (await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES ('idem_user', 'x', 'sync_idem_user_xxxxxxxxxxxxxx', 'admin', 'active')`
  )).id;

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.user = { id: USER_ID, username: 'idem_user', role: 'admin' }; next(); });
  app.use(require('../routes/meals'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n--- TEST: a retry after the first request finished returns the saved meal ---');
    const key = newKey();
    const first = await post(baseUrl, { rawText: 'owsianka z jagodami', idempotencyKey: key });
    assert(first.status === 201, `the first submission saves the meal (got ${first.status})`);
    advanceClock(60 * 1000);
    const retry = await post(baseUrl, { rawText: 'owsianka z jagodami', idempotencyKey: key });
    assert(retry.status === 200 && retry.body.replayed === true, `the retry is answered from the saved submission (got ${retry.status})`);
    assert(retry.body.meals[0].id === first.body.meals[0].id && retry.body.meals[0].calories === first.body.meals[0].calories,
      'with the same meal and the same estimate');
    assert(await mealCount() === 1, 'exactly one meal exists');
    assert(gemini.calls === 1, 'and the AI was asked once');

    console.log('\n--- TEST: a retry while the first request is still analysing does not start a second one ---');
    const key2 = newKey();
    gemini.delayMs = 400;
    const slow = post(baseUrl, { rawText: 'kanapka z serem', idempotencyKey: key2 });
    await new Promise(r => setTimeout(r, 100));
    advanceClock(60 * 1000);
    const during = await post(baseUrl, { rawText: 'kanapka z serem', idempotencyKey: key2 });
    assert(during.status === 409 && during.body.pending === true, `a retry during the analysis gets 409 pending (got ${during.status})`);
    const slowDone = await slow;
    gemini.delayMs = 0;
    assert(slowDone.status === 201, 'the first request still completes');
    assert(await mealCount() === 2, 'one meal for this submission, not two');
    assert(gemini.calls === 2, 'and no second analysis was started');

    console.log('\n--- TEST: a failed analysis frees the key for a real retry ---');
    const key3 = newKey();
    gemini.failNext = true;
    const failed = await post(baseUrl, { rawText: 'zupa pomidorowa', idempotencyKey: key3 });
    assert(failed.status === 500, `the failed analysis answers 500 (got ${failed.status})`);
    assert(!/stubbed Gemini failure/.test(failed.body.error || ''), 'without the internal error text (N2)');
    advanceClock(60 * 1000);
    const again = await post(baseUrl, { rawText: 'zupa pomidorowa', idempotencyKey: key3 });
    assert(again.status === 201, `the retry with the same key runs the analysis (got ${again.status})`);
    assert(await mealCount() === 3, 'and saves the meal once');

    console.log('\n--- TEST: a new submission (new key) is a new meal ---');
    advanceClock(60 * 1000);
    const repeatMeal = await post(baseUrl, { rawText: 'owsianka z jagodami', idempotencyKey: newKey() });
    assert(repeatMeal.status === 201 && await mealCount() === 4, 'the same text with a NEW key is a second, intended meal');

    console.log('\n--- TEST: two deliberate entries of the same meal are two meals (round 2) ---');
    // No clock advance: within the old 15-second content window, which used to swallow the
    // second one, and with identical content, which the frontend used to map to the same key.
    const before = await mealCount();
    const callsBefore = gemini.calls;
    const keyTwo = newKey();
    const one = await post(baseUrl, { rawText: 'banan', idempotencyKey: newKey() });
    const two = await post(baseUrl, { rawText: 'banan', idempotencyKey: keyTwo });
    assert(one.status === 201 && two.status === 201 && !two.body.replayed, `both are saved (got ${one.status}, ${two.status})`);
    assert(await mealCount() === before + 2, 'two meals exist');
    assert(gemini.calls === callsBefore + 2, 'each was analysed');
    const retryTwo = await post(baseUrl, { rawText: 'banan', idempotencyKey: keyTwo });
    assert(retryTwo.status === 200 && retryTwo.body.replayed === true, 'a retry of the second with ITS key is answered from the saved meal');
    assert(await mealCount() === before + 2, 'and adds nothing');

    console.log('\n--- TEST: requests without a key behave as before; a malformed key is refused ---');
    advanceClock(60 * 1000);
    const legacy = await post(baseUrl, { rawText: 'jabłko' });
    assert(legacy.status === 201, 'no key: the meal is saved as before');
    const bad = await post(baseUrl, { rawText: 'gruszka', idempotencyKey: 'x' });
    assert(bad.status === 400, `a malformed key is refused (got ${bad.status})`);
  } finally {
    server.close();
    Date.now = realNow;
  }
}

run()
  .then(() => {
    console.log('\n🎉 MEAL IDEMPOTENCY TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ MEAL IDEMPOTENCY TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
