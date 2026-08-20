const express = require('express');
const router = express.Router();
const db = require('../db');
const { getLocalDateString } = require('../utils/dates');
const { generateContentWithFallback } = require('../config');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');
const { invalidateAiExplanationCache } = require('../utils/aiExplanationCache');
const { decrypt } = require('../utils/encryption');
const { aiRateLimiter } = require('../middleware/rateLimit');
const {
  sanitizeNumber,
  sanitizeNullableNumber,
  ALLOWED_MEAL_IMAGE_MIME_TYPES,
  MAX_MEAL_IMAGE_BASE64_CHARS
} = require('../utils/mealSanitize');
const { buildMealPrompt } = require('../utils/mealPrompts');

// Detektor anomalii w posiłkach - logika (oba sygnały: niezgodność makro/kalorii
// i statystyczny odstrój vs własna historia) wydzielona do utils/mealAnomaly.js,
// bo jest współdzielona z routes/dashboard.js (lista posiłków dnia w /api/dashboard,
// z którego faktycznie korzysta MealLogger.jsx po stronie frontendu).

// Cache na zduplikowane żądania wysyłane w krótkim czasie (np. szybki double-click)
const recentRequests = new Map();

// Okresowe czyszczenie starych wpisów cache, aby zapobiec wyciekowi pamięci (Runda 6)
setInterval(() => {
  const now = Date.now();
  for (const [userId, rec] of recentRequests.entries()) {
    if (now - rec.timestamp > 15000) {
      recentRequests.delete(userId);
    }
  }
}, 5 * 60 * 1000); // co 5 minut

const updateLastMealModifiedAt = async (userId, date) => {
  const nowIso = new Date().toISOString();
  try {
    await db.run(`
      INSERT INTO health_metrics (user_id, date, last_meal_modified_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET last_meal_modified_at = excluded.last_meal_modified_at
    `, [userId, date, nowIso]);
  } catch (err) {
    console.error('[DB ERROR] Błąd aktualizacji last_meal_modified_at:', err);
  }
};

