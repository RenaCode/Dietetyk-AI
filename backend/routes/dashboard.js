const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLocalDateString, getWarsawWallClock } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { getCalorieBaseline, detectMealAnomalies } = require('../utils/mealAnomaly');
const { DEFAULT_TARGET_WATER_ML, getTargetCalories, getBmr, getTargetWaterMl } = require('../utils/defaultSettings');
const { genAI, generateContentWithFallback } = require('../config');
const { buildGoalPaceAnalysis } = require('../services/summaries');
const { getDayEventsInRange, formatDayEventsForPrompt } = require('../utils/dayEvents');
const { decrypt } = require('../utils/encryption');
const { getWeatherAndTimeContext, getUserLocationOverride } = require('../utils/weatherContext');

// --- REJESTR INSIGHTÓW (obsługa zbiorczego /api/dashboard/insights) ---
//
// Dashboard renderuje kilkadziesiąt niezależnych kart, z których każda miała
// własny useEffect i własny fetch - jedno wejście na ekran to było ~60 round-tripów
// HTTP i tyle samo osobnych serii zapytań do SQLite. Zamiast dopisywać ręcznie
// utrzymywaną listę tras (która natychmiast rozjechałaby się z rzeczywistością),
// przechwytujemy rejestracje router.get() i zapisujemy handler pod jego
// identyfikatorem. Dzięki temu każdy NOWY insight dodany w przyszłości trafia do
// wsadu automatycznie, bez pamiętania o drugim miejscu do aktualizacji.
const insightHandlers = new Map();
const INSIGHT_PATH_PREFIX = '/api/dashboard/';
const registerRoute = router.get.bind(router);

router.get = function registerAndIndex(path, ...handlers) {
  if (typeof path === 'string' && path.startsWith(INSIGHT_PATH_PREFIX)) {
    const id = path.slice(INSIGHT_PATH_PREFIX.length);
    // Pomijamy trasy parametryzowane i zagnieżdżone - wsad obsługuje wyłącznie
    // proste, bezparametrowe endpointy odczytowe.
    if (id && !id.includes('/') && !id.includes(':')) {
      insightHandlers.set(id, handlers[handlers.length - 1]);
    }
  }
  return registerRoute(path, ...handlers);
};

// Blokada równoległego generowania porady AI dla tej samej (user, data) - bez tego
// kilka odświeżeń dashboardu w krótkim czasie (np. otwarcie kilku zakładek albo
// szybkie odświeżanie po nieudanym ładowaniu) odpalałoby N równoległych zapytań
// do Gemini dla identycznego promptu, mnożąc niepotrzebnie koszt/limity API.
const pendingAdviceGeneration = new Set();

// Blokada równoległego generowania KRÓTKIEGO wyjaśnienia AI (ai-explanation-insight,
// Runda 11) - osobny Set od pendingAdviceGeneration, bo to inny cache (kolumny
// ai_explanation/ai_explanation_generated_at) i inny, znacznie krótszy/tańszy prompt.
const pendingExplanationGeneration = new Set();

// Przesunięcie daty (string YYYY-MM-DD) o N dni - czysta arytmetyka kalendarzowa
// przez Date.UTC (jak w istniejącym subtractDay), żeby uniknąć błędów strefy
// czasowej. deltaDays może być ujemne (w tył) lub dodatnie (w przód).
const shiftDate = (dateStr, deltaDays) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
};

// Walidacja formatu ?date= z query string (Runda 14, naprawa z audytu) - bez tego
// niepoprawny string (np. "abc", inny format) wywala shiftDate/Date.UTC w
// Invalid Date -> toISOString() rzuca RangeError -> 500 zamiast czytelnego
// zachowania. Przy złym formacie po prostu wracamy do dzisiejszej daty, tak jak
// przy braku parametru, zamiast zwracać błąd - mniej zaskakujące dla wywołań
// frontendu, które zawsze wysyłają poprawny format.
const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;
const resolveQueryDate = (req) => {
  const raw = req.query.date;
  return typeof raw === 'string' && DATE_STRING_RE.test(raw) ? raw : getLocalDateString();
};

// --- ZBIORCZE POBRANIE INSIGHTÓW ---
//
// GET /api/dashboard/insights?ids=sleep-insight,recovery-insight&date=YYYY-MM-DD
//
// Uruchamia handlery zarejestrowanych insightów w jednym żądaniu i zwraca mapę
// wyników. Każdy insight jest izolowany: błąd, timeout albo nieznany identyfikator
// jednego nie przewraca całej odpowiedzi - klient dostaje status per pozycja i
// renderuje resztę kart normalnie.
//
// Rejestrujemy tę trasę przez registerRoute (a nie przez opakowany router.get),
// żeby nie wpisała samej siebie do rejestru insightów.

// Ile handlerów wykonujemy równolegle. SQLite obsługuje jedno połączenie zapisu,
// a insighty to głównie odczyty na tych samych tabelach - pełna równoległość
// kilkudziesięciu handlerów wysyca pulę i wydłuża najwolniejsze zapytania zamiast
// je przyspieszać. 6 to kompromis wybrany tak, żeby nie zamienić jednego wąskiego
// gardła (sieć) na drugie (baza).
const INSIGHT_BATCH_CONCURRENCY = 6;

// Górny limit pozycji we wsadzie - dashboard prosi dziś o ~48. Zapas jest po to,
// żeby nowe insighty nie wymagały ruszania tej stałej, ale limit istnieje, bo bez
// niego jedno żądanie mogłoby wymusić dowolnie długą pracę serwera.
const INSIGHT_BATCH_MAX_IDS = 100;

// Pojedynczy insight nie może zablokować całego wsadu. Większość to czyste
// zapytania SQL (milisekundy), ale ai-explanation-insight potrafi wywołać Gemini -
// wtedy klient dostaje status 'timeout' dla tej jednej karty i może dociągnąć ją
// osobnym żądaniem, zamiast czekać na całość.
const INSIGHT_BATCH_TIMEOUT_MS = 15000;

// Wykonuje handler Express poza cyklem żądania, przechwytując to, co zapisałby do
// odpowiedzi. Handlery insightów używają wyłącznie res.json() i res.status().json(),
// więc atrapa obsługuje dokładnie ten kontrakt - gdyby ktoś dodał insight
// używający res.send()/res.end(), dostanie czytelny błąd zamiast cichego zwisu.
function runInsightHandler(handler, req, dateParam) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(
      () => finish({ status: 'timeout' }),
      INSIGHT_BATCH_TIMEOUT_MS
    );

    // Prototypowe dziedziczenie po prawdziwym req - handlery czytają req.user,
    // req.ip i nagłówki, a my podmieniamy wyłącznie query.date. Kopiowanie tylko
    // wybranych pól groziłoby cichym rozjazdem, gdyby handler sięgnął po coś jeszcze.
    const scopedReq = Object.create(req);
    scopedReq.query = dateParam ? { date: dateParam } : {};

    let statusCode = 200;
    const scopedRes = {
      status(code) { statusCode = code; return scopedRes; },
      json(payload) {
        finish(statusCode >= 400
          ? { status: 'error', statusCode, data: payload }
          : { status: 'ok', data: payload });
      },
      send() { finish({ status: 'error', statusCode: 500, data: { error: 'Insight użył res.send() - wsad obsługuje tylko res.json().' } }); },
      end() { finish({ status: 'error', statusCode: 500, data: { error: 'Insight użył res.end() - wsad obsługuje tylko res.json().' } }); }
    };

    Promise.resolve()
      .then(() => handler(scopedReq, scopedRes))
      .catch((err) => {
        console.error('[INSIGHTS BATCH] Handler rzucił wyjątkiem:', err);
        finish({ status: 'error', statusCode: 500, data: { error: 'Błąd insightu.' } });
      });
  });
}

registerRoute('/api/dashboard/insights', async (req, res) => {
  try {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const requestedIds = [...new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean)
    )];

    if (requestedIds.length === 0) {
      return res.status(400).json({
        error: 'Brak parametru ids.',
        available: [...insightHandlers.keys()].sort()
      });
    }
    if (requestedIds.length > INSIGHT_BATCH_MAX_IDS) {
      return res.status(400).json({
        error: `Zbyt wiele insightów w jednym żądaniu (limit ${INSIGHT_BATCH_MAX_IDS}).`
      });
    }

    const dateParam = typeof req.query.date === 'string' && DATE_STRING_RE.test(req.query.date)
      ? req.query.date
      : null;

    const results = {};
    // Prosta pula robocza: N równoległych "pracowników" zdejmuje kolejne pozycje
    // ze wspólnego kursora. Bez tego Promise.all na 48 pozycjach odpaliłby wszystkie
    // handlery naraz.
    let cursor = 0;
    const worker = async () => {
      while (cursor < requestedIds.length) {
        const id = requestedIds[cursor++];
        const handler = insightHandlers.get(id);
        if (!handler) {
          results[id] = { status: 'unknown' };
          continue;
        }
        results[id] = await runInsightHandler(handler, req, dateParam);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(INSIGHT_BATCH_CONCURRENCY, requestedIds.length) },
        worker
      )
    );

    res.json({ date: dateParam || getLocalDateString(), results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zbiorczego pobierania insightów.' });
  }
});

// Agregacja odżywiania (kalorie/makro) dla zakresu dat - używana do porównań
// tydzień/miesiąc (punkt 10 z analizy dashboardu). Średnie liczone WYŁĄCZNIE
// po dniach, w których faktycznie zapisano posiłki (days_logged) - dzielenie
// przez całą długość okresu zaniżałoby średnią przy nieregularnym logowaniu.
async function aggregateNutrition(userId, startDate, endDate) {
  const rows = await db.all(
    `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, SUM(fiber) AS fiber, SUM(sugar) AS sugar, SUM(sodium) AS sodium
     FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const daysLogged = rows.length;
  const totals = rows.reduce((acc, r) => {
    acc.calories += r.calories || 0;
    acc.protein += r.protein || 0;
    acc.carbs += r.carbs || 0;
    acc.fat += r.fat || 0;
    acc.fiber += r.fiber || 0;
    acc.sugar += r.sugar || 0;
    acc.sodium += r.sodium || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  const avg = daysLogged > 0 ? {
    calories: Math.round(totals.calories / daysLogged),
    protein: Math.round((totals.protein / daysLogged) * 10) / 10,
    carbs: Math.round((totals.carbs / daysLogged) * 10) / 10,
    fat: Math.round((totals.fat / daysLogged) * 10) / 10,
    fiber: Math.round((totals.fiber / daysLogged) * 10) / 10,
    sugar: Math.round((totals.sugar / daysLogged) * 10) / 10,
    sodium: Math.round(totals.sodium / daysLogged)
  } : null;
  return { start: startDate, end: endDate, days_logged: daysLogged, totals, avg };
}

// Bilans kaloryczny narastająco dla zakresu dat (punkt 11 z analizy dashboardu).
// Liczony tylko po dniach z zapisanymi posiłkami - dni bez logów nie psują
// bilansu zerami.
async function aggregateCalorieBalance(userId, startDate, endDate, targetCalories, bmr) {
  const mealRows = await db.all(
    `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
    [userId, startDate, endDate]
  );
  const healthRows = await db.all(
    `SELECT date, active_calories FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ?`,
    [userId, startDate, endDate]
  );
  const activeByDate = new Map(healthRows.map(r => [r.date, r.active_calories || 0]));

  const daysWithData = mealRows.length;
  let totalEaten = 0;
  let totalBurned = 0;
  mealRows.forEach(r => {
    totalEaten += r.calories || 0;
    totalBurned += bmr + (activeByDate.get(r.date) || 0);
  });

  return {
    start: startDate,
    end: endDate,
    days_with_data: daysWithData,
    target_calories: targetCalories,
    total_eaten: totalEaten,
    total_burned: daysWithData > 0 ? totalBurned : 0,
    balance_vs_burned: daysWithData > 0 ? totalEaten - totalBurned : null,
    balance_vs_target: daysWithData > 0 ? totalEaten - (targetCalories * daysWithData) : null
  };
}

