const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString, isCalendarDateString } = require('../utils/dates');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');
const { invalidateAiExplanationCache } = require('../utils/aiExplanationCache');
const { aiRateLimiter } = require('../middleware/rateLimit');
const {
  sanitizeMealText,
  ALLOWED_MEAL_IMAGE_MIME_TYPES,
  MAX_MEAL_IMAGE_BASE64_CHARS
} = require('../utils/mealSanitize');
const {
  analyzeMeal,
  sanitizeAnalysedMeal,
  pendingAnalysisJson,
  pendingFlags,
  PHOTO_MEAL_FALLBACK_NAME
} = require('../services/mealAnalysis');

// Meal anomaly detection - the logic (both signals: macro/calorie inconsistency and a
// statistical outlier versus the user's own history) lives in utils/mealAnomaly.js, because
// it is shared with routes/dashboard.js (the day's meal list in /api/dashboard, which is
// what MealLogger.jsx on the frontend actually consumes).

// Cache for duplicate requests sent in quick succession (a fast double-click, say)
const recentRequests = new Map();

// Periodic cleanup of old cache entries to prevent a memory leak (round 6)
setInterval(() => {
  const now = Date.now();
  for (const [userId, rec] of recentRequests.entries()) {
    if (now - rec.timestamp > 15000) {
      recentRequests.delete(userId);
    }
  }
}, 5 * 60 * 1000); // co 5 minut

// ===== Idempotency of POST /api/meals (audit 2026-10-09, W2) =====
// See the meal_submissions migration in db.js for the production duplicate that motivated it.
// The browser generates one key per submission of the meal form and re-sends the SAME key when
// it retries, so a retry after a dropped connection gets the meals the first request saved
// instead of a second, differently-estimated copy. The key is optional: a request without one
// (an old cached frontend) behaves exactly as before.
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9-]{16,64}$/;
// A 'pending' row older than this belongs to a request that died mid-analysis (a restart, a
// crash) - one AI call is bounded by GEMINI_WORST_CASE_MS (config.js), so nothing alive can
// still be working on it, and the retry may take it over.
const STALE_SUBMISSION_MS = 5 * 60 * 1000;
// Finished submissions are only useful while a retry is plausible.
const SUBMISSION_RETENTION_DAYS = 7;

// Returns { state: 'claimed' } when this request owns the submission and must run it,
// { state: 'done', mealIds } when an earlier request already finished it, or
// { state: 'pending' } when an earlier request is still running.
async function claimMealSubmission(userId, key) {
  const inserted = await db.run(
    `INSERT OR IGNORE INTO meal_submissions (user_id, idempotency_key, status) VALUES (?, ?, 'pending')`,
    [userId, key]
  );
  if (inserted.changes === 1) return { state: 'claimed' };

  const row = await db.get(
    `SELECT status, meal_ids, created_at FROM meal_submissions WHERE user_id = ? AND idempotency_key = ?`,
    [userId, key]
  );
  if (!row) return claimMealSubmission(userId, key); // released between the two statements
  if (row.status === 'done') {
    let mealIds;
    try { mealIds = JSON.parse(row.meal_ids || '[]'); } catch (e) { mealIds = []; }
    return { state: 'done', mealIds };
  }
  const startedMs = new Date(String(row.created_at).replace(' ', 'T') + 'Z').getTime();
  if (Number.isFinite(startedMs) && Date.now() - startedMs > STALE_SUBMISSION_MS) {
    // Conditional on the same created_at, so two retries racing for a stale row cannot both win.
    const takeover = await db.run(
      `UPDATE meal_submissions SET created_at = datetime('now') WHERE user_id = ? AND idempotency_key = ? AND status = 'pending' AND created_at = ?`,
      [userId, key, row.created_at]
    );
    if (takeover.changes === 1) return { state: 'claimed' };
  }
  return { state: 'pending' };
}

async function releaseMealSubmission(userId, key) {
  await db.run(`DELETE FROM meal_submissions WHERE user_id = ? AND idempotency_key = ? AND status = 'pending'`, [userId, key]);
}

async function completeMealSubmission(userId, key, mealIds) {
  await db.run(
    `UPDATE meal_submissions SET status = 'done', meal_ids = ? WHERE user_id = ? AND idempotency_key = ?`,
    [JSON.stringify(mealIds), userId, key]
  );
  await db.run(
    `DELETE FROM meal_submissions WHERE user_id = ? AND status = 'done' AND created_at < datetime('now', ?)`,
    [userId, `-${SUBMISSION_RETENTION_DAYS} days`]
  );
}