router.post('/api/meals', aiRateLimiter, async (req, res) => {
  const { rawText, date, image } = req.body;
  const targetDate = date || getLocalDateString();
  // B-W1: Sanitizacja wejścia użytkownika — trim + ograniczenie długości
  const safeRawText = rawText ? rawText.trim().slice(0, 500) : '';

  if ((!rawText || rawText.trim() === '') && !image) {
    return res.status(400).json({ error: 'Opis posiłku lub zdjęcie nie może być puste.' });
  }

  const userId = req.user.id;
  const now = Date.now();
  const requestKey = {
    rawText: safeRawText,
    date: targetDate,
    imageLength: image ? image.length : 0,
    imageSample: image ? image.slice(-100) : ''
  };

  const lastRequest = recentRequests.get(userId);
  if (lastRequest &&
      (now - lastRequest.timestamp < 15000) &&
      lastRequest.key.rawText === requestKey.rawText &&
      lastRequest.key.date === requestKey.date &&
      lastRequest.key.imageLength === requestKey.imageLength &&
      lastRequest.key.imageSample === requestKey.imageSample) {
    console.log(`[API LOG] Wykryto zduplikowane żądanie w ciągu 15s dla użytkownika ${userId}. Zwracanie poprzedniego wyniku.`);
    
    // Odtwórz pełną odpowiedź z obrazkiem przesłanym w tym żądaniu, aby nie trzymać go w cache RAM
    const restoredResponse = {
      count: lastRequest.response.count,
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

  try {
    console.log(`[API LOG] POST /api/meals - Rozpoczęto analizę dla użytkownika ${req.user.username} (${targetDate})`);

    let imagePart = null;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];

        // B-S5: Whitelist dozwolonych typów MIME
        if (!ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mimeType)) {
          return res.status(400).json({ error: 'Nieobsługiwany format obrazu. Dozwolone: JPG, PNG, WebP, GIF.' });
        }

        if (base64Data.length > MAX_MEAL_IMAGE_BASE64_CHARS) {
          console.warn(`[API WARNING] Odrzucono zdjęcie posiłku - za duży rozmiar (${base64Data.length} znaków base64).`);
          return res.status(413).json({ error: 'Zdjęcie jest za duże. Maksymalny rozmiar to ok. 5MB - spróbuj zrobić zdjęcie w niższej rozdzielczości.' });
        }

        imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };
        console.log(`[API LOG] Pomyślnie przetworzono zdjęcie. Typ: ${mimeType}, Rozmiar Base64: ${base64Data.length} znaków.`);
      } else {
        console.warn(`[API WARNING] Nieprawidłowy format pliku obrazu.`);
      }
    }

    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
    const forceCustomKeyOnly = req.user.role !== 'admin';
    const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
    const language = langRow ? langRow.value : 'pl';

    // Prompt budowany w utils/mealPrompts.js - patrz komentarz w tamtym module co do
    // pierwszeństwa opisu użytkownika nad tym, co model odczyta ze zdjęcia. Wcześniej
    // cztery warianty szablonu (zdjęcie/tekst x pl/en) siedziały tutaj jako ~150 linii
    // literałów, przez co nie dało się ich sprawdzić inaczej niż realnym, płatnym
    // wywołaniem Gemini.
    const prompt = buildMealPrompt({
      hasImage: Boolean(imagePart),
      userText: safeRawText,
      language
    });

    const responseText = await generateContentWithFallback(prompt, true, imagePart, userApiKey, forceCustomKeyOnly);
    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch (err) {
      console.error('[API ERROR] Błąd parsowania odpowiedzi AI:', responseText);
      throw new Error('AI nie zwróciło poprawnego formatu JSON.');
    }

    // Przy zdjęciu AI może zwrócić kilka rozbitych posiłków (analysis.meals - patrz
    // prompt powyżej, np. zrzut ekranu z aplikacji do liczenia kalorii podzielony na
    // Śniadanie/Obiad/Kolację). Każdy wykryty posiłek zapisujemy jako OSOBNY wiersz
    // w tabeli meals, z własnymi makroskładnikami i własną nazwą (raw_text) wziętą
    // z detekcji AI, a nie z tekstu wpisanego przez użytkownika.
    let mealsToInsert;
    if (imagePart) {
      if (analysis && Array.isArray(analysis.meals) && analysis.meals.length > 0) {
        mealsToInsert = analysis.meals;
      } else {
        // Fallback: AI zwróciło płaski obiekt mimo instrukcji w prompcie (starszy
        // format) - traktujemy to jako jeden posiłek, żeby nie wywalić całego żądania.
        mealsToInsert = [{ ...analysis, name: analysis?.name || rawText || 'Posiłek ze zdjęcia' }];
      }
    } else {
      // Brak zdjęcia - posiłek wpisany tylko tekstem, bez detekcji wielu sekcji,
      // zachowanie identyczne jak wcześniej (jeden wiersz, nazwa = tekst użytkownika).
      mealsToInsert = [{ ...analysis, name: rawText }];
    }

    // Bazowy rozkład kalorii liczony RAZ dla całego żądania (nie per posiłek) - przy
    // zdjęciu rozbitym na kilka sekcji (Śniadanie/Obiad/Kolacja) wszystkie porównujemy
    // do tej samej, historycznej linii bazowej z dni PRZED targetDate.
    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

    const insertedMeals = [];
    for (const m of mealsToInsert) {
      const mealDescription = (imagePart ? (m.name || rawText || 'Posiłek ze zdjęcia') : (m.name || rawText));

      // Odcięcie wartości z odpowiedzi AI do sensownego zakresu przed zapisem do bazy
      // (patrz komentarz przy definicji sanitizeNumber powyżej).
      const safeCalories = sanitizeNumber(m.calories, 0, 5000, 0);
      const safeProtein = sanitizeNumber(m.protein, 0, 500, 0);
      const safeCarbs = sanitizeNumber(m.carbs, 0, 500, 0);
      const safeFat = sanitizeNumber(m.fat, 0, 500, 0);
      const safeFiber = sanitizeNullableNumber(m.fiber, 0, 100);
      const safeSugar = sanitizeNullableNumber(m.sugar, 0, 300);
      const safeSodium = sanitizeNullableNumber(m.sodium, 0, 15000);

      // Zapisz posiłek w bazie (błonnik/cukry/sód jako NULL, jeśli AI ich nie
      // oszacowało - bez fabrykowania zer, zgodnie z ustaloną zasadą projektu - ale
      // jeśli AI JEDNAK podało wartość, odcinamy ją do sensownego zakresu jak resztę makro)
      const result = await db.run(`
        INSERT INTO meals (user_id, date, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, analysis_json, image_base64)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        req.user.id,
        targetDate,
        mealDescription,
        safeCalories,
        safeProtein,
        safeCarbs,
        safeFat,
        safeFiber,
        safeSugar,
        safeSodium,
        JSON.stringify(m),
        image || null
      ]);

      // Odpowiedź do frontendu musi pokazywać te SAME (odcięte) wartości, które
      // wylądowały w bazie - inaczej dashboard od razu po dodaniu posiłku pokazałby
      // inną liczbę kcal/makro niż po jego odświeżeniu z bazy.
      insertedMeals.push({
        id: result.id,
        date: targetDate,
        raw_text: mealDescription,
        image_base64: image || null,
        ...m,
        calories: safeCalories,
        protein: safeProtein,
        carbs: safeCarbs,
        fat: safeFat,
        fiber: safeFiber,
        sugar: safeSugar,
        sodium: safeSodium,
        anomalies: detectMealAnomalies({ calories: safeCalories, protein: safeProtein, carbs: safeCarbs, fat: safeFat }, calorieBaseline)
      });
    }

    const totalCalories = insertedMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
    console.log(`[API LOG] Dodano ${insertedMeals.length} posiłek(ów) dla ${req.user.username} (ID: ${insertedMeals.map(m => m.id).join(', ')}). Łącznie: ${totalCalories} kcal`);

    // Runda 12 (audyt): patrz komentarz w utils/aiExplanationCache.js - dodanie posiłku
    // (w tym retroaktywnie, dla targetDate z przeszłości) może zmienić rzeczywistą
    // przyczynę odchylenia, którą AI miało już wyjaśnione i zapisane w cache'u.
    await invalidateAiExplanationCache(req.user.id, targetDate);

    const responsePayload = {
      count: insertedMeals.length,
      meals: insertedMeals
    };

    // Zapisujemy w cache kopię bez dużego Base64 obrazka (Runda 6), aby zapobiec wyciekowi RAM
    const cachedResponse = {
      count: responsePayload.count,
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

    await updateLastMealModifiedAt(req.user.id, targetDate);

    res.status(201).json(responsePayload);

  } catch (err) {
    console.error('[API ERROR] Błąd analizy posiłku przez AI:', err);
    res.status(500).json({ error: 'Wystąpił błąd podczas analizowania posiłku przez AI: ' + err.message });
  }
});

// 2. Pobieranie listy posiłków z danego dnia
router.get('/api/meals', async (req, res) => {
  const date = req.query.date || getLocalDateString();
  try {
    const rows = await db.all(`
      SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY timestamp DESC
    `, [req.user.id, date]);

    // Ta sama linia bazowa co przy zapisie (POST) - dni PRZED `date`, więc wynik
    // anomalii dla danego dnia jest stabilny niezależnie od tego, ile razy
    // odświeżymy widok (nie zmienia się przy każdym kolejnym posiłku tego samego dnia).
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);

    const meals = rows.map(r => {
      let analysis = {};
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
        // Kolumny bazy zawierają wartości PO sanityzacji (sanitizeNumber/sanitizeNullableNumber
        // przy zapisie) - mogą się różnić od niesanityzowanego analysis_json zwróconego przez AI.
        // Muszą nadpisać spread z `analysis`, inaczej GET zwróci inne wartości niż te faktycznie
        // użyte w agregacjach (dashboard, podsumowania).
        calories: r.calories,
        protein: r.protein,
        carbs: r.carbs,
        fat: r.fat,
        anomalies: detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
      };
    });

    res.json(meals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania posiłków.' });
  }
});

// 3. Usuwanie posiłku
router.delete('/api/meals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Data PRZED usunięciem - potrzebna do invalidacji cache'u wyjaśnienia AI (patrz
    // utils/aiExplanationCache.js), po DELETE wiersza nie da się jej już odzyskać.
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

// Automatyzacja (Runda 9): lista najczęściej powtarzanych posiłków użytkownika
// (grupowanie po znormalizowanym raw_text - LOWER(TRIM(...)), bo użytkownik zwykle
// wpisuje tę samą nazwę posiłku z drobnymi różnicami wielkości liter/spacji, nie
// identyczny ciąg znaków), do szybkiego ponownego dodania bez ponownego wywołania AI
// (patrz POST /api/meals/repeat poniżej). Tylko posiłki powtórzone co najmniej 2 razy.
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

// Szybkie ponowne dodanie wcześniej zapisanego posiłku (na bazie jego id) - kopiuje
// wartości odżywcze z oryginalnego wpisu BEZ ponownego wywołania AI (inaczej niż
// POST /api/meals powyżej), bo posiłek już raz został przeanalizowany i użytkownik
// chce po prostu zalogować "to samo co ostatnio" (np. swoje stałe śniadanie) - szybciej
// i bez zużywania limitu/kosztu zapytań do Gemini.
router.post('/api/meals/repeat', async (req, res) => {
  const { mealId, date } = req.body;
  const targetDate = date || getLocalDateString();

  if (!mealId) {
    return res.status(400).json({ error: 'Brak wskazania posiłku do powtórzenia.' });
  }

  try {
    const original = await db.get(`SELECT * FROM meals WHERE id = ? AND user_id = ?`, [mealId, req.user.id]);
    if (!original) {
      return res.status(404).json({ error: 'Nie znaleziono oryginalnego posiłku do powtórzenia.' });
    }

    const calorieBaseline = await getCalorieBaseline(req.user.id, targetDate);

    // Nie kopiujemy image_base64 - jest to dane duże (base64 zdjęcia), a przy
    // powtarzaniu posiłku nie ma potrzeby duplikowania go w bazie (baza rosłaby
    // liniowo z każdym powtórzeniem). Zdjęcie jest cechą konkretnego wpisu,
    // nie samego przepisu/posiłku.
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