router.get('/api/dashboard', async (req, res) => {
  const date = resolveQueryDate(req);
  try {
    // Ustawienia celów
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    // Realny HRmax na bazie roku urodzenia użytkownika (wzór 220 - wiek) - wcześniej
    // strefy tętna (Karvonen) liczone na froncie zawsze zakładały HRmax=190 (czyli
    // wiek ~30 lat) niezależnie od realnego wieku użytkownika. Pole opcjonalne -
    // jeśli użytkownik nie podał roku urodzenia w profilu, zwracamy null, a front
    // sam wraca do fallbacku 190.
    const userRow = await db.get('SELECT birth_year FROM users WHERE id = ?', [req.user.id]);
    // Bug fix: rok liczony przez getWarsawWallClock (nie goły `new Date()`, który
    // bierze strefę procesu Node) - na hostingu w UTC, w oknie ok. 22:00-23:59
    // czasu Europe/Warsaw pierwszego dnia stycznia... a właściwie odwrotnie: w
    // oknie 00:00-01:59 1 stycznia czasu warszawskiego (czyli jeszcze 31 grudnia
    // w UTC), `new Date().getFullYear()` zwracał POPRZEDNI rok, więc HRmax
    // (Karvonen) był liczony o rok "za młodo" dla użytkownika przez ok. 2h w
    // Sylwestra - ten sam wzorzec błędu, co przy getLocalDateString (patrz
    // komentarz w utils/dates.js).
    const currentYear = getWarsawWallClock().getUTCFullYear();
    const userMaxHr = userRow && userRow.birth_year ? (220 - (currentYear - userRow.birth_year)) : null;

    // Posiłki z dzisiaj
    const mealRows = await db.all(`SELECT * FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, date]);
    // Detektor anomalii (patrz utils/mealAnomaly.js) - bazowy rozkład kalorii liczony
    // RAZ dla całego dnia, z historii PRZED `date`, a nie per posiłek.
    const calorieBaseline = await getCalorieBaseline(req.user.id, date);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
    const meals = mealRows.map(r => {
      let analysis = {};
      try {
        analysis = JSON.parse(r.analysis_json);
      } catch (e) {
        analysis = { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, food_items: [] };
      }
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
      totalEaten.fiber += r.fiber || 0;
      totalEaten.sugar += r.sugar || 0;
      totalEaten.sodium += r.sodium || 0;
      // Kolumny bazy (po sanityzacji przy zapisie) muszą nadpisać spread z `analysis`
      // (niesanityzowany JSON z AI) - inaczej karta posiłku pokaże inne wartości niż
      // te użyte tuż wyżej do totalEaten.
      return {
        id: r.id, raw_text: r.raw_text, timestamp: r.timestamp, image_base64: r.image_base64, ...analysis,
        calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
        anomalies: detectMealAnomalies({ calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat }, calorieBaseline)
      };
    });

    // Zaokrąglenie makr zjedzonych
    totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
    totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
    totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;
    totalEaten.fiber = Math.round(totalEaten.fiber * 10) / 10;
    totalEaten.sugar = Math.round(totalEaten.sugar * 10) / 10;
    totalEaten.sodium = Math.round(totalEaten.sodium);

    // Dane zdrowotne z Oura & Withings z wybranego dnia
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, date]) || getDefaultHealthMetrics();

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);

    // Pobierz najświeższe nie-null/nie-zero wartości dla wszystkich wskaźników zdrowotnych (jeśli wybrane są puste)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;
    let displayBpSystolic = health.blood_pressure_systolic;
    let displayBpDiastolic = health.blood_pressure_diastolic;
    let displaySteps = health.steps;
    let displayActiveCalories = health.active_calories;
    let displayTotalCaloriesBurned = health.total_calories_burned;
    let displaySleepScore = health.sleep_score;
    let displaySleepDuration = health.sleep_duration;
    let displaySleepDeep = health.sleep_deep;
    let displaySleepRem = health.sleep_rem;
    let displayReadinessScore = health.readiness_score;
    let displayHrv = health.hrv;
    let displayRhr = health.rhr;
    let displayTempDev = health.temperature_deviation;
    let displayRespiratoryRate = health.respiratory_rate;
    let displaySpo2 = health.spo2_percentage;
    let displayWristTemperature = health.wrist_temperature;
    let displayActiveMinutes = health.active_minutes;
    // Dystans i rozbicie aktywności (sedentary/low) to liczniki dzienne jak kroki -
    // celowo NIE są dociągane z poprzednich dni (patrz komentarz powyżej).
    let displayDistanceMeters = health.distance_meters;
    let displaySedentaryMinutes = health.sedentary_minutes;
    let displayLowActivityMinutes = health.low_activity_minutes;
    // Stres (Oura daily_stress) to wynik liczony raz dziennie, tak jak gotowość/sen -
    // dociągamy ostatnią dostępną wartość, jeśli dzisiejsza synchronizacja jeszcze nie
    // nadeszła (patrz analogiczna logika dla displayReadinessScore poniżej).
    let displayStressHighMinutes = health.stress_high_minutes;
    let displayStressRecoveryMinutes = health.stress_recovery_minutes;
    let displayStressSummary = health.stress_summary;

    if (displayWeight === null) {
      const row = await db.get(`SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWeight = row.weight;
    }
    if (displayFatRatio === null) {
      const row = await db.get(`SELECT fat_ratio FROM health_metrics WHERE user_id = ? AND fat_ratio IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayFatRatio = row.fat_ratio;
    }
    if (displayMuscleMass === null) {
      const row = await db.get(`SELECT muscle_mass FROM health_metrics WHERE user_id = ? AND muscle_mass IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayMuscleMass = row.muscle_mass;
    }
    // Ciśnienie tętnicze (Withings BPM) - dociągane analogicznie do wagi/składu ciała,
    // bo pomiar nie jest robiony codziennie.
    if (displayBpSystolic === null) {
      const row = await db.get(`SELECT blood_pressure_systolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpSystolic = row.blood_pressure_systolic;
    }
    if (displayBpDiastolic === null) {
      const row = await db.get(`SELECT blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_diastolic IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayBpDiastolic = row.blood_pressure_diastolic;
    }
    // Uwaga: liczniki dzienne (kroki, kalorie aktywne, kalorie spalone, minuty aktywności)
    // celowo NIE są dociągane z poprzednich dni - mają zerować się każdego dnia, dopóki
    // pierwsza synchronizacja danego dnia nie zapisze nowych wartości w health_metrics.
    // (W przeciwnym razie dashboard otwarty rano przed pierwszą synchronizacją pokazywałby
    // wczorajsze kroki/kalorie, co jest błędne.)
    if (displaySleepScore === null || displaySleepScore === 0) {
      const row = await db.get(`SELECT sleep_score FROM health_metrics WHERE user_id = ? AND sleep_score IS NOT NULL AND sleep_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepScore = row.sleep_score;
    }
    if (displaySleepDuration === null || displaySleepDuration === 0) {
      const row = await db.get(`SELECT sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL AND sleep_duration > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDuration = row.sleep_duration;
    }
    if (displaySleepDeep === null || displaySleepDeep === 0) {
      const row = await db.get(`SELECT sleep_deep FROM health_metrics WHERE user_id = ? AND sleep_deep IS NOT NULL AND sleep_deep > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepDeep = row.sleep_deep;
    }
    if (displaySleepRem === null || displaySleepRem === 0) {
      const row = await db.get(`SELECT sleep_rem FROM health_metrics WHERE user_id = ? AND sleep_rem IS NOT NULL AND sleep_rem > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySleepRem = row.sleep_rem;
    }
    if (displayReadinessScore === null || displayReadinessScore === 0) {
      const row = await db.get(`SELECT readiness_score FROM health_metrics WHERE user_id = ? AND readiness_score IS NOT NULL AND readiness_score > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayReadinessScore = row.readiness_score;
    }
    if (displayHrv === null || displayHrv === 0) {
      const row = await db.get(`SELECT hrv FROM health_metrics WHERE user_id = ? AND hrv IS NOT NULL AND hrv > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayHrv = row.hrv;
    }
    if (displayRhr === null || displayRhr === 0) {
      const row = await db.get(`SELECT rhr FROM health_metrics WHERE user_id = ? AND rhr IS NOT NULL AND rhr > 0 ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRhr = row.rhr;
    }
    if (displayTempDev === null) {
      const row = await db.get(`SELECT temperature_deviation FROM health_metrics WHERE user_id = ? AND temperature_deviation IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayTempDev = row.temperature_deviation;
    }
    if (displayRespiratoryRate === null) {
      const row = await db.get(`SELECT respiratory_rate FROM health_metrics WHERE user_id = ? AND respiratory_rate IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayRespiratoryRate = row.respiratory_rate;
    }
    if (displaySpo2 === null) {
      const row = await db.get(`SELECT spo2_percentage FROM health_metrics WHERE user_id = ? AND spo2_percentage IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displaySpo2 = row.spo2_percentage;
    }
    if (displayWristTemperature === null) {
      const row = await db.get(`SELECT wrist_temperature FROM health_metrics WHERE user_id = ? AND wrist_temperature IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayWristTemperature = row.wrist_temperature;
    }
    // displayActiveMinutes / displayDistanceMeters / displaySedentaryMinutes /
    // displayLowActivityMinutes: brak dociągania z poprzednich dni - patrz komentarz powyżej.
    if (displayStressHighMinutes === null) {
      const row = await db.get(`SELECT stress_high_minutes FROM health_metrics WHERE user_id = ? AND stress_high_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressHighMinutes = row.stress_high_minutes;
    }
    if (displayStressRecoveryMinutes === null) {
      const row = await db.get(`SELECT stress_recovery_minutes FROM health_metrics WHERE user_id = ? AND stress_recovery_minutes IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressRecoveryMinutes = row.stress_recovery_minutes;
    }
    if (displayStressSummary === null) {
      const row = await db.get(`SELECT stress_summary FROM health_metrics WHERE user_id = ? AND stress_summary IS NOT NULL ORDER BY date DESC LIMIT 1`, [req.user.id]);
      if (row) displayStressSummary = row.stress_summary;
    }

    // Ostatni zapisany pomiar obwodów ciała (niezależnie od wybranego dnia dashboardu) -
    // główny Dashboard wcześniej nie pokazywał nawet ostatniej wartości, mimo że pełny
    // CRUD + wykres trendu już istnieje w ActivityTracker.jsx.
    const latestBodyMeasurement = await db.get(
      `SELECT date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Realne treningi z danego dnia (zsynchronizowane przez webhook Apple Health,
    // patrz routes/appleHealth.js). Liczone tutaj (przed promptem AI), żeby dało się
    // przekazać dzisiejsze treningi do advicePrompt, nie tylko do odpowiedzi JSON.
    const workoutRows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories,
              avg_heart_rate, max_heart_rate, zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date = ? ORDER BY updated_at DESC`,
      [req.user.id, date]
    );
    const workouts = workoutRows.map(w => ({
      type: w.workout_type || 'Trening',
      duration_mins: Math.round(w.duration_minutes || 0),
      calories: Math.round(w.active_calories || 0),
      // Realne strefy kardio (Karvonen) zmierzone na zegarku w trakcie TEGO treningu -
      // patrz routes/appleHealth.js (computeWorkoutHrZones). null, gdy payload Health Auto
      // Export nie zawierał tętna (przełącznik "Include Workout Metrics" wyłączony) albo
      // użytkownik nie podał roku urodzenia (HRmax nieznany).
      avg_hr: w.avg_heart_rate != null ? Math.round(w.avg_heart_rate) : null,
      max_hr: w.max_heart_rate != null ? Math.round(w.max_heart_rate) : null,
      zone_minutes: [w.zone1_minutes, w.zone2_minutes, w.zone3_minutes, w.zone4_minutes, w.zone5_minutes]
    }));

    const activeCalories = displayActiveCalories || 0;
    const bmr = getBmr(settings);
    const totalBurned = displayTotalCaloriesBurned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Streaki celów (kalorie, sen) - liczone wyłącznie na bazie historii już zapisanej
    // w bazie (meals + health_metrics), zero nowych integracji (punkt 9 z analizy
    // dashboardu). Liczymy od WCZORAJ w dół względem przeglądanej daty (dzisiejszy/
    // przeglądany dzień może być jeszcze niedokończony - nie wszystkie posiłki czy sen
    // muszą być już zarejestrowane), przerywając na pierwszym dniu, który nie trafia
    // w cel, albo na pierwszej "dziurze" w danych (brak wpisu = przerwana passa).
    const subtractDay = (dateStr) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().split('T')[0];
    };
    const computeStreak = (valuesByDate, referenceDateStr, meetsGoal, maxDays = 90) => {
      let streak = 0;
      let cursor = subtractDay(referenceDateStr);
      for (let i = 0; i < maxDays; i++) {
        if (!valuesByDate.has(cursor) || !meetsGoal(valuesByDate.get(cursor))) break;
        streak++;
        cursor = subtractDay(cursor);
      }
      return streak;
    };

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const calorieMap = new Map(calorieRows.map(r => [r.date, r.total_calories]));
    // "Trafienie" w cel kaloryczny = bilans w rozsądnym paśmie wokół celu (+/-15%), nie
    // dokładnie do kalorii - inaczej streak byłby praktycznie niemożliwy do utrzymania.
    const targetCaloriesForStreak = getTargetCalories(settings);
    const calorieStreakDays = computeStreak(calorieMap, date, (total) =>
      total >= targetCaloriesForStreak * 0.85 && total <= targetCaloriesForStreak * 1.15
    );

    const sleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics WHERE user_id = ? AND sleep_duration IS NOT NULL ORDER BY date DESC LIMIT 90`,
      [req.user.id]
    );
    const sleepMap = new Map(sleepRows.map(r => [r.date, r.sleep_duration]));
    // POPRAWKA (runda 4 audytu): !settings.target_sleep_duration traktował realne,
    // zapisane przez użytkownika 0 (cel snu wyłączony) tak samo jak "nie ustawiono celu"
    // (settings.target_sleep_duration === undefined, gdy nie ma wiersza w tabeli settings).
    // Teraz fallback 7.2h włącza się tylko, gdy wartości faktycznie nie ma / jest NaN.
    const targetSleepForStreak = (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration;
    const sleepStreakDays = computeStreak(sleepMap, date, (duration) => duration >= targetSleepForStreak);

    // Generowanie porady od Dietetyka AI na bazie dzisiejszych danych (opcjonalne/throttled co 4h lub natychmiast po zmianie posiłku)
    let aiAdvice = "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.";
    let hasValidCache = false;

    if (health && health.ai_advice) {
      aiAdvice = health.ai_advice;
      if (health.ai_advice_generated_at) {
        const lastGenerated = new Date(health.ai_advice_generated_at).getTime();
        const lastModified = health.last_meal_modified_at ? new Date(health.last_meal_modified_at).getTime() : 0;
        
        // Cache jest ważny, gdy porada została wygenerowana po ostatniej modyfikacji posiłku
        // ORAZ od czasu generowania minęło mniej niż 4 godziny (4 * 60 * 60 * 1000)
        if (lastGenerated > lastModified && (Date.now() - lastGenerated < 4 * 60 * 60 * 1000)) {
          hasValidCache = true;
        }
      }
    }

    if (!hasValidCache) {
      // WAŻNE: dashboard ma być generowany WYŁĄCZNIE na podstawie danych już
      // zapisanych w bazie - to samo zgłoszenie, które kazało nam usunąć dane
      // demo z frontendu, dotyczy też tego miejsca. Wcześniej ten blok robił
      // "await generateContentWithFallback(...)" w trakcie obsługi żądania
      // GET /api/dashboard, czyli CAŁA odpowiedź (w tym kroki, kalorie, sen -
      // dane, które już były gotowe w bazie) czekała na żywe zapytanie sieciowe
      // do Gemini. Stąd wrażenie "dashboard się dociąga" przy otwarciu strony.
      // Teraz: jeśli cache porady wygasł, zwracamy to, co już mamy w bazie
      // (starą poradę lub domyślny placeholder) natychmiast, a nową poradę
      // generujemy w tle (fire-and-forget) - trafi do bazy i pojawi się przy
      // kolejnym odświeżeniu/synchronizacji, bez blokowania tej odpowiedzi.
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));

      // Klucz (user, data) do blokady równoległego generowania (patrz definicja
      // pendingAdviceGeneration na górze pliku) - jeśli generowanie dla tej (user, data)
      // już trwa (np. inna karta przeglądarki odświeżyła dashboard chwilę wcześniej),
      // NIE odpalamy kolejnego zapytania do Gemini, tylko zostawiamy stary cache/placeholder.
      const adviceLockKey = `${req.user.id}:${date}`;

      if (canUseAI && !pendingAdviceGeneration.has(adviceLockKey) && (meals.length > 0 || activeCalories > 0 || health.sleep_score !== null)) {
        // Imię (jeśli ustawione w Ustawieniach) ma priorytet nad loginem technicznym -
        // o to prosił użytkownik: AI ma się zwracać po imieniu, nie po nazwie konta.
        const displayName = req.user.first_name || req.user.username;

        // Pomiary i posiłki z wczoraj do kontekstu porównawczego dla AI
        const yesterdayDate = shiftDate(date, -1);
        const yesterdayMealRows = await db.all(
          `SELECT calories, protein, carbs, fat, raw_text FROM meals WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        );
        let yesterdayTotalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        yesterdayMealRows.forEach(r => {
          yesterdayTotalEaten.calories += r.calories || 0;
          yesterdayTotalEaten.protein += r.protein || 0;
          yesterdayTotalEaten.carbs += r.carbs || 0;
          yesterdayTotalEaten.fat += r.fat || 0;
        });
        yesterdayTotalEaten.protein = Math.round(yesterdayTotalEaten.protein * 10) / 10;
        yesterdayTotalEaten.carbs = Math.round(yesterdayTotalEaten.carbs * 10) / 10;
        yesterdayTotalEaten.fat = Math.round(yesterdayTotalEaten.fat * 10) / 10;

        const yesterdayHealth = await db.get(
          `SELECT active_calories, steps, supplements FROM health_metrics WHERE user_id = ? AND date = ?`,
          [req.user.id, yesterdayDate]
        ) || { active_calories: 0, steps: 0, supplements: null };

        // Pobranie trendów historycznych z bazy danych dla AI
        const last7DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -7), shiftDate(date, -1));
        const last30DaysNutrition = await aggregateNutrition(req.user.id, shiftDate(date, -30), shiftDate(date, -1));
        
        const weightHistory = await db.all(
          `SELECT date, weight, fat_ratio, muscle_mass FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const sleepHistory = await db.all(
          `SELECT date, sleep_score, readiness_score FROM health_metrics WHERE user_id = ? AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL) ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        const bpHistory = await db.all(
          `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics WHERE user_id = ? AND blood_pressure_systolic IS NOT NULL ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );
        // Pełna historia suplementów (ostatnie 7 dni z wpisem, nie tylko dziś/wczoraj) -
        // użytkownik wprost zażądał, żeby podsumowanie AI brało WSZYSTKO, co jest
        // wpisywane w aplikacji, łącznie z suplementami, a nie tylko dwa ostatnie dni.
        const supplementsHistory = await db.all(
          `SELECT date, supplements FROM health_metrics WHERE user_id = ? AND supplements IS NOT NULL AND supplements != '' ORDER BY date DESC LIMIT 7`,
          [req.user.id]
        );

        // "Tag dnia" (day_events) z ostatnich 30 dni (to samo okno co last30DaysNutrition) -
        // żeby AI wiedziało o dniach oznaczonych jako choroba/wakacje/późne zaśnięcie i nie
        // budowało rekomendacji na bazie nietypowych danych z tych dni (patrz utils/dayEvents.js).
        const dayEventsInWindow = await getDayEventsInRange(req.user.id, shiftDate(date, -30), date);
        const dayEventsContext = formatDayEventsForPrompt(dayEventsInWindow);

        // Cel sylwetki (opis tekstowy + opcjonalne zdjęcie referencyjne, ustawiane
        // w Ustawieniach - patrz routes/account.js i migracja w db.js). Nie trzymamy
        // tego w req.user (middleware/auth.js), bo zdjęcie base64 mogłoby być duże
        // i niepotrzebnie obciążałoby KAŻDE uwierzytelnione żądanie - pobieramy je
        // tylko tutaj, raz na faktyczne generowanie porady AI.
        const bodyGoalRow = await db.get(`SELECT body_goal_text, body_goal_photo_base64 FROM users WHERE id = ?`, [req.user.id]);
        const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;
        let bodyGoalImagePart = null;
        if (bodyGoalRow && bodyGoalRow.body_goal_photo_base64) {
          const goalPhotoMatch = bodyGoalRow.body_goal_photo_base64.match(/^data:([^;]+);base64,(.+)$/);
          if (goalPhotoMatch) {
            bodyGoalImagePart = {
              inlineData: {
                data: goalPhotoMatch[2],
                mimeType: goalPhotoMatch[1]
              }
            };
          }
        }

        const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
        const language = langRow ? langRow.value : 'pl';

        // Aktualna pogoda i pora dnia (Zadanie: algorytm ma znać i uwzględniać w
        // analizie bieżącą pogodę/czas - patrz utils/weatherContext.js). Ta porada
        // jest cache'owana do 4h (patrz hasValidCache powyżej), więc "aktualność"
        // pogody jest w tej samej rozdzielczości co reszta porady - to spójne z
        // resztą tej funkcji, nie żywy odczyt przy każdym GET /api/dashboard.
        // Lokalizacja: własna użytkownika (Ustawienia -> Lokalizacja), jeśli
        // ustawiona, inaczej domyślna lokalizacja wdrożenia.
        const userLocation = await getUserLocationOverride(req.user.id);
        const weatherTimeContext = await getWeatherAndTimeContext(language, userLocation?.lat, userLocation?.lon);

        let advicePrompt = '';
        if (language === 'en') {
          advicePrompt = `
You are a professional, friendly AI sports dietician working in the "Dietetyk AI" app.
Analyze today's balance for user ${displayName} on date ${date}:
User Goals:
- Target daily calorie intake: ${getTargetCalories(settings)} kcal
- Target Protein: ${settings.target_protein}g, Carbs: ${settings.target_carbs}g, Fat: ${settings.target_fat}g
- BMR (Basal Metabolic Rate): ${bmr} kcal
- User body goal description: ${bodyGoalText || 'not described in Settings'}${bodyGoalImagePart ? '\n- The user also attached a reference photo of their body goal (see the attached image) - analyze it visually and relate recommendations to the body shape shown in the photo (e.g., muscle level, fat tissue, proportions), in the context of other data.' : ''}

Today's Balance:
- Total eaten: ${totalEaten.calories} kcal (Protein: ${totalEaten.protein}g, Carbs: ${totalEaten.carbs}g, Fat: ${totalEaten.fat}g, Fiber: ${totalEaten.fiber}g, Sugar: ${totalEaten.sugar}g, Sodium: ${totalEaten.sodium}mg)
- Active calories burned: ${activeCalories} kcal
- Total calories burned (BMR + Active): ${totalBurned} kcal
- Net balance (eaten - burned): ${netCalories} kcal
- Steps today: ${displaySteps || 0}
- Activity today: ${displayActiveMinutes || 0} min active, Distance: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Sedentary time: ${displaySedentaryMinutes || 0} min, Light activity: ${displayLowActivityMinutes || 0} min
- Water intake today: ${health.water_ml || 0}ml (target: ${getTargetWaterMl(settings)}ml)
- Supplements taken today: ${health.supplements || 'none (user did not save any supplements today)'}
- Subjective state (user rating, scale 1-5): Energy: ${health.energy_level != null ? health.energy_level + '/5' : 'not rated'}, Mood: ${health.mood != null ? health.mood + '/5' : 'not rated'}
- Workouts registered today (Apple Health): ${workouts.length > 0 ? workouts.map(w => {
    const base = `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`;
    if (w.avg_hr != null && w.zone_minutes.some(z => z != null)) {
      const zonesStr = w.zone_minutes.map((z, i) => `Z${i + 1}: ${Math.round(z || 0)}min`).join(', ');
      return `${base}, avg HR ${w.avg_hr} bpm (max ${w.max_hr} bpm) - heart rate zones: ${zonesStr}`;
    }
    return base;
  }).join(', ') : 'no registered workouts'}
- Calorie target streak: ${calorieStreakDays} days, Sleep target streak: ${sleepStreakDays} days

Current time and weather (context, not a user-logged metric):
${weatherTimeContext}

Oura Sleep/Readiness & Withings Body Composition:
- Sleep Score: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'no data'} (Duration: ${displaySleepDuration || 0}h, Deep: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Heart & Temp parameters: Resting HR (RHR): ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Wrist temperature deviation: ${displayTempDev !== null ? displayTempDev + ' °C' : 'N/A'}
- Respiration & SpO2: Respiratory rate: ${displayRespiratoryRate !== null ? displayRespiratoryRate + '/min' : 'N/A'}, SpO2: ${displaySpo2 !== null ? displaySpo2 + '%' : 'N/A'}, Wrist temperature: ${displayWristTemperature !== null ? displayWristTemperature + ' °C' : 'N/A'}
- Stress (Oura): High stress: ${displayStressHighMinutes !== null ? displayStressHighMinutes + ' min' : 'no data'}, Recovery: ${displayStressRecoveryMinutes !== null ? displayStressRecoveryMinutes + ' min' : 'no data'}, Stress summary: ${displayStressSummary || 'N/A'}
- Readiness Score: ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'no data'}
- Body Composition: Weight: ${displayWeight !== null ? displayWeight + ' kg' : 'no data'}, Body fat percentage: ${displayFatRatio !== null ? displayFatRatio + '%' : 'no data'}, Muscle mass: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'no data'}
- Blood Pressure (Withings): ${displayBpSystolic !== null && displayBpDiastolic !== null ? `${displayBpSystolic}/${displayBpDiastolic} mmHg` : 'no data'}
- Body measurements (latest from ${latestBodyMeasurement ? latestBodyMeasurement.date : 'N/A'}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Waist: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Waist +2cm: ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Waist -2cm: ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Chest: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Shoulders: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Hips: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps Left: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps Right: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Thigh: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'no fields filled' : 'no data in database'}

Today's meals list:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fat}g)`).join('\n') || 'No meals logged'}

Yesterday's context (${yesterdayDate}):
- Yesterday total eaten: ${yesterdayTotalEaten.calories} kcal (P: ${yesterdayTotalEaten.protein}g, C: ${yesterdayTotalEaten.carbs}g, F: ${yesterdayTotalEaten.fat}g)
- Yesterday active calories: ${yesterdayHealth.active_calories || 0} kcal
- Yesterday steps: ${yesterdayHealth.steps || 0}
- Yesterday supplements: ${yesterdayHealth.supplements || 'none'}
- Yesterday meals list:
${yesterdayMealRows.map(m => `- ${m.raw_text} (${m.calories} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fat}g)`).join('\n') || 'No meals logged yesterday'}

Trends and database history:
- Average nutrition (last 7 days): ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (P: ${last7DaysNutrition.avg.protein}g, C: ${last7DaysNutrition.avg.carbs}g, F: ${last7DaysNutrition.avg.fat}g, Fiber: ${last7DaysNutrition.avg.fiber}g, Sugar: ${last7DaysNutrition.avg.sugar}g, Sodium: ${last7DaysNutrition.avg.sodium}mg) over ${last7DaysNutrition.days_logged} logged days` : 'no data'}
- Average nutrition (last 30 days): ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (P: ${last30DaysNutrition.avg.protein}g, C: ${last30DaysNutrition.avg.carbs}g, F: ${last30DaysNutrition.avg.fat}g, Fiber: ${last30DaysNutrition.avg.fiber}g, Sugar: ${last30DaysNutrition.avg.sugar}g, Sodium: ${last30DaysNutrition.avg.sodium}mg) over ${last30DaysNutrition.days_logged} logged days` : 'no data'}
- Weight & body composition history:
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (fat: ${w.fat_ratio || '-'}%, muscle: ${w.muscle_mass || '-'} kg)`).join('\n') || 'no data'}
- Supplements history (latest):
${supplementsHistory.map(s => `- ${s.date}: ${s.supplements}`).join('\n') || 'no data'}
- Latest Oura sleep/readiness history:
${sleepHistory.map(s => `- ${s.date}: Sleep ${s.sleep_score || '-'}, Readiness ${s.readiness_score || '-'}`).join('\n') || 'no data'}
- Blood pressure history (Withings):
${bpHistory.map(b => `- ${b.date}: ${b.blood_pressure_systolic}/${b.blood_pressure_diastolic} mmHg`).join('\n') || 'no data'}
${dayEventsContext}

Your analysis MUST consider ALL data above (today's meals & micronutrients, activity, workouts, supplements, yesterday's comparison, 7/30-day trends, weight/body composition/circumference history, blood pressure, sleep, readiness, stress, respiration). Make sure to address:
1. Workout intensity and cardio zones: if "heart rate zones" are provided (Z1-Z5 based on Karvonen), base your evaluation on these real zones. Relate minutes in zones to the user's body goal.
2. Precise dietary adjustments based on today's meals and workout, including fiber, simple sugars, and sodium quality.
3. Comparison with yesterday and the 7/30-day trend.
4. Insights from weight, body composition, and circumference trends.
5. Supplement intake: analyze supplement history and comment on regularity, timing, and usefulness.
6. Blood pressure: evaluate if values are within range, and advise consulting a doctor if values are elevated (do not diagnose).
7. Recovery and stress (Oura): SpO2, respiratory rate, wrist temperature, stress minutes.
8. Calorie/sleep streaks: highlight consistency or suggest how to return to track.
9. Body goal: assess if current trend, diet, and training are leading towards it.
10. Days with a Day Tag (if any): adjust recommendations and do not count deviations from these days as normal.

Format the response STRICTLY in this Markdown structure:
1. One short, personalized introductory sentence addressing the user by name (${displayName}).
2. Header "## Analysis" followed by 2-3 concise sentences synthesizing today's data against historical trends.
3. Header "## Recommendations" followed by a bullet list (3-5 points, each starting with "- ") detailing concrete, actionable recommendations.

Use **bolding** for key numbers and phrases in the Analysis and Recommendations. Write in English, directly to the user, concisely and factually.
`;
        } else {
          advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${displayName} dla dnia ${date}:
Cele użytkownika:
- Cel kaloryczny spożycia: ${getTargetCalories(settings)} kcal
- Cel Białka: ${settings.target_protein}g, Węglowodanych: ${settings.target_carbs}g, Tłuszczu: ${settings.target_fat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal
- Cel sylwetki opisany przez użytkownika: ${bodyGoalText || 'użytkownik nie opisał celu sylwetki w Ustawieniach'}${bodyGoalImagePart ? '\n- Użytkownik dołączył też zdjęcie referencyjne celu sylwetki (patrz załączony obraz) - przeanalizuj je wizualnie i odnieś rekomendacje do tego, jak wygląda sylwetka na zdjęciu (np. poziom umięśnienia, tkanki tłuszczowej, proporcje), w kontekście pozostałych danych.' : ''}

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g, Błonnik: ${totalEaten.fiber}g, Cukry: ${totalEaten.sugar}g, Sód: ${totalEaten.sodium}mg)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${displaySteps || 0}
- Aktywność dzisiaj: ${displayActiveMinutes || 0} min aktywności, Dystans: ${displayDistanceMeters ? (Math.round(displayDistanceMeters / 100) / 10) + ' km' : '0 km'}, Czas siedzący: ${displaySedentaryMinutes || 0} min, Niska intensywność: ${displayLowActivityMinutes || 0} min
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${getTargetWaterMl(settings)}ml)
- Przyjęte suplementy dzisiaj: ${health.supplements || 'brak (użytkownik nie zapisał dzisiaj żadnych suplementów)'}
- Samopoczucie (ręczna ocena użytkownika, skala 1-5): Energia: ${health.energy_level != null ? health.energy_level + '/5' : 'nie oceniono'}, Nastrój: ${health.mood != null ? health.mood + '/5' : 'nie oceniono'}
- Treningi zarejestrowane dzisiaj (Apple Health): ${workouts.length > 0 ? workouts.map(w => {
    const base = `${w.type} (${w.duration_mins} min, ${w.calories} kcal)`;
    if (w.avg_hr != null && w.zone_minutes.some(z => z != null)) {
      const zonesStr = w.zone_minutes.map((z, i) => `Z${i + 1}: ${Math.round(z || 0)}min`).join(', ');
      return `${base}, śr. tętno ${w.avg_hr} bpm (max ${w.max_hr} bpm) - realny rozkład stref kardio: ${zonesStr}`;
    }
    return base;
  }).join(', ') : 'brak zarejestrowanych treningów'}
- Passa (streak) trafiania w cel kaloryczny: ${calorieStreakDays} dni, Passa snu wg celu: ${sleepStreakDays} dni

Aktualny czas i pogoda (kontekst, nie metryka zapisana przez użytkownika):
${weatherTimeContext}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${displaySleepScore !== null ? displaySleepScore + '/100' : 'Brak danych'} (Czas trwania: ${displaySleepDuration || 0}h, Głęboki: ${displaySleepDeep || 0}h, REM: ${displaySleepRem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${displayRhr || '-'} bpm, HRV: ${displayHrv || '-'} ms, Odchylenie temperatury ciała: ${displayTempDev !== null ? displayTempDev + ' °C' : 'brak'}
- Oddech i utlenowanie krwi: Częstość oddechów: ${displayRespiratoryRate !== null ? displayRespiratoryRate + '/min' : 'brak'}, SpO2: ${displaySpo2 !== null ? displaySpo2 + '%' : 'brak'}, Temperatura nadgarstka: ${displayWristTemperature !== null ? displayWristTemperature + ' °C' : 'brak'}
- Stres (Oura): Wysoki stres: ${displayStressHighMinutes !== null ? displayStressHighMinutes + ' min' : 'brak danych'}, Regeneracja: ${displayStressRecoveryMinutes !== null ? displayStressRecoveryMinutes + ' min' : 'brak danych'}, Podsumowanie: ${displayStressSummary || 'brak'}
- Wynik Gotowości (Readiness): ${displayReadinessScore !== null ? displayReadinessScore + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${displayWeight !== null ? displayWeight + ' kg' : 'brak danych'}, Procent tłuszczu: ${displayFatRatio !== null ? displayFatRatio + '%' : 'brak danych'}, Masa mięśniowa: ${displayMuscleMass !== null ? displayMuscleMass + ' kg' : 'brak danych'}
- Ciśnienie tętnicze (Withings): ${displayBpSystolic !== null && displayBpDiastolic !== null ? `${displayBpSystolic}/${displayBpDiastolic} mmHg` : 'brak danych'}
- Obwody ciała (ostatni zapisany pomiar${latestBodyMeasurement ? ', ' + latestBodyMeasurement.date : ''}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Pas +2cm: ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Pas -2cm: ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Barki: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps lewy: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps prawy: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'brak wypełnionych pól' : 'brak danych w bazie'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Dla kontekstu historycznego, oto dane z wczoraj (${yesterdayDate}):
- Łącznie zjedzone wczoraj: ${yesterdayTotalEaten.calories} kcal (Białko: ${yesterdayTotalEaten.protein}g, Węgle: ${yesterdayTotalEaten.carbs}g, Tłuszcz: ${yesterdayTotalEaten.fat}g)
- Aktywne kalorie spalone wczoraj: ${yesterdayHealth.active_calories || 0} kcal
- Wykonane kroki wczoraj: ${yesterdayHealth.steps || 0}
- Przyjęte suplementy wczoraj: ${yesterdayHealth.supplements || 'brak'}
- Lista wczorajszych posiłków:
${yesterdayMealRows.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak posiłków wczoraj'}

Trendy i historia z bazy danych użytkownika:
- Średnie odżywianie z ostatnich 7 dni: ${last7DaysNutrition.avg ? `${last7DaysNutrition.avg.calories} kcal (B: ${last7DaysNutrition.avg.protein}g, W: ${last7DaysNutrition.avg.carbs}g, T: ${last7DaysNutrition.avg.fat}g, Błonnik: ${last7DaysNutrition.avg.fiber}g, Cukry: ${last7DaysNutrition.avg.sugar}g, Sód: ${last7DaysNutrition.avg.sodium}mg) na ${last7DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Średnie odżywianie z ostatnich 30 dni: ${last30DaysNutrition.avg ? `${last30DaysNutrition.avg.calories} kcal (B: ${last30DaysNutrition.avg.protein}g, W: ${last30DaysNutrition.avg.carbs}g, T: ${last30DaysNutrition.avg.fat}g, Błonnik: ${last30DaysNutrition.avg.fiber}g, Cukry: ${last30DaysNutrition.avg.sugar}g, Sód: ${last30DaysNutrition.avg.sodium}mg) na ${last30DaysNutrition.days_logged} dni logowania` : 'brak danych'}
- Historia pomiarów wagi i składu ciała (ostatnie wpisy):
${weightHistory.map(w => `- ${w.date}: ${w.weight} kg (tłuszcz: ${w.fat_ratio || '-'}%, mięśnie: ${w.muscle_mass || '-'} kg)`).join('\n') || 'brak danych w bazie'}
- Historia suplementów (ostatnie wpisy, nie tylko dziś/wczoraj):
${supplementsHistory.map(s => `- ${s.date}: ${s.supplements}`).join('\n') || 'brak zapisanych suplementów w bazie'}
- Ostatnia jakość snu i gotowości Oura:
${sleepHistory.map(s => `- ${s.date}: Sen ${s.sleep_score || '-'}, Gotowość ${s.readiness_score || '-'}`).join('\n') || 'brak danych w bazie'}
- Historia ciśnienia tętniczego (Withings, ostatnie pomiary):
${bpHistory.map(b => `- ${b.date}: ${b.blood_pressure_systolic}/${b.blood_pressure_diastolic} mmHg`).join('\n') || 'brak danych w bazie'}
${dayEventsContext}
Twoja analiza MUSI uwzględniać WSZYSTKIE dane podane powyżej (dzisiejsze posiłki i mikroelementy, aktywność, treningi, suplementy, porównanie z wczoraj, trendy 7/30-dniowe, historię wagi/składu ciała/obwodów, ciśnienia tętniczego, snu, gotowości, stresu i parametrów oddechowych) - to jest kluczowa funkcja tej aplikacji, użytkownik oczekuje analizy na bazie CAŁEJ historii i wszystkich dostępnych metryk, nie tylko jednego dnia czy wybranych wskaźników. Weź pod uwagę przy analizie i rekomendacjach:
1. Intensywność wysiłku i strefy kardio: jeśli przy treningu podano "realny rozkład stref kardio" (zmierzony tętnem podczas treningu, strefy Z1-Z5 metodą Karvonena: Z1 regeneracja, Z2 spalanie tłuszczu/baza tlenowa, Z3 tempo, Z4-Z5 wysoka intensywność beztlenowa), PRIORYTETOWO oprzyj ocenę na tych realnych minutach w strefach, nie na szacowaniu - i odnieś ten rozkład wprost do celu sylwetki użytkownika (np. przy celu redukcji/spalania tłuszczu doceń czas w Z2, przy celu budowy wydolności/masy zwróć uwagę na czas w Z3-Z4, a nadmiar minut w Z1 przy intensywnym typie treningu skomentuj jako niewykorzystany potencjał). Jeśli realnych stref nie podano (brak danych z zegarka), oceń intensywność orientacyjnie na bazie aktywnych kalorii, typu/czasu trwania treningu oraz RHR/HRV, zaznaczając że to oszacowanie.
2. Precyzyjne zmiany w diecie na bazie dzisiejszych posiłków i treningu, w tym jakość diety pod kątem błonnika, cukrów prostych i sodu (np. zbyt mało błonnika w stosunku do kalorii, zbyt dużo cukrów prostych lub sodu w ostatnich dniach) - nie tylko makra, ale pełny obraz odżywiania.
3. Porównanie dzisiejszego odżywiania i aktywności z wczorajszymi oraz z trendem 7/30-dniowym - jeśli dieta z ostatnich dni nie była optymalna (np. za mało białka w stosunku do celu, zbyt mało kcal po dużym treningu lub nadmiar kalorii przy braku ruchu), wskaż to konstruktywnie i doradź konkretną korektę.
4. Wnioski z trendu wagi, składu ciała i obwodów ciała z ostatnich pomiarów Withings oraz jakości snu, regeneracji i poziomu stresu z Oura (zwróć uwagę, czy obecny trend przybliża użytkownika do celu w dłuższej perspektywie 7/30 dni).
5. Przyjęte suplementy: przeanalizuj CAŁĄ historię suplementów (nie tylko dziś/wczoraj, ale wszystkie dostępne wpisy z ostatnich dni) i skomentuj krótko ich przydatność, regularność przyjmowania i czas przyjmowania w odniesieniu do treningu i samopoczucia użytkownika.
6. Ciśnienie tętnicze: jeśli dostępne są pomiary ciśnienia, oceń czy wartości są w normie (orientacyjnie <120/80 mmHg optymalnie, 120-129/<80 podwyższone prawidłowe, ≥130/80 nadciśnienie) i czy trend z ostatnich pomiarów jest stabilny, rosnący czy spadkowy - jeśli widzisz niepokojący trend lub wartości podwyższone, zalecaj konsultację lekarską (nie diagnozuj).
7. Regeneracja i stres: jeśli dostępne są dane o stresie (Oura), SpO2, częstości oddechów czy temperaturze nadgarstka, skomentuj ogólny stan regeneracji organizmu i zasugeruj, czy potrzebny jest dzień odpoczynku.
8. Konsekwencja (streaki): jeśli użytkownik ma passę trafiania w cel kaloryczny lub cel snu, doceń to krótko - jeśli passa jest przerwana lub bliska zera, zachęcająco zasugeruj, jak wrócić na właściwe tory.
9. Cel sylwetki: jeśli użytkownik opisał swój cel sylwetki (i/lub dołączył zdjęcie referencyjne), odnieś dzisiejsze i historyczne dane DO TEGO CELU - oceń, czy obecne tempo, dieta i trening realnie do niego prowadzą, i jeśli nie, zaproponuj konkretną korektę. Jeśli cel nie został opisany, pomiń ten punkt bez komentowania jego braku.
10. Dni oznaczone "Tagiem dnia" (jeśli podane powyżej): jeśli dzisiejsza data lub dni z analizowanej historii pokrywają się z oznaczonym okresem (choroba, wakacje/urlop, późne zaśnięcie), uwzględnij ten kontekst i NIE buduj korygujących rekomendacji na bazie odchyleń z tych dni - są one już wyjaśnione i oczekiwane.

Sformatuj odpowiedź WYŁĄCZNIE w tej strukturze Markdown (frontend renderuje nagłówki, pogrubienia i listy punktowane):
1. Jedno krótkie, spersonalizowane zdanie wstępu, zwracające się do użytkownika po imieniu (${displayName}).
2. Nagłówek "## Analiza" a pod nim 2-3 zwięzłe zdania syntetyzujące dzisiejsze dane NA TLE trendu historycznego (wczoraj + 7/30 dni) - to ma być realna analiza porównawcza, nie powtórzenie samych liczb.
3. Nagłówek "## Rekomendacje" a pod nim lista punktowana (3-5 punktów, każdy zaczynający się od "- ") z konkretnymi, wykonalnymi działaniami wynikającymi z analizy (dieta i mikroelementy, trening, regeneracja i stres, suplementy, ciśnienie - tylko te obszary, które mają pokrycie w danych).
Używaj **pogrubienia** dla kluczowych liczb i fraz w Analizie i Rekomendacjach. Pisz w języku polskim, bezpośrednio do użytkownika, konkretnie i merytorycznie, bez lania wody.
`;
        }

        // Oznaczamy (user, data) jako "generowanie w toku" PRZED startem zapytania do
        // Gemini, żeby kolejne, prawie równoczesne żądanie GET /api/dashboard (patrz
        // warunek pendingAdviceGeneration.has(...) powyżej) nie odpaliło duplikatu.
        pendingAdviceGeneration.add(adviceLockKey);

        // Fire-and-forget: NIE czekamy na wynik w tym żądaniu (patrz komentarz wyżej).
        generateContentWithFallback(advicePrompt, false, bodyGoalImagePart, userApiKey, forceCustomKeyOnly)
          .then(async (text) => {
            const trimmed = text.trim();
            const nowStr = new Date().toISOString();
            await db.run(`
              INSERT INTO health_metrics (user_id, date, ai_advice, ai_advice_generated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET
                ai_advice = excluded.ai_advice,
                ai_advice_generated_at = excluded.ai_advice_generated_at
            `, [req.user.id, date, trimmed, nowStr]);
          })
          .catch((aiErr) => {
            console.error('[API ERROR] Błąd generowania porady AI (w tle):', aiErr);
          })
          .finally(() => {
            // Usuwamy blokadę zarówno po sukcesie, jak i po błędzie - inaczej błąd
            // (np. tymczasowa awaria Gemini) zablokowałby generowanie porady dla tej
            // (user, data) na zawsze, do restartu serwera.
            pendingAdviceGeneration.delete(adviceLockKey);
          });
      }
    }

    res.json({
      date,
      summary: {
        target_calories: settings.target_calories,
        target_protein: settings.target_protein,
        target_carbs: settings.target_carbs,
        target_fat: settings.target_fat,
        // POPRAWKA (runda 4 audytu): te pola to cele aktywności edytowalne w
        // ActivityTracker/Ustawieniach z atrybutem min="0" - użytkownik może świadomie
        // zapisać 0 (np. wyłączyć śledzenie celu kroków). Poprzedni warunek `!wartość`
        // traktował to zapisane 0 identycznie jak "brak wiersza w settings" (undefined)
        // i bezpowrotnie nadpisywał je domyślną wartością przy każdym odświeżeniu
        // dashboardu - 0 nigdy nie wracało do frontu. Teraz fallback działa tylko
        // faktycznie brakującej (undefined) lub niepoprawnej (NaN) wartości.
        target_steps: (settings.target_steps === undefined || isNaN(settings.target_steps)) ? 10000 : settings.target_steps,
        target_active_calories: (settings.target_active_calories === undefined || isNaN(settings.target_active_calories)) ? 500 : settings.target_active_calories,
        target_sleep_duration: (settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)) ? 7.2 : settings.target_sleep_duration,
        target_active_minutes: (settings.target_active_minutes === undefined || isNaN(settings.target_active_minutes)) ? 30 : settings.target_active_minutes,
        target_water_ml: getTargetWaterMl(settings),
        // Cel wagowy (kg) - pole opcjonalne (0 = brak ustawionego celu), używane
        // przez ActivityTracker.jsx do prognozy "do celu" (regresja liniowa).
        // Bez wpisania tu nie wracałoby z /api/dashboard mimo zapisania w
        // tabeli settings przez POST /api/settings (patrz account.js).
        target_weight_kg: (settings.target_weight_kg === undefined || isNaN(settings.target_weight_kg)) ? 0 : settings.target_weight_kg,
        height_cm: isNaN(settings.height_cm) || !settings.height_cm || settings.height_cm <= 0 ? null : settings.height_cm,
        bmr,
        calories_eaten: totalEaten.calories,
        calories_burned_active: activeCalories,
        calories_burned_total: totalBurned,
        net_calories: netCalories,
        eaten_protein: totalEaten.protein,
        eaten_carbs: totalEaten.carbs,
        eaten_fat: totalEaten.fat,
        steps: displaySteps || 0,
        workouts,
        last_sync: health.last_sync,
        sleep_score: displaySleepScore,
        sleep_duration: displaySleepDuration,
        sleep_deep: displaySleepDeep,
        sleep_rem: displaySleepRem,
        readiness_score: displayReadinessScore,
        hrv: displayHrv,
        rhr: displayRhr,
        temperature_deviation: displayTempDev,
        respiratory_rate: displayRespiratoryRate,
        spo2_percentage: displaySpo2,
        wrist_temperature: displayWristTemperature,
        weight: displayWeight,
        fat_ratio: displayFatRatio,
        muscle_mass: displayMuscleMass,
        blood_pressure_systolic: displayBpSystolic,
        blood_pressure_diastolic: displayBpDiastolic,
        active_minutes: displayActiveMinutes || 0,
        distance_meters: displayDistanceMeters || 0,
        sedentary_minutes: displaySedentaryMinutes || 0,
        low_activity_minutes: displayLowActivityMinutes || 0,
        stress_high_minutes: displayStressHighMinutes,
        stress_recovery_minutes: displayStressRecoveryMinutes,
        stress_summary: displayStressSummary,
        water_ml: health.water_ml || 0,
        supplements: health.supplements || null,
        energy_level: health.energy_level ?? null,
        mood: health.mood ?? null,
        has_oura: !!hasOuraRow,
        has_withings: !!hasWithingsRow,
        activity_source: health.activity_source || null,
        latest_body_measurement: latestBodyMeasurement || null,
        calorie_streak_days: calorieStreakDays,
        sleep_streak_days: sleepStreakDays,
        user_max_hr: userMaxHr
      },
      meals,
      aiAdvice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych dashboardu.' });
  }
});

// Porównanie odżywiania tydzień/miesiąc - bieżący okres (ostatnie 7/30 dni
// licząc do wybranej daty) vs poprzedni okres tej samej długości.
router.get('/api/dashboard/nutrition-comparison', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const weekCurrentStart = shiftDate(today, -6);
    const weekPreviousEnd = shiftDate(weekCurrentStart, -1);
    const weekPreviousStart = shiftDate(weekPreviousEnd, -6);

    const monthCurrentStart = shiftDate(today, -29);
    const monthPreviousEnd = shiftDate(monthCurrentStart, -1);
    const monthPreviousStart = shiftDate(monthPreviousEnd, -29);

    const [weekCurrent, weekPrevious, monthCurrent, monthPrevious] = await Promise.all([
      aggregateNutrition(req.user.id, weekCurrentStart, today),
      aggregateNutrition(req.user.id, weekPreviousStart, weekPreviousEnd),
      aggregateNutrition(req.user.id, monthCurrentStart, today),
      aggregateNutrition(req.user.id, monthPreviousStart, monthPreviousEnd)
    ]);

    const pctChange = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    res.json({
      date: today,
      week: {
        current: weekCurrent,
        previous: weekPrevious,
        calories_change_pct: pctChange(weekCurrent.avg?.calories, weekPrevious.avg?.calories)
      },
      month: {
        current: monthCurrent,
        previous: monthPrevious,
        calories_change_pct: pctChange(monthCurrent.avg?.calories, monthPrevious.avg?.calories)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania porównania odżywiania.' });
  }
});

// Bilans kaloryczny narastająco za ostatnie 7 i 30 dni względem celu.
router.get('/api/dashboard/calorie-balance', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const [week, month] = await Promise.all([
      aggregateCalorieBalance(req.user.id, shiftDate(today, -6), today, targetCalories, bmr),
      aggregateCalorieBalance(req.user.id, shiftDate(today, -29), today, targetCalories, bmr)
    ]);

    res.json({ date: today, week, month });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania bilansu kalorycznego.' });
  }
});

// Insight: wpływ snu na odżywianie NASTĘPNEGO dnia (kalorie/cukier). Dzielimy
// noce z danymi o śnie (Oura) na "krótki sen" i "wystarczający sen" względem
// celu użytkownika (target_sleep_duration, domyślnie 7.2h - ten sam cel co na
// karcie "Czas snu"), a potem porównujemy średnie spożycie kalorii/cukru
// następnego dnia w obu grupach. To nie jest test statystyczny - to opisowe
// porównanie dwóch średnich na realnych danych użytkownika, więc wymagamy
// minimalnej liczby dni w KAŻDEJ grupie (MIN_NIGHTS_PER_GROUP), inaczej wynik
// byłby przypadkowy (np. 1 krótka noc z akurat sytą kolacją następnego dnia).
const MIN_NIGHTS_PER_GROUP = 5;
const SLEEP_INSIGHT_LOOKBACK_DAYS = 90;

router.get('/api/dashboard/sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SLEEP_INSIGHT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const sleepThreshold = settings.target_sleep_duration === undefined || isNaN(settings.target_sleep_duration)
      ? 7.2
      : settings.target_sleep_duration;

    // Noce ze znanym czasem snu - data tej noclegówki to dzień, do którego Oura
    // przypisuje sen (rano po przebudzeniu), więc "następny dzień" w sensie
    // odżywiania to po prostu data+1.
    const rawSleepRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_duration IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    // Tag dnia: noce oznaczone jako "późne zaśnięcie" wykluczamy z liczenia efektu
    // krótki-sen -> jedzenie następnego dnia - to już wiadomy, opisany wyjątek, nie
    // powinien kształtować baseline "typowej" krótkiej noce użytkownika.
    const lateSleepExcluded = await getExcludedDates(req.user.id, ['late_sleep'], startDate, today);
    const sleepRows = rawSleepRows.filter(r => !lateSleepExcluded.has(r.date));

    if (sleepRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_sleep_data', sleepThreshold });
    }

    // Posiłki zgrupowane po dniu - potrzebujemy sum kalorii/cukru dla KAŻDEGO
    // dnia w oknie (+1 dzień ponad zakres snu, żeby objąć "następny dzień" po
    // ostatniej nocy z danymi).
    const mealRows = await db.all(
      `SELECT date, SUM(calories) AS calories, SUM(sugar) AS sugar
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const mealsByDate = new Map(mealRows.map(r => [r.date, { calories: r.calories || 0, sugar: r.sugar || 0 }]));

    const shortSleepNext = [];
    const goodSleepNext = [];

    sleepRows.forEach(row => {
      const nextDay = shiftDate(row.date, 1);
      const nextMeals = mealsByDate.get(nextDay);
      // Dzień bez ŻADNEGO zapisanego posiłku (nie ma wpisu w mealsByDate) nie
      // wchodzi do porównania - "0 kcal następnego dnia" oznaczałoby tu brak
      // logowania, nie realny fakt "nic nie jadł", co fałszywie zaniżałoby
      // średnią danej grupy.
      if (!nextMeals) return;
      const bucket = row.sleep_duration < sleepThreshold ? shortSleepNext : goodSleepNext;
      bucket.push(nextMeals);
    });

    if (shortSleepNext.length < MIN_NIGHTS_PER_GROUP || goodSleepNext.length < MIN_NIGHTS_PER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_nights',
        sleepThreshold,
        shortSleepNights: shortSleepNext.length,
        goodSleepNights: goodSleepNext.length,
        minNightsRequired: MIN_NIGHTS_PER_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;

    const avgCaloriesShort = avg(shortSleepNext, 'calories');
    const avgCaloriesGood = avg(goodSleepNext, 'calories');
    const avgSugarShort = avg(shortSleepNext, 'sugar');
    const avgSugarGood = avg(goodSleepNext, 'sugar');

    res.json({
      hasEnoughData: true,
      sleepThreshold,
      shortSleepNights: shortSleepNext.length,
      goodSleepNights: goodSleepNext.length,
      avgCaloriesAfterShortSleep: avgCaloriesShort,
      avgCaloriesAfterGoodSleep: avgCaloriesGood,
      caloriesDiff: Math.round((avgCaloriesShort - avgCaloriesGood) * 10) / 10,
      avgSugarAfterShortSleep: avgSugarShort,
      avgSugarAfterGoodSleep: avgSugarGood,
      sugarDiff: Math.round((avgSugarShort - avgSugarGood) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sen-odżywianie.' });
  }
});

// Próg "wysokiego sodu" wg wytycznych WHO/AHA (górna granica dziennego spożycia
// dla populacji ogólnej) - świadomie NIE jest to ustawienie użytkownika, bo to
// uznany punkt odniesienia kliniczny, a nie cel personalny jak target_calories.
const SODIUM_HIGH_THRESHOLD_MG = 2300;
const MIN_DAYS_PER_SODIUM_GROUP = 5;
const SODIUM_BP_LOOKBACK_DAYS = 90;

// Alert/insight: sód -> ciśnienie następnego dnia. Dwie niezależne części:
// 1) "today" - czy DZIŚ spożycie sodu już przekroczyło próg WHO/AHA (działa
//    od razu, niezależnie od historii - to ostrzeżenie wg wytycznych, nie
//    odkrycie z danych użytkownika).
// 2) "insight" - porównanie średniego ciśnienia NASTĘPNEGO dnia po dniach z
//    wysokim sodem vs dniach z sodem w normie, na bazie realnej historii
//    użytkownika (Withings) - jak przy insighcie sen->odżywianie, wymaga
//    minimalnej liczby dni w każdej grupie.
router.get('/api/dashboard/sodium-bp-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SODIUM_BP_LOOKBACK_DAYS);

    // Część 1: sód zjedzony dziś (niezależnie od tego, czy mamy już wystarczającą historię).
    const todayRow = await db.get(
      `SELECT SUM(sodium) AS sodium FROM meals WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    const todaySodium = todayRow && todayRow.sodium != null ? Math.round(todayRow.sodium) : null;
    const todayHighSodium = todaySodium != null && todaySodium >= SODIUM_HIGH_THRESHOLD_MG;

    // Część 2: historia sodu (dzień) -> ciśnienie (dzień+1).
    const sodiumRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const bpRows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    const bpByDate = new Map(bpRows.map(r => [r.date, { sys: r.blood_pressure_systolic, dia: r.blood_pressure_diastolic }]));

    const highSodiumNext = [];
    const normalSodiumNext = [];

    sodiumRows.forEach(row => {
      if (row.sodium == null) return;
      const nextDay = shiftDate(row.date, 1);
      const nextBp = bpByDate.get(nextDay);
      if (!nextBp) return;
      const bucket = row.sodium >= SODIUM_HIGH_THRESHOLD_MG ? highSodiumNext : normalSodiumNext;
      bucket.push(nextBp);
    });

    let insight;
    if (highSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP || normalSodiumNext.length < MIN_DAYS_PER_SODIUM_GROUP) {
      insight = {
        hasEnoughData: false,
        reason: 'not_enough_days',
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        minDaysRequired: MIN_DAYS_PER_SODIUM_GROUP
      };
    } else {
      const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
      const avgSysHigh = avg(highSodiumNext, 'sys');
      const avgSysNormal = avg(normalSodiumNext, 'sys');
      const avgDiaHigh = avg(highSodiumNext, 'dia');
      const avgDiaNormal = avg(normalSodiumNext, 'dia');
      insight = {
        hasEnoughData: true,
        highSodiumDays: highSodiumNext.length,
        normalSodiumDays: normalSodiumNext.length,
        avgSystolicAfterHighSodium: avgSysHigh,
        avgSystolicAfterNormalSodium: avgSysNormal,
        systolicDiff: Math.round((avgSysHigh - avgSysNormal) * 10) / 10,
        avgDiastolicAfterHighSodium: avgDiaHigh,
        avgDiastolicAfterNormalSodium: avgDiaNormal,
        diastolicDiff: Math.round((avgDiaHigh - avgDiaNormal) * 10) / 10
      };
    }

    res.json({
      sodiumThresholdMg: SODIUM_HIGH_THRESHOLD_MG,
      today: { sodium: todaySodium, isHigh: todayHighSodium },
      insight
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sód-ciśnienie.' });
  }
});

// Trening uznajemy za "znaczący" (a nie incydentalną aktywność dnia) od tej
// liczby minut łącznie w danym dniu (apple_health_workouts.duration_minutes) -
// to próg odróżniający realny trening od np. krótkiego spaceru zarejestrowanego
// jako "workout" przez zegarek.
const SIGNIFICANT_WORKOUT_MIN_MINUTES = 20;
const MIN_DAYS_PER_RECOVERY_GROUP = 5;
const RECOVERY_LOOKBACK_DAYS = 90;
// Próg minimalnej liczby dni PO KAŻDEJ stronie podziału "trening intensywny vs
// spokojny" (wg udziału stref Z4+Z5 w sumie minut strefowych danego dnia) - osobny
// od MIN_DAYS_PER_RECOVERY_GROUP, bo to dodatkowy, bardziej wymagający podział
// (wymaga realnych danych tętna z treningu, nie tylko jego czasu trwania).
const MIN_DAYS_PER_INTENSITY_GROUP = 4;

// Wskaźnik regeneracji: jak HRV/RHR dnia NASTĘPNEGO po znaczącym treningu
// wypadają na tle "normalnych" dni użytkownika (bez treningu dzień wcześniej).
// HRV niższe i/lub RHR wyższe niż baseline po treningu = sygnał niedostatecznej
// regeneracji (typowo po zbyt intensywnym/częstym treningu); odwrotnie = dobra
// adaptacja. To opisowe porównanie dwóch średnich z danych Oura użytkownika,
// nie diagnoza medyczna.
router.get('/api/dashboard/recovery-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -RECOVERY_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, SUM(duration_minutes) AS total_minutes,
              SUM(zone1_minutes) AS z1, SUM(zone2_minutes) AS z2, SUM(zone3_minutes) AS z3,
              SUM(zone4_minutes) AS z4, SUM(zone5_minutes) AS z5
       FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date HAVING total_minutes >= ?`,
      [req.user.id, startDate, today, SIGNIFICANT_WORKOUT_MIN_MINUTES]
    );

    if (workoutRows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_significant_workouts' });
    }

    // Udział stref Z4+Z5 (wysoka intensywność) w sumie zmierzonych minut strefowych
    // danego dnia treningowego - dostępne tylko dla treningów z włączonym "Include
    // Workout Metrics" w Health Auto Export (patrz hr-zones-insight); dni bez tych
    // danych (totalZoneMinutes === 0) są pomijane z podziału wg intensywności, nie
    // trafiają sztucznie do żadnej z grup.
    const zoneShareByWorkoutDate = new Map();
    workoutRows.forEach(r => {
      const z1 = r.z1 || 0, z2 = r.z2 || 0, z3 = r.z3 || 0, z4 = r.z4 || 0, z5 = r.z5 || 0;
      const totalZoneMinutes = z1 + z2 + z3 + z4 + z5;
      if (totalZoneMinutes > 0) {
        zoneShareByWorkoutDate.set(r.date, (z4 + z5) / totalZoneMinutes);
      }
    });

    const rawHrvRhrRows = await db.all(
      `SELECT date, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND hrv IS NOT NULL AND hrv > 0 AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, startDate, shiftDate(today, 1)]
    );
    // Tag dnia: dni choroby i dni po późnym zaśnięciu wykluczamy z liczenia baseline
    // regeneracji - to znane, opisane wyjątki (HRV/RHR z natury wypada inaczej), nie
    // powinny zaburzać porównania "trening vs spoczynek" u zdrowego, normalnie
    // wypoczętego użytkownika.
    const recoveryExcluded = await getExcludedDates(req.user.id, ['illness', 'late_sleep'], startDate, shiftDate(today, 1));
    const hrvRhrRows = rawHrvRhrRows.filter(r => !recoveryExcluded.has(r.date));
    const metricsByDate = new Map(hrvRhrRows.map(r => [r.date, { hrv: r.hrv, rhr: r.rhr }]));

    const postWorkoutDates = new Set(workoutRows.map(r => shiftDate(r.date, 1)));
    // shiftDate(+1) jest injektywne (różne daty treningu -> różne daty regeneracji),
    // więc mapowanie 1:1 jest bezpieczne.
    const workoutDateByRecoveryDate = new Map(workoutRows.map(r => [shiftDate(r.date, 1), r.date]));
    const postWorkout = [];
    const otherDays = [];
    const intensityCandidates = [];

    hrvRhrRows.forEach(r => {
      if (postWorkoutDates.has(r.date)) {
        postWorkout.push(metricsByDate.get(r.date));
        const workoutDate = workoutDateByRecoveryDate.get(r.date);
        const zoneShare = zoneShareByWorkoutDate.get(workoutDate);
        if (zoneShare !== undefined) {
          intensityCandidates.push({ hrv: r.hrv, rhr: r.rhr, zoneShare });
        }
      } else {
        otherDays.push(metricsByDate.get(r.date));
      }
    });

    if (postWorkout.length < MIN_DAYS_PER_RECOVERY_GROUP || otherDays.length < MIN_DAYS_PER_RECOVERY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        postWorkoutDays: postWorkout.length,
        otherDays: otherDays.length,
        minDaysRequired: MIN_DAYS_PER_RECOVERY_GROUP
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgHrvPostWorkout = avg(postWorkout, 'hrv');
    const avgHrvOther = avg(otherDays, 'hrv');
    const avgRhrPostWorkout = avg(postWorkout, 'rhr');
    const avgRhrOther = avg(otherDays, 'rhr');

    // Najnowszy trening ze znaną regeneracją następnego dnia - konkretny,
    // aktualny punkt odniesienia pokazywany razem ze statystyką ogólną.
    const latestWorkout = [...workoutRows].sort((a, b) => (a.date < b.date ? 1 : -1))
      .find(w => metricsByDate.has(shiftDate(w.date, 1)));
    let latest = null;
    if (latestWorkout) {
      const nextDate = shiftDate(latestWorkout.date, 1);
      const m = metricsByDate.get(nextDate);
      latest = { workoutDate: latestWorkout.date, recoveryDate: nextDate, hrv: m.hrv, rhr: m.rhr };
    }

    // Dodatkowy podział: czy regeneracja zależy nie tylko od TEGO, że był trening,
    // ale od TEGO, JAK INTENSYWNY był (udział stref Z4+Z5). Mediana własnych dni
    // treningowych użytkownika - jak w innych insightach z tej rundy, nie sztywny próg.
    let intensitySplit = null;
    if (intensityCandidates.length >= MIN_DAYS_PER_INTENSITY_GROUP * 2) {
      const medianShare = median(intensityCandidates.map(c => c.zoneShare));
      const highIntensity = intensityCandidates.filter(c => c.zoneShare > medianShare);
      const lowIntensity = intensityCandidates.filter(c => c.zoneShare <= medianShare);
      if (highIntensity.length >= MIN_DAYS_PER_INTENSITY_GROUP && lowIntensity.length >= MIN_DAYS_PER_INTENSITY_GROUP) {
        const avgHrvHighIntensity = avg(highIntensity, 'hrv');
        const avgHrvLowIntensity = avg(lowIntensity, 'hrv');
        const avgRhrHighIntensity = avg(highIntensity, 'rhr');
        const avgRhrLowIntensity = avg(lowIntensity, 'rhr');
        intensitySplit = {
          hasEnoughData: true,
          highIntensityDays: highIntensity.length,
          lowIntensityDays: lowIntensity.length,
          avgHrvHighIntensity,
          avgHrvLowIntensity,
          hrvDiff: Math.round((avgHrvHighIntensity - avgHrvLowIntensity) * 10) / 10,
          avgRhrHighIntensity,
          avgRhrLowIntensity,
          rhrDiff: Math.round((avgRhrHighIntensity - avgRhrLowIntensity) * 10) / 10
        };
      }
    }

    res.json({
      hasEnoughData: true,
      postWorkoutDays: postWorkout.length,
      otherDays: otherDays.length,
      avgHrvPostWorkout,
      avgHrvOtherDays: avgHrvOther,
      hrvDiff: Math.round((avgHrvPostWorkout - avgHrvOther) * 10) / 10,
      avgRhrPostWorkout,
      avgRhrOtherDays: avgRhrOther,
      rhrDiff: Math.round((avgRhrPostWorkout - avgRhrOther) * 10) / 10,
      latest,
      intensitySplit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania wskaźnika regeneracji.' });
  }
});

// Próg minimalnej liczby dni z/bez danego suplementu, żeby w ogóle pokazać go
// w wynikach - jak w pozostałych insightach (sen-odżywianie, sód-ciśnienie,
// regeneracja), bez tego pojedynczy dzień z suplementem i dobrym snem
// wygenerowałby fałszywie mocny wniosek ("suplement X = +2 pkt snu!").
const MIN_DAYS_PER_SUPPLEMENT_GROUP = 3;
const SUPPLEMENTS_SLEEP_LOOKBACK_DAYS = 90;
// Maksymalna liczba suplementów pokazywanych w wyniku - tylko te z największą
// (co do wartości absolutnej) różnicą, żeby nie zasypywać użytkownika
// dziesiątkami marginalnych porównań.
const MAX_SUPPLEMENT_FINDINGS = 5;

// Insight: suplementy (wolny tekst, pole health_metrics.supplements) vs sen/
// regeneracja TEGO SAMEGO dnia. Pairing "ten sam dzień" (nie dzień+1) jest
// świadomy i zgodny z istniejącą konwencją już ustaloną w tym pliku (prompt AI
// dashboardu, ok. linii 456-519) oraz w services/summaries.js - suplementy
// zalogowane na dzień D są tam zestawiane z sleep_score/readiness_score z
// dnia D, nie D+1. Nie kopiujemy tu żadnego mechanizmu z konkurencyjnych apek -
// to wyłącznie własna analiza już zbieranych przez Dietetyk-AI danych
// (suplementy z routes/health.js + sleep_score/readiness_score z Oura).
//
// Parsowanie tekstu suplementów: split po przecinku + trim, identycznie jak
// w istniejącej logice frontu (Dashboard.jsx, handleSaveSupplements) - jedyna
// ustalona w kodzie konwencja separatora, nie wprowadzamy tu nowej.
router.get('/api/dashboard/supplements-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SUPPLEMENTS_SLEEP_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND supplements IS NOT NULL AND TRIM(supplements) != ''
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    if (rows.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_supplement_data' });
    }

    // Wszystkie dni w oknie z choć jednym znanym wskaźnikiem snu/regeneracji -
    // potrzebne jako "wszechświat" do policzenia grupy "BEZ" danego suplementu
    // (dzień bez wpisanych suplementów liczy się jako "bez" KAŻDEGO z nich;
    // brak wpisu w polu supplements traktujemy jako realny fakt "nie brał",
    // nie jako brak danych - w przeciwieństwie do np. brakującego logowania
    // posiłków w innych insightach).
    const allDaysRows = await db.all(
      `SELECT date, supplements, sleep_score, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND (sleep_score IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    const parseSupplements = (text) =>
      (text || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Zbiór unikalnych suplementów (porównanie bez rozróżniania wielkości liter,
    // ale do wyświetlenia używamy pierwszej napotkanej wersji zapisu, żeby nie
    // psuć np. nazw własnych).
    const displayNameByKey = new Map();
    rows.forEach((r) => {
      parseSupplements(r.supplements).forEach((s) => {
        const key = s.toLowerCase();
        if (!displayNameByKey.has(key)) displayNameByKey.set(key, s);
      });
    });

    const avg = (arr, key) => {
      const vals = arr.map((x) => x[key]).filter((v) => v != null);
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    };

    const findings = [];
    for (const [key, displayName] of displayNameByKey.entries()) {
      const withDays = [];
      const withoutDays = [];
      allDaysRows.forEach((r) => {
        const tokens = parseSupplements(r.supplements).map((s) => s.toLowerCase());
        (tokens.includes(key) ? withDays : withoutDays).push(r);
      });

      if (withDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP || withoutDays.length < MIN_DAYS_PER_SUPPLEMENT_GROUP) {
        continue;
      }

      const avgSleepWith = avg(withDays, 'sleep_score');
      const avgSleepWithout = avg(withoutDays, 'sleep_score');
      const avgReadinessWith = avg(withDays, 'readiness_score');
      const avgReadinessWithout = avg(withoutDays, 'readiness_score');
      const sleepDiff = avgSleepWith != null && avgSleepWithout != null
        ? Math.round((avgSleepWith - avgSleepWithout) * 10) / 10
        : null;
      const readinessDiff = avgReadinessWith != null && avgReadinessWithout != null
        ? Math.round((avgReadinessWith - avgReadinessWithout) * 10) / 10
        : null;

      // Suplement bez żadnej liczonej różnicy (np. brak danych sleep_score
      // ANI readiness_score w obu grupach) nie wnosi nic do wyniku.
      if (sleepDiff == null && readinessDiff == null) continue;

      findings.push({
        supplement: displayName,
        daysWith: withDays.length,
        daysWithout: withoutDays.length,
        avgSleepScoreWith: avgSleepWith,
        avgSleepScoreWithout: avgSleepWithout,
        sleepScoreDiff: sleepDiff,
        avgReadinessScoreWith: avgReadinessWith,
        avgReadinessScoreWithout: avgReadinessWithout,
        readinessScoreDiff: readinessDiff
      });
    }

    if (findings.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_supplement',
        minDaysRequired: MIN_DAYS_PER_SUPPLEMENT_GROUP
      });
    }

    // Sortowanie po największej (co do wartości absolutnej) różnicy snu, a przy
    // jej braku - regeneracji. Najbardziej "zauważalne" wyniki na początku.
    findings.sort((a, b) => {
      const scoreOf = (f) => Math.max(Math.abs(f.sleepScoreDiff || 0), Math.abs(f.readinessScoreDiff || 0));
      return scoreOf(b) - scoreOf(a);
    });

    res.json({
      hasEnoughData: true,
      lookbackDays: SUPPLEMENTS_SLEEP_LOOKBACK_DAYS,
      findings: findings.slice(0, MAX_SUPPLEMENT_FINDINGS)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu suplementy-sen.' });
  }
});

// Adaptacyjna korekta celu kalorycznego: porównuje DEKLAROWANY bilans kaloryczny
// (na bazie zalogowanych posiłków: zjedzone - (BMR + kalorie aktywne)) z bilansem
// WYNIKAJĄCYM Z REALNEJ zmiany wagi (regresja liniowa po pomiarach wagi, slope
// kg/dzień razy przybliżenie 7700 kcal/kg). Rozjazd między tymi dwiema liczbami
// (gap) zwykle oznacza niedoszacowanie/przeszacowanie porcji, nieuwzględnione
// "podjadanie" albo nieprecyzyjny BMR - a nie że cel kaloryczny jest źle ustawiony
// per se. Sugerujemy więc korektę CELU tak, aby przy dotychczasowym sposobie
// logowania realny efekt zbliżył się do oryginalnie zamierzonego tempa.
// Wymagamy solidnej próbki w obu wymiarach (dni z posiłkami i pomiary wagi
// rozciągnięte na sensowny okres) - inaczej szum pomiarowy (np. wahania wody)
// dałby fałszywą sugestię.
const CALORIE_RECAL_LOOKBACK_DAYS = 21;
const KCAL_PER_KG = 7700; // szacunkowa wartość energetyczna 1 kg tkanki - powszechnie używane przybliżenie
const MIN_LOGGED_DAYS = 10;
const MIN_WEIGHT_MEASUREMENTS = 4;
const MIN_WEIGHT_SPAN_DAYS = 10;
const MIN_MEANINGFUL_GAP_KCAL = 100;

router.get('/api/dashboard/calorie-target-suggestion', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -(CALORIE_RECAL_LOOKBACK_DAYS - 1));

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const currentTargetCalories = getTargetCalories(settings);
    const bmr = getBmr(settings);

    const balance = await aggregateCalorieBalance(req.user.id, startDate, today, currentTargetCalories, bmr);
    if (balance.days_with_data < MIN_LOGGED_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_logged_days', daysLogged: balance.days_with_data, minDaysRequired: MIN_LOGGED_DAYS });
    }
    const loggedDailyBalance = balance.balance_vs_burned / balance.days_with_data;

    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    if (weightRows.length < MIN_WEIGHT_MEASUREMENTS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_weight_data', weightMeasurements: weightRows.length, minWeightMeasurementsRequired: MIN_WEIGHT_MEASUREMENTS });
    }
    const baseTime = new Date(weightRows[0].date).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const points = weightRows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r.weight }));
    const spanDays = points[points.length - 1].x;
    if (spanDays < MIN_WEIGHT_SPAN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'weight_span_too_short', spanDays: Math.round(spanDays), minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS });
    }
    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) {
      return res.json({ hasEnoughData: false, reason: 'flat_weight_data' });
    }
    const slope = (n * sumXY - sumX * sumY) / denom; // kg/dzień
    const actualDailyBalance = slope * KCAL_PER_KG;
    const gap = actualDailyBalance - loggedDailyBalance;

    if (Math.abs(gap) < MIN_MEANINGFUL_GAP_KCAL) {
      return res.json({
        hasEnoughData: true,
        suggestionNeeded: false,
        loggedDailyBalance: Math.round(loggedDailyBalance),
        actualDailyBalance: Math.round(actualDailyBalance),
        gap: Math.round(gap)
      });
    }

    const suggestedTargetCalories = Math.round(currentTargetCalories - gap);

    res.json({
      hasEnoughData: true,
      suggestionNeeded: true,
      daysLogged: balance.days_with_data,
      weightMeasurements: weightRows.length,
      loggedDailyBalance: Math.round(loggedDailyBalance),
      actualDailyBalance: Math.round(actualDailyBalance),
      gap: Math.round(gap),
      currentTargetCalories,
      suggestedTargetCalories
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania korekty celu kalorycznego.' });
  }
});

// ============================================================================
// Runda 7: nowe insighty bazujące WYŁĄCZNIE na danych już zbieranych przez
// aplikację (water_ml, sedentary_minutes, fiber, respiratory_rate,
// temperature_deviation, stress_high_minutes, liczba posiłków/dzień, historia
// streaków kalorycznych) - zero nowych integracji, zero kopiowania funkcji
// z konkurencyjnych aplikacji dietetycznych. Każdy insight trzyma się
// konwencji z istniejących endpointów wyżej: gating na minimalnej próbce,
// hasEnoughData, polskie komentarze, try/catch z polskim komunikatem błędu.
// ============================================================================

// Mediana - używana tam, gdzie nie ma sensownego progu klinicznego/ustawienia
// użytkownika do podziału na grupy (np. "dużo siedzenia" jest różne dla osoby
// z pracą biurową vs fizyczną) - porównujemy więc użytkownika do JEGO WŁASNEJ
// mediany z okresu, nie do sztywnej wartości.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanAndStdDev(values) {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / values.length;
  return { mean: m, stdDev: Math.sqrt(variance) };
}

// "Tag dnia": zbiór dat (stringi 'YYYY-MM-DD') oznaczonych przez użytkownika jednym
// z podanych typów zdarzenia (day_events), które przecinają się z oknem [startDate,
// endDate]. Insighty bazujące na własnej normie/baseline (np. recovery-insight,
// self-benchmark-insight) wykluczają te dni z liczenia średnich/percentyli/regresji
// poniżej - nietypowy okres (choroba/wakacje/późne zaśnięcie) nie powinien zaburzać
// trendu, mapowanie typ->insight ustalone z użytkownikiem przy projektowaniu funkcji
// (patrz routes/dayEvents.js dla samego CRUD i listy dozwolonych typów).
async function getExcludedDates(userId, types, startDate, endDate) {
  if (!types || types.length === 0) return new Set();
  const placeholders = types.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT start_date, end_date FROM day_events
     WHERE user_id = ? AND type IN (${placeholders}) AND end_date >= ? AND start_date <= ?`,
    [userId, ...types, startDate, endDate]
  );
  const excluded = new Set();
  rows.forEach(r => {
    // Przecinamy zakres zdarzenia z oknem zapytania, żeby nie generować dat poza
    // [startDate, endDate] (np. wieloletni zakres wpisany przez pomyłkę).
    let d = r.start_date > startDate ? r.start_date : startDate;
    const end = r.end_date < endDate ? r.end_date : endDate;
    while (d <= end) {
      excluded.add(d);
      d = shiftDate(d, 1);
    }
  });
  return excluded;
}

function linearRegressionSlope(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function toRegressionPoints(rows, valueKey) {
  const baseTime = new Date(rows[0].date).getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  return rows.map(r => ({ x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r[valueKey] }));
}

const MIN_DAYS_PER_HYDRATION_GROUP = 5;
const HYDRATION_LOOKBACK_DAYS = 90;

// Insight: nawodnienie (water_ml) vs gotowość/HRV TEGO SAMEGO dnia oraz RHR dnia
// NASTĘPNEGO. Podział względem WŁASNEGO celu nawodnienia użytkownika
// (target_water_ml z ustawień, domyślnie 2500 ml) - nie sztywnego progu
// klinicznego, bo potrzeba nawodnienia jest bardzo indywidualna.
router.get('/api/dashboard/hydration-readiness-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -HYDRATION_LOOKBACK_DAYS);

    const settingsRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'target_water_ml'`, [req.user.id]);
    const targetWaterMl = settingsRow && !isNaN(Number(settingsRow.value)) ? Number(settingsRow.value) : DEFAULT_TARGET_WATER_ML;

    const rows = await db.all(
      `SELECT date, water_ml, readiness_score, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND water_ml IS NOT NULL AND water_ml > 0`,
      [req.user.id, startDate, today]
    );
    const rhrByDate = new Map(rows.filter(r => r.rhr != null && r.rhr > 0).map(r => [r.date, r.rhr]));

    const hydrated = [];
    const underHydrated = [];
    rows.forEach(r => {
      if (r.readiness_score == null && r.hrv == null) return;
      const nextRhr = rhrByDate.get(shiftDate(r.date, 1));
      const entry = { readiness: r.readiness_score, hrv: r.hrv, nextRhr: nextRhr != null ? nextRhr : null };
      (r.water_ml >= targetWaterMl ? hydrated : underHydrated).push(entry);
    });

    if (hydrated.length < MIN_DAYS_PER_HYDRATION_GROUP || underHydrated.length < MIN_DAYS_PER_HYDRATION_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        hydratedDays: hydrated.length,
        underHydratedDays: underHydrated.length,
        minDaysRequired: MIN_DAYS_PER_HYDRATION_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgReadinessHydrated = avgOf(hydrated, 'readiness');
    const avgReadinessUnder = avgOf(underHydrated, 'readiness');
    const avgHrvHydrated = avgOf(hydrated, 'hrv');
    const avgHrvUnder = avgOf(underHydrated, 'hrv');
    const avgNextRhrHydrated = avgOf(hydrated, 'nextRhr');
    const avgNextRhrUnder = avgOf(underHydrated, 'nextRhr');

    res.json({
      hasEnoughData: true,
      targetWaterMl,
      hydratedDays: hydrated.length,
      underHydratedDays: underHydrated.length,
      avgReadinessHydrated,
      avgReadinessUnderHydrated: avgReadinessUnder,
      readinessDiff: avgReadinessHydrated != null && avgReadinessUnder != null ? Math.round((avgReadinessHydrated - avgReadinessUnder) * 10) / 10 : null,
      avgHrvHydrated,
      avgHrvUnderHydrated: avgHrvUnder,
      hrvDiff: avgHrvHydrated != null && avgHrvUnder != null ? Math.round((avgHrvHydrated - avgHrvUnder) * 10) / 10 : null,
      avgNextDayRhrHydrated: avgNextRhrHydrated,
      avgNextDayRhrUnderHydrated: avgNextRhrUnder,
      nextDayRhrDiff: avgNextRhrHydrated != null && avgNextRhrUnder != null ? Math.round((avgNextRhrHydrated - avgNextRhrUnder) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu nawodnienie-regeneracja.' });
  }
});

const MIN_DAYS_PER_SEDENTARY_GROUP = 5;
const SEDENTARY_LOOKBACK_DAYS = 90;

// Insight: czas siedzący (sedentary_minutes) vs jakość snu TEJ SAMEJ NOCY
// (sleep_score, sleep_deep, sleep_rem). Podział wg mediany WŁASNYCH wartości
// użytkownika z okresu.
router.get('/api/dashboard/sedentary-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SEDENTARY_LOOKBACK_DAYS);

    const rawRows = await db.all(
      `SELECT date, sedentary_minutes, sleep_score, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sedentary_minutes IS NOT NULL AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    // sleep_deep/sleep_rem są w bazie zapisane w GODZINACH (patrz services/sync.js -
    // totalDeepSec / 3600), a odpowiedź tego endpointu jest opisana w UI jako "min" -
    // konwertujemy tu na minuty, żeby sleepDeepDiff/sleepRemDiff faktycznie były w
    // jednostce, w jakiej je wyświetlamy (wcześniej np. "+0.3 min" zamiast "+18 min").
    const rows = rawRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));

    if (rows.length < MIN_DAYS_PER_SEDENTARY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP * 2
      });
    }

    const medianSedentary = median(rows.map(r => r.sedentary_minutes));
    const moreSitting = rows.filter(r => r.sedentary_minutes >= medianSedentary);
    const lessSitting = rows.filter(r => r.sedentary_minutes < medianSedentary);

    if (moreSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP || lessSitting.length < MIN_DAYS_PER_SEDENTARY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreSittingDays: moreSitting.length,
        lessSittingDays: lessSitting.length,
        minDaysRequired: MIN_DAYS_PER_SEDENTARY_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSleepScoreMore = avgOf(moreSitting, 'sleep_score');
    const avgSleepScoreLess = avgOf(lessSitting, 'sleep_score');
    const avgDeepMore = avgOf(moreSitting, 'sleep_deep');
    const avgDeepLess = avgOf(lessSitting, 'sleep_deep');
    const avgRemMore = avgOf(moreSitting, 'sleep_rem');
    const avgRemLess = avgOf(lessSitting, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianSedentaryMinutes: Math.round(medianSedentary),
      moreSittingDays: moreSitting.length,
      lessSittingDays: lessSitting.length,
      avgSleepScoreMoreSitting: avgSleepScoreMore,
      avgSleepScoreLessSitting: avgSleepScoreLess,
      sleepScoreDiff: avgSleepScoreMore != null && avgSleepScoreLess != null ? Math.round((avgSleepScoreMore - avgSleepScoreLess) * 10) / 10 : null,
      avgSleepDeepMoreSitting: avgDeepMore,
      avgSleepDeepLessSitting: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreSitting: avgRemMore,
      avgSleepRemLessSitting: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu siedzenie-sen.' });
  }
});

const MIN_DAYS_PER_FIBER_GROUP = 5;
const FIBER_SLEEP_LOOKBACK_DAYS = 90;

// Insight: błonnik (suma dzienna z posiłków) vs głęboki/REM sen TEJ SAMEJ NOCY.
// Inny niż istniejący sleep-insight (tam: sen -> kalorie/cukier NASTĘPNEGO
// dnia) - tu kierunek odwrotny (odżywianie -> sen tej doby) i inne pola fazy
// snu. Podział wg mediany WŁASNEGO spożycia błonnika użytkownika.
router.get('/api/dashboard/fiber-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -FIBER_SLEEP_LOOKBACK_DAYS);

    const fiberRows = await db.all(
      `SELECT date, SUM(fiber) AS fiber FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? AND fiber IS NOT NULL GROUP BY date HAVING fiber > 0`,
      [req.user.id, startDate, today]
    );
    const rawSleepRows = await db.all(
      `SELECT date, sleep_deep, sleep_rem FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (sleep_deep IS NOT NULL OR sleep_rem IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    // Konwersja godzin -> minuty (patrz analogiczny komentarz w sedentary-sleep-insight) -
    // pole jest opisane w UI jako "min", a w bazie sleep_deep/sleep_rem są w godzinach.
    const sleepRows = rawSleepRows.map(r => ({
      ...r,
      sleep_deep: r.sleep_deep != null ? r.sleep_deep * 60 : r.sleep_deep,
      sleep_rem: r.sleep_rem != null ? r.sleep_rem * 60 : r.sleep_rem
    }));
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    const combined = fiberRows
      .filter(r => sleepByDate.has(r.date))
      .map(r => ({ fiber: r.fiber, ...sleepByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_FIBER_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP * 2
      });
    }

    const medianFiber = median(combined.map(r => r.fiber));
    const moreFiber = combined.filter(r => r.fiber >= medianFiber);
    const lessFiber = combined.filter(r => r.fiber < medianFiber);

    if (moreFiber.length < MIN_DAYS_PER_FIBER_GROUP || lessFiber.length < MIN_DAYS_PER_FIBER_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreFiberDays: moreFiber.length,
        lessFiberDays: lessFiber.length,
        minDaysRequired: MIN_DAYS_PER_FIBER_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgDeepMore = avgOf(moreFiber, 'sleep_deep');
    const avgDeepLess = avgOf(lessFiber, 'sleep_deep');
    const avgRemMore = avgOf(moreFiber, 'sleep_rem');
    const avgRemLess = avgOf(lessFiber, 'sleep_rem');

    res.json({
      hasEnoughData: true,
      medianFiberGrams: Math.round(medianFiber * 10) / 10,
      moreFiberDays: moreFiber.length,
      lessFiberDays: lessFiber.length,
      avgSleepDeepMoreFiber: avgDeepMore,
      avgSleepDeepLessFiber: avgDeepLess,
      sleepDeepDiff: avgDeepMore != null && avgDeepLess != null ? Math.round((avgDeepMore - avgDeepLess) * 10) / 10 : null,
      avgSleepRemMoreFiber: avgRemMore,
      avgSleepRemLessFiber: avgRemLess,
      sleepRemDiff: avgRemMore != null && avgRemLess != null ? Math.round((avgRemMore - avgRemLess) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu błonnik-sen.' });
  }
});

const MIN_RECOMP_MEASUREMENTS = 4;
const MIN_RECOMP_SPAN_DAYS = 14;
const RECOMP_LOOKBACK_DAYS = 180;

// Detektor "rekompozycji ciała": czy trend OBWODU PASA i trend WAGI rozjeżdżają
// się (np. waga stabilna/rosnąca, a pas się zmniejsza - typowy sygnał przyrostu
// mięśni przy redukcji tkanki tłuszczowej, albo odwrotnie). Dwie NIEZALEŻNE
// regresje liniowe (jak w calorie-target-suggestion) - pomiary wagi i obwodów
// zwykle nie są robione tego samego dnia, łączenie po dacie odsiałoby dane.
router.get('/api/dashboard/body-recomposition-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -RECOMP_LOOKBACK_DAYS);

    const waistRows = await db.all(
      `SELECT date, waist FROM body_measurements WHERE user_id = ? AND date >= ? AND date <= ? AND waist IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (waistRows.length < MIN_RECOMP_MEASUREMENTS || weightRows.length < MIN_RECOMP_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_measurements',
        waistMeasurements: waistRows.length,
        weightMeasurements: weightRows.length,
        minMeasurementsRequired: MIN_RECOMP_MEASUREMENTS
      });
    }

    const waistPoints = toRegressionPoints(waistRows, 'waist');
    const weightPoints = toRegressionPoints(weightRows, 'weight');
    const waistSpanDays = waistPoints[waistPoints.length - 1].x;
    const weightSpanDays = weightPoints[weightPoints.length - 1].x;

    if (waistSpanDays < MIN_RECOMP_SPAN_DAYS || weightSpanDays < MIN_RECOMP_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        waistSpanDays: Math.round(waistSpanDays),
        weightSpanDays: Math.round(weightSpanDays),
        minSpanDaysRequired: MIN_RECOMP_SPAN_DAYS
      });
    }

    const waistSlopePerDay = linearRegressionSlope(waistPoints);
    const weightSlopePerDay = linearRegressionSlope(weightPoints);
    if (waistSlopePerDay === null || weightSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    // Rozjazd: pas się zmniejsza, a waga rośnie/stabilna (lub odwrotnie) -
    // sygnał rekompozycji, a nie zwykłego "chudnięcia/przybierania" widocznego
    // jednocześnie w obu miarach.
    const waistTrend = waistSlopePerDay < -0.02 ? 'down' : waistSlopePerDay > 0.02 ? 'up' : 'flat';
    const weightTrend = weightSlopePerDay < -0.02 ? 'down' : weightSlopePerDay > 0.02 ? 'up' : 'flat';
    const divergentTrend = waistTrend !== 'flat' && weightTrend !== 'flat' && waistTrend !== weightTrend;

    res.json({
      hasEnoughData: true,
      waistMeasurements: waistRows.length,
      weightMeasurements: weightRows.length,
      waistSlopeCmPerWeek: Math.round(waistSlopePerDay * 7 * 100) / 100,
      weightSlopeKgPerWeek: Math.round(weightSlopePerDay * 7 * 100) / 100,
      waistTrend,
      weightTrend,
      divergentTrend
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wykrywania rekompozycji ciała.' });
  }
});

const STRAIN_BASELINE_LOOKBACK_DAYS = 30;
const MIN_DAYS_FOR_STRAIN_BASELINE = 14;
const STRAIN_STD_DEV_THRESHOLD = 1; // odchylenia standardowe od własnej średniej użytkownika

// Wczesny alert "przeciążenie/możliwa infekcja": odchylenie DZISIEJSZYCH
// wartości (częstość oddechów, odchylenie temperatury nadgarstka, gotowość) od
// WŁASNEJ średniej użytkownika z ostatnich dni (z-score - podejście statystyczne
// analogiczne do wykrywania anomalii posiłków w utils/mealAnomaly.js, tu
// zastosowane do danych Oura). Opisowy sygnał na bazie własnej historii
// użytkownika, NIE diagnoza medyczna.
router.get('/api/dashboard/early-strain-alert', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -STRAIN_BASELINE_LOOKBACK_DAYS);
    const baselineEnd = shiftDate(today, -1);

    const todayRow = await db.get(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    // Runda 12 (audyt): dodano "readiness_score <= 0" - ujednolicenie z dominującym
    // wzorcem w tym pliku (linie ~223, ~239, ~3017), gdzie 0 dla sleep_score/readiness_score
    // jest traktowane jako wartość-sentinel "brak pomiaru", nie realny wynik Oura (w
    // odróżnieniu od temperature_deviation, gdzie 0 jest realną, znaczącą wartością -
    // "brak odchylenia" - tej kolumny NIE dotyczy ta zmiana).
    if (!todayRow || todayRow.respiratory_rate == null || todayRow.temperature_deviation == null
      || todayRow.readiness_score == null || todayRow.readiness_score <= 0) {
      return res.json({ hasEnoughData: false, reason: 'no_today_data' });
    }

    const baselineRows = await db.all(
      `SELECT respiratory_rate, temperature_deviation, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND respiratory_rate IS NOT NULL AND temperature_deviation IS NOT NULL
       AND readiness_score IS NOT NULL AND readiness_score > 0`,
      [req.user.id, baselineStart, baselineEnd]
    );

    if (baselineRows.length < MIN_DAYS_FOR_STRAIN_BASELINE) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_baseline_days',
        baselineDays: baselineRows.length,
        minDaysRequired: MIN_DAYS_FOR_STRAIN_BASELINE
      });
    }

    const respStats = meanAndStdDev(baselineRows.map(r => r.respiratory_rate));
    const tempStats = meanAndStdDev(baselineRows.map(r => r.temperature_deviation));
    const readinessStats = meanAndStdDev(baselineRows.map(r => r.readiness_score));

    const respZ = respStats.stdDev > 0 ? (todayRow.respiratory_rate - respStats.mean) / respStats.stdDev : 0;
    const tempZ = tempStats.stdDev > 0 ? (todayRow.temperature_deviation - tempStats.mean) / tempStats.stdDev : 0;
    const readinessZ = readinessStats.stdDev > 0 ? (todayRow.readiness_score - readinessStats.mean) / readinessStats.stdDev : 0;

    // Alert tylko gdy WSZYSTKIE trzy wskaźniki naraz odbiegają w niepokojącym
    // kierunku - pojedynczy odstający wskaźnik to zwykły szum dnia, nie sygnał.
    const alert = respZ >= STRAIN_STD_DEV_THRESHOLD && tempZ >= STRAIN_STD_DEV_THRESHOLD && readinessZ <= -STRAIN_STD_DEV_THRESHOLD;

    res.json({
      hasEnoughData: true,
      baselineDays: baselineRows.length,
      today: {
        respiratoryRate: todayRow.respiratory_rate,
        temperatureDeviation: todayRow.temperature_deviation,
        readinessScore: todayRow.readiness_score
      },
      baseline: {
        avgRespiratoryRate: Math.round(respStats.mean * 10) / 10,
        avgTemperatureDeviation: Math.round(tempStats.mean * 100) / 100,
        avgReadinessScore: Math.round(readinessStats.mean * 10) / 10
      },
      respiratoryRateZScore: Math.round(respZ * 100) / 100,
      temperatureDeviationZScore: Math.round(tempZ * 100) / 100,
      readinessScoreZScore: Math.round(readinessZ * 100) / 100,
      alert
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd wyznaczania wczesnego alertu przeciążenia.' });
  }
});

const MIN_DAYS_PER_STRESS_GROUP = 5;
const STRESS_NUTRITION_LOOKBACK_DAYS = 90;

// Insight: minuty wysokiego stresu (stress_high_minutes, dotąd tylko
// wyświetlane, nieużywane w żadnym insighcie) vs spożycie sodu/cukru TEGO
// SAMEGO dnia - sprawdza potoczną hipotezę "stres -> sięganie po słodkie/
// słone jedzenie" na bazie własnych danych użytkownika. Podział wg mediany
// WŁASNYCH minut stresu z okresu.
router.get('/api/dashboard/stress-nutrition-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STRESS_NUTRITION_LOOKBACK_DAYS);

    const stressRows = await db.all(
      `SELECT date, stress_high_minutes FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND stress_high_minutes IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const nutritionRows = await db.all(
      `SELECT date, SUM(sodium) AS sodium, SUM(sugar) AS sugar FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const nutritionByDate = new Map(nutritionRows.map(r => [r.date, r]));

    const combined = stressRows
      .filter(r => nutritionByDate.has(r.date))
      .map(r => ({ stressMinutes: r.stress_high_minutes, ...nutritionByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_STRESS_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP * 2
      });
    }

    const medianStress = median(combined.map(r => r.stressMinutes));
    const highStress = combined.filter(r => r.stressMinutes >= medianStress);
    const lowStress = combined.filter(r => r.stressMinutes < medianStress);

    if (highStress.length < MIN_DAYS_PER_STRESS_GROUP || lowStress.length < MIN_DAYS_PER_STRESS_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        highStressDays: highStress.length,
        lowStressDays: lowStress.length,
        minDaysRequired: MIN_DAYS_PER_STRESS_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgSodiumHigh = avgOf(highStress, 'sodium');
    const avgSodiumLow = avgOf(lowStress, 'sodium');
    const avgSugarHigh = avgOf(highStress, 'sugar');
    const avgSugarLow = avgOf(lowStress, 'sugar');

    res.json({
      hasEnoughData: true,
      medianStressMinutes: Math.round(medianStress),
      highStressDays: highStress.length,
      lowStressDays: lowStress.length,
      avgSodiumHighStress: avgSodiumHigh,
      avgSodiumLowStress: avgSodiumLow,
      sodiumDiff: avgSodiumHigh != null && avgSodiumLow != null ? Math.round((avgSodiumHigh - avgSodiumLow) * 10) / 10 : null,
      avgSugarHighStress: avgSugarHigh,
      avgSugarLowStress: avgSugarLow,
      sugarDiff: avgSugarHigh != null && avgSugarLow != null ? Math.round((avgSugarHigh - avgSugarLow) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stres-odżywianie.' });
  }
});

const MIN_DAYS_PER_MEAL_FREQ_GROUP = 5;
const MEAL_FREQ_LOOKBACK_DAYS = 90;
// Pasmo trafienia w cel kaloryczny +/-15% - identyczne jak przy istniejącym
// streaku kalorycznym (computeStreak w głównym handlerze /api/dashboard).
const CALORIE_TARGET_BAND = 0.15;

// Insight: liczba posiłków zalogowanych w ciągu dnia (meals.date, COUNT) vs
// trafienie w cel kaloryczny tego dnia - sprawdza, czy więcej mniejszych
// posiłków dziennie koreluje z lepszym trzymaniem się celu ("podjadanie
// kontrolowane" vs 1-2 duże posiłki).
router.get('/api/dashboard/meal-frequency-adherence-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MEAL_FREQ_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const rows = await db.all(
      `SELECT date, COUNT(*) AS meal_count, SUM(calories) AS total_calories
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_DAYS_PER_MEAL_FREQ_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP * 2
      });
    }

    const onTarget = [];
    const offTarget = [];
    rows.forEach(r => {
      if (r.total_calories == null) return;
      const hit = r.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) && r.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      (hit ? onTarget : offTarget).push(r);
    });

    if (onTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP || offTarget.length < MIN_DAYS_PER_MEAL_FREQ_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        onTargetDays: onTarget.length,
        offTargetDays: offTarget.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_FREQ_GROUP
      });
    }

    const avgOf = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgMealCountOnTarget = avgOf(onTarget, 'meal_count');
    const avgMealCountOffTarget = avgOf(offTarget, 'meal_count');

    res.json({
      hasEnoughData: true,
      targetCalories,
      onTargetDays: onTarget.length,
      offTargetDays: offTarget.length,
      avgMealCountOnTarget,
      avgMealCountOffTarget,
      mealCountDiff: Math.round((avgMealCountOnTarget - avgMealCountOffTarget) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu częstość posiłków-cel kaloryczny.' });
  }
});

const MIN_DAYS_PER_STREAK_GROUP = 5;
const STREAK_DRIFT_LOOKBACK_DAYS = 120;
const STREAK_MIN_LENGTH = 3; // od ilu kolejnych dni w paśmie celu liczymy to jako "passę"

// Insight: HRV/gotowość w dniach będących CZĘŚCIĄ passy trzymania się celu
// kalorycznego (3+ kolejne dni w paśmie +/-15%) vs w dniu BEZPOŚREDNIO PO
// przerwaniu takiej passy. Własna, samodzielna logika wykrywania passy (NIE
// computeStreak z głównego handlera dashboardu, który liczy tylko długość
// AKTUALNEJ passy względem jednej daty referencyjnej i nie jest eksportowany) -
// tu potrzebujemy historii wszystkich przeszłych pass i ich końców.
router.get('/api/dashboard/streak-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STREAK_DRIFT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const metricsRows = await db.all(
      `SELECT date, hrv, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND (hrv IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, startDate, today]
    );
    const metricsByDate = new Map(metricsRows.map(r => [r.date, r]));

    // Wymagamy KOLEJNYCH dni kalendarzowych (bez dziur) do liczenia passy -
    // dziura w logowaniu przerywa passę tak samo jak dzień poza paśmem celu.
    let prevDate = null;
    let currentStreak = 0;
    const streakDayMetrics = [];
    const breakDayMetrics = [];

    calorieRows.forEach(row => {
      const inBand = row.total_calories != null &&
        row.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) &&
        row.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      const isConsecutive = prevDate !== null && shiftDate(prevDate, 1) === row.date;

      if (inBand) {
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
        if (currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) streakDayMetrics.push(m);
        }
      } else {
        // "Dzień po przerwaniu" liczymy tylko, jeśli WCZORAJ była ustalona
        // passa (>= STREAK_MIN_LENGTH) i dziś jest kolejnym dniem kalendarzowym po niej.
        if (isConsecutive && currentStreak >= STREAK_MIN_LENGTH) {
          const m = metricsByDate.get(row.date);
          if (m) breakDayMetrics.push(m);
        }
        currentStreak = 0;
      }
      prevDate = row.date;
    });

    if (streakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP || breakDayMetrics.length < MIN_DAYS_PER_STREAK_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        streakDays: streakDayMetrics.length,
        breakDays: breakDayMetrics.length,
        minDaysRequired: MIN_DAYS_PER_STREAK_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgHrvStreak = avgOf(streakDayMetrics, 'hrv');
    const avgHrvBreak = avgOf(breakDayMetrics, 'hrv');
    const avgReadinessStreak = avgOf(streakDayMetrics, 'readiness_score');
    const avgReadinessBreak = avgOf(breakDayMetrics, 'readiness_score');

    res.json({
      hasEnoughData: true,
      targetCalories,
      streakMinLength: STREAK_MIN_LENGTH,
      streakDays: streakDayMetrics.length,
      breakDays: breakDayMetrics.length,
      avgHrvDuringStreak: avgHrvStreak,
      avgHrvAfterBreak: avgHrvBreak,
      hrvDiff: avgHrvStreak != null && avgHrvBreak != null ? Math.round((avgHrvStreak - avgHrvBreak) * 10) / 10 : null,
      avgReadinessDuringStreak: avgReadinessStreak,
      avgReadinessAfterBreak: avgReadinessBreak,
      readinessDiff: avgReadinessStreak != null && avgReadinessBreak != null ? Math.round((avgReadinessStreak - avgReadinessBreak) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu passa-regeneracja.' });
  }
});

const RHR_RECENT_WINDOW_DAYS = 7;
const RHR_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_RHR_DAYS = 4;
const MIN_BASELINE_RHR_DAYS = 14;

// Insight (Runda 8): trend spoczynkowego tętna (rhr) - średnia z ostatnich 7 dni vs
// własna baseline z poprzedzających 28 dni. Niezależny od early-strain-alert (tamten
// klucz się o intensywność treningu) i od recovery-insight (tamten porównuje
// HRV/RHR PO treningu vs spoczynku) - tu czysty trend RHR w czasie, użyteczny jako
// wczesny sygnał przemęczenia/choroby/nadmiernego stresu, NIEZALEŻNIE od aktywności.
// Próg "podniesionego" RHR liczony względem WŁASNEGO odchylenia standardowego
// użytkownika (meanAndStdDev), nie sztywnej liczby uderzeń/min - naturalny rozrzut
// RHR bardzo różni się między osobami.
router.get('/api/dashboard/rhr-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(RHR_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(RHR_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );
    // Tag dnia: dni choroby wykluczamy z liczenia baseline i odczytu trendu - RHR
    // jest wtedy podniesione z już znanej przyczyny, włączenie tych dni fałszywie
    // "wyjaśniałoby" trend chorobą zamiast realnym przemęczeniem/stresem.
    const rhrIllnessExcluded = await getExcludedDates(req.user.id, ['illness'], baselineStart, today);
    const rows = rawRows.filter(r => !rhrIllnessExcluded.has(r.date));

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.rhr);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd).map(r => r.rhr);

    if (recent.length < MIN_RECENT_RHR_DAYS || baseline.length < MIN_BASELINE_RHR_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_RHR_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_RHR_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
    const avgRecentRhr = avg(recent);
    const avgBaselineRhr = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const rhrDiff = Math.round((avgRecentRhr - avgBaselineRhr) * 10) / 10;
    const isElevated = baselineStdDev > 0 ? rhrDiff > baselineStdDev : rhrDiff > 2;

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentRhr,
      avgBaselineRhr,
      rhrDiff,
      baselineStdDev: Math.round(baselineStdDev * 10) / 10,
      isElevated
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu tętna spoczynkowego.' });
  }
});

const MIN_DAYS_PER_MEAL_TIMING_GROUP = 5;
const MEAL_TIMING_LOOKBACK_DAYS = 90;

// Insight (Runda 8): godzina ostatniego posiłku w ciągu dnia (MAX(timestamp) z meals)
// vs jakość snu TEJ SAMEJ NOCY (sleep_score, sleep_deep). Podział wg mediany WŁASNYCH
// godzin ostatniego posiłku użytkownika z okresu - nie sztywnego progu (np. "po
// 20:00"), bo nawyki żywieniowe/dobowe są bardzo indywidualne. Inny kierunek niż
// istniejący sleep-insight (tam: sen -> odżywianie NASTĘPNEGO dnia).
router.get('/api/dashboard/meal-timing-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MEAL_TIMING_LOOKBACK_DAYS);

    const mealRows = await db.all(
      `SELECT date, MAX(timestamp) AS last_meal_timestamp FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const sleepRows = await db.all(
      `SELECT date, sleep_score, sleep_deep FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r]));

    // Godzina ostatniego posiłku jako liczba dziesiętna (np. 21:30 -> 21.5) - do
    // liczenia mediany i podziału na grupy.
    const toHourFraction = (ts) => {
      const match = /\s(\d{2}):(\d{2})/.exec(ts || '');
      if (!match) return null;
      return Number(match[1]) + Number(match[2]) / 60;
    };

    const entries = [];
    mealRows.forEach(r => {
      const hour = toHourFraction(r.last_meal_timestamp);
      const sleep = sleepByDate.get(r.date);
      if (hour == null || !sleep) return;
      // sleep_deep jest w bazie w GODZINACH (services/sync.js: totalDeepSec / 3600) -
      // konwertujemy na minuty, bo avgSleepDeepLaterEating/sleepDeepDiff w odpowiedzi
      // są opisane w UI jako "min" (patrz analogiczna poprawka w sedentary-sleep-insight
      // i fiber-sleep-insight).
      entries.push({ hour, sleep_score: sleep.sleep_score, sleep_deep: sleep.sleep_deep != null ? sleep.sleep_deep * 60 : sleep.sleep_deep });
    });

    if (entries.length < MIN_DAYS_PER_MEAL_TIMING_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: entries.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP * 2
      });
    }

    const medianHour = median(entries.map(e => e.hour));
    const laterEaters = entries.filter(e => e.hour >= medianHour);
    const earlierEaters = entries.filter(e => e.hour < medianHour);

    if (laterEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP || earlierEaters.length < MIN_DAYS_PER_MEAL_TIMING_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        laterDays: laterEaters.length,
        earlierDays: earlierEaters.length,
        minDaysRequired: MIN_DAYS_PER_MEAL_TIMING_GROUP
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const avgScoreLater = avgOf(laterEaters, 'sleep_score');
    const avgScoreEarlier = avgOf(earlierEaters, 'sleep_score');
    const avgDeepLater = avgOf(laterEaters, 'sleep_deep');
    const avgDeepEarlier = avgOf(earlierEaters, 'sleep_deep');

    const formatHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

    res.json({
      hasEnoughData: true,
      medianLastMealHour: formatHour(medianHour),
      laterEatingDays: laterEaters.length,
      earlierEatingDays: earlierEaters.length,
      avgSleepScoreLaterEating: avgScoreLater,
      avgSleepScoreEarlierEating: avgScoreEarlier,
      sleepScoreDiff: avgScoreLater != null && avgScoreEarlier != null ? Math.round((avgScoreLater - avgScoreEarlier) * 10) / 10 : null,
      avgSleepDeepLaterEating: avgDeepLater,
      avgSleepDeepEarlierEating: avgDeepEarlier,
      sleepDeepDiff: avgDeepLater != null && avgDeepEarlier != null ? Math.round((avgDeepLater - avgDeepEarlier) * 10) / 10 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu godzina posiłku-sen.' });
  }
});