const updateLastMealModifiedAt = async (userId, date) => {
  const nowIso = new Date().toISOString();
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, last_meal_modified_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET last_meal_modified_at = excluded.last_meal_modified_at
    `, [userId, date, nowIso]);
  } catch (err) {
    console.error('[DB ERROR] Failed to update last_meal_modified_at:', err);
  }
};

router.post('/api/meals', aiRateLimiter, async (req, res) => {
  const { rawText, date, image } = req.body;
  const targetDate = date || getLocalDateString();
  // B-W1: sanitise user input - trim, cap the length and defuse the isolation tag.
  // This value is now the ONLY form of the user's text that leaves this handler. It used to
  // be built here and then used for the analysis prompt alone, while the untrimmed `rawText`
  // was what actually got written to meals.raw_text - so the 500-character cap protected the
  // one prompt it was invented for and nothing else. See sanitizeMealText in
  // utils/mealSanitize.js for what the unbounded value did to every later prompt.
  const safeRawText = sanitizeMealText(rawText);

  // The date is a storage key, not a display value: it goes into meals.date and
  // health_metrics.date and every aggregation selects on it with string comparisons
  // (`date BETWEEN ? AND ?`, `date >= ?`). '2026-09-99' sorts inside September and was
  // silently counted in that month's averages; arbitrary text produced rows no screen could
  // ever show or delete. An empty value still means "today" - that is what the date input
  // sends when it is cleared.
  if (!isCalendarDateString(targetDate)) {
    return res.status(400).json({ error: 'Nieprawidłowa data (oczekiwany format RRRR-MM-DD).' });
  }

  // safeRawText rather than rawText.trim(): a non-string rawText threw a TypeError here and
  // came back as a 500.
  if (!safeRawText && !image) {
    return res.status(400).json({ error: 'Opis posiłku lub zdjęcie nie może być puste.' });
  }

  // Anything other than a data URL used to fall through with only a console warning: no
  // MIME check, no size cap, and the raw string was still stored in meals.image_base64 and
  // served back to the browser as an <img src>. The MIME and size checks further down
  // therefore guarded only the inputs that were already well-formed, and anything else up to
  // the 20 MB body limit could be written into the database on every request.
  if (image && (typeof image !== 'string' || !/^data:[^;]+;base64,.+$/.test(image))) {
    return res.status(400).json({ error: 'Nieprawidłowy format zdjęcia.' });
  }

  const userId = req.user.id;

  const now = Date.now();
  const requestKey = {
    rawText: safeRawText,
    date: targetDate,
    imageLength: image ? image.length : 0,
    imageSample: image ? image.slice(-100) : ''
  };

  // Content-based, so only for requests WITHOUT an idempotency key (an old cached frontend).
  // With a key, the key alone decides what is a retry (audit 2026-10-10, round 2): two
  // deliberate entries of the same meal within 15 s are two meals, and this window used to
  // answer the second with the first one's result.
  const lastRequest = req.body.idempotencyKey ? null : recentRequests.get(userId);
  if (lastRequest &&
      (now - lastRequest.timestamp < 15000) &&
      lastRequest.key.rawText === requestKey.rawText &&
      lastRequest.key.date === requestKey.date &&
      lastRequest.key.imageLength === requestKey.imageLength &&
      lastRequest.key.imageSample === requestKey.imageSample) {
    console.log(`[API LOG] Duplicate request within 15s for user ${userId}. Returning the previous result.`);
    
    // Rebuild the full response using the image sent in this request, so it is not held in the RAM cache
    const restoredResponse = {
      ...lastRequest.response,
      meals: lastRequest.response.meals.map(m => {
        const copy = { ...m };
        if (copy.image_base64 === '__HAS_IMAGE__') {
          copy.image_base64 = image || null;
        }
        return copy;
      })
    };
    return res.status(200).json(restoredResponse);
  }

  const { idempotencyKey } = req.body;
  if (idempotencyKey !== undefined && idempotencyKey !== null
      && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey))) {
    return res.status(400).json({ error: 'Nieprawidłowy klucz idempotencji.' });
  }
  let ownsSubmission = false;
  // Express 4 does not catch a rejected promise in an async handler - a database error here,
  // outside the try below, would leave the request hanging with no response.
  if (idempotencyKey) try {
    const claim = await claimMealSubmission(userId, idempotencyKey);
    if (claim.state === 'done') {
      const placeholders = claim.mealIds.map(() => '?').join(',') || 'NULL';
      const rows = await db.all(
        `SELECT id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_status FROM meals WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...claim.mealIds]
      );
      console.log(`[API LOG] Meal submission retried for user ${userId}: returning the ${rows.length} meal(s) already saved.`);
      const meals = rows.map(({ analysis_status, ...r }) => ({ ...r, ...pendingFlags(analysis_status) }));
      return res.status(200).json({ count: meals.length, meals, replayed: true });
    }
    if (claim.state === 'pending') {
      return res.status(409).json({
        error: 'Ten posiłek jest jeszcze analizowany. Odśwież listę za chwilę - nie wysyłaj go ponownie.',
        pending: true
      });
    }
    ownsSubmission = true;
  } catch (err) {
    console.error('[API ERROR] Meal submission lookup failed:', err);
    return res.status(500).json({ error: 'Błąd serwera.' });
  }
  let submissionCompleted = false;

  try {
    console.log(`[API LOG] POST /api/meals - starting analysis for user ${req.user.username} (${targetDate})`);

    let imagePart = null;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];

        // B-S5: whitelist of allowed MIME types
        if (!ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mimeType)) {
          return res.status(400).json({ error: 'Nieobsługiwany format obrazu. Dozwolone: JPG, PNG, WebP, GIF.' });
        }

        if (base64Data.length > MAX_MEAL_IMAGE_BASE64_CHARS) {
          console.warn(`[API WARNING] Meal photo rejected - too large (${base64Data.length} base64 characters).`);
          return res.status(413).json({ error: 'Zdjęcie jest za duże. Maksymalny rozmiar to ok. 5MB - spróbuj zrobić zdjęcie w niższej rozdzielczości.' });
        }

        imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };
        console.log(`[API LOG] Photo processed. Type: ${mimeType}, base64 size: ${base64Data.length} characters.`);
      } else {
        console.warn(`[API WARNING] Invalid image file format.`);
      }
    }

    // A failed analysis no longer loses the meal (production 15.10.2026, see
    // services/mealAnalysis.js): it is saved as 'pending' with zero macros, and the retry
    // loop fills it in once the AI answers again. Only the AI step falls back this way - a
    // database error below is still a 500, because then nothing was saved.
    let mealsToInsert = null;
    let analysisError = null;
    try {
      mealsToInsert = await analyzeMeal({ userId, role: req.user.role, userText: safeRawText, imagePart });
    } catch (err) {
      analysisError = err;
      console.error('[API ERROR] AI meal analysis failed - saving the meal as pending:', err);
    }

    // The calorie baseline is computed ONCE per request rather than per meal - with a photo
    // split into several sections (breakfast/lunch/dinner) all of them are compared with the
    // same historical baseline from the days BEFORE targetDate.
    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

    const insertedMeals = [];
    if (analysisError) {
      const rawTextToStore = safeRawText || PHOTO_MEAL_FALLBACK_NAME;
      const result = await db.run(`
        INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, analysis_json, image_base64, analysis_status)
        VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 'pending')
      `, [req.user.id, targetDate, rawTextToStore, pendingAnalysisJson(safeRawText), image || null]);
      insertedMeals.push({
        id: result.id,
        date: targetDate,
        raw_text: rawTextToStore,
        image_base64: image || null,
        food_items: [],
        // Unknown, not zero - the same shape pendingFlags() gives a pending row read back later.
        calories: null, protein: null, carbs: null, fat: null, fiber: null, sugar: null, sodium: null,
        analysis_pending: true,
        anomalies: []
      });
    }

    for (const m of mealsToInsert || []) {
      // Clamped and capped values (see sanitizeAnalysedMeal), the same ones the retry writes.
      const v = sanitizeAnalysedMeal(m, { userText: safeRawText, hasImage: Boolean(imagePart) });

      const result = await db.run(`
        INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        req.user.id,
        targetDate,
        v.rawText,
        v.calories,
        v.protein,
        v.carbs,
        v.fat,
        v.fiber,
        v.sugar,
        v.sodium,
        JSON.stringify(m),
        image || null
      ]);

      // The response to the frontend must show the SAME clamped values that were written to
      // the database - otherwise the dashboard would show different kcal/macros right after a
      // meal is added than after reloading it from the database.
      insertedMeals.push({
        id: result.id,
        date: targetDate,
        raw_text: v.rawText,
        image_base64: image || null,
        ...m,
        calories: v.calories,
        protein: v.protein,
        carbs: v.carbs,
        fat: v.fat,
        fiber: v.fiber,
        sugar: v.sugar,
        sodium: v.sodium,
        anomalies: detectMealAnomalies({ calories: v.calories, protein: v.protein, carbs: v.carbs, fat: v.fat }, calorieBaseline)
      });
    }

    const totalCalories = insertedMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
    console.log(`[API LOG] Added ${insertedMeals.length} meal(s) for ${req.user.username} (ID: ${insertedMeals.map(m => m.id).join(', ')}). Total: ${totalCalories} kcal`);

    // Round 12 (audit): see the comment in utils/aiExplanationCache.js - adding a meal,
    // including retroactively for a targetDate in the past, can change the real cause of a
    // deviation that the AI had already explained and cached.
    await invalidateAiExplanationCache(req.user.id, targetDate);

    const responsePayload = {
      count: insertedMeals.length,
      meals: insertedMeals
    };
    if (analysisError) {
      // 201, not an error: the meal IS saved, and a retry from the client would only add a
      // second pending copy. The flag lets the client say why the macros are still empty.
      responsePayload.analysisPending = true;
      // Only the application's own, user-actionable messages reach the client (audit
      // 2026-10-09, N2) - a missing API key is something the user can fix in Settings, and
      // until they do the retry loop cannot succeed either. SDK internals stay in the log.
      const message = analysisError.message || '';
      if (/^(Usługa AI jest obecnie niedostępna|AI nie zwróciło)/.test(message)) {
        responsePayload.analysisPendingReason = message;
      }
    }

    // We cache a copy without the large base64 image (round 6) to prevent a memory leak
    const cachedResponse = {
      ...responsePayload,
      meals: responsePayload.meals.map(m => {
        const copy = { ...m };
        if (copy.image_base64) {
          copy.image_base64 = '__HAS_IMAGE__';
        }
        return copy;
      })
    };

    recentRequests.set(userId, {
      timestamp: Date.now(),
      key: requestKey,
      response: cachedResponse
    });

    if (ownsSubmission) {
      await completeMealSubmission(userId, idempotencyKey, insertedMeals.map(m => m.id));
      submissionCompleted = true;
    }

    await updateLastMealModifiedAt(req.user.id, targetDate);

    res.status(201).json(responsePayload);

  } catch (err) {
    // AI failures no longer land here (they save a pending meal above) - this is the database
    // or something unexpected, and the client gets no internals (audit 2026-10-09, N2).
    console.error('[API ERROR] Saving the meal failed:', err);
    res.status(500).json({ error: 'Wystąpił błąd podczas zapisywania posiłku. Spróbuj ponownie za chwilę.' });
  } finally {
    // Nothing was saved (validation refusal, database error): the key is free again, so the
    // user's retry runs afresh rather than waiting on a submission that will never finish.
    if (ownsSubmission && !submissionCompleted) {
      await releaseMealSubmission(userId, idempotencyKey).catch((e) => console.error('[API ERROR] Failed to release a meal submission:', e.message));
    }
  }
});

// 2. Fetch the meals for a given day
router.get('/api/meals', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    const rows = await db.all(`
      SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY timestamp DESC
    `, [req.user.id, date]);

    // The same baseline as on write (POST) - days BEFORE `date`, so the anomaly result for a
    // given day is stable however many times the view is refreshed (it does not shift with
    // each additional meal on that same day).
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);

    const meals = rows.map(r => {
      let analysis;
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      return {
        id: r.id,
        date: r.date,
        timestamp: r.timestamp,
        raw_text: r.raw_text,
        image_base64: r.image_base64,
        ...analysis,
      // The database columns hold the values AFTER sanitisation (sanitizeNumber /
      // sanitizeNullableNumber on write) and may differ from the unsanitised analysis_json
      // returned by the AI. They must override the spread of `analysis`, otherwise GET would
      // return different values from those actually used in the aggregations (dashboard,
      // summaries).
        calories: r.calories,
        protein: r.protein,
        carbs: r.carbs,
        fat: r.fat,
        ...pendingFlags(r.analysis_status),
        // A pending meal's zeros are a placeholder, not a meal to compare with the baseline.
        anomalies: r.analysis_status ? [] : detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
      };
    });

    res.json(meals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania posiłków.' });
  }
});

// 3. Delete a meal
router.delete('/api/meals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // The date BEFORE deletion - needed to invalidate the AI explanation cache (see
    // utils/aiExplanationCache.js); once the row is deleted it can no longer be recovered.
    const meal = await db.get(`SELECT date FROM meals WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    const result = await db.run(`DELETE FROM meals WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Nie znaleziono posiłku.' });
    }
    if (meal) {
      await invalidateAiExplanationCache(req.user.id, meal.date);
      await updateLastMealModifiedAt(req.user.id, meal.date);
    }
    res.json({ success: true, message: 'Posiłek został usunięty.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania posiłku.' });
  }
});

// Automation (round 9): the user's most frequently repeated meals, grouped by normalised
// raw_text - LOWER(TRIM(...)), because a user usually types the same meal name with small
// differences in case and spacing rather than an identical string. Used for quickly adding
// one again without another AI call (see POST /api/meals/repeat below). Only meals repeated
// at least twice qualify.
router.get('/api/meals/frequent', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
    const rows = await db.all(`
      SELECT
        MAX(id) AS latest_id,
        raw_text,
        COUNT(*) AS count,
        MAX(date) AS last_date,
        AVG(calories) AS avg_calories,
        AVG(protein) AS avg_protein,
        AVG(carbs) AS avg_carbs,
        AVG(fat) AS avg_fat
      FROM meals
      WHERE user_id = ? AND raw_text IS NOT NULL AND TRIM(raw_text) != ''
        AND analysis_status IS NULL
      GROUP BY LOWER(TRIM(raw_text))
      HAVING COUNT(*) >= 2
      ORDER BY count DESC, last_date DESC
      LIMIT ?
    `, [req.user.id, limit]);

    res.json(rows.map(r => ({
      mealId: r.latest_id,
      rawText: r.raw_text,
      count: r.count,
      lastDate: r.last_date,
      avgCalories: Math.round(r.avg_calories),
      avgProtein: Math.round(r.avg_protein * 10) / 10,
      avgCarbs: Math.round(r.avg_carbs * 10) / 10,
      avgFat: Math.round(r.avg_fat * 10) / 10
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania częstych posiłków.' });
  }
});

// Quickly re-add a previously saved meal by its id - copies the nutritional values from the
// original entry WITHOUT another AI call (unlike POST /api/meals above), because the meal has
// already been analysed once and the user simply wants to log 'the same as last time', such
// as their regular breakfast. Faster, and it does not consume the Gemini quota or cost.
router.post('/api/meals/repeat', async (req, res) => {
  const { mealId, date } = req.body;
  const targetDate = date || getLocalDateString();

  // Same storage-key reasoning as POST /api/meals above.
  if (!isCalendarDateString(targetDate)) {
    return res.status(400).json({ error: 'Nieprawidłowa data (oczekiwany format RRRR-MM-DD).' });
  }

  if (!mealId) {
    return res.status(400).json({ error: 'Brak wskazania posiłku do powtórzenia.' });
  }

  try {
    const original = await db.get(`SELECT * FROM meals WHERE id = ? AND user_id = ?`, [mealId, req.user.id]);
    if (!original) {
      return res.status(404).json({ error: 'Nie znaleziono oryginalnego posiłku do powtórzenia.' });
    }
    // Repeating copies the macros - for a meal still waiting for its analysis those are the
    // placeholder zeros, and the copy would never be filled in (it carries no pending status).
    if (original.analysis_status) {
      return res.status(409).json({ error: 'Ten posiłek nie ma jeszcze analizy AI - nie można go powtórzyć.' });
    }

    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

      // We do not copy image_base64 - it is large (a base64 photo), and repeating a meal has
      // no need to duplicate it in the database, which would grow linearly with each repeat.
      // The photo is a property of one specific entry, not of the meal itself.
    const result = await db.run(`
      INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      targetDate,
      original.raw_text,
      original.calories,
      original.protein,
      original.carbs,
      original.fat,
      original.fiber,
      original.sugar,
      original.sodium,
      original.analysis_json,
      null
    ]);

    let analysis = {};
    try {
      analysis = JSON.parse(original.analysis_json);
    } catch (e) {
      analysis = {};
    }

    await invalidateAiExplanationCache(req.user.id, targetDate);
    await updateLastMealModifiedAt(req.user.id, targetDate);

    res.status(201).json({
      count: 1,
      meals: [{
        id: result.id,
        date: targetDate,
        raw_text: original.raw_text,
        image_base64: null,
        ...analysis,
        calories: original.calories,
        protein: original.protein,
        carbs: original.carbs,
        fat: original.fat,
        fiber: original.fiber,
        sugar: original.sugar,
        sodium: original.sodium,
        anomalies: detectMealAnomalies({ calories: original.calories, protein: original.protein, carbs: original.carbs, fat: original.fat }, calorieBaseline)
      }]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd powtarzania posiłku.' });
  }
});

module.exports = router;
