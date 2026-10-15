// Meals saved while the AI is unavailable, and the loop that analyses them later
// (services/mealAnalysis.js).
//
// Production, 15.10.2026: the Gemini prepayment ran out (402 Payment Required) and every
// POST /api/meals answered 500 with nothing saved - a user tried the same meal eight times and
// lost it each time. These tests drive the real route and the real retry with Gemini stubbed:
// a failed analysis still saves the meal (flagged, with no anomalies and outside "frequent
// meals"), the retry fills in the macros once the AI answers, a deleted meal stays deleted,
// and a meal that never gets an answer is eventually given up on.
//
// Run with: node tests/test-meal-pending.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-meal-pending-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-meal-pending';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-meal-pending';

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

// `down` reproduces the production outage; `respond` decides what a working AI returns.
const gemini = { calls: 0, down: false, prompts: [], images: [], respond: () => ({ calories: 350, protein: 20, carbs: 40, fat: 10, fiber: 4, food_items: [] }) };
stubModule('config.js', {
  PORT: 0,
  genAI: {},
  model: null,
  generateContentWithFallback: async (prompt, isJson, imagePart) => {
    gemini.calls++;
    gemini.prompts.push(prompt);
    gemini.images.push(imagePart);
    if (gemini.down) throw new Error('[GoogleGenerativeAI Error]: [402 Payment Required] Your prepayment credits are depleted.');
    return JSON.stringify(gemini.respond());
  },
  ACTIVE_GEMINI_MODEL: 'stub-model',
  DEFAULT_GEMINI_MODEL: 'stub-model'
});

const express = require('express');
const db = require('../db');
const { retryPendingMeals, MAX_RETRY_ATTEMPTS } = require('../services/mealAnalysis');