// Insight (Runda 9): samodzielny trend ciśnienia krwi (ostatnie 7 dni vs poprzedzające
// 28 dni) - w przeciwieństwie do istniejącego sodium-bp-insight (sód jako zmienna
// wyjaśniająca), tutaj liczy się czysty trend w czasie, niezależnie od przyczyny.
// Klasyfikacja kategorii to uproszczone progi AHA (American Heart Association) -
// orientacyjna etykieta, nie diagnoza medyczna.
const BP_RECENT_WINDOW_DAYS = 7;
const BP_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_BP_DAYS = 3;
const MIN_BASELINE_BP_DAYS = 7;

function classifyBloodPressure(systolic, diastolic) {
  if (systolic == null || diastolic == null) return null;
  if (systolic >= 180 || diastolic >= 120) return 'Przełom nadciśnieniowy';
  if (systolic >= 140 || diastolic >= 90) return 'Nadciśnienie 2. stopnia';
  if (systolic >= 130 || diastolic >= 80) return 'Nadciśnienie 1. stopnia';
  if (systolic >= 120) return 'Podwyższone';
  return 'Prawidłowe';
}

router.get('/api/dashboard/bp-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(BP_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(BP_BASELINE_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT date, blood_pressure_systolic, blood_pressure_diastolic FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND blood_pressure_systolic IS NOT NULL AND blood_pressure_diastolic IS NOT NULL
       AND blood_pressure_systolic > 0 AND blood_pressure_diastolic > 0`,
      [req.user.id, baselineStart, today]
    );

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd);

    if (recent.length < MIN_RECENT_BP_DAYS || baseline.length < MIN_BASELINE_BP_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        recentDays: recent.length,
        baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_BP_DAYS,
        minBaselineDaysRequired: MIN_BASELINE_BP_DAYS
      });
    }

    const avg = (arr, key) => Math.round((arr.reduce((s, r) => s + r[key], 0) / arr.length) * 10) / 10;
    const avgRecentSystolic = avg(recent, 'blood_pressure_systolic');
    const avgRecentDiastolic = avg(recent, 'blood_pressure_diastolic');
    const avgBaselineSystolic = avg(baseline, 'blood_pressure_systolic');
    const avgBaselineDiastolic = avg(baseline, 'blood_pressure_diastolic');

    res.json({
      hasEnoughData: true,
      recentDays: recent.length,
      baselineDays: baseline.length,
      avgRecentSystolic,
      avgRecentDiastolic,
      avgBaselineSystolic,
      avgBaselineDiastolic,
      systolicDiff: Math.round((avgRecentSystolic - avgBaselineSystolic) * 10) / 10,
      diastolicDiff: Math.round((avgRecentDiastolic - avgBaselineDiastolic) * 10) / 10,
      recentCategory: classifyBloodPressure(avgRecentSystolic, avgRecentDiastolic),
      baselineCategory: classifyBloodPressure(avgBaselineSystolic, avgBaselineDiastolic)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu ciśnienia krwi.' });
  }
});

// Insight: realne strefy kardio (Karvonen) zsumowane z treningów Apple Health z ostatnich
// 14 dni. W przeciwieństwie do statycznej tabeli referencyjnej "Strefy Tętna" (na bazie
// wzoru, nie pomiaru), tu liczą się REALNE minuty zmierzone tętnem w trakcie treningów -
// patrz computeWorkoutHrZones w routes/appleHealth.js. Wymaga włączonego przełącznika
// "Include Workout Metrics" w Health Auto Export; bez niego workouty mają same NULL-e
// w kolumnach zoneN_minutes i nie wchodzą do sumy (warunek zone1_minutes IS NOT NULL).
const HR_ZONES_INSIGHT_WINDOW_DAYS = 14;
const MIN_WORKOUTS_WITH_ZONES = 2;

router.get('/api/dashboard/hr-zones-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const windowStart = shiftDate(today, -(HR_ZONES_INSIGHT_WINDOW_DAYS - 1));

    const rows = await db.all(
      `SELECT zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND zone1_minutes IS NOT NULL`,
      [req.user.id, windowStart, today]
    );

    if (rows.length < MIN_WORKOUTS_WITH_ZONES) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_with_zones',
        workoutsWithZoneData: rows.length,
        minWorkoutsRequired: MIN_WORKOUTS_WITH_ZONES
      });
    }

    const zoneMinutes = { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };
    for (const r of rows) {
      zoneMinutes.zone1 += r.zone1_minutes || 0;
      zoneMinutes.zone2 += r.zone2_minutes || 0;
      zoneMinutes.zone3 += r.zone3_minutes || 0;
      zoneMinutes.zone4 += r.zone4_minutes || 0;
      zoneMinutes.zone5 += r.zone5_minutes || 0;
    }
    Object.keys(zoneMinutes).forEach(k => { zoneMinutes[k] = Math.round(zoneMinutes[k]); });

    const totalMinutes = Object.values(zoneMinutes).reduce((s, v) => s + v, 0);
    let dominantZone = null;
    let dominantMax = -1;
    Object.entries(zoneMinutes).forEach(([, mins], idx) => {
      if (mins > dominantMax) { dominantMax = mins; dominantZone = idx + 1; }
    });

    res.json({
      hasEnoughData: true,
      windowDays: HR_ZONES_INSIGHT_WINDOW_DAYS,
      workoutsWithZoneData: rows.length,
      zoneMinutes,
      totalMinutes,
      dominantZone
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu stref kardio.' });
  }
});

// ============================================================================
// Runda 10: kolejne insighty bazujące WYŁĄCZNIE na danych już zbieranych przez
// aplikację (health_rating posiłków z analysis_json, dzień tygodnia, strefy kardio
// treningów, target_weight_kg z ustawień, powtarzające się posiłki) - zero nowych
// integracji, zero kopiowania funkcji z konkurencyjnych aplikacji dietetycznych.
// ============================================================================

const MEAL_QUALITY_RECENT_WINDOW_DAYS = 14;
const MEAL_QUALITY_BASELINE_WINDOW_DAYS = 30;
const MIN_RECENT_RATED_MEALS = 3;
const MIN_BASELINE_RATED_MEALS = 5;

// Insight: trend jakości posiłków na bazie health_rating (1-10) - oceny zdrowotności
// KAŻDEGO posiłku, którą Gemini już zwraca przy analizie (routes/meals.js), ale która
// dotąd nigdy nie była agregowana w czasie (widoczna tylko per-posiłek w widoku dnia).
// health_rating nie ma własnej kolumny w tabeli meals - żyje wewnątrz analysis_json,
// więc parsujemy go tu tym samym wzorcem try/catch co GET /api/meals. Porównanie:
// ostatnie 14 dni vs poprzedzające 30 dni.
router.get('/api/dashboard/meal-quality-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(MEAL_QUALITY_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(MEAL_QUALITY_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, analysis_json FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, baselineStart, today]
    );
    // Tag dnia: dni wakacji wykluczamy z trendu jakości posiłków - jedzenie na
    // wyjeździe (restauracje, inny rytm) nie jest reprezentatywne dla normalnej
    // jakości diety, fałszywie zaburzyłoby porównanie "ostatnio vs wcześniej".
    const mealQualityVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], baselineStart, today);
    const rows = rawRows.filter(r => !mealQualityVacationExcluded.has(r.date));

    const ratedMeals = [];
    rows.forEach(r => {
      try {
        const analysis = JSON.parse(r.analysis_json);
        const rating = Number(analysis.health_rating);
        if (Number.isFinite(rating) && rating >= 1 && rating <= 10) {
          ratedMeals.push({ date: r.date, rating });
        }
      } catch (e) {
        // Starszy posiłek / brak albo uszkodzony analysis_json - brak health_rating, pomijamy.
      }
    });

    const recent = ratedMeals.filter(m => m.date >= recentStart && m.date <= today);
    const baseline = ratedMeals.filter(m => m.date >= baselineStart && m.date <= baselineEnd);

    if (recent.length < MIN_RECENT_RATED_MEALS || baseline.length < MIN_BASELINE_RATED_MEALS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_rated_meals',
        recentRatedMeals: recent.length,
        baselineRatedMeals: baseline.length,
        minRecentRequired: MIN_RECENT_RATED_MEALS,
        minBaselineRequired: MIN_BASELINE_RATED_MEALS
      });
    }

    const avgRating = arr => Math.round((arr.reduce((s, m) => s + m.rating, 0) / arr.length) * 10) / 10;
    const avgRecentRating = avgRating(recent);
    const avgBaselineRating = avgRating(baseline);

    res.json({
      hasEnoughData: true,
      recentRatedMeals: recent.length,
      baselineRatedMeals: baseline.length,
      avgRecentRating,
      avgBaselineRating,
      ratingDiff: Math.round((avgRecentRating - avgBaselineRating) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania trendu jakości posiłków.' });
  }
});

const WEEKEND_EFFECT_LOOKBACK_DAYS = 28;
const MIN_WEEKDAY_DAYS_WITH_DATA = 8;
const MIN_WEEKEND_DAYS_WITH_DATA = 4;

// Dzień tygodnia z daty 'YYYY-MM-DD' - przez Date.UTC (jak shiftDate powyżej), żeby
// uniknąć zależności od strefy czasowej procesu Node (zob. utils/dates.js).
function isWeekendDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = niedziela, 6 = sobota
  return dow === 0 || dow === 6;
}

// Insight: "efekt weekendu" - porównanie kalorii/aktywności/snu w dni robocze vs
// weekend z ostatnich 4 tygodni. Pierwszy insight grupujący dane wg dnia tygodnia
// (wszystkie pozostałe porównują dwa okresy czasu albo dwie grupy wg wartości
// metryki) - sprawdza, czy typowy "rozjazd weekendowy" faktycznie istnieje u TEGO
// użytkownika, nie zakłada go z góry.
router.get('/api/dashboard/weekend-effect-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -(WEEKEND_EFFECT_LOOKBACK_DAYS - 1));

    const rawMealRows = await db.all(
      `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`,
      [req.user.id, startDate, today]
    );
    const rawHealthRows = await db.all(
      `SELECT date, active_calories, steps, sleep_score FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, startDate, today]
    );
    // Tag dnia: dni wakacji wykluczamy z efektu weekendu - na wyjeździe "weekend"
    // przestaje mieć typowe znaczenie (każdy dzień bywa jak weekend), włączenie
    // tych dni zniekształcałoby porównanie dni robocze vs weekend w normalnym życiu.
    const weekendVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const mealRows = rawMealRows.filter(r => !weekendVacationExcluded.has(r.date));
    const healthRows = rawHealthRows.filter(r => !weekendVacationExcluded.has(r.date));

    const weekdayCalories = [], weekendCalories = [];
    mealRows.forEach(r => {
      if (r.calories == null) return;
      (isWeekendDateStr(r.date) ? weekendCalories : weekdayCalories).push(r.calories);
    });

    if (weekdayCalories.length < MIN_WEEKDAY_DAYS_WITH_DATA || weekendCalories.length < MIN_WEEKEND_DAYS_WITH_DATA) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        weekdayDaysLogged: weekdayCalories.length,
        weekendDaysLogged: weekendCalories.length,
        minWeekdayDaysRequired: MIN_WEEKDAY_DAYS_WITH_DATA,
        minWeekendDaysRequired: MIN_WEEKEND_DAYS_WITH_DATA
      });
    }

    const weekdaySteps = [], weekendSteps = [];
    const weekdayActiveCal = [], weekendActiveCal = [];
    const weekdaySleep = [], weekendSleep = [];
    healthRows.forEach(r => {
      const weekend = isWeekendDateStr(r.date);
      if (r.steps != null && r.steps > 0) (weekend ? weekendSteps : weekdaySteps).push(r.steps);
      if (r.active_calories != null && r.active_calories > 0) (weekend ? weekendActiveCal : weekdayActiveCal).push(r.active_calories);
      if (r.sleep_score != null) (weekend ? weekendSleep : weekdaySleep).push(r.sleep_score);
    });

    const avg = arr => (arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null);
    const avgWeekdayCalories = avg(weekdayCalories);
    const avgWeekendCalories = avg(weekendCalories);

    res.json({
      hasEnoughData: true,
      weekdayDaysLogged: weekdayCalories.length,
      weekendDaysLogged: weekendCalories.length,
      avgWeekdayCalories,
      avgWeekendCalories,
      // B-S4: Zabezpieczenie przed NaN gdy avg() zwraca null (brak danych w jednej grupie)
      caloriesDiff: (avgWeekendCalories != null && avgWeekdayCalories != null) ? avgWeekendCalories - avgWeekdayCalories : null,
      avgWeekdaySteps: avg(weekdaySteps),
      avgWeekendSteps: avg(weekendSteps),
      avgWeekdayActiveCalories: avg(weekdayActiveCal),
      avgWeekendActiveCalories: avg(weekendActiveCal),
      avgWeekdaySleepScore: avg(weekdaySleep),
      avgWeekendSleepScore: avg(weekendSleep)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy efektu weekendu.' });
  }
});

const WORKOUT_EFFICIENCY_LOOKBACK_DAYS = 90;
const MIN_WORKOUTS_PER_TYPE = 3;

// Insight: efektywność kalorii per typ treningu (kcal/min) na bazie
// apple_health_workouts.active_calories i duration_minutes z ostatnich 90 dni -
// ranking typów treningu wg realnie spalanych kalorii na minutę, pokazujący który
// rodzaj aktywności TEGO użytkownika daje najlepszy efekt kaloryczny na jednostkę
// czasu (a nie ogólny stereotyp "bieganie pali więcej niż joga").
router.get('/api/dashboard/workout-efficiency-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_EFFICIENCY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
       AND duration_minutes >= 5 AND active_calories IS NOT NULL AND active_calories > 0`,
      [req.user.id, startDate, today]
    );

    const byType = new Map();
    rows.forEach(r => {
      const type = r.workout_type || 'Inny';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(r);
    });

    const types = [];
    byType.forEach((workouts, type) => {
      if (workouts.length < MIN_WORKOUTS_PER_TYPE) return;
      const avgKcalPerMin = workouts.reduce((s, w) => s + w.active_calories / w.duration_minutes, 0) / workouts.length;
      const avgDurationMin = workouts.reduce((s, w) => s + w.duration_minutes, 0) / workouts.length;
      const totalCalories = workouts.reduce((s, w) => s + w.active_calories, 0);
      types.push({
        type,
        count: workouts.length,
        avgKcalPerMin: Math.round(avgKcalPerMin * 10) / 10,
        avgDurationMin: Math.round(avgDurationMin),
        totalCalories: Math.round(totalCalories)
      });
    });

    if (types.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_per_type',
        minWorkoutsPerTypeRequired: MIN_WORKOUTS_PER_TYPE
      });
    }

    types.sort((a, b) => b.avgKcalPerMin - a.avgKcalPerMin);

    res.json({
      hasEnoughData: true,
      windowDays: WORKOUT_EFFICIENCY_LOOKBACK_DAYS,
      types
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy efektywności treningów.' });
  }
});

const WEIGHT_FORECAST_LOOKBACK_DAYS = 60;
const MIN_WEIGHT_FORECAST_MEASUREMENTS = 4;
const MIN_WEIGHT_FORECAST_SPAN_DAYS = 14;

// Insight: prognoza daty osiągnięcia liczbowego celu wagi (target_weight_kg) na bazie
// regresji liniowej wagi z ostatnich 60 dni. Ta sama logika statusu/tempa co w mailu
// tygodniowym (buildGoalPaceAnalysis w services/summaries.js, reużyte tu, żeby nie
// duplikować) - dotąd ta prognoza była widoczna WYŁĄCZNIE w okresowych mailach, tu
// wystawiona jako stała karta na dashboardzie. weeklyWeightChange liczone tu z
// regresji z dłuższego okna (60 dni), nie z prostej różnicy pierwszy-ostatni pomiar
// w tygodniu jak w mailu - stabilniejsze przy nieregularnych pomiarach.
router.get('/api/dashboard/weight-goal-forecast', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WEIGHT_FORECAST_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetWeightKg = settings.target_weight_kg || 0;
    if (!targetWeightKg) {
      return res.json({ hasEnoughData: false, reason: 'no_target_weight_set' });
    }

    const rawWeightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    // Tag dnia: dni wakacji wykluczamy z regresji - wahania wagi na wyjeździe nie
    // odzwierciedlają realnego tempa zmiany przy normalnym trybie życia, fałszywie
    // przesunęłyby prognozowaną datę osiągnięcia celu.
    const forecastVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const weightRows = rawWeightRows.filter(r => !forecastVacationExcluded.has(r.date));
    if (weightRows.length < MIN_WEIGHT_FORECAST_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_weight_data',
        weightMeasurements: weightRows.length,
        minWeightMeasurementsRequired: MIN_WEIGHT_FORECAST_MEASUREMENTS
      });
    }

    const points = toRegressionPoints(weightRows, 'weight');
    const spanDays = points[points.length - 1].x;
    if (spanDays < MIN_WEIGHT_FORECAST_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        spanDays: Math.round(spanDays),
        minSpanDaysRequired: MIN_WEIGHT_FORECAST_SPAN_DAYS
      });
    }

    const slopePerDay = linearRegressionSlope(points);
    if (slopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_weight_data' });
    }
    const currentWeight = weightRows[weightRows.length - 1].weight;
    const weeklyWeightChange = Math.round(slopePerDay * 7 * 100) / 100;

    const pace = buildGoalPaceAnalysis(targetWeightKg, currentWeight, weeklyWeightChange);
    if (!pace) {
      return res.json({ hasEnoughData: false, reason: 'cannot_evaluate_pace' });
    }

    const projectedDate = pace.weeksToGoal != null ? shiftDate(today, Math.round(pace.weeksToGoal * 7)) : null;

    res.json({
      hasEnoughData: true,
      weightMeasurements: weightRows.length,
      spanDays: Math.round(spanDays),
      ...pace,
      projectedDate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd prognozy celu wagi.' });
  }
});

const FAVORITE_MEAL_DRIFT_LOOKBACK_DAYS = 180;
const MIN_OCCURRENCES_FOR_DRIFT = 4;
const DRIFT_THRESHOLD_PERCENT = 20;
const MAX_DRIFT_FINDINGS = 5;

// Insight: stabilność ulubionych (powtarzających się) posiłków w czasie. Rozszerza
// wzorzec grupowania z /api/meals/frequent (LOWER(TRIM(raw_text)), powtórzenia) o
// porównanie STARSZEJ vs NOWSZEJ połowy wystąpień danego posiłku - wykrywa "dryf
// porcji" (ten sam zapisany posiłek z czasem rośnie/maleje kalorycznie, np. przez
// powolne zwiększanie porcji bez zmiany opisu) - dotąd niewidoczny, bo
// /api/meals/frequent liczy tylko jedną uśrednioną wartość z całego okresu.
router.get('/api/dashboard/favorite-meal-drift-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -FAVORITE_MEAL_DRIFT_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT LOWER(TRIM(raw_text)) AS meal_key, raw_text, date, calories
       FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? AND raw_text IS NOT NULL AND TRIM(raw_text) != '' AND calories IS NOT NULL
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    const grouped = new Map();
    rows.forEach(r => {
      if (!grouped.has(r.meal_key)) grouped.set(r.meal_key, []);
      grouped.get(r.meal_key).push(r);
    });

    const eligibleGroups = [...grouped.values()].filter(occ => occ.length >= MIN_OCCURRENCES_FOR_DRIFT);
    if (eligibleGroups.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_repeated_meals',
        minOccurrencesRequired: MIN_OCCURRENCES_FOR_DRIFT
      });
    }

    const avgCal = arr => arr.reduce((s, x) => s + x.calories, 0) / arr.length;
    const findings = [];
    eligibleGroups.forEach(occurrences => {
      const mid = Math.floor(occurrences.length / 2);
      const olderAvg = avgCal(occurrences.slice(0, mid));
      const newerAvg = avgCal(occurrences.slice(mid));
      if (olderAvg <= 0) return;
      const diffPercent = Math.round(((newerAvg - olderAvg) / olderAvg) * 100);
      if (Math.abs(diffPercent) >= DRIFT_THRESHOLD_PERCENT) {
        findings.push({
          rawText: occurrences[occurrences.length - 1].raw_text,
          occurrences: occurrences.length,
          olderAvgCalories: Math.round(olderAvg),
          newerAvgCalories: Math.round(newerAvg),
          diffPercent,
          firstDate: occurrences[0].date,
          lastDate: occurrences[occurrences.length - 1].date
        });
      }
    });

    findings.sort((a, b) => Math.abs(b.diffPercent) - Math.abs(a.diffPercent));

    res.json({
      hasEnoughData: true,
      mealsAnalyzed: eligibleGroups.length,
      findings: findings.slice(0, MAX_DRIFT_FINDINGS)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd analizy dryfu ulubionych posiłków.' });
  }
});

const SPO2_RECENT_WINDOW_DAYS = 7;
const SPO2_BASELINE_WINDOW_DAYS = 28;
const MIN_RECENT_SPO2_DAYS = 4;
const MIN_BASELINE_SPO2_DAYS = 14;

// Trend SpO2 (saturacja krwi): okno ostatnich dni vs poprzedzający baseline -
// identyczny wzorzec jak rhr-drift-insight, ale tu interesuje nas SPADEK
// (niższe SpO2 niż własny baseline może sygnalizować problemy z oddychaniem
// w czasie snu, infekcję albo przebywanie na wysokości), nie wzrost.
router.get('/api/dashboard/spo2-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const recentStart = shiftDate(today, -(SPO2_RECENT_WINDOW_DAYS - 1));
    const baselineEnd = shiftDate(recentStart, -1);
    const baselineStart = shiftDate(baselineEnd, -(SPO2_BASELINE_WINDOW_DAYS - 1));

    const rawRows = await db.all(
      `SELECT date, spo2_percentage FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND spo2_percentage IS NOT NULL AND spo2_percentage > 0`,
      [req.user.id, baselineStart, today]
    );
    // Tag dnia: dni choroby wykluczamy - obniżone SpO2 ma wtedy już znaną przyczynę
    // (infekcja), nie powinno trafiać do baseline "normalnego" spoczynkowego SpO2.
    const spo2IllnessExcluded = await getExcludedDates(req.user.id, ['illness'], baselineStart, today);
    const rows = rawRows.filter(r => !spo2IllnessExcluded.has(r.date));

    const recent = rows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.spo2_percentage);
    const baseline = rows.filter(r => r.date >= baselineStart && r.date <= baselineEnd).map(r => r.spo2_percentage);

    if (recent.length < MIN_RECENT_SPO2_DAYS || baseline.length < MIN_BASELINE_SPO2_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_days',
        recentDays: recent.length, baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_SPO2_DAYS, minBaselineDaysRequired: MIN_BASELINE_SPO2_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
    const avgRecentSpo2 = avg(recent);
    const avgBaselineSpo2 = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const spo2Diff = Math.round((avgRecentSpo2 - avgBaselineSpo2) * 10) / 10;
    // SpO2 ma naturalnie bardzo mały rozrzut (zwykle 95-99%), więc przy stdDev=0
    // (np. tylko jedna odczytana wartość się powtarza) fallback jest niewielki - 1pp.
    const isLow = baselineStdDev > 0 ? spo2Diff < -baselineStdDev : spo2Diff < -1;

    res.json({
      hasEnoughData: true, recentDays: recent.length, baselineDays: baseline.length,
      avgRecentSpo2, avgBaselineSpo2, spo2Diff,
      baselineStdDev: Math.round(baselineStdDev * 10) / 10, isLow
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu SpO2.' });
  }
});

const MIN_WHR_MEASUREMENTS = 4;
const MIN_WHR_SPAN_DAYS = 14;
const WHR_LOOKBACK_DAYS = 365;

// Wskaźnik WHR (waist-to-hip ratio = obwód pasa / obwód bioder) - uznany w
// literaturze klinicznej (WHO) wskaźnik ryzyka sercowo-naczyniowego, niezależny
// od samej wagi czy BMI. Liczony tylko z pomiarów, gdzie waist i hips zapisano
// TEGO SAMEGO dnia (inaczej łączenie po dacie zniekształcałoby wskaźnik).
// Progi WHO: kobiety >0.85, mężczyźni >0.90 = podwyższone ryzyko. Aplikacja nie
// zbiera pola "płeć" w ustawieniach, więc zwracamy oba progi i pozwalamy
// frontowi/użytkownikowi samemu zinterpretować wynik względem własnego progu.
router.get('/api/dashboard/whr-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WHR_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, waist, hips FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND waist IS NOT NULL AND hips IS NOT NULL AND hips > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_WHR_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_measurements',
        measurements: rows.length, minMeasurementsRequired: MIN_WHR_MEASUREMENTS
      });
    }

    const whrRows = rows.map(r => ({ date: r.date, whr: r.waist / r.hips }));
    const spanDays = (new Date(whrRows[whrRows.length - 1].date).getTime() - new Date(whrRows[0].date).getTime()) / (24 * 60 * 60 * 1000);

    if (spanDays < MIN_WHR_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'span_too_short',
        spanDays: Math.round(spanDays), minSpanDaysRequired: MIN_WHR_SPAN_DAYS
      });
    }

    const latestWhr = Math.round(whrRows[whrRows.length - 1].whr * 1000) / 1000;
    const whrPoints = toRegressionPoints(whrRows, 'whr');
    const whrSlopePerDay = linearRegressionSlope(whrPoints);
    const whrTrend = whrSlopePerDay === null ? 'flat' : (whrSlopePerDay < -0.0002 ? 'down' : whrSlopePerDay > 0.0002 ? 'up' : 'flat');

    res.json({
      hasEnoughData: true,
      measurements: rows.length,
      spanDays: Math.round(spanDays),
      latestWhr,
      latestDate: whrRows[whrRows.length - 1].date,
      whrTrend,
      whrSlopePerMonth: whrSlopePerDay !== null ? Math.round(whrSlopePerDay * 30 * 1000) / 1000 : null,
      whoThresholdFemale: 0.85,
      whoThresholdMale: 0.90,
      isAboveFemaleThreshold: latestWhr > 0.85,
      isAboveMaleThreshold: latestWhr > 0.90
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu WHR.' });
  }
});

const MIN_SYMMETRY_MEASUREMENTS = 4;
const SYMMETRY_LOOKBACK_DAYS = 365;
const SYMMETRY_ASYMMETRY_THRESHOLD_CM = 0.5;

// Symetria bicepsów (biceps_left vs biceps_right) - nigdy wcześniej nie
// porównywane w aplikacji. Trwała różnica >0.5cm między stronami jest częstym
// sygnałem nierównomiernego treningu/dominacji jednej strony ciała (typowe u
// osób praworęcznych/leworęcznych trenujących bez świadomej korekty).
router.get('/api/dashboard/body-symmetry-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SYMMETRY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, biceps_left, biceps_right FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND biceps_left IS NOT NULL AND biceps_right IS NOT NULL
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_SYMMETRY_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_measurements',
        measurements: rows.length, minMeasurementsRequired: MIN_SYMMETRY_MEASUREMENTS
      });
    }

    const diffRows = rows.map(r => ({ date: r.date, diff: r.biceps_left - r.biceps_right }));
    const avgDiffCm = Math.round((diffRows.reduce((s, r) => s + r.diff, 0) / diffRows.length) * 100) / 100;
    const latestDiffCm = Math.round(diffRows[diffRows.length - 1].diff * 100) / 100;
    const diffPoints = toRegressionPoints(diffRows, 'diff');
    const diffSlopePerDay = linearRegressionSlope(diffPoints);

    res.json({
      hasEnoughData: true,
      measurements: rows.length,
      avgDiffCm,
      latestDiffCm,
      latestDate: diffRows[diffRows.length - 1].date,
      dominantSide: Math.abs(avgDiffCm) < 0.05 ? null : (avgDiffCm > 0 ? 'left' : 'right'),
      isAsymmetric: Math.abs(avgDiffCm) >= SYMMETRY_ASYMMETRY_THRESHOLD_CM,
      asymmetryThresholdCm: SYMMETRY_ASYMMETRY_THRESHOLD_CM,
      diffTrendCmPerMonth: diffSlopePerDay !== null ? Math.round(diffSlopePerDay * 30 * 100) / 100 : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu symetrii bicepsów.' });
  }
});

const PACE_LOOKBACK_DAYS = 120;
const PACE_RECENT_WINDOW_DAYS = 14;
const PACE_BASELINE_WINDOW_DAYS = 90;
const MIN_RECENT_PACE_DAYS = 3;
const MIN_BASELINE_PACE_DAYS = 5;
const PACE_WORKOUT_TYPE_REGEX = /run|bieg|walk|marsz|spacer|hik|trek/i;

// Tempo biegu/marszu (min/km) - PRZYBLIŻONE, bo apple_health_workouts NIE MA
// kolumny dystansu per trening. Łączymy więc dzienny dystans (health_metrics.
// distance_meters) z czasem trwania treningu, ale TYLKO dla dni, w których
// zapisano DOKŁADNIE JEDEN trening danego dnia (niezależnie od typu) - inaczej
// dzienny dystans mógłby być sumą np. biegu i osobnego marszu, co fałszowałoby
// tempo. Patrz workout-efficiency-insight - tu zamiast kcal/min liczymy
// czas/km, i dodatkowo wymagamy typu run/walk/hike.
router.get('/api/dashboard/pace-trend-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -PACE_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, workout_type, duration_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND duration_minutes IS NOT NULL AND duration_minutes > 0`,
      [req.user.id, startDate, today]
    );

    const byDate = new Map();
    workoutRows.forEach(w => {
      if (!byDate.has(w.date)) byDate.set(w.date, []);
      byDate.get(w.date).push(w);
    });

    const singleWorkoutDates = [...byDate.entries()]
      .filter(([, workouts]) => workouts.length === 1 && PACE_WORKOUT_TYPE_REGEX.test(workouts[0].workout_type || ''))
      .map(([date, workouts]) => ({ date, durationMinutes: workouts[0].duration_minutes }));

    if (singleWorkoutDates.length === 0) {
      return res.json({ hasEnoughData: false, reason: 'no_eligible_single_workout_days' });
    }

    const dates = singleWorkoutDates.map(d => d.date);
    const distRows = await db.all(
      `SELECT date, distance_meters FROM health_metrics
       WHERE user_id = ? AND date IN (${dates.map(() => '?').join(',')}) AND distance_meters IS NOT NULL AND distance_meters > 0`,
      [req.user.id, ...dates]
    );
    const distanceByDate = new Map(distRows.map(r => [r.date, r.distance_meters]));

    const paceRows = singleWorkoutDates
      .filter(d => distanceByDate.has(d.date))
      .map(d => ({
        date: d.date,
        paceMinPerKm: d.durationMinutes / (distanceByDate.get(d.date) / 1000)
      }))
      .filter(r => r.paceMinPerKm > 0 && isFinite(r.paceMinPerKm))
      .sort((a, b) => a.date.localeCompare(b.date));

    const recentStart = shiftDate(today, -(PACE_RECENT_WINDOW_DAYS - 1));
    const recent = paceRows.filter(r => r.date >= recentStart && r.date <= today).map(r => r.paceMinPerKm);
    const baseline = paceRows.filter(r => r.date < recentStart && r.date >= shiftDate(today, -PACE_BASELINE_WINDOW_DAYS)).map(r => r.paceMinPerKm);

    if (recent.length < MIN_RECENT_PACE_DAYS || baseline.length < MIN_BASELINE_PACE_DAYS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_days',
        eligibleDays: paceRows.length, recentDays: recent.length, baselineDays: baseline.length,
        minRecentDaysRequired: MIN_RECENT_PACE_DAYS, minBaselineDaysRequired: MIN_BASELINE_PACE_DAYS
      });
    }

    const avg = (arr) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
    const avgRecentPace = avg(recent);
    const avgBaselinePace = avg(baseline);
    const { stdDev: baselineStdDev } = meanAndStdDev(baseline);
    const paceDiffMinPerKm = Math.round((avgRecentPace - avgBaselinePace) * 100) / 100;
    // Niższe tempo (min/km) = szybciej = lepiej, więc "poprawa" to UJEMNA różnica.
    const isImproving = baselineStdDev > 0 ? paceDiffMinPerKm < -baselineStdDev : paceDiffMinPerKm < -0.5;
    const isSlower = baselineStdDev > 0 ? paceDiffMinPerKm > baselineStdDev : paceDiffMinPerKm > 0.5;

    res.json({
      hasEnoughData: true, recentDays: recent.length, baselineDays: baseline.length,
      avgRecentPaceMinPerKm: avgRecentPace, avgBaselinePaceMinPerKm: avgBaselinePace,
      paceDiffMinPerKm, baselineStdDev: Math.round(baselineStdDev * 100) / 100,
      isImproving, isSlower
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu trendu tempa.' });
  }
});