let USER_ID;
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function call(baseUrl, method, url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const mealRow = (id) => db.get(`SELECT * FROM meals WHERE id = ?`, [id]);
// The retry spaces attempts by analysis_attempted_at; tests move that back instead of waiting.
const makeDue = () => db.run(`UPDATE meals SET analysis_attempted_at = datetime('now', '-1 day') WHERE analysis_status = 'pending'`);

async function run() {
  await db.initDb();
  USER_ID = (await db.run(
    `INSERT INTO users (username, password_hash, sync_token, role, status) VALUES ('pending_user', 'x', 'sync_pending_user_xxxxxxxxxxx', 'admin', 'active')`
  )).id;

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.user = { id: USER_ID, username: 'pending_user', role: 'admin' }; next(); });
  app.use(require('../routes/meals'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n--- TEST: an AI outage still saves the meal ---');
    gemini.down = true;
    const saved = await call(baseUrl, 'POST', '/api/meals', { rawText: 'jajecznica z 3 jaj na maśle', date: '2026-10-15' });
    assert(saved.status === 201, `the meal is saved despite the AI error (got ${saved.status}) - this was a 500 with nothing saved before`);
    assert(saved.body.analysisPending === true && saved.body.meals[0].analysis_pending === true, 'the response says the analysis is pending');
    assert(!/402|prepayment/.test(JSON.stringify(saved.body)), 'without the SDK error text (N2)');
    const pendingId = saved.body.meals[0].id;
    let row = await mealRow(pendingId);
    assert(row.analysis_status === 'pending' && row.raw_text === 'jajecznica z 3 jaj na maśle', 'the row keeps the user\'s text and is marked pending');
    assert(row.calories === 0 && row.fiber === null, 'with placeholder zero macros and no fabricated estimates');

    const day = await call(baseUrl, 'GET', '/api/meals?date=2026-10-15');
    const listed = day.body.find(m => m.id === pendingId);
    assert(listed && listed.analysis_pending === true && listed.anomalies.length === 0, 'GET lists it as pending, with no anomaly raised on the zeros');

    console.log('\n--- TEST: a pending meal is neither "frequent" nor repeatable ---');
    await call(baseUrl, 'POST', '/api/meals', { rawText: 'jajecznica z 3 jaj na maśle', date: '2026-10-14' });
    const frequent = await call(baseUrl, 'GET', '/api/meals/frequent');
    assert(frequent.body.length === 0, 'two pending copies of a meal do not make it a frequent meal with 0 kcal');
    const repeat = await call(baseUrl, 'POST', '/api/meals/repeat', { mealId: pendingId, date: '2026-10-16' });
    assert(repeat.status === 409, `repeating a pending meal is refused (got ${repeat.status}) - the copy would keep the zeros forever`);

    console.log('\n--- TEST: while the AI is still down the retry only counts the attempt ---');
    const callsBefore = gemini.calls;
    let result = await retryPendingMeals();
    assert(result.analysed === 0 && gemini.calls === callsBefore + 2, 'both pending meals were tried, neither analysed');
    row = await mealRow(pendingId);
    assert(row.analysis_status === 'pending' && row.analysis_attempts === 1, 'the meal stays pending with one attempt recorded');
    result = await retryPendingMeals();
    assert(gemini.calls === callsBefore + 2, 'an immediate second tick does not retry again (attempts are spaced)');

    console.log('\n--- TEST: once the AI answers, the retry fills in the meal ---');
    gemini.down = false;
    await makeDue();
    const promptsBefore = gemini.prompts.length;
    result = await retryPendingMeals();
    assert(result.analysed === 2, `both pending meals are analysed (got ${result.analysed})`);
    assert(gemini.prompts.slice(promptsBefore).every(p => p.includes('jajecznica z 3 jaj na maśle')), 'with the user\'s original text in the prompt');
    row = await mealRow(pendingId);
    assert(row.analysis_status === null && row.calories === 350 && row.fiber === 4, 'the row now carries the analysed values');
    const after = await call(baseUrl, 'GET', '/api/meals?date=2026-10-15');
    assert(!after.body.find(m => m.id === pendingId).analysis_pending, 'and is no longer flagged');

    console.log('\n--- TEST: a pending photo is re-sent as a photo, and a split result becomes several meals ---');
    gemini.down = true;
    const photo = await call(baseUrl, 'POST', '/api/meals', { rawText: '', image: PHOTO, date: '2026-10-15' });
    assert(photo.status === 201 && photo.body.meals[0].raw_text === 'Posiłek ze zdjęcia', 'a photo without text is saved under the placeholder name');
    gemini.down = false;
    gemini.respond = () => ({ meals: [
      { name: 'Śniadanie', calories: 400, protein: 20, carbs: 50, fat: 12 },
      { name: 'Obiad', calories: 700, protein: 45, carbs: 60, fat: 25 }
    ] });
    await makeDue();
    const imagesBefore = gemini.images.length;
    await retryPendingMeals();
    assert(gemini.images[imagesBefore] && gemini.images[imagesBefore].inlineData.mimeType === 'image/png', 'the stored photo goes to the AI again');
    const photoRows = await db.all(`SELECT raw_text, calories, analysis_status, image_base64 FROM meals WHERE user_id = ? AND date = '2026-10-15' AND raw_text IN ('Śniadanie', 'Obiad') ORDER BY id`, [USER_ID]);
    assert(photoRows.length === 2 && photoRows[0].calories === 400 && photoRows[1].calories === 700, 'the split result is two meals with their own values');
    assert(photoRows[0].image_base64 && !photoRows[1].image_base64, 'the photo stays on the original row only');

    console.log('\n--- TEST: a meal deleted while the retry is analysing it is not brought back ---');
    gemini.down = true;
    const doomed = await call(baseUrl, 'POST', '/api/meals', { rawText: 'banan', date: '2026-10-15' });
    const doomedId = doomed.body.meals[0].id;
    gemini.down = false;
    const countBefore = (await db.get(`SELECT COUNT(*) AS n FROM meals`)).n;
    // The user deletes it in the window between the retry picking it up and Gemini answering
    // - with a split result, which would otherwise also insert the extra rows.
    gemini.respond = () => {
      db.run(`DELETE FROM meals WHERE id = ?`, [doomedId]);
      return { meals: [{ name: 'Banan', calories: 100, protein: 1, carbs: 25, fat: 0 }, { name: 'Jogurt', calories: 120, protein: 8, carbs: 10, fat: 5 }] };
    };
    await makeDue();
    const res = await retryPendingMeals();
    assert(res.analysed === 0, 'the retry reports nothing analysed');
    assert((await db.get(`SELECT COUNT(*) AS n FROM meals`)).n === countBefore - 1, 'the meal stays deleted and no split rows appear');

    console.log('\n--- TEST: a meal that never gets an answer is given up on ---');
    gemini.down = true;
    const stuck = await call(baseUrl, 'POST', '/api/meals', { rawText: 'kanapka', date: '2026-10-15' });
    const stuckId = stuck.body.meals[0].id;
    await db.run(`UPDATE meals SET analysis_attempts = ? WHERE id = ?`, [MAX_RETRY_ATTEMPTS - 1, stuckId]);
    await makeDue();
    await retryPendingMeals();
    row = await mealRow(stuckId);
    assert(row.analysis_status === 'failed', `after ${MAX_RETRY_ATTEMPTS} attempts the meal is marked failed`);
    const failedList = await call(baseUrl, 'GET', '/api/meals?date=2026-10-15');
    assert(failedList.body.find(m => m.id === stuckId).analysis_failed === true, 'and the client is told so');
    const callsAtGiveUp = gemini.calls;
    await makeDue();
    await db.run(`UPDATE meals SET analysis_attempted_at = datetime('now', '-1 day') WHERE id = ?`, [stuckId]);
    await retryPendingMeals();
    assert(gemini.calls === callsAtGiveUp, 'and is not retried any more');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 PENDING MEAL TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ PENDING MEAL TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