const VARIETY_LOOKBACK_DAYS = 60;
const MIN_TOTAL_WORKOUTS_FOR_VARIETY = 6;
const VARIETY_DOMINANCE_THRESHOLD_PERCENT = 70;

// Różnorodność treningów - rozkład workout_type z ostatnich 60 dni. W odróżnieniu
// od workout-efficiency-insight (kcal/min per typ), tu interesuje nas wyłącznie
// CZĘSTOŚĆ poszczególnych dyscyplin - jedna dominująca dyscyplina >70% wszystkich
// treningów może sygnalizować ryzyko przetrenowania jednostronnego (np. tylko
// bieganie, brak treningu siłowego/mobilności).
router.get('/api/dashboard/workout-variety-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -VARIETY_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT workout_type FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ? AND workout_type IS NOT NULL`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_TOTAL_WORKOUTS_FOR_VARIETY) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_workouts',
        totalWorkouts: rows.length, minWorkoutsRequired: MIN_TOTAL_WORKOUTS_FOR_VARIETY
      });
    }

    const counts = new Map();
    rows.forEach(r => {
      const key = r.workout_type.trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const breakdown = [...counts.entries()]
      .map(([type, count]) => ({ type, count, pct: Math.round((count / rows.length) * 1000) / 10 }))
      .sort((a, b) => b.count - a.count);

    const dominant = breakdown[0];

    res.json({
      hasEnoughData: true,
      totalWorkouts: rows.length,
      distinctTypes: breakdown.length,
      breakdown,
      dominantType: dominant.type,
      dominantPct: dominant.pct,
      isImbalanced: dominant.pct >= VARIETY_DOMINANCE_THRESHOLD_PERCENT
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu różnorodności treningów.' });
  }
});

const WELLNESS_SCORE_RHR_BASELINE_DAYS = 28;
const MIN_WELLNESS_COMPONENTS = 3;
// Wagi pięciu składowych - sumują się do 1.0 gdy WSZYSTKIE są dostępne. Gdy
// część sygnałów brakuje danego dnia (np. brak HRV/RHR bo użytkownik nie ma
// zegarka, albo brak posiłków bo jeszcze nic nie zjadł), wagi dostępnych
// składowych są renormalizowane proporcjonalnie - patrz niżej.
// KONTRAKT: suma wag musi wynosić 1.0 (0.25+0.25+0.15+0.20+0.15=1.0) - przy
// edycji tych wartości w przyszłości zachowaj tę sumę, inaczej renormalizacja
// niżej (weightSum) to "naprawi" w locie, ale udział każdej składowej względem
// pozostałych przestanie odpowiadać zamierzonym proporcjom.
console.assert(
  Math.abs(Object.values({ sleep: 0.25, readiness: 0.25, rhrRecovery: 0.15, nutritionAdherence: 0.20, hydration: 0.15 }).reduce((a, b) => a + b, 0) - 1) < 1e-9,
  'WELLNESS_WEIGHTS musi sumować się do 1.0'
);
const WELLNESS_WEIGHTS = { sleep: 0.25, readiness: 0.25, rhrRecovery: 0.15, nutritionAdherence: 0.20, hydration: 0.15 };

// Composite "Wellness Score" (0-100) - syntetyzuje sen, gotowość, RHR względem
// własnego baseline, trzymanie się celu kalorycznego i nawodnienie w JEDEN
// nagłówkowy wskaźnik dnia. Nie zastępuje pozostałych insightów (te analizują
// PRZYCZYNY/korelacje w czasie) - to jest "stan dnia" w jednej liczbie, żeby
// użytkownik nie musiał scrollować całego dashboardu, by ocenić "jak mi idzie dzisiaj".
router.get('/api/dashboard/wellness-score', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const health = await db.get(
      `SELECT sleep_score, readiness_score, rhr, water_ml FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // Naprawa z audytu (runda 17): konwertujemy na liczbę WYŁĄCZNIE klucze faktycznie
    // czytane niżej jako liczby (target_calories, target_water_ml) - wcześniej
    // `Number(r.value)` było stosowane na WSZYSTKICH wierszach settings, co zepsułoby
    // się przy dowolnym przyszłym kluczu tekstowym (np. gemini_api_key) zapisanym w tej
    // samej tabeli. Pozostałe klucze zostają niezmienione (string).
    const NUMERIC_SETTINGS_KEYS = ['target_calories', 'target_water_ml'];
    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = NUMERIC_SETTINGS_KEYS.includes(r.key) ? Number(r.value) : r.value;
    });
    const targetCalories = getTargetCalories(settings);
    const targetWaterMl = getTargetWaterMl(settings);

    const mealRow = await db.get(
      `SELECT SUM(calories) AS calories FROM meals WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );
    const caloriesToday = mealRow && mealRow.calories != null ? mealRow.calories : null;

    const baselineStart = shiftDate(today, -WELLNESS_SCORE_RHR_BASELINE_DAYS);
    const baselineRhrRows = await db.all(
      `SELECT rhr FROM health_metrics WHERE user_id = ? AND date >= ? AND date < ? AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );

    const components = {};

    if (health && health.sleep_score != null && health.sleep_score > 0) {
      components.sleep = Math.max(0, Math.min(100, health.sleep_score));
    }
    if (health && health.readiness_score != null && health.readiness_score > 0) {
      components.readiness = Math.max(0, Math.min(100, health.readiness_score));
    }
    if (health && health.rhr != null && health.rhr > 0 && baselineRhrRows.length >= 5) {
      const { mean, stdDev } = meanAndStdDev(baselineRhrRows.map(r => r.rhr));
      // Niższe RHR niż własny baseline = lepsza regeneracja. z>0 oznacza RHR
      // WYŻSZE niż zwykle (gorzej), stąd odejmujemy z*15 od 100 (skala empiryczna,
      // nie kliniczna - 1 odchylenie standardowe odpowiada -15 punktów).
      const z = stdDev > 0 ? (health.rhr - mean) / stdDev : 0;
      components.rhrRecovery = Math.max(0, Math.min(100, 100 - z * 15));
    }
    if (caloriesToday != null && caloriesToday > 0 && targetCalories > 0) {
      const deviationRatio = Math.abs(caloriesToday - targetCalories) / targetCalories;
      components.nutritionAdherence = Math.max(0, Math.min(100, 100 - deviationRatio * 100));
    }
    if (health && health.water_ml != null && health.water_ml > 0 && targetWaterMl > 0) {
      components.hydration = Math.max(0, Math.min(100, (health.water_ml / targetWaterMl) * 100));
    }

    const availableKeys = Object.keys(components);
    if (availableKeys.length < MIN_WELLNESS_COMPONENTS) {
      return res.json({
        hasEnoughData: false, reason: 'not_enough_components',
        availableComponents: availableKeys, minComponentsRequired: MIN_WELLNESS_COMPONENTS
      });
    }

    const weightSum = availableKeys.reduce((s, k) => s + WELLNESS_WEIGHTS[k], 0);
    const wellnessScore = Math.round(
      availableKeys.reduce((s, k) => s + components[k] * (WELLNESS_WEIGHTS[k] / weightSum), 0)
    );

    const label = wellnessScore >= 80 ? 'Świetnie' : wellnessScore >= 60 ? 'Dobrze' : wellnessScore >= 40 ? 'Przeciętnie' : 'Słabo';

    res.json({
      hasEnoughData: true,
      date: today,
      wellnessScore,
      label,
      components: Object.fromEntries(availableKeys.map(k => [k, Math.round(components[k])])),
      componentsUsed: availableKeys.length,
      componentsTotal: Object.keys(WELLNESS_WEIGHTS).length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania Wellness Score.' });
  }
});

// --- BATERIA ENERGII ---
//
// Jedna liczba 0-100 na górze dashboardu, odpowiadająca na pytanie "ile mam dziś
// paliwa", zamiast kilkudziesięciu osobnych kart, w których ta odpowiedź się gubi.
//
// Czym różni się od Wellness Score: Wellness Score ocenia, jak DOBRY był dzień
// (sen, gotowość, trzymanie się celu kalorycznego, nawodnienie) - to ocena
// zachowania. Bateria odpowiada na inne pytanie: ile zasobu ZOSTAŁO na teraz.
// Ładuje się nocą, rozładowuje w ciągu dnia proporcjonalnie do obciążenia i pory
// dnia, i pamięta skumulowany dług snu. Dlatego dzień z idealną dietą, ale po
// trzech krótkich nocach, ma wysoki Wellness Score i niską baterię - i to jest
// zamierzone, bo to dwie różne informacje.
//
// UWAGA co do skali: wagi i przeliczniki poniżej są EMPIRYCZNE, dobrane tak, by
// typowy dzień wypadał sensownie na skali 0-100. To nie jest miara kliniczna ani
// odtworzenie algorytmu Garmina/Whoop - to model opisowy na własnych danych
// użytkownika, budowany w tej samej konwencji co pozostałe insighty w tym pliku
// (porównanie do WŁASNEGO baseline, a nie do norm populacyjnych).

const BATTERY_SLEEP_DEBT_DAYS = 14;
const BATTERY_STRAIN_BASELINE_DAYS = 30;
const MIN_DAYS_FOR_BATTERY_STRAIN_BASELINE = 7;

// Ile punktów baterii zabiera pełny, typowy dzień (przy obciążeniu równym własnemu
// baseline). 45 pkt oznacza, że po zwykłym dniu z pełnego naładowania zostaje ok.
// połowy - a dzień wyraźnie cięższy niż zwykle potrafi zejść znacznie niżej.
const BATTERY_FULL_DAY_DRAIN = 45;

// Podział zużycia na dwie niezależne części.
//
// Dlaczego nie jedna, skalowana zegarem: pierwsza wersja liczyła zużycie jako
// "część doby, która minęła" razy "obciążenie względem baseline przeskalowanego
// tą samą częścią doby". To zakładało, że aktywność rozkłada się równomiernie
// przez całą dobę - a o 8:00 rano nikt nie ma za sobą jednej trzeciej dziennych
// kalorii. Efekt: poranny trening zjadał połowę baterii, a spokojny wieczór
// zaniżał obciążenie.
//
// Teraz zużycie to suma:
//   - część AKTYWNOŚCIOWA, proporcjonalna do realnie wykonanej pracy względem
//     typowego pełnego dnia (bez odnoszenia do zegara),
//   - część CZASOWA, proporcjonalna do tego, jak długo użytkownik nie śpi
//     (samo funkcjonowanie kosztuje energię, nawet w dniu bez treningu).
// Dzięki temu dzień odpoczynku kończy się z wysoką baterią, a ciężki trening
// obniża ją od razu, niezależnie od tego, o której się odbył.
const BATTERY_ACTIVITY_DRAIN_SHARE = 0.7;
const BATTERY_TIME_DRAIN_SHARE = 0.3;

// Okno czuwania używane do części czasowej (godziny zegara warszawskiego).
// Przybliżenie, nie ustawienie użytkownika - dla części zużycia wartej 13 punktów
// dokładniejszy model (np. z pory pobudki z Oury) nie zmieniłby wyniku na tyle,
// żeby uzasadnić dodatkową złożoność i kolejne źródło "brak danych".
const BATTERY_WAKING_START_MINUTE = 7 * 60;
const BATTERY_WAKING_END_MINUTE = 23 * 60;

// Kara za skumulowany dług snu. 2 pkt za każdą brakującą godzinę z ostatnich 14 nocy,
// ale nie więcej niż 15 pkt - dług snu ma obniżać sufit baterii, a nie sam z siebie
// sprowadzać ją do zera.
const BATTERY_DEBT_PENALTY_PER_HOUR = 2;
const BATTERY_MAX_DEBT_PENALTY = 15;

const BATTERY_MAX_STRESS_DRAIN = 15;
const BATTERY_MAX_STRESS_RECOVERY = 10;

// Wagi ładowania nocnego. sleep_score jest najbliżej "jak dobrze się zregenerowałem",
// readiness_score to gotowość wg Oury, a czas snu względem własnego celu domyka obraz
// (można mieć wysoki wynik jakości na zbyt krótkiej nocy).
const BATTERY_CHARGE_WEIGHTS = {
  sleepScore: 0.45,
  readiness: 0.35,
  sleepDuration: 0.20
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Jaka część okna czuwania już minęła (0-1) w strefie Europe/Warsaw. Używane
// WYŁĄCZNIE do czasowej części zużycia. Dla dat historycznych zwracamy 1, bo tamte
// doby są już domknięte.
function getWakingProgress(dateStr) {
  if (dateStr !== getLocalDateString()) return 1;
  const wall = getWarsawWallClock();
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const span = BATTERY_WAKING_END_MINUTE - BATTERY_WAKING_START_MINUTE;
  return clamp((minutes - BATTERY_WAKING_START_MINUTE) / span, 0, 1);
}

router.get('/api/dashboard/energy-battery', async (req, res) => {
  try {
    const today = resolveQueryDate(req);

    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
    const targetSleep = settings.target_sleep_duration === undefined
      || isNaN(Number(settings.target_sleep_duration))
      ? 7.2
      : Number(settings.target_sleep_duration);

    const health = await db.get(
      `SELECT sleep_score, sleep_duration, readiness_score, hrv, rhr,
              active_calories, active_minutes, steps,
              stress_high_minutes, stress_recovery_minutes
       FROM health_metrics WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // Bez danych o nocy nie ma z czego policzyć naładowania - lepiej powiedzieć
    // wprost "brak danych" niż pokazać liczbę zbudowaną z niczego.
    const hasSleepSignal = health && (
      (health.sleep_score != null && health.sleep_score > 0) ||
      (health.sleep_duration != null && health.sleep_duration > 0) ||
      (health.readiness_score != null && health.readiness_score > 0)
    );
    if (!hasSleepSignal) {
      return res.json({ hasEnoughData: false, reason: 'no_sleep_data', date: today });
    }

    // --- 1. Ładowanie nocne ---
    const chargeParts = {};
    if (health.sleep_score != null && health.sleep_score > 0) {
      chargeParts.sleepScore = clamp(health.sleep_score, 0, 100);
    }
    if (health.readiness_score != null && health.readiness_score > 0) {
      chargeParts.readiness = clamp(health.readiness_score, 0, 100);
    }
    if (health.sleep_duration != null && health.sleep_duration > 0 && targetSleep > 0) {
      chargeParts.sleepDuration = clamp((health.sleep_duration / targetSleep) * 100, 0, 100);
    }
    const chargeKeys = Object.keys(chargeParts);
    const chargeWeightSum = chargeKeys.reduce((s, k) => s + BATTERY_CHARGE_WEIGHTS[k], 0);
    const nightCharge = chargeKeys.reduce(
      (s, k) => s + chargeParts[k] * (BATTERY_CHARGE_WEIGHTS[k] / chargeWeightSum), 0
    );

    // --- 2. Dług snu z ostatnich 14 nocy ---
    const debtRows = await db.all(
      `SELECT date, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date > ? AND date <= ? AND sleep_duration IS NOT NULL AND sleep_duration > 0`,
      [req.user.id, shiftDate(today, -BATTERY_SLEEP_DEBT_DAYS), today]
    );
    // Liczymy WYŁĄCZNIE niedobory. Dłuższy sen jednej nocy nie "spłaca" długu
    // liniowo - to założenie upraszczające, ale ostrożniejsze niż sumowanie
    // nadwyżek, które potrafiłoby wyzerować realny, wielodniowy deficyt.
    const sleepDebtHours = debtRows.reduce(
      (sum, row) => sum + Math.max(0, targetSleep - row.sleep_duration), 0
    );
    const debtPenalty = Math.min(
      BATTERY_MAX_DEBT_PENALTY,
      sleepDebtHours * BATTERY_DEBT_PENALTY_PER_HOUR
    );

    // --- 3. Zużycie dzienne względem WŁASNEGO baseline obciążenia ---
    // Kolejność metryk to kolejność wiarygodności: kalorie aktywne najlepiej
    // oddają obciążenie, minuty aktywności są zamiennikiem, kroki ostatecznością.
    const strainRows = await db.all(
      `SELECT active_calories, active_minutes, steps FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, shiftDate(today, -BATTERY_STRAIN_BASELINE_DAYS), today]
    );

    const strainMetric = ['active_calories', 'active_minutes', 'steps'].find(key => {
      const todayValue = health[key];
      const history = strainRows.filter(r => r[key] != null && r[key] > 0);
      return todayValue != null && todayValue > 0 && history.length >= MIN_DAYS_FOR_BATTERY_STRAIN_BASELINE;
    });

    let strainRatio = 1;
    let strainBaseline = null;
    if (strainMetric) {
      const values = strainRows.map(r => r[strainMetric]).filter(v => v != null && v > 0);
      strainBaseline = median(values);
      if (strainBaseline > 0) {
        // Porównanie do CAŁEGO typowego dnia, bez skalowania zegarem - ta liczba
        // znaczy "ile typowego dnia pracy mam już za sobą", więc rano jest po prostu
        // niska, zamiast sztucznie zawyżana przez krótkie okno odniesienia.
        strainRatio = health[strainMetric] / strainBaseline;
      }
    }
    // Górne ograniczenie: dzień skrajnie ciężki nie zeruje baterii natychmiast.
    // Dolnego ograniczenia nie ma - zero aktywności ma znaczyć zero zużycia
    // aktywnościowego, bo od "samego istnienia" jest osobna część czasowa.
    const boundedStrainRatio = clamp(strainRatio, 0, 2);
    const activityDrain = boundedStrainRatio * BATTERY_FULL_DAY_DRAIN * BATTERY_ACTIVITY_DRAIN_SHARE;
    const timeDrain = getWakingProgress(today) * BATTERY_FULL_DAY_DRAIN * BATTERY_TIME_DRAIN_SHARE;
    const dayDrain = activityDrain + timeDrain;

    // --- 4. Stres: obciążenie i regeneracja w ciągu dnia (dane z Oury) ---
    const stressDrain = health.stress_high_minutes != null && health.stress_high_minutes > 0
      ? Math.min(BATTERY_MAX_STRESS_DRAIN, health.stress_high_minutes / 10)
      : 0;
    const stressRecovery = health.stress_recovery_minutes != null && health.stress_recovery_minutes > 0
      ? Math.min(BATTERY_MAX_STRESS_RECOVERY, health.stress_recovery_minutes / 20)
      : 0;

    const battery = Math.round(
      clamp(nightCharge - debtPenalty - dayDrain - stressDrain + stressRecovery, 0, 100)
    );

    // Progi etykiet. Zalecenie niżej korzysta z TYCH SAMYCH progów - inaczej karta
    // potrafiła pokazać etykietę "Niska" obok zdania "Bateria w normie" (przy
    // wartościach tuż pod granicą), co brzmi jak dwie sprzeczne diagnozy.
    const BATTERY_LABEL_BANDS = [
      { min: 75, label: 'Naładowana' },
      { min: 50, label: 'Dobra' },
      { min: 30, label: 'Niska' },
      { min: 0, label: 'Na rezerwie' }
    ];
    const label = BATTERY_LABEL_BANDS.find(b => battery >= b.min).label;

    // Jedno konkretne zalecenie zamiast samego opisu stanu. Kolejność warunków to
    // kolejność ważności: najpierw to, co najmocniej ciągnie baterię w dół.
    let recommendation;
    if (debtPenalty >= BATTERY_MAX_DEBT_PENALTY * 0.6) {
      recommendation = `Dług snu z ostatnich ${BATTERY_SLEEP_DEBT_DAYS} dni to ok. ${sleepDebtHours.toFixed(1)} h. Dziś połóż się o godzinę wcześniej niż zwykle.`;
    } else if (boundedStrainRatio >= 1.6) {
      recommendation = 'Obciążenie wyraźnie powyżej Twojej normy. Zaplanuj lżejszy wieczór i nie dokładaj treningu.';
    } else if (battery < 30) {
      recommendation = 'Bateria na rezerwie. Dziś priorytetem jest sen i jedzenie w okolicach celu, nie trening.';
    } else if (battery < 50) {
      recommendation = 'Bateria niska. Zejdź z intensywności i pilnuj wcześniejszego wieczoru.';
    } else if (battery >= 75 && boundedStrainRatio <= 1) {
      recommendation = 'Zapas energii jest wysoki, a obciążenie poniżej normy - dobry dzień na mocniejszy trening.';
    } else {
      recommendation = 'Bateria w normie. Trzymaj zwykły plan dnia.';
    }

    res.json({
      hasEnoughData: true,
      date: today,
      battery,
      label,
      recommendation,
      components: {
        nightCharge: Math.round(nightCharge),
        debtPenalty: Math.round(debtPenalty * 10) / 10,
        dayDrain: Math.round(dayDrain * 10) / 10,
        activityDrain: Math.round(activityDrain * 10) / 10,
        timeDrain: Math.round(timeDrain * 10) / 10,
        stressDrain: Math.round(stressDrain * 10) / 10,
        stressRecovery: Math.round(stressRecovery * 10) / 10
      },
      sleepDebt: {
        hours: Math.round(sleepDebtHours * 10) / 10,
        nights: debtRows.length,
        windowDays: BATTERY_SLEEP_DEBT_DAYS,
        targetSleepHours: targetSleep
      },
      strain: {
        metric: strainMetric || null,
        today: strainMetric ? health[strainMetric] : null,
        baselineMedian: strainBaseline != null ? Math.round(strainBaseline) : null,
        ratioToBaseline: strainMetric ? Math.round(boundedStrainRatio * 100) / 100 : null
      },
      // Klient rysuje wskaźnik "na teraz", więc musi wiedzieć, że dla dnia
      // historycznego wartość jest końcem doby, a nie stanem bieżącym.
      isLive: today === getLocalDateString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania baterii energii.' });
  }
});

const EXPLANATION_BASELINE_DAYS = 28;
const MIN_BASELINE_DAYS_FOR_EXPLANATION = 14;
// Próg "znaczącego" odchylenia liczony we własnych odchyleniach standardowych
// użytkownika (jak w rhr-drift-insight/spo2-trend-insight) - 1 stdDev to umiarkowany,
// ale realny sygnał, nie szum dnia do dnia.
const EXPLANATION_ZSCORE_THRESHOLD = 1.0;
const EXPLANATION_CACHE_FRESH_MS = 30 * 60 * 1000;

// Metryki analizowane pod kątem największego dobowego odchylenia od własnego baseline.
// higherIsWorse: true dla rhr (podniesione tętno spoczynkowe = gorzej), false dla
// pozostałych (niższy sen/gotowość/HRV niż zwykle = gorzej).
const EXPLANATION_METRICS = [
  { key: 'sleep_score', label: 'jakość snu', higherIsWorse: false },
  { key: 'readiness_score', label: 'gotowość/regeneracja', higherIsWorse: false },
  { key: 'hrv', label: 'HRV', higherIsWorse: false },
  { key: 'rhr', label: 'tętno spoczynkowe', higherIsWorse: true }
];

// Zbiera MINIMALNY, już zebrany kontekst (dzisiejsze/wczorajsze odżywianie, nawodnienie,
// aktywność, treningi, suplementy) potrzebny do wyjaśnienia JEDNEGO konkretnego
// odchylenia - celowo dużo mniejszy zakres niż pełny prompt ai_advice w /api/dashboard,
// żeby zapytanie do Gemini było krótkie, szybkie i tanie.
async function buildExplanationContext(userId, today) {
  const yesterday = shiftDate(today, -1);

  const [todayNutrition, yesterdayNutrition, todayHealth, todayWorkouts, supplementsRow] = await Promise.all([
    db.get(
      `SELECT SUM(calories) AS calories, SUM(sodium) AS sodium, SUM(sugar) AS sugar, SUM(fiber) AS fiber, MAX(timestamp) AS last_meal_timestamp
       FROM meals WHERE user_id = ? AND date = ?`,
      [userId, today]
    ),
    db.get(
      `SELECT SUM(calories) AS calories, SUM(sodium) AS sodium, SUM(sugar) AS sugar, SUM(fiber) AS fiber
       FROM meals WHERE user_id = ? AND date = ?`,
      [userId, yesterday]
    ),
    db.get(
      `SELECT steps, active_calories, sedentary_minutes, water_ml FROM health_metrics WHERE user_id = ? AND date = ?`,
      [userId, today]
    ),
    db.all(
      `SELECT workout_type, duration_minutes FROM apple_health_workouts WHERE user_id = ? AND date IN (?, ?)`,
      [userId, today, yesterday]
    ),
    db.get(`SELECT supplements FROM health_metrics WHERE user_id = ? AND date = ?`, [userId, today])
  ]);

  const lastMealHour = todayNutrition && todayNutrition.last_meal_timestamp
    ? new Date(todayNutrition.last_meal_timestamp).getUTCHours() // B-S3: UTC aby uniknąć błędu strefy czasowej
    : null;

  return {
    todayNutrition: todayNutrition || null,
    yesterdayNutrition: yesterdayNutrition || null,
    lastMealHour,
    steps: todayHealth ? todayHealth.steps : null,
    activeCalories: todayHealth ? todayHealth.active_calories : null,
    sedentaryMinutes: todayHealth ? todayHealth.sedentary_minutes : null,
    waterMl: todayHealth ? todayHealth.water_ml : null,
    workouts: todayWorkouts || [],
    supplements: supplementsRow ? supplementsRow.supplements : null
  };
}

// Krótki, ukierunkowany prompt - w stylu Oura Advisor/Whoop Coach ("Twój sen spadł,
// bo...") - łączy KONKRETNĄ metrykę z KONKRETNYM dniem, nie ogólnikową poradą.
function buildExplanationPrompt(finding, context, language) {
  let label = finding.label;
  if (language === 'en') {
    if (finding.metric === 'sleep_score') label = 'sleep quality';
    else if (finding.metric === 'readiness_score') label = 'readiness/recovery';
    else if (finding.metric === 'hrv') label = 'HRV';
    else if (finding.metric === 'rhr') label = 'resting heart rate';
    
    return `You are a health analyst. Today's value for the metric "${label}" is significantly worse than the user's own 28-day baseline (deviation of ${finding.z.toFixed(1)} standard deviations, mean for the last 28 days: ${finding.mean}, today: ${finding.todayValue}).

Available data from the last 24 hours (may or may not explain this deviation - ONLY use what actually points to the cause, do not guess):
- Nutrition today: ${JSON.stringify(context.todayNutrition)}
- Nutrition yesterday: ${JSON.stringify(context.yesterdayNutrition)}
- Hour of last meal: ${context.lastMealHour !== null ? context.lastMealHour + ':00' : 'no data'}
- Steps today: ${context.steps ?? 'no data'}, active calories: ${context.activeCalories ?? 'no data'}, sedentary minutes: ${context.sedentaryMinutes ?? 'no data'}
- Water today: ${context.waterMl ?? 'no data'} ml
- Workouts (today/yesterday): ${JSON.stringify(context.workouts)}
- Supplements today: ${context.supplements || 'no data'}

Write ONE to TWO concise sentences in English directly to the user, in the style "Your [metric] [dropped/increased] because [specific cause from data above]". If the data does not clearly point to a cause, write it openly (e.g., "Your [X] is lower than usual - today's data doesn't point to a clear cause, you might want to focus on recovery"). No headers, no lists, no generalities like "take care of your health".`;
  }

  return `Jesteś analitykiem zdrowia. Dzisiejsza wartość metryki "${finding.label}" jest znacząco gorsza niż własny 28-dniowy wzorzec użytkownika (odchylenie ${finding.z.toFixed(1)} odchylenia standardowego, średnia z ostatnich 28 dni: ${finding.mean}, dziś: ${finding.todayValue}).

Dostępne dane z ostatniej doby (mogą, ale nie muszą wyjaśniać to odchylenie - użyj TYLKO tego, co faktycznie wskazuje na przyczynę, nie zgaduj na siłę):
- Odżywianie dziś: ${JSON.stringify(context.todayNutrition)}
- Odżywianie wczoraj: ${JSON.stringify(context.yesterdayNutrition)}
- Godzina ostatniego posiłku: ${context.lastMealHour !== null ? context.lastMealHour + ':00' : 'brak danych'}
- Kroki dziś: ${context.steps ?? 'brak danych'}, kalorie aktywne: ${context.activeCalories ?? 'brak danych'}, minuty siedzące: ${context.sedentaryMinutes ?? 'brak danych'}
- Woda dziś: ${context.waterMl ?? 'brak danych'} ml
- Treningi (dziś/wczoraj): ${JSON.stringify(context.workouts)}
- Suplementy dziś: ${context.supplements || 'brak danych'}

Napisz JEDNO do DWÓCH zwięzłych zdań po polsku, bezpośrednio do użytkownika, w stylu "Twoja/Twój [metryka] [spadła/wzrosła], bo [konkretna przyczyna z danych powyżej]". Jeśli dane NIE wskazują jednoznacznie na przyczynę, napisz to otwarcie (np. "Twój [X] jest niższy niż zwykle - dane z dzisiaj nie wskazują jednoznacznej przyczyny, warto zwrócić uwagę na regenerację"). Bez nagłówków, bez list, bez ogólników typu "dbaj o zdrowie".`;
}

// Insight (Runda 11, na bazie researchu konkurencji - styl Oura Advisor/Whoop Coach):
// wykrywa NAJWIĘKSZE dzisiejsze odchylenie sen/gotowość/HRV/RHR względem własnego
// 28-dniowego baseline (z-score, jak w rhr-drift-insight/spo2-trend-insight) i prosi
// AI o JEDNO konkretne, krótkie wyjaśnienie PRZYCZYNY na bazie już zebranych danych
// (odżywianie/nawodnienie/aktywność/treningi/suplementy) - rozszerzenie istniejącego
// mechanizmu AI (ai_advice), ale osobny, znacznie mniejszy prompt/cache (patrz migracja
// ai_explanation/ai_explanation_generated_at w db.js).
router.get('/api/dashboard/ai-explanation-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -EXPLANATION_BASELINE_DAYS);

    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, today]);
    if (!health) {
      return res.json({ hasEnoughData: false, reason: 'no_data_for_date' });
    }

    const baselineRows = await db.all(
      `SELECT sleep_score, readiness_score, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, baselineStart, today]
    );

    let bestFinding = null;
    for (const metric of EXPLANATION_METRICS) {
      const todayValue = health[metric.key];
      if (todayValue == null || todayValue <= 0) continue;
      const baselineValues = baselineRows.map(r => r[metric.key]).filter(v => v != null && v > 0);
      if (baselineValues.length < MIN_BASELINE_DAYS_FOR_EXPLANATION) continue;
      const { mean, stdDev } = meanAndStdDev(baselineValues);
      if (stdDev <= 0) continue;
      const rawZ = (todayValue - mean) / stdDev;
      // z dodatnie = ZAWSZE "gorzej niż zwykle", niezależnie od kierunku metryki
      const z = metric.higherIsWorse ? rawZ : -rawZ;
      if (z >= EXPLANATION_ZSCORE_THRESHOLD && (!bestFinding || z > bestFinding.z)) {
        bestFinding = {
          metric: metric.key,
          label: metric.label,
          z,
          todayValue,
          mean: Math.round(mean * 10) / 10
        };
      }
    }

    if (!bestFinding) {
      return res.json({ hasEnoughData: true, hasFinding: false });
    }

    // Cache per (user, data) w health_metrics - dla dni PRZESZŁYCH dane są niezmienne,
    // więc wygenerowane raz wyjaśnienie jest świeże na zawsze; dla dnia DZISIEJSZEGO
    // odświeżamy co 30 min (jak ai_advice), bo w trakcie dnia mogą napłynąć nowe dane.
    const isPastDay = today < getLocalDateString();
    const generatedAtMs = health.ai_explanation_generated_at ? new Date(health.ai_explanation_generated_at).getTime() : 0;
    const isFresh = isPastDay
      ? !!health.ai_explanation
      : (!!health.ai_explanation && Date.now() - generatedAtMs < EXPLANATION_CACHE_FRESH_MS);

    if (!isFresh) {
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
      const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
      const forceCustomKeyOnly = req.user.role !== 'admin';
      const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));
      const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
      const language = langRow ? langRow.value : 'pl';

      const explanationLockKey = `${req.user.id}:${today}`;
      if (canUseAI && !pendingExplanationGeneration.has(explanationLockKey)) {
        pendingExplanationGeneration.add(explanationLockKey);

        buildExplanationContext(req.user.id, today)
          .then(context => generateContentWithFallback(buildExplanationPrompt(bestFinding, context, language), false, null, userApiKey, forceCustomKeyOnly))
          .then(async (text) => {
            const trimmed = text.trim();
            const nowStr = new Date().toISOString();
            await db.run(`
              INSERT INTO health_metrics (user_id, date, ai_explanation, ai_explanation_generated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET
                ai_explanation = excluded.ai_explanation,
                ai_explanation_generated_at = excluded.ai_explanation_generated_at
            `, [req.user.id, today, trimmed, nowStr]);
          })
          .catch((aiErr) => {
            console.error('[API ERROR] Błąd generowania wyjaśnienia AI (w tle):', aiErr);
          })
          .finally(() => {
            pendingExplanationGeneration.delete(explanationLockKey);
          });
      }
    }

    res.json({
      hasEnoughData: true,
      hasFinding: true,
      metric: bestFinding.metric,
      label: bestFinding.label,
      zScore: Math.round(bestFinding.z * 100) / 100,
      explanation: health.ai_explanation || null,
      generating: !isFresh
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania wyjaśnienia AI.' });
  }
});

const SELF_BENCHMARK_LOOKBACK_DAYS = 90;
const MIN_SELF_BENCHMARK_DAYS = 14;

// Metryki porównywane "Ty dziś vs Ty w przeszłości" - WYŁĄCZNIE własna historia
// użytkownika (90 dni), bez jakiegokolwiek porównania z innymi użytkownikami (w
// odróżnieniu od Whoop "people like you"). higherIsBetter steruje kierunkiem percentyla.
const SELF_BENCHMARK_METRICS = [
  { key: 'sleep_score', label: 'Sen', source: 'health', higherIsBetter: true, unit: 'pkt' },
  { key: 'readiness_score', label: 'Gotowość', source: 'health', higherIsBetter: true, unit: 'pkt' },
  { key: 'hrv', label: 'HRV', source: 'health', higherIsBetter: true, unit: 'ms' },
  { key: 'rhr', label: 'Tętno spoczynkowe', source: 'health', higherIsBetter: false, unit: 'bpm' },
  { key: 'steps', label: 'Kroki', source: 'health', higherIsBetter: true, unit: 'kroków' },
  { key: 'active_calories', label: 'Kalorie aktywne', source: 'health', higherIsBetter: true, unit: 'kcal' }
];

// Percentyl wartości "value" względem tablicy historycznych wartości (% historycznych
// dni, które value przewyższa lub im równa) - prosta, czytelna miara "ile dni było
// gorszych/słabszych", bez zakładania rozkładu normalnego (w przeciwieństwie do z-score
// używanego w innych insightach) - tu celem jest właśnie intuicyjne "lepszy niż X% dni".
function percentileRank(value, historicalValues) {
  if (historicalValues.length === 0) return null;
  const countAtOrBelow = historicalValues.filter(v => v <= value).length;
  return Math.round((countAtOrBelow / historicalValues.length) * 100);
}

// Insight (Runda 11, na bazie researchu konkurencji - prywatna wersja Whoop "people
// like you", ale BEZ porównań międzyludzkich): dla każdej dostępnej metryki liczy
// percentyl dzisiejszej wartości względem własnych ostatnich 90 dni użytkownika,
// a następnie wybiera najbardziej WYRÓŻNIAJĄCY się dzień (najwyższy i najniższy
// percentyl) jako "najlepszy" i "najsłabszy" sygnał dnia.
router.get('/api/dashboard/self-benchmark-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SELF_BENCHMARK_LOOKBACK_DAYS);

    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, today]);
    const mealRow = await db.get(`SELECT SUM(calories) AS calories FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, today]);

    // Runda 12 (audyt): wcześniej brak wpisu zdrowia/posiłków na DZISIAJ kończył się tym
    // samym reason: 'not_enough_days' jak realny brak wystarczającej historii - mylące,
    // bo to dwa różne problemy (jak już rozróżnia ai-explanation-insight przez
    // no_data_for_date). Rozróżniamy je tutaj analogicznie.
    if (!health && (!mealRow || mealRow.calories == null)) {
      return res.json({ hasEnoughData: false, reason: 'no_data_for_date' });
    }

    const rawHistoryRows = await db.all(
      `SELECT date, sleep_score, readiness_score, hrv, rhr, steps, active_calories FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, startDate, today]
    );
    // Tag dnia: dni choroby wykluczamy z baseline "Ty w przeszłości" - chory dzień
    // nie jest reprezentatywny dla normalnej formy, fałszywie zaniżałby/zawyżałby
    // percentyl dzisiejszej wartości w zależności od metryki.
    const benchmarkIllnessExcluded = await getExcludedDates(req.user.id, ['illness'], startDate, today);
    const historyRows = rawHistoryRows.filter(r => !benchmarkIllnessExcluded.has(r.date));

    const todayValues = { ...(health || {}) };
    if (mealRow && mealRow.calories != null) todayValues.calories = mealRow.calories;

    const results = [];
    for (const metric of SELF_BENCHMARK_METRICS) {
      const todayValue = todayValues[metric.key];
      if (todayValue == null || todayValue <= 0) continue;
      const historicalValues = historyRows.map(r => r[metric.key]).filter(v => v != null && v > 0);
      if (historicalValues.length < MIN_SELF_BENCHMARK_DAYS) continue;

      const rawPercentile = percentileRank(todayValue, historicalValues);
      // Dla metryk gdzie NIŻEJ jest lepiej (np. RHR), odwracamy percentyl, żeby
      // "100" zawsze znaczyło "jeden z Twoich najlepszych dni", niezależnie od metryki.
      const percentile = metric.higherIsBetter ? rawPercentile : 100 - rawPercentile;

      results.push({
        metric: metric.key,
        label: metric.label,
        // Runda 12 (audyt): zwracamy też todayValue/unit/higherIsBetter (nie tylko
        // znormalizowany percentyl) - frontend dzięki temu może pokazać surową wartość
        // i jednoznacznie zaznaczyć kierunek "co jest dobre" przy metrykach typu RHR,
        // gdzie NIŻSZA wartość = lepszy wynik (w przeciwieństwie do np. kroków).
        // Percentyl sam w sobie jest już znormalizowany (100 = najlepszy dzień,
        // niezależnie od kierunku metryki), ale bez tego kontekstu surowa wartość
        // RHR=92 z percentylem 90 mogłaby sugerować użytkownikowi "więcej = lepiej".
        todayValue,
        unit: metric.unit,
        higherIsBetter: metric.higherIsBetter,
        percentile,
        historyDays: historicalValues.length
      });
    }

    if (results.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        minDaysRequired: MIN_SELF_BENCHMARK_DAYS
      });
    }

    const best = results.reduce((a, b) => (b.percentile > a.percentile ? b : a));
    const worst = results.reduce((a, b) => (b.percentile < a.percentile ? b : a));

    res.json({
      hasEnoughData: true,
      lookbackDays: SELF_BENCHMARK_LOOKBACK_DAYS,
      metrics: results,
      best,
      worst: worst.metric !== best.metric ? worst : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania benchmarku "Ty dziś vs Ty w przeszłości".' });
  }
});

const WORKOUT_SLEEP_LOOKBACK_DAYS = 120;
const MIN_WORKOUTS_PER_TYPE_FOR_SLEEP = 3;
const MIN_REST_DAYS_FOR_SLEEP = 5;

// Runda 13, nowa funkcja 1: typ treningu (workout_type) wykonanego danego dnia vs
// jakość snu TEJ SAMEJ NOCY (sleep_score). Łączenie po TEJ SAMEJ dacie - konwencja
// jak w fiber-sleep-insight ("odżywianie/aktywność dnia -> sen tej doby"), inna niż
// w sleep-insight (tam: sen -> odżywianie NASTĘPNEGO dnia). Dni bez treningu (ale z
// sleep_score) tworzą grupę bazową "dni bez treningu" do porównania per typ.
router.get('/api/dashboard/workout-type-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_SLEEP_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, workout_type FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ? AND workout_type IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepRows = await db.all(
      `SELECT date, sleep_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ? AND sleep_score IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sleepByDate = new Map(sleepRows.map(r => [r.date, r.sleep_score]));

    const workoutDatesByType = new Map();
    const allWorkoutDates = new Set();
    workoutRows.forEach(w => {
      allWorkoutDates.add(w.date);
      if (!workoutDatesByType.has(w.workout_type)) workoutDatesByType.set(w.workout_type, new Set());
      workoutDatesByType.get(w.workout_type).add(w.date);
    });

    const restDaySleepScores = sleepRows
      .filter(r => !allWorkoutDates.has(r.date))
      .map(r => r.sleep_score);

    if (restDaySleepScores.length < MIN_REST_DAYS_FOR_SLEEP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_rest_days',
        restDays: restDaySleepScores.length,
        minRestDaysRequired: MIN_REST_DAYS_FOR_SLEEP
      });
    }

    const avgRestSleepScore = Math.round((restDaySleepScores.reduce((s, v) => s + v, 0) / restDaySleepScores.length) * 10) / 10;

    const types = [];
    workoutDatesByType.forEach((dates, type) => {
      const scores = [...dates].filter(d => sleepByDate.has(d)).map(d => sleepByDate.get(d));
      if (scores.length < MIN_WORKOUTS_PER_TYPE_FOR_SLEEP) return;
      const avgScore = Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10;
      types.push({
        type,
        nights: scores.length,
        avgSleepScore: avgScore,
        diffVsRestDays: Math.round((avgScore - avgRestSleepScore) * 10) / 10
      });
    });

    if (types.length === 0) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workouts_per_type',
        minWorkoutsPerTypeRequired: MIN_WORKOUTS_PER_TYPE_FOR_SLEEP,
        avgRestDaySleepScore: avgRestSleepScore,
        restDays: restDaySleepScores.length
      });
    }

    types.sort((a, b) => b.diffVsRestDays - a.diffVsRestDays);

    res.json({
      hasEnoughData: true,
      lookbackDays: WORKOUT_SLEEP_LOOKBACK_DAYS,
      restDays: restDaySleepScores.length,
      avgRestDaySleepScore: avgRestSleepScore,
      types,
      best: types[0],
      worst: (types[types.length - 1].type !== types[0].type && types[types.length - 1].diffVsRestDays !== types[0].diffVsRestDays)
        ? types[types.length - 1] : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu typ treningu-sen.' });
  }
});

const MUSCLE_PROTEIN_LOOKBACK_DAYS = 120;
const MIN_MUSCLE_MEASUREMENTS = 4;
const MIN_MUSCLE_SPAN_DAYS = 21;
const MIN_PROTEIN_DAYS_LOGGED = 14;
const MUSCLE_TREND_THRESHOLD_KG_PER_DAY = 0.005; // ok. 0.035 kg/tydzień
const ADEQUATE_PROTEIN_G_PER_KG = 1.6; // powszechnie przyjęty próg dla budowy/utrzymania masy mięśniowej

// Runda 13, nowa funkcja 2: trend masy mięśniowej (regresja liniowa, jak w
// body-recomposition-insight) vs ŚREDNIE dzienne spożycie białka z tego samego okna.
// Dwie NIEZALEŻNE miary (pomiary składu ciała i logowanie posiłków rzadko zbiegają
// się dzień w dzień) - porównujemy FAKTY z tego samego okresu, nie liczymy korelacji
// punkt-w-punkt (jak w body-recomposition-insight).
router.get('/api/dashboard/muscle-protein-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -MUSCLE_PROTEIN_LOOKBACK_DAYS);

    const muscleRows = await db.all(
      `SELECT date, muscle_mass FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND muscle_mass IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const proteinRows = await db.all(
      `SELECT date, SUM(protein) AS protein FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date HAVING protein > 0`,
      [req.user.id, startDate, today]
    );
    const weightRow = await db.get(
      `SELECT weight FROM health_metrics WHERE user_id = ? AND date <= ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`,
      [req.user.id, today]
    );

    if (muscleRows.length < MIN_MUSCLE_MEASUREMENTS || proteinRows.length < MIN_PROTEIN_DAYS_LOGGED) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data',
        muscleMeasurements: muscleRows.length,
        proteinLoggedDays: proteinRows.length,
        minMuscleMeasurementsRequired: MIN_MUSCLE_MEASUREMENTS,
        minProteinDaysRequired: MIN_PROTEIN_DAYS_LOGGED
      });
    }

    const musclePoints = toRegressionPoints(muscleRows, 'muscle_mass');
    const muscleSpanDays = musclePoints[musclePoints.length - 1].x;
    if (muscleSpanDays < MIN_MUSCLE_SPAN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        muscleSpanDays: Math.round(muscleSpanDays),
        minSpanDaysRequired: MIN_MUSCLE_SPAN_DAYS
      });
    }

    const muscleSlopePerDay = linearRegressionSlope(musclePoints);
    if (muscleSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    const avgProteinGramsPerDay = Math.round((proteinRows.reduce((s, r) => s + r.protein, 0) / proteinRows.length) * 10) / 10;
    const proteinPerKg = weightRow && weightRow.weight ? Math.round((avgProteinGramsPerDay / weightRow.weight) * 100) / 100 : null;

    const muscleTrend = muscleSlopePerDay > MUSCLE_TREND_THRESHOLD_KG_PER_DAY ? 'up'
      : muscleSlopePerDay < -MUSCLE_TREND_THRESHOLD_KG_PER_DAY ? 'down' : 'flat';
    const proteinAdequate = proteinPerKg !== null ? proteinPerKg >= ADEQUATE_PROTEIN_G_PER_KG : null;

    res.json({
      hasEnoughData: true,
      muscleMeasurements: muscleRows.length,
      muscleSpanDays: Math.round(muscleSpanDays),
      muscleSlopeKgPerWeek: Math.round(muscleSlopePerDay * 7 * 1000) / 1000,
      muscleTrend,
      proteinLoggedDays: proteinRows.length,
      avgProteinGramsPerDay,
      proteinPerKgBodyweight: proteinPerKg,
      adequateProteinThresholdGPerKg: ADEQUATE_PROTEIN_G_PER_KG,
      proteinAdequate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu masa mięśniowa-białko.' });
  }
});

const TEMP_DIVERGENCE_LOOKBACK_DAYS = 90;
const MIN_TEMP_DIVERGENCE_DAYS = 10;
const TEMP_DIVERGENCE_NOISE_THRESHOLD_C = 0.15; // poniżej traktujemy odczyt jako szum pomiaru, nie realne wychylenie

// Runda 13, nowa funkcja 3: rozjazd między dwoma NIEPOROWNYWALNYMI BEZPOŚREDNIO
// źródłami temperatury - Oura `temperature_deviation` (już WZGLĘDNE odchylenie od
// własnej bazowej Oura) vs Apple Watch `wrist_temperature` (wartość ABSOLUTNA, °C,
// tylko Series 8+/Ultra). Nie da się ich po prostu odjąć - normalizujemy Apple Watch
// do własnego odchylenia od WŁASNEJ średniej z okna, a potem sprawdzamy, czy oba
// źródła ZGADZAJĄ SIĘ co do KIERUNKU wychylenia tego samego dnia, czy się rozjeżdżają.
router.get('/api/dashboard/temperature-divergence-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -TEMP_DIVERGENCE_LOOKBACK_DAYS);

    const wristRows = await db.all(
      `SELECT date, wrist_temperature FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND wrist_temperature IS NOT NULL`,
      [req.user.id, startDate, today]
    );

    if (wristRows.length < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'no_wrist_temperature_data',
        wristTemperatureDays: wristRows.length,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    const baselineWrist = wristRows.reduce((s, r) => s + r.wrist_temperature, 0) / wristRows.length;

    const ouraRows = await db.all(
      `SELECT date, temperature_deviation FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND temperature_deviation IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const ouraByDate = new Map(ouraRows.map(r => [r.date, r.temperature_deviation]));

    const combined = wristRows
      .filter(r => ouraByDate.has(r.date))
      .map(r => ({
        date: r.date,
        wristDeviation: Math.round((r.wrist_temperature - baselineWrist) * 100) / 100,
        ouraDeviation: ouraByDate.get(r.date)
      }));

    if (combined.length < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_overlapping_days',
        overlappingDays: combined.length,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    const signOf = (v) => (Math.abs(v) < TEMP_DIVERGENCE_NOISE_THRESHOLD_C ? 0 : (v > 0 ? 1 : -1));
    let agreeDays = 0;
    let divergeDays = 0;
    const divergentDates = [];
    combined.forEach(r => {
      const wSign = signOf(r.wristDeviation);
      const oSign = signOf(r.ouraDeviation);
      if (wSign === 0 || oSign === 0) return; // niejednoznaczne (szum) - nie liczymy do zgodności/rozjazdu
      if (wSign === oSign) agreeDays++;
      else { divergeDays++; divergentDates.push(r.date); }
    });

    const decisiveDays = agreeDays + divergeDays;
    if (decisiveDays < MIN_TEMP_DIVERGENCE_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_decisive_days',
        decisiveDays,
        minDaysRequired: MIN_TEMP_DIVERGENCE_DAYS
      });
    }

    res.json({
      hasEnoughData: true,
      overlappingDays: combined.length,
      decisiveDays,
      agreeDays,
      divergeDays,
      agreementRatePercent: Math.round((agreeDays / decisiveDays) * 1000) / 10,
      baselineWristTemperatureC: Math.round(baselineWrist * 100) / 100,
      recentDivergentDates: divergentDates.slice(-5)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu rozjazdu temperatur.' });
  }
});

const PROPORTIONS_LOOKBACK_DAYS = 365;
const MIN_PROPORTIONS_MEASUREMENTS = 2;

// Runda 13, nowa funkcja 4: proporcje obwodów ciała - barki/talia i klatka/talia -
// na bazie body_measurements (shoulders, chest, waist). Porównanie PIERWSZEGO i
// OSTATNIEGO dostępnego pomiaru każdej z proporcji w oknie (jak w
// body-symmetry-insight, ale tu interesuje nas zmiana proporcji w czasie, nie
// symetria L/P). "Złoty wskaźnik" barki-talia (~1.618, Adonis Index) podany
// WYŁĄCZNIE jako powszechnie znany punkt odniesienia z fizjologii sportu, nie jako
// cel narzucony użytkownikowi.
router.get('/api/dashboard/body-proportions-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -PROPORTIONS_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, shoulders, chest, waist FROM body_measurements
       WHERE user_id = ? AND date >= ? AND date <= ? AND waist > 0 AND (shoulders IS NOT NULL OR chest IS NOT NULL)
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    const shoulderRows = rows.filter(r => r.shoulders != null);
    const chestRows = rows.filter(r => r.chest != null);

    if (shoulderRows.length < MIN_PROPORTIONS_MEASUREMENTS && chestRows.length < MIN_PROPORTIONS_MEASUREMENTS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_measurements',
        shoulderMeasurements: shoulderRows.length,
        chestMeasurements: chestRows.length,
        minMeasurementsRequired: MIN_PROPORTIONS_MEASUREMENTS
      });
    }

    const buildRatio = (arr, key) => {
      if (arr.length < MIN_PROPORTIONS_MEASUREMENTS) return null;
      const first = arr[0];
      const last = arr[arr.length - 1];
      const firstRatio = Math.round((first[key] / first.waist) * 1000) / 1000;
      const lastRatio = Math.round((last[key] / last.waist) * 1000) / 1000;
      return {
        firstDate: first.date,
        lastDate: last.date,
        firstRatio,
        lastRatio,
        ratioDiff: Math.round((lastRatio - firstRatio) * 1000) / 1000,
        measurements: arr.length
      };
    };

    const shoulderToWaist = buildRatio(shoulderRows, 'shoulders');
    const chestToWaist = buildRatio(chestRows, 'chest');

    res.json({
      hasEnoughData: true,
      shoulderToWaist,
      chestToWaist,
      referenceGoldenRatio: 1.618
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu proporcji obwodów ciała.' });
  }
});

const ACTIVITY_APPETITE_LOOKBACK_DAYS = 90;
const MIN_DAYS_PER_ACTIVITY_GROUP = 7;

// Runda 13, nowa funkcja 5: aktywność dnia (active_calories) vs apetyt TEGO SAMEGO
// dnia (suma kalorii z posiłków). Podział wg mediany WŁASNEJ aktywności użytkownika -
// analogicznie do sedentary-sleep-insight/fiber-sleep-insight (median split, nie
// regresja - interesuje nas prosty kontrast "dni bardziej aktywne" vs "mniej aktywne").
router.get('/api/dashboard/activity-appetite-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -ACTIVITY_APPETITE_LOOKBACK_DAYS);

    const activityRows = await db.all(
      `SELECT date, active_calories FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND active_calories IS NOT NULL AND active_calories > 0`,
      [req.user.id, startDate, today]
    );
    const mealRows = await db.all(
      `SELECT date, SUM(calories) AS calories FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date HAVING calories > 0`,
      [req.user.id, startDate, today]
    );
    const caloriesByDate = new Map(mealRows.map(r => [r.date, r.calories]));

    const combined = activityRows
      .filter(r => caloriesByDate.has(r.date))
      .map(r => ({ date: r.date, activeCalories: r.active_calories, calories: caloriesByDate.get(r.date) }));

    if (combined.length < MIN_DAYS_PER_ACTIVITY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: combined.length,
        minDaysRequired: MIN_DAYS_PER_ACTIVITY_GROUP * 2
      });
    }

    const medianActive = median(combined.map(r => r.activeCalories));
    const moreActive = combined.filter(r => r.activeCalories >= medianActive);
    const lessActive = combined.filter(r => r.activeCalories < medianActive);

    if (moreActive.length < MIN_DAYS_PER_ACTIVITY_GROUP || lessActive.length < MIN_DAYS_PER_ACTIVITY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        moreActiveDays: moreActive.length,
        lessActiveDays: lessActive.length,
        minDaysRequired: MIN_DAYS_PER_ACTIVITY_GROUP
      });
    }

    const avgOf = (arr, key) => Math.round((arr.reduce((s, x) => s + x[key], 0) / arr.length) * 10) / 10;
    const avgCaloriesMoreActive = avgOf(moreActive, 'calories');
    const avgCaloriesLessActive = avgOf(lessActive, 'calories');

    res.json({
      hasEnoughData: true,
      medianActiveCalories: Math.round(medianActive),
      moreActiveDays: moreActive.length,
      lessActiveDays: lessActive.length,
      avgCaloriesMoreActiveDays: avgCaloriesMoreActive,
      avgCaloriesLessActiveDays: avgCaloriesLessActive,
      caloriesDiff: Math.round((avgCaloriesMoreActive - avgCaloriesLessActive) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu aktywność-apetyt.' });
  }
});

const DIET_QUALITY_WEIGHT_LOOKBACK_DAYS = 90;
const MIN_RATED_MEALS_FOR_DIET_QUALITY = 10;
const MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY = 4;
const MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY = 21;
const WEIGHT_TREND_THRESHOLD_KG_PER_DAY = 0.01; // ok. 0.07 kg/tydzień
const HIGH_DIET_QUALITY_RATING = 7;
const LOW_DIET_QUALITY_RATING = 5;

// Runda 13, nowa funkcja 6: ŚREDNIA jakość posiłków (health_rating z analysis_json,
// jak w meal-quality-trend-insight) jako kontekst dla tempa zmiany wagi (regresja
// liniowa, jak w weight-goal-forecast/body-recomposition-insight) z tego samego
// okna. To NIE jest korelacja punkt-w-punkt (jakość diety per dzień nie da się
// sensownie połączyć z jednorazowymi pomiarami wagi) - to JUKSTAPOZYCJA dwóch
// niezależnych faktów z tego samego okresu, podobnie jak w body-recomposition-insight.
router.get('/api/dashboard/diet-quality-weight-pace-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -DIET_QUALITY_WEIGHT_LOOKBACK_DAYS);

    const mealRows = await db.all(
      `SELECT analysis_json FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`,
      [req.user.id, startDate, today]
    );
    const ratings = [];
    mealRows.forEach(r => {
      try {
        const analysis = JSON.parse(r.analysis_json);
        const rating = Number(analysis.health_rating);
        if (Number.isFinite(rating) && rating >= 1 && rating <= 10) ratings.push(rating);
      } catch (e) {
        // Brak/uszkodzony analysis_json - pomijamy (jak w meal-quality-trend-insight).
      }
    });

    const weightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (ratings.length < MIN_RATED_MEALS_FOR_DIET_QUALITY || weightRows.length < MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data',
        ratedMeals: ratings.length,
        weightMeasurements: weightRows.length,
        minRatedMealsRequired: MIN_RATED_MEALS_FOR_DIET_QUALITY,
        minWeightMeasurementsRequired: MIN_WEIGHT_MEASUREMENTS_FOR_DIET_QUALITY
      });
    }

    const weightPoints = toRegressionPoints(weightRows, 'weight');
    const weightSpanDays = weightPoints[weightPoints.length - 1].x;
    if (weightSpanDays < MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY) {
      return res.json({
        hasEnoughData: false,
        reason: 'span_too_short',
        weightSpanDays: Math.round(weightSpanDays),
        minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS_FOR_DIET_QUALITY
      });
    }

    const weightSlopePerDay = linearRegressionSlope(weightPoints);
    if (weightSlopePerDay === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    const avgRating = Math.round((ratings.reduce((s, v) => s + v, 0) / ratings.length) * 10) / 10;
    const dietQuality = avgRating >= HIGH_DIET_QUALITY_RATING ? 'high' : avgRating <= LOW_DIET_QUALITY_RATING ? 'low' : 'medium';
    const weightTrend = weightSlopePerDay > WEIGHT_TREND_THRESHOLD_KG_PER_DAY ? 'up'
      : weightSlopePerDay < -WEIGHT_TREND_THRESHOLD_KG_PER_DAY ? 'down' : 'flat';

    res.json({
      hasEnoughData: true,
      ratedMeals: ratings.length,
      avgMealRating: avgRating,
      dietQuality,
      weightMeasurements: weightRows.length,
      weightSpanDays: Math.round(weightSpanDays),
      weightSlopeKgPerWeek: Math.round(weightSlopePerDay * 7 * 100) / 100,
      weightTrend
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu jakość diety-tempo wagi.' });
  }
});

const STREAK_WEIGHT_LOOKBACK_DAYS = 180;
const STREAK_WEIGHT_MIN_LENGTH = 3; // jak STREAK_MIN_LENGTH w streak-drift-insight
const MIN_WEIGHT_POINTS_PER_STREAK_GROUP = 5;
const MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP = 14;

// Runda 13, nowa funkcja 7: czy dni będące CZĘŚCIĄ passy trzymania się celu
// kalorycznego (3+ kolejne dni w paśmie +/-15%, ta sama logika wykrywania passy co w
// streak-drift-insight) pokazują INNE tempo zmiany wagi niż dni BEZ aktywnej passy.
// Każdej dacie z pomiarem wagi przypisujemy status "w trakcie passy"/"bez passy" na
// podstawie historii logowania kalorii DO TEJ DATY, a potem liczymy NIEZALEŻNĄ
// regresję wagi w czasie dla każdej z dwóch grup (x = dni od początku okna, żeby obie
// regresje były na tej samej skali czasu).
router.get('/api/dashboard/streak-weight-effect-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -STREAK_WEIGHT_LOOKBACK_DAYS);

    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = Number(r.value); });
    const targetCalories = getTargetCalories(settings);

    const calorieRows = await db.all(
      `SELECT date, SUM(calories) AS total_calories FROM meals
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    const rawWeightRows = await db.all(
      `SELECT date, weight FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND weight IS NOT NULL ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );
    // Tag dnia: dni wakacji wykluczamy z pomiarów wagi - zmiany wagi na wyjeździe
    // (inna dieta, podróż, zatrzymanie wody) nie są efektem trzymania/nietrzymania
    // się celu kalorycznego, fałszywie zaburzyłyby porównanie tempa obu grup.
    const streakVacationExcluded = await getExcludedDates(req.user.id, ['vacation'], startDate, today);
    const weightRows = rawWeightRows.filter(r => !streakVacationExcluded.has(r.date));

    let prevDate = null;
    let currentStreak = 0;
    const streakStatusByDate = new Map();

    calorieRows.forEach(row => {
      const inBand = row.total_calories != null &&
        row.total_calories >= targetCalories * (1 - CALORIE_TARGET_BAND) &&
        row.total_calories <= targetCalories * (1 + CALORIE_TARGET_BAND);
      const isConsecutive = prevDate !== null && shiftDate(prevDate, 1) === row.date;

      if (inBand) {
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
      } else {
        currentStreak = 0;
      }
      streakStatusByDate.set(row.date, currentStreak >= STREAK_WEIGHT_MIN_LENGTH);
      prevDate = row.date;
    });

    const baseTime = weightRows.length > 0 ? new Date(weightRows[0].date).getTime() : null;
    const msPerDay = 24 * 60 * 60 * 1000;
    const streakWeightPoints = [];
    const noStreakWeightPoints = [];

    weightRows.forEach(r => {
      const isStreakDay = streakStatusByDate.get(r.date);
      if (isStreakDay === undefined) return; // brak danych kalorycznych dla tej daty - nie wiemy, do której grupy przypisać
      const point = { x: (new Date(r.date).getTime() - baseTime) / msPerDay, y: r.weight };
      (isStreakDay ? streakWeightPoints : noStreakWeightPoints).push(point);
    });

    const spanOf = (points) => (points.length > 0 ? points[points.length - 1].x - points[0].x : 0);

    if (
      streakWeightPoints.length < MIN_WEIGHT_POINTS_PER_STREAK_GROUP ||
      noStreakWeightPoints.length < MIN_WEIGHT_POINTS_PER_STREAK_GROUP ||
      spanOf(streakWeightPoints) < MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP ||
      spanOf(noStreakWeightPoints) < MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP
    ) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_data_per_group',
        streakWeightPoints: streakWeightPoints.length,
        noStreakWeightPoints: noStreakWeightPoints.length,
        minPointsRequired: MIN_WEIGHT_POINTS_PER_STREAK_GROUP,
        minSpanDaysRequired: MIN_WEIGHT_SPAN_DAYS_PER_STREAK_GROUP
      });
    }

    const streakSlope = linearRegressionSlope(streakWeightPoints);
    const noStreakSlope = linearRegressionSlope(noStreakWeightPoints);
    if (streakSlope === null || noStreakSlope === null) {
      return res.json({ hasEnoughData: false, reason: 'flat_data' });
    }

    res.json({
      hasEnoughData: true,
      streakMinLength: STREAK_WEIGHT_MIN_LENGTH,
      targetCalories,
      streakWeightPoints: streakWeightPoints.length,
      noStreakWeightPoints: noStreakWeightPoints.length,
      weightSlopeKgPerWeekDuringStreak: Math.round(streakSlope * 7 * 100) / 100,
      weightSlopeKgPerWeekWithoutStreak: Math.round(noStreakSlope * 7 * 100) / 100,
      slopeDiffKgPerWeek: Math.round((streakSlope - noStreakSlope) * 7 * 100) / 100
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu passa-efekt na wadze.' });
  }
});

const SEDENTARY_PERFORMANCE_LOOKBACK_DAYS = 90;
const MIN_WORKOUTS_PER_SEDENTARY_GROUP = 4;

// Runda 13, nowa funkcja 8: czas siedzenia (sedentary_minutes, Oura) TEGO SAMEGO dnia
// vs wydajność treningu wykonanego tego dnia (kcal/min, jak w
// workout-efficiency-insight - prostszy i szerzej dostępny proxy "wydajności" niż
// udział stref Z4+Z5 z recovery-insight, bo nie wymaga włączonych dodatkowych metryk
// strefowych w Health Auto Export). Podział wg mediany WŁASNEGO czasu siedzenia
// użytkownika w dniach treningowych.
router.get('/api/dashboard/sedentary-performance-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -SEDENTARY_PERFORMANCE_LOOKBACK_DAYS);

    const workoutRows = await db.all(
      `SELECT date, COALESCE(SUM(active_calories), 0) AS active_calories, COALESCE(SUM(duration_minutes), 0) AS duration_minutes
       FROM apple_health_workouts WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date HAVING duration_minutes >= 5 AND active_calories > 0`,
      [req.user.id, startDate, today]
    );
    const sedentaryRows = await db.all(
      `SELECT date, sedentary_minutes FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? AND sedentary_minutes IS NOT NULL`,
      [req.user.id, startDate, today]
    );
    const sedentaryByDate = new Map(sedentaryRows.map(r => [r.date, r.sedentary_minutes]));

    const combined = workoutRows
      .filter(r => sedentaryByDate.has(r.date))
      .map(r => ({
        date: r.date,
        sedentaryMinutes: sedentaryByDate.get(r.date),
        kcalPerMin: r.active_calories / r.duration_minutes
      }));

    if (combined.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP * 2) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workout_days',
        workoutDays: combined.length,
        minWorkoutDaysRequired: MIN_WORKOUTS_PER_SEDENTARY_GROUP * 2
      });
    }

    const medianSedentary = median(combined.map(r => r.sedentaryMinutes));
    const moreSitting = combined.filter(r => r.sedentaryMinutes >= medianSedentary);
    const lessSitting = combined.filter(r => r.sedentaryMinutes < medianSedentary);

    if (moreSitting.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP || lessSitting.length < MIN_WORKOUTS_PER_SEDENTARY_GROUP) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_workout_days_per_group',
        moreSittingWorkoutDays: moreSitting.length,
        lessSittingWorkoutDays: lessSitting.length,
        minWorkoutDaysRequired: MIN_WORKOUTS_PER_SEDENTARY_GROUP
      });
    }

    const avgOf = (arr) => Math.round((arr.reduce((s, x) => s + x.kcalPerMin, 0) / arr.length) * 10) / 10;
    const avgPerformanceMoreSitting = avgOf(moreSitting);
    const avgPerformanceLessSitting = avgOf(lessSitting);

    res.json({
      hasEnoughData: true,
      medianSedentaryMinutes: Math.round(medianSedentary),
      moreSittingWorkoutDays: moreSitting.length,
      lessSittingWorkoutDays: lessSitting.length,
      avgKcalPerMinMoreSitting: avgPerformanceMoreSitting,
      avgKcalPerMinLessSitting: avgPerformanceLessSitting,
      performanceDiffKcalPerMin: Math.round((avgPerformanceMoreSitting - avgPerformanceLessSitting) * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu siedzenie-wydajność treningu.' });
  }
});

// Insight: Hydratacja a jakość snu
// Sprawdza korelację między ilością wypitej wody (water_ml) a sleep_score.
// Analogiczny wzorzec do hydration-readiness-insight, ale mierzony względem snu
// (nie gotowości), bo readiness i sleep to różne wymiary regeneracji.
// Minimalna liczba dni z oboma polami: MIN_WATER_SLEEP_DAYS.
const MIN_WATER_SLEEP_DAYS = 14;
const WATER_SLEEP_LOOKBACK_DAYS = 60;

router.get('/api/dashboard/water-sleep-insight', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WATER_SLEEP_LOOKBACK_DAYS);

    const rows = await db.all(
      `SELECT date, water_ml, sleep_score, sleep_deep
       FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND water_ml IS NOT NULL AND water_ml > 0
         AND sleep_score IS NOT NULL AND sleep_score > 0`,
      [req.user.id, startDate, today]
    );

    if (rows.length < MIN_WATER_SLEEP_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days',
        totalDays: rows.length,
        minDaysRequired: MIN_WATER_SLEEP_DAYS
      });
    }

    // Podziel na grupy po medianie hydratacji: dobrze nawodnione vs słabiej nawodnione.
    const waterValues = rows.map(r => r.water_ml).sort((a, b) => a - b);
    const medianWater = waterValues[Math.floor(waterValues.length / 2)];

    const wellHydrated = rows.filter(r => r.water_ml >= medianWater);
    const lessHydrated = rows.filter(r => r.water_ml < medianWater);

    if (wellHydrated.length < 5 || lessHydrated.length < 5) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_days_per_group',
        totalDays: rows.length,
        minDaysRequired: MIN_WATER_SLEEP_DAYS
      });
    }

    const avgOf = (arr, key) => {
      const vals = arr.filter(x => x[key] != null).map(x => x[key]);
      return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };

    const avgSleepWell = avgOf(wellHydrated, 'sleep_score');
    const avgSleepLess = avgOf(lessHydrated, 'sleep_score');
    // sleep_deep w health_metrics jest w godzinach (sync.js: totalDeepSec / 3600)
    // — konwertujemy na minuty dla spójności z innymi insightami snu.
    const avgDeepWell = wellHydrated.filter(r => r.sleep_deep != null).length > 0
      ? Math.round(avgOf(wellHydrated, 'sleep_deep') * 60 * 10) / 10
      : null;
    const avgDeepLess = lessHydrated.filter(r => r.sleep_deep != null).length > 0
      ? Math.round(avgOf(lessHydrated, 'sleep_deep') * 60 * 10) / 10
      : null;

    res.json({
      hasEnoughData: true,
      totalDays: rows.length,
      medianWaterMl: Math.round(medianWater),
      wellHydratedDays: wellHydrated.length,
      lessHydratedDays: lessHydrated.length,
      avgWaterWell: Math.round(avgOf(wellHydrated, 'water_ml')),
      avgWaterLess: Math.round(avgOf(lessHydrated, 'water_ml')),
      avgSleepScoreWellHydrated: avgSleepWell,
      avgSleepScoreLessHydrated: avgSleepLess,
      sleepScoreDiff: avgSleepWell != null && avgSleepLess != null
        ? Math.round((avgSleepWell - avgSleepLess) * 10) / 10
        : null,
      avgSleepDeepWellHydrated: avgDeepWell,
      avgSleepDeepLessHydrated: avgDeepLess,
      sleepDeepDiff: avgDeepWell != null && avgDeepLess != null
        ? Math.round((avgDeepWell - avgDeepLess) * 10) / 10
        : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu hydratacja-sen.' });
  }
});

// ============================================================================
// Runda 23: Training Readiness + Training Plan Analysis
// Dane z własnej bazy (apple_health_workouts, health_metrics, users, settings)
// — bez zewnętrznych API. Pierwszy endpoint jest deterministyczny (brak AI,
// brak kosztu tokenów, odpowiedź natychmiastowa). Drugi używa Gemini z cache
// 7-dniowym w tabeli settings (key-value), żeby nie wysyłać promptu przy każdym
// wejściu na dashboard.
// ============================================================================

const READINESS_LOOKBACK_HRV_RHR = 30;   // dni do baseline HRV/RHR
const READINESS_RECENT_WORKOUTS_DAYS = 3; // okno "dużo treningów ostatnio"

// Wyznacza czytelny sygnał gotowości do treningu bez AI — na podstawie:
// 1) readiness_score z Oury (najlepszy sygnał, gdy dostępny)
// 2) HRV dziś vs 30d średnia (odchylenie procentowe)
// 3) RHR dziś vs 30d średnia
// 4) sleep_score Oury
// 5) liczba treningów w ostatnich READINESS_RECENT_WORKOUTS_DAYS dniach
//
// Logika: każdy sygnał głosuje "za" lub "przeciw" twardemu treningowi.
// readinessScore Oury (0-100) to gotowy composite — gdy go mamy, stanowi 60%
// wagi. Gdy brak (user bez Oury), fallback na własny composite z HRV/RHR/snu.
router.get('/api/dashboard/training-readiness', async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const baselineStart = shiftDate(today, -READINESS_LOOKBACK_HRV_RHR);

    const health = await db.get(
      `SELECT readiness_score, hrv, rhr, sleep_score, sleep_duration FROM health_metrics
       WHERE user_id = ? AND date = ?`,
      [req.user.id, today]
    );

    // Baseline HRV/RHR z ostatnich 30 dni (bez dzisiaj)
    const baselineRows = await db.all(
      `SELECT hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date < ?
         AND hrv IS NOT NULL AND hrv > 0 AND rhr IS NOT NULL AND rhr > 0`,
      [req.user.id, baselineStart, today]
    );
    const avgBaselineHrv = baselineRows.length > 0
      ? baselineRows.reduce((s, r) => s + r.hrv, 0) / baselineRows.length
      : null;
    const avgBaselineRhr = baselineRows.length > 0
      ? baselineRows.reduce((s, r) => s + r.rhr, 0) / baselineRows.length
      : null;

    // Treningi z ostatnich READINESS_RECENT_WORKOUTS_DAYS dni
    const recentWorkoutRows = await db.all(
      `SELECT date, SUM(duration_minutes) AS total_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date < ?
       GROUP BY date HAVING total_minutes >= 20`,
      [req.user.id, shiftDate(today, -READINESS_RECENT_WORKOUTS_DAYS), today]
    );
    const recentWorkoutDays = recentWorkoutRows.length;

    // Treningi z ostatnich 7 dni (obciążenie tygodniowe)
    const weekWorkoutRows = await db.all(
      `SELECT COUNT(DISTINCT date) AS cnt FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date < ?`,
      [req.user.id, shiftDate(today, -7), today]
    );
    const weekWorkoutDays = weekWorkoutRows[0]?.cnt || 0;

    // Budujemy composite score 0-100:
    // Baza: jeśli mamy readiness_score Oury → weight 60%; reszta 40%.
    // Bez Oury: HRV 40%, RHR 30%, sen 30%.
    const signals = [];
    let compositeScore = 50; // neutral start

    if (health?.readiness_score != null && health.readiness_score > 0) {
      // Oura readiness: 0-100, mapujemy bezpośrednio jako 60% wagi
      compositeScore = health.readiness_score * 0.6 + 20; // skala 0-80 → 20-80 po przesunięciu
      signals.push({
        label: 'Gotowość Oura',
        value: health.readiness_score,
        unit: 'pkt',
        status: health.readiness_score >= 70 ? 'good' : health.readiness_score >= 50 ? 'ok' : 'low'
      });
    }

    // HRV vs baseline
    if (health?.hrv != null && health.hrv > 0 && avgBaselineHrv != null) {
      const hrvPct = (health.hrv / avgBaselineHrv - 1) * 100;
      const hrvScore = health.readiness_score != null
        ? hrvPct * 0.2  // mniejsza waga gdy mamy Ourę
        : hrvPct * 0.4;
      compositeScore += hrvScore;
      signals.push({
        label: 'HRV dziś',
        value: Math.round(health.hrv),
        unit: 'ms',
        baseline: Math.round(avgBaselineHrv),
        diff: Math.round(hrvPct),
        status: hrvPct >= 5 ? 'good' : hrvPct >= -5 ? 'ok' : 'low'
      });
    }

    // RHR vs baseline
    if (health?.rhr != null && health.rhr > 0 && avgBaselineRhr != null) {
      const rhrPct = (avgBaselineRhr / health.rhr - 1) * 100; // wyższy RHR = gorszy → odwracamy
      const rhrScore = health.readiness_score != null
        ? rhrPct * 0.1
        : rhrPct * 0.3;
      compositeScore += rhrScore;
      signals.push({
        label: 'Tętno spoczynkowe',
        value: Math.round(health.rhr),
        unit: 'bpm',
        baseline: Math.round(avgBaselineRhr),
        diff: Math.round((health.rhr - avgBaselineRhr) * 10) / 10,
        status: health.rhr <= avgBaselineRhr + 2 ? 'good' : health.rhr <= avgBaselineRhr + 5 ? 'ok' : 'low'
      });
    }

    // Sen
    if (health?.sleep_score != null && health.sleep_score > 0) {
      const sleepScore = health.readiness_score != null ? 0 : (health.sleep_score - 50) * 0.3;
      compositeScore += sleepScore;
      signals.push({
        label: 'Jakość snu',
        value: health.sleep_score,
        unit: 'pkt',
        status: health.sleep_score >= 75 ? 'good' : health.sleep_score >= 60 ? 'ok' : 'low'
      });
    }

    // Kara za przeciążenie treningami w ostatnich 3 dniach
    const overloadPenalty = Math.min(recentWorkoutDays * 8, 20);
    compositeScore -= overloadPenalty;
    if (recentWorkoutDays >= 2) {
      signals.push({
        label: `Treningi (ostatnie ${READINESS_RECENT_WORKOUTS_DAYS} dni)`,
        value: recentWorkoutDays,
        unit: 'dni',
        status: recentWorkoutDays >= 3 ? 'low' : recentWorkoutDays >= 2 ? 'ok' : 'good'
      });
    }

    compositeScore = Math.max(0, Math.min(100, compositeScore));

    let status, label, emoji, advice;
    if (compositeScore >= 67) {
      status = 'TRAIN_HARD';
      label = 'Trenuj mocno';
      emoji = '🟢';
      advice = 'Twoje sygnały wskazują na dobrą gotowość. Dobry dzień na intensywny trening.';
    } else if (compositeScore >= 34) {
      status = 'TRAIN_LIGHT';
      label = 'Lekki trening';
      emoji = '🟡';
      advice = 'Umiarkowana gotowość. Sprawdzi się lżejszy trening lub technika zamiast maksymalnego wysiłku.';
    } else {
      status = 'RECOVER';
      label = 'Odpoczynek';
      emoji = '🔴';
      advice = 'Niskie sygnały regeneracji. Rozważ dzień odpoczynku lub aktywną regenerację (spacer, stretching).';
    }

    const hasSignificantData = health != null && (
      health.readiness_score != null || health.hrv != null || health.sleep_score != null
    );

    res.json({
      hasEnoughData: hasSignificantData,
      status,
      label,
      emoji,
      compositeScore: Math.round(compositeScore),
      advice,
      signals,
      weekWorkoutDays,
      recentWorkoutDays
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania gotowości do treningu.' });
  }
});

const TRAINING_PLAN_LOOKBACK_WEEKS = 4;
const TRAINING_PLAN_CACHE_DAYS = 7;

// Normalizuje overallRating do liczby 1-10 — stare cache'owane wartości mogły
// przechowywać string ("good"/"needs_improvement"/"poor") z poprzedniej wersji promptu.
function sanitizeTrainingRating(obj) {
  if (!obj || obj.overallRating == null) return obj;
  const stringMap = { good: 8, needs_improvement: 5, poor: 2 };
  if (typeof obj.overallRating === 'string') {
    obj.overallRating = stringMap[obj.overallRating] ?? 5;
  } else {
    const n = Math.round(Number(obj.overallRating));
    obj.overallRating = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : null;
  }
  return obj;
}

// AI analiza planu treningowego — ocenia czy historia treningów użytkownika
// jest dopasowana do jego celu sylwetki i sugeruje co dodać. Cache 7 dni
// w settings (klucz training_plan_insight_json / training_plan_insight_at),
// wymuszenie odświeżenia: ?refresh=1.
//
// Dane wejściowe dla AI: 4 tygodnie treningów (typ/czas), cel sylwetki
// (body_goal_text, target_weight_kg, target_body_fat_pct), sygnały regeneracji
// (HRV, RHR, readiness — 7d avg), aktualny skład ciała (waga, % tłuszczu,
// masa mięśniowa). Odpowiedź: JSON z oceną, brakującymi elementami i sugestiami.
router.get('/api/dashboard/training-plan-insight', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';

    // Cache z settings
    const cachedJsonRow = await db.get(
      `SELECT value FROM settings WHERE user_id = ? AND key = 'training_plan_insight_json'`,
      [req.user.id]
    );
    const cachedAtRow = await db.get(
      `SELECT value FROM settings WHERE user_id = ? AND key = 'training_plan_insight_at'`,
      [req.user.id]
    );

    const cachedAt = cachedAtRow ? new Date(cachedAtRow.value).getTime() : 0;
    const cacheAgeDays = (Date.now() - cachedAt) / (1000 * 60 * 60 * 24);
    const isCacheFresh = !!cachedJsonRow && cacheAgeDays < TRAINING_PLAN_CACHE_DAYS;

    if (isCacheFresh && !forceRefresh) {
      let parsed;
      try { parsed = JSON.parse(cachedJsonRow.value); } catch (e) { parsed = null; }
      if (parsed) {
        // Sanityzacja overallRating - stary cache mógł mieć string ("good"/"needs_improvement"/"poor")
        parsed = sanitizeTrainingRating(parsed);
        return res.json({ hasEnoughData: true, cached: true, generatedAt: cachedAtRow.value, ...parsed });
      }
    }

    // Zbieramy dane
    const today = resolveQueryDate(req);
    const lookbackStart = shiftDate(today, -(TRAINING_PLAN_LOOKBACK_WEEKS * 7));

    // Treningi z ostatnich 4 tygodni
    const workoutRows = await db.all(
      `SELECT date, workout_type, duration_minutes, active_calories
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
       ORDER BY date DESC`,
      [req.user.id, lookbackStart, today]
    );

    // Agregat per typ treningu
    const byType = {};
    workoutRows.forEach(w => {
      const t = (w.workout_type || 'Nieznany').trim();
      if (!byType[t]) byType[t] = { count: 0, totalMinutes: 0, totalCalories: 0 };
      byType[t].count++;
      byType[t].totalMinutes += w.duration_minutes || 0;
      byType[t].totalCalories += w.active_calories || 0;
    });

    // Cel sylwetki i dane ciała
    const userRow = await db.get(
      `SELECT body_goal_text FROM users WHERE id = ?`,
      [req.user.id]
    );
    const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
    const targetBodyFatPct = settings.target_body_fat_pct ? parseFloat(settings.target_body_fat_pct) : null;
    const targetWeightKg = settings.target_weight_kg ? parseFloat(settings.target_weight_kg) : null;

    // Aktualny skład ciała (ostatni pomiar)
    const latestBody = await db.get(
      `SELECT weight, fat_ratio, muscle_mass FROM health_metrics
       WHERE user_id = ? AND date <= ? AND (weight IS NOT NULL OR fat_ratio IS NOT NULL)
       ORDER BY date DESC LIMIT 1`,
      [req.user.id, today]
    );

    // 7d average regeneracji
    const recoveryRows = await db.all(
      `SELECT hrv, rhr, readiness_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND (hrv IS NOT NULL OR rhr IS NOT NULL OR readiness_score IS NOT NULL)`,
      [req.user.id, shiftDate(today, -7), today]
    );
    const avgOf7d = (key) => {
      const vals = recoveryRows.map(r => r[key]).filter(v => v != null && v > 0);
      return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null;
    };
    const avg7dHrv = avgOf7d('hrv');
    const avg7dRhr = avgOf7d('rhr');
    const avg7dReadiness = avgOf7d('readiness_score');

    // Sprawdzamy dostęp do AI
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;
    const forceCustomKeyOnly = req.user.role !== 'admin';
    const canUseAI = userApiKey || (!forceCustomKeyOnly && (genAI || process.env.GEMINI_API_KEY));
    const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
    const language = langRow ? langRow.value : 'pl';

    if (!canUseAI) {
      return res.json({ hasEnoughData: false, reason: 'no_ai_key' });
    }

    // Budujemy opis treningów dla promptu
    const workoutSummaryLines = Object.entries(byType).map(([type, stats]) => {
      const avgMin = stats.count > 0 ? Math.round(stats.totalMinutes / stats.count) : 0;
      if (language === 'en') {
        return `- ${type}: ${stats.count}x, avg ${avgMin} min/session${stats.totalCalories > 0 ? `, total ~${stats.totalCalories} kcal` : ''}`;
      }
      return `- ${type}: ${stats.count}x, śr. ${avgMin} min/sesja${stats.totalCalories > 0 ? `, łącznie ~${stats.totalCalories} kcal` : ''}`;
    });
    const totalWorkouts = workoutRows.length;
    const avgPerWeek = Math.round(totalWorkouts / TRAINING_PLAN_LOOKBACK_WEEKS * 10) / 10;

    const bodyLines = [];
    if (latestBody?.weight) bodyLines.push(language === 'en' ? `Weight: ${latestBody.weight} kg` : `Waga: ${latestBody.weight} kg`);
    if (latestBody?.fat_ratio) bodyLines.push(language === 'en' ? `Body fat: ${Math.round(latestBody.fat_ratio * 10) / 10}%` : `Tkanka tłuszczowa: ${Math.round(latestBody.fat_ratio * 10) / 10}%`);
    if (latestBody?.muscle_mass) bodyLines.push(language === 'en' ? `Muscle mass: ${Math.round(latestBody.muscle_mass * 10) / 10} kg` : `Masa mięśniowa: ${Math.round(latestBody.muscle_mass * 10) / 10} kg`);

    const goalLines = [];
    if (userRow?.body_goal_text) goalLines.push(language === 'en' ? `Body goal: ${userRow.body_goal_text}` : `Cel sylwetki: ${userRow.body_goal_text}`);
    if (targetWeightKg) goalLines.push(language === 'en' ? `Weight target: ${targetWeightKg} kg` : `Cel wagowy: ${targetWeightKg} kg`);
    if (targetBodyFatPct) goalLines.push(language === 'en' ? `Target % body fat: ${targetBodyFatPct}%` : `Docelowy % tkanki tłuszczowej: ${targetBodyFatPct}%`);

    const recoveryLines = [];
    if (avg7dReadiness != null) recoveryLines.push(language === 'en' ? `Oura Readiness (7d avg): ${avg7dReadiness} pts` : `Gotowość Oura (7d śr.): ${avg7dReadiness} pkt`);
    if (avg7dHrv != null) recoveryLines.push(language === 'en' ? `HRV (7d avg): ${avg7dHrv} ms` : `HRV (7d śr.): ${avg7dHrv} ms`);
    if (avg7dRhr != null) recoveryLines.push(language === 'en' ? `Resting HR (7d avg): ${avg7dRhr} bpm` : `Tętno spoczynkowe (7d śr.): ${avg7dRhr} bpm`);

    let prompt = '';
    if (language === 'en') {
      prompt = `You are an experienced personal trainer specializing in body recomposition and fat loss. Analyze the following data and evaluate the user's training plan.

=== GOAL ===
${goalLines.length > 0 ? goalLines.join('\n') : 'No goal data'}

=== BODY COMPOSITION ===
${bodyLines.length > 0 ? bodyLines.join('\n') : 'No data'}

=== WORKOUTS (last ${TRAINING_PLAN_LOOKBACK_WEEKS} weeks) ===
Total: ${totalWorkouts} workouts (avg ${avgPerWeek}/week)
${workoutSummaryLines.length > 0 ? workoutSummaryLines.join('\n') : '- No workouts in this period'}

=== RECOVERY SIGNALS ===
${recoveryLines.length > 0 ? recoveryLines.join('\n') : 'No recovery data'}

Respond EXCLUSIVELY in JSON format (no markdown, no explanation outside JSON):
{
  "assessment": "Short assessment of the current plan (1-2 sentences in English)",
  "missing": ["Element1 that is missing", "Element2"],
  "suggestions": [
    {"title": "Suggestion Title", "description": "Specific description of what to do and why (in English)"},
    {"title": "Title", "description": "Description"}
  ],
  "overallRating": 7
}

overallRating is an integer from 1 to 10 (1=very bad plan, 10=ideal). DO NOT use strings like "good" - only a number.
Be specific and practical. Max 3 suggestions. Respond only in English.`;
    } else {
      prompt = `Jesteś doświadczonym trenerem personalnym specjalizującym się w rekomozycji ciała i redukcji tkanki tłuszczowej. Przeanalizuj poniższe dane i oceń plan treningowy użytkownika.

=== CEL ===
${goalLines.length > 0 ? goalLines.join('\n') : 'Brak danych o celu'}

=== SKŁAD CIAŁA ===
${bodyLines.length > 0 ? bodyLines.join('\n') : 'Brak danych'}

=== TRENINGI (ostatnie ${TRAINING_PLAN_LOOKBACK_WEEKS} tygodnie) ===
Łącznie: ${totalWorkouts} treningów (śr. ${avgPerWeek}/tydzień)
${workoutSummaryLines.length > 0 ? workoutSummaryLines.join('\n') : '- Brak treningów w tym okresie'}

=== SYGNAŁY REGENERACJI ===
${recoveryLines.length > 0 ? recoveryLines.join('\n') : 'Brak danych regeneracji'}

Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown, bez objaśnień poza JSON):
{
  "assessment": "Krótka ocena obecnego planu (1-2 zdania po polsku)",
  "missing": ["Element1 którego brakuje", "Element2"],
  "suggestions": [
    {"title": "Tytuł sugestii", "description": "Konkretny opis co zrobić i dlaczego (po polsku)"},
    {"title": "Tytuł", "description": "Opis"}
  ],
  "overallRating": 7
}

overallRating to liczba całkowita od 1 do 10 (1=bardzo zły plan, 10=idealny). NIE używaj stringów jak "good" - tylko liczba.
Bądź konkretny i praktyczny. Maks. 3 sugestie. Odpowiadaj tylko po polsku.`;
    }

    let insightJson = null;
    try {
      const rawText = await generateContentWithFallback(prompt, false, null, userApiKey, forceCustomKeyOnly);
      // Wycinamy JSON z odpowiedzi (AI może dodać markdown ```json ... ```)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        insightJson = JSON.parse(jsonMatch[0]);
      }
    } catch (aiErr) {
      console.error('[TRAINING PLAN] Błąd Gemini:', aiErr);
      return res.status(500).json({ error: 'Błąd generowania analizy AI.' });
    }

    if (!insightJson) {
      return res.status(500).json({ error: 'Nieprawidłowa odpowiedź AI.' });
    }

    // Normalizacja overallRating (AI może zwrócić string mimo instrukcji)
    insightJson = sanitizeTrainingRating(insightJson);

    // Zapisz cache
    const nowStr = new Date().toISOString();
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'training_plan_insight_json', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [req.user.id, JSON.stringify(insightJson)]
    );
    await db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'training_plan_insight_at', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [req.user.id, nowStr]
    );

    res.json({
      hasEnoughData: true,
      cached: false,
      generatedAt: nowStr,
      ...insightJson
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania analizy planu treningowego.' });
  }
});

// =============================================================================
// INSIGHTY TRENINGOWE (Runda 25): Oura + Apple Watch cross-device analytics
// =============================================================================

// Próg "dobrego" snu - taki sam jak w sleep-insight, tu lokalnie.
const SLEEP_SCORE_GOOD_THRESHOLD = 75;
// Próg "słabego" snu (dla grupowania: słaby vs dobry)
const SLEEP_SCORE_POOR_THRESHOLD = 65;
// Minimalna liczba dni w każdej grupie
const WORKOUT_INSIGHT_MIN_DAYS = 5;
// Lookback dla insightów treningowych (dni)
const WORKOUT_INSIGHT_LOOKBACK = 60;
// Próg "ciężkiego" treningu w minutach
const HEAVY_WORKOUT_MIN_MINUTES = 30;
// Próg "wysokiej gotowości" Oura
const HIGH_READINESS_THRESHOLD = 70;
// Próg "niskiej gotowości" Oura
const LOW_READINESS_THRESHOLD = 55;

// Helper: kcal/min z rekordu treningu (zwraca null jeśli brak danych)
function kcalPerMin(row) {
  if (!row || !row.active_calories || !row.duration_minutes || row.duration_minutes < 5) return null;
  return Math.round((row.active_calories / row.duration_minutes) * 10) / 10;
}

// Helper: średnia z tablicy liczb (pomija null/undefined)
function avgNonNull(arr) {
  const vals = arr.filter(v => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10;
}

// INSIGHT: SEN OURA → WYDAJNOŚĆ TRENINGU APPLE WATCH (dzień następny)
// Pytanie: czy noc z dobrym score'em snu przekłada się na lepszy trening dnia kolejnego?
router.get('/api/dashboard/sleep-workout-performance-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Pobierz wszystkie dni z danymi snu
    const sleepRows = await db.all(
      `SELECT date, sleep_score FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND sleep_score IS NOT NULL AND sleep_score > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (sleepRows.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_sleep_days', minRequired: WORKOUT_INSIGHT_MIN_DAYS * 2, available: sleepRows.length });
    }

    // Dla każdego dnia ze snem sprawdź trening dzień później
    const goodSleepPerf = [];
    const poorSleepPerf = [];

    for (const sleepRow of sleepRows) {
      const nextDay = shiftDate(sleepRow.date, 1);
      if (nextDay > today) continue;

      const workouts = await db.all(
        `SELECT active_calories, duration_minutes FROM apple_health_workouts
         WHERE user_id = ? AND date = ? AND duration_minutes >= 10 AND active_calories > 0`,
        [req.user.id, nextDay]
      );
      if (workouts.length === 0) continue;

      // Weź najdłuższy trening tego dnia
      const best = workouts.sort((a, b) => b.duration_minutes - a.duration_minutes)[0];
      const kpm = kcalPerMin(best);
      if (kpm == null) continue;

      if (sleepRow.sleep_score >= SLEEP_SCORE_GOOD_THRESHOLD) {
        goodSleepPerf.push(kpm);
      } else if (sleepRow.sleep_score <= SLEEP_SCORE_POOR_THRESHOLD) {
        poorSleepPerf.push(kpm);
      }
    }

    if (goodSleepPerf.length < WORKOUT_INSIGHT_MIN_DAYS || poorSleepPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        goodSleepDays: goodSleepPerf.length,
        poorSleepDays: poorSleepPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgGood = avgNonNull(goodSleepPerf);
    const avgPoor = avgNonNull(poorSleepPerf);
    const diff = avgGood != null && avgPoor != null ? Math.round((avgGood - avgPoor) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      goodSleepThreshold: SLEEP_SCORE_GOOD_THRESHOLD,
      poorSleepThreshold: SLEEP_SCORE_POOR_THRESHOLD,
      avgKcalPerMinAfterGoodSleep: avgGood,
      avgKcalPerMinAfterPoorSleep: avgPoor,
      diff,
      goodSleepDays: goodSleepPerf.length,
      poorSleepDays: poorSleepPerf.length,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu sen-trening.' });
  }
});

// INSIGHT: GOTOWOŚĆ OURA → WYDAJNOŚĆ TRENINGU APPLE WATCH (ten sam dzień)
// Pytanie: czy score gotowości Oury przekłada się na realną wydajność treningu?
router.get('/api/dashboard/readiness-workout-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Dni z gotowością Oury
    const readinessRows = await db.all(
      `SELECT hm.date, hm.readiness_score
       FROM health_metrics hm
       WHERE hm.user_id = ? AND hm.date >= ? AND hm.date <= ?
         AND hm.readiness_score IS NOT NULL AND hm.readiness_score > 0
       ORDER BY hm.date ASC`,
      [req.user.id, startDate, today]
    );

    if (readinessRows.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_readiness_days', available: readinessRows.length });
    }

    const highReadinessPerf = [];
    const lowReadinessPerf = [];

    for (const rRow of readinessRows) {
      const workouts = await db.all(
        `SELECT active_calories, duration_minutes FROM apple_health_workouts
         WHERE user_id = ? AND date = ? AND duration_minutes >= 10 AND active_calories > 0`,
        [req.user.id, rRow.date]
      );
      if (workouts.length === 0) continue;

      const best = workouts.sort((a, b) => b.duration_minutes - a.duration_minutes)[0];
      const kpm = kcalPerMin(best);
      if (kpm == null) continue;

      if (rRow.readiness_score >= HIGH_READINESS_THRESHOLD) {
        highReadinessPerf.push(kpm);
      } else if (rRow.readiness_score <= LOW_READINESS_THRESHOLD) {
        lowReadinessPerf.push(kpm);
      }
    }

    if (highReadinessPerf.length < WORKOUT_INSIGHT_MIN_DAYS || lowReadinessPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        highReadinessDays: highReadinessPerf.length,
        lowReadinessDays: lowReadinessPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgHigh = avgNonNull(highReadinessPerf);
    const avgLow = avgNonNull(lowReadinessPerf);
    const diff = avgHigh != null && avgLow != null ? Math.round((avgHigh - avgLow) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      highReadinessThreshold: HIGH_READINESS_THRESHOLD,
      lowReadinessThreshold: LOW_READINESS_THRESHOLD,
      avgKcalPerMinHighReadiness: avgHigh,
      avgKcalPerMinLowReadiness: avgLow,
      diff,
      highReadinessDays: highReadinessPerf.length,
      lowReadinessDays: lowReadinessPerf.length,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu gotowość-trening.' });
  }
});

// INSIGHT: POLARYZACJA STREF TĘTNA 80/20 (Apple Watch only)
// Pytanie: czy treningi są odpowiednio spolaryzowane (80% aerobowe / 20% intensywne)?
// Teoria 80/20: optymalny podział dla wytrzymałości i regeneracji.
router.get('/api/dashboard/hr-polarization-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    const workoutRows = await db.all(
      `SELECT zone1_minutes, zone2_minutes, zone3_minutes, zone4_minutes, zone5_minutes,
              duration_minutes
       FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= 10
         AND (zone1_minutes IS NOT NULL OR zone2_minutes IS NOT NULL
              OR zone3_minutes IS NOT NULL OR zone4_minutes IS NOT NULL OR zone5_minutes IS NOT NULL)`,
      [req.user.id, startDate, today]
    );

    if (workoutRows.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_workouts', available: workoutRows.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS });
    }

    let totalZ1 = 0, totalZ2 = 0, totalZ3 = 0, totalZ4 = 0, totalZ5 = 0;
    for (const w of workoutRows) {
      totalZ1 += w.zone1_minutes ?? 0;
      totalZ2 += w.zone2_minutes ?? 0;
      totalZ3 += w.zone3_minutes ?? 0;
      totalZ4 += w.zone4_minutes ?? 0;
      totalZ5 += w.zone5_minutes ?? 0;
    }

    const totalZone = totalZ1 + totalZ2 + totalZ3 + totalZ4 + totalZ5;
    if (totalZone < 60) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_zone_data', totalMinutes: totalZone });
    }

    const pct = (v) => Math.round(v / totalZone * 100);
    const easyPct = pct(totalZ1 + totalZ2);   // Strefy 1-2 = łatwy wysiłek aerobowy
    const hardPct = pct(totalZ4 + totalZ5);   // Strefy 4-5 = intensywny/anaerobowy
    const midPct  = pct(totalZ3);             // Strefa 3 = "szara strefa" (unika się w 80/20)

    // Idealny podział: ≥80% łatwy, ≤10% środkowy, ≥15% intensywny
    const isWellPolarized = easyPct >= 75 && hardPct >= 10 && midPct <= 15;
    const tooMuchGrayZone = midPct > 25;

    res.json({
      hasEnoughData: true,
      totalZoneMinutes: Math.round(totalZone),
      workoutsAnalyzed: workoutRows.length,
      zone1Pct: pct(totalZ1),
      zone2Pct: pct(totalZ2),
      zone3Pct: midPct,
      zone4Pct: pct(totalZ4),
      zone5Pct: pct(totalZ5),
      easyPct,
      hardPct,
      midPct,
      isWellPolarized,
      tooMuchGrayZone,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu polaryzacji stref.' });
  }
});

// INSIGHT: CIĘŻKI TRENING APPLE WATCH → HRV/RHR OURA DZIEń +1/+2
// Pytanie: jak długo po intensywnym treningu HRV/RHR są zaburzone?
router.get('/api/dashboard/workout-recovery-hrv-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Znajdź ciężkie treningi (≥30 min)
    const heavyWorkouts = await db.all(
      `SELECT DISTINCT date FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= ? AND active_calories > 100`,
      [req.user.id, startDate, shiftDate(today, -2), HEAVY_WORKOUT_MIN_MINUTES]
    );

    if (heavyWorkouts.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_heavy_workouts', available: heavyWorkouts.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS });
    }

    // Dni bazowe (bez treningu i nie następny/pojutrze po ciężkim treningu)
    const heavyDates = new Set(heavyWorkouts.map(r => r.date));
    const post1Hrv = [], post1Rhr = [];
    const post2Hrv = [], post2Rhr = [];

    for (const w of heavyWorkouts) {
      const day1 = shiftDate(w.date, 1);
      const day2 = shiftDate(w.date, 2);
      if (day1 > today || day2 > today) continue;

      const m1 = await db.get(
        `SELECT hrv, rhr FROM health_metrics WHERE user_id = ? AND date = ? AND (hrv IS NOT NULL OR rhr IS NOT NULL)`,
        [req.user.id, day1]
      );
      if (m1) {
        if (m1.hrv > 0) post1Hrv.push(m1.hrv);
        if (m1.rhr > 0) post1Rhr.push(m1.rhr);
      }

      const m2 = await db.get(
        `SELECT hrv, rhr FROM health_metrics WHERE user_id = ? AND date = ? AND (hrv IS NOT NULL OR rhr IS NOT NULL)`,
        [req.user.id, day2]
      );
      if (m2) {
        if (m2.hrv > 0) post2Hrv.push(m2.hrv);
        if (m2.rhr > 0) post2Rhr.push(m2.rhr);
      }
    }

    // Baseline HRV/RHR (dni bez ciężkiego treningu i bez dnia po ciężkim treningu)
    const baselineRows = await db.all(
      `SELECT date, hrv, rhr FROM health_metrics
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND (hrv > 0 OR rhr > 0)`,
      [req.user.id, startDate, today]
    );

    const baselineHrv = [], baselineRhr = [];
    for (const b of baselineRows) {
      const isPostHeavy = heavyDates.has(shiftDate(b.date, -1)) || heavyDates.has(shiftDate(b.date, -2)) || heavyDates.has(b.date);
      if (!isPostHeavy) {
        if (b.hrv > 0) baselineHrv.push(b.hrv);
        if (b.rhr > 0) baselineRhr.push(b.rhr);
      }
    }

    if (post1Hrv.length < 3 && post1Rhr.length < 3) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_recovery_data' });
    }

    const avgPost1Hrv = avgNonNull(post1Hrv);
    const avgPost2Hrv = avgNonNull(post2Hrv);
    const avgBaseHrv  = avgNonNull(baselineHrv);
    const avgPost1Rhr = avgNonNull(post1Rhr);
    const avgPost2Rhr = avgNonNull(post2Rhr);
    const avgBaseRhr  = avgNonNull(baselineRhr);

    res.json({
      hasEnoughData: true,
      heavyWorkoutDays: heavyWorkouts.length,
      heavyWorkoutMinMinutes: HEAVY_WORKOUT_MIN_MINUTES,
      avgHrvDay1: avgPost1Hrv,
      avgHrvDay2: avgPost2Hrv,
      avgHrvBaseline: avgBaseHrv,
      avgRhrDay1: avgPost1Rhr,
      avgRhrDay2: avgPost2Rhr,
      avgRhrBaseline: avgBaseRhr,
      hrvDiff1: avgPost1Hrv != null && avgBaseHrv != null ? Math.round((avgPost1Hrv - avgBaseHrv) * 10) / 10 : null,
      hrvDiff2: avgPost2Hrv != null && avgBaseHrv != null ? Math.round((avgPost2Hrv - avgBaseHrv) * 10) / 10 : null,
      rhrDiff1: avgPost1Rhr != null && avgBaseRhr != null ? Math.round((avgPost1Rhr - avgBaseRhr) * 10) / 10 : null,
      rhrDiff2: avgPost2Rhr != null && avgBaseRhr != null ? Math.round((avgPost2Rhr - avgBaseRhr) * 10) / 10 : null,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu regeneracja HRV po treningu.' });
  }
});

// INSIGHT: PRZERWA MIĘDZY TRENINGAMI → WYDAJNOŚĆ (Apple Watch only)
// Pytanie: czy więcej dni odpoczynku przekłada się na lepszą wydajność treningu?
router.get('/api/dashboard/workout-rest-performance-insight', requireAuth, async (req, res) => {
  try {
    const today = resolveQueryDate(req);
    const startDate = shiftDate(today, -WORKOUT_INSIGHT_LOOKBACK);

    // Pobierz wszystkie dni treningowe posortowane
    const workoutDays = await db.all(
      `SELECT date, active_calories, duration_minutes FROM apple_health_workouts
       WHERE user_id = ? AND date >= ? AND date <= ?
         AND duration_minutes >= 10 AND active_calories > 0
       ORDER BY date ASC`,
      [req.user.id, startDate, today]
    );

    if (workoutDays.length < WORKOUT_INSIGHT_MIN_DAYS * 2) {
      return res.json({ hasEnoughData: false, reason: 'not_enough_workouts', available: workoutDays.length, minRequired: WORKOUT_INSIGHT_MIN_DAYS * 2 });
    }

    // Dla każdego treningu (poza pierwszym) oblicz ile dni minęło od poprzedniego
    const fewRestPerf = [];   // 0-1 dni przerwy
    const moreRestPerf = [];  // 2+ dni przerwy

    // Grupuj po datach (jeden wynik na dzień - najdłuższy trening)
    const byDate = {};
    for (const w of workoutDays) {
      if (!byDate[w.date] || w.duration_minutes > byDate[w.date].duration_minutes) {
        byDate[w.date] = w;
      }
    }
    const sortedDates = Object.keys(byDate).sort();

    for (let i = 1; i < sortedDates.length; i++) {
      const curr = byDate[sortedDates[i]];
      const prev = byDate[sortedDates[i - 1]];
      const kpm = kcalPerMin(curr);
      if (kpm == null) continue;

      // Ile dni między poprzednim treningiem a tym
      const [py, pm, pd] = prev.date.split('-').map(Number);
      const [cy, cm, cd] = curr.date.split('-').map(Number);
      const daysDiff = Math.round(
        (Date.UTC(cy, cm - 1, cd) - Date.UTC(py, pm - 1, pd)) / 86400000
      ) - 1; // -1 bo liczymy dni MIĘDZY, nie od dnia treningu

      if (daysDiff <= 1) {
        fewRestPerf.push(kpm);
      } else {
        moreRestPerf.push(kpm);
      }
    }

    if (fewRestPerf.length < WORKOUT_INSIGHT_MIN_DAYS || moreRestPerf.length < WORKOUT_INSIGHT_MIN_DAYS) {
      return res.json({
        hasEnoughData: false,
        reason: 'not_enough_groups',
        fewRestDays: fewRestPerf.length,
        moreRestDays: moreRestPerf.length,
        minRequired: WORKOUT_INSIGHT_MIN_DAYS
      });
    }

    const avgFew  = avgNonNull(fewRestPerf);
    const avgMore = avgNonNull(moreRestPerf);
    const diff = avgMore != null && avgFew != null ? Math.round((avgMore - avgFew) * 10) / 10 : null;

    res.json({
      hasEnoughData: true,
      avgKcalPerMinFewRest: avgFew,
      avgKcalPerMinMoreRest: avgMore,
      diff,
      fewRestDays: fewRestPerf.length,
      moreRestDays: moreRestPerf.length,
      restThreshold: 2,
      lookbackDays: WORKOUT_INSIGHT_LOOKBACK
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania insightu przerwa-wydajność.' });
  }
});

module.exports = router;
