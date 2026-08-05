const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { aiRateLimiter } = require('../middleware/rateLimit');
const { getLocalDateString } = require('../utils/dates');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { generateContentWithFallback } = require('../config');
const { getTargetCalories, getBmr, getTargetWaterMl } = require('../utils/defaultSettings');
const { getDayEventsInRange, formatDayEventsForPrompt } = require('../utils/dayEvents');
const { decrypt } = require('../utils/encryption');
const { getWeatherAndTimeContext, getUserLocationOverride } = require('../utils/weatherContext');
const {
  MAX_CHAT_MESSAGE_LENGTH,
  CHAT_DEFAULT_LOOKBACK_DAYS,
  CHAT_EXTENDED_LOOKBACK_DAYS,
  messageNeedsLongHistory,
  buildWeeklyTrendSummary
} = require('../utils/chatHistory');

router.post('/api/chat', requireAuth, aiRateLimiter, async (req, res) => {
  const { message, date, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Treść wiadomości jest wymagana.' });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Wiadomość jest zbyt długa (maks. ${MAX_CHAT_MESSAGE_LENGTH} znaków).` });
  }

  const queryDate = date || getLocalDateString();

  try {
    // Pobierz cele użytkownika
    const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const settings = {};
    settingsRows.forEach(r => {
      settings[r.key] = Number(r.value);
    });

    const bmr = getBmr(settings);

    // Pobierz dzisiejsze dane zdrowotne
    const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]) || getDefaultHealthMetrics();

    // Tylko kolumny liczbowe potrzebne do bilansu kalorycznego czatu - bez
    // image_base64/analysis_json, które tu nigdy nie są używane (patrz forEach niżej).
    const mealRows = await db.all(`SELECT calories, protein, carbs, fat FROM meals WHERE user_id = ? AND date = ?`, [req.user.id, queryDate]);
    let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    mealRows.forEach(r => {
      totalEaten.calories += r.calories;
      totalEaten.protein += r.protein;
      totalEaten.carbs += r.carbs;
      totalEaten.fat += r.fat;
    });

    const activeCalories = health.active_calories || 0;
    const totalBurned = health.total_calories_burned || (bmr + activeCalories);
    const netCalories = totalEaten.calories - totalBurned;

    // Treningi z Apple Health (apple_health_workouts) dla wybranego dnia - wcześniej
    // czat w ogóle nie widział tych danych, mimo że są zbierane i wykorzystywane na
    // Dashboardzie (patrz routes/dashboard.js). Potrzebne, żeby AI mogło odpowiadać
    // na pytania o trening/progres siłowy w oparciu o realną aktywność użytkownika,
    // a nie zgadywać "w ciemno".
    const todayWorkoutRows = await db.all(
      `SELECT workout_type, duration_minutes, active_calories, avg_heart_rate, max_heart_rate
       FROM apple_health_workouts WHERE user_id = ? AND date = ? ORDER BY updated_at DESC`,
      [req.user.id, queryDate]
    );
    const todayWorkoutsText = todayWorkoutRows.length === 0
      ? 'brak zarejestrowanych treningów'
      : todayWorkoutRows.map(w => {
          const parts = [`${w.workout_type || 'Trening'} (${Math.round(w.duration_minutes || 0)} min`];
          if (w.active_calories) parts.push(`, ${Math.round(w.active_calories)} kcal`);
          if (w.avg_heart_rate) parts.push(`, śr. tętno ${Math.round(w.avg_heart_rate)} bpm`);
          if (w.max_heart_rate) parts.push(`, maks. tętno ${Math.round(w.max_heart_rate)} bpm`);
          return parts.join('') + ')';
        }).join('; ');

    // Pobierz najświeższe dane dla wagi, tłuszczu i mięśni (jeśli dzisiejsze są null)
    let displayWeight = health.weight;
    let displayFatRatio = health.fat_ratio;
    let displayMuscleMass = health.muscle_mass;

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

    const latestBodyMeasurement = await db.get(
      `SELECT date, chest, waist, hips, biceps, thigh, biceps_left, biceps_right, shoulders, waist_above, waist_below FROM body_measurements WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
      [req.user.id]
    );

    // Okno historii: domyślnie 7 dni, rozszerzone do 90 dni jeśli treść wiadomości
    // wskazuje na pytanie o dłuższy okres (patrz messageNeedsLongHistory powyżej).
    const useExtendedHistory = messageNeedsLongHistory(message);
    const lookbackDays = useExtendedHistory ? CHAT_EXTENDED_LOOKBACK_DAYS : CHAT_DEFAULT_LOOKBACK_DAYS;
    const pastDateLimit = new Date(new Date(queryDate).getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const pastDateStr = pastDateLimit.toISOString().slice(0, 10);

    const historyMetrics = await db.all(`
      SELECT date, steps, active_calories, weight, sleep_score, sleep_duration, readiness_score
      FROM health_metrics
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    const historyMeals = await db.all(`
      SELECT date, raw_text, calories, protein, carbs, fat
      FROM meals
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    const historyWorkouts = await db.all(`
      SELECT date, workout_type, duration_minutes, active_calories, avg_heart_rate, max_heart_rate
      FROM apple_health_workouts
      WHERE user_id = ? AND date >= ? AND date < ?
      ORDER BY date ASC
    `, [req.user.id, pastDateStr, queryDate]);

    let weeklyTrendSummary = '';
    if (historyMetrics.length > 0 || historyMeals.length > 0 || historyWorkouts.length > 0) {
      if (useExtendedHistory) {
        // Pytanie wskazuje na dłuższy okres - zwarte podsumowanie tygodniowe
        // (patrz buildWeeklyTrendSummary) zamiast logu dzień po dniu, żeby nie
        // rozdąć prompta przy oknie do 90 dni.
        weeklyTrendSummary = `\nPodsumowanie tygodniowe użytkownika z ostatnich ${lookbackDays} dni (przed wybraną datą) - Twoje pytanie wskazuje na potrzebę szerszego kontekstu czasowego niż tylko ostatni tydzień:\n`
          + buildWeeklyTrendSummary(historyMetrics, historyMeals, historyWorkouts, pastDateStr, queryDate);
      } else {
        weeklyTrendSummary = `\nHistoria i trendy użytkownika z ostatnich ${lookbackDays} dni (przed wybraną datą):\n`;

        const mealsByDate = {};
        historyMeals.forEach(m => {
          if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
          mealsByDate[m.date].push(m);
        });
        const workoutsByDate = {};
        historyWorkouts.forEach(w => {
          if (!workoutsByDate[w.date]) workoutsByDate[w.date] = [];
          workoutsByDate[w.date].push(w);
        });

        const allPastDates = new Set([...historyMetrics.map(hm => hm.date), ...Object.keys(mealsByDate), ...Object.keys(workoutsByDate)]);
        const sortedPastDates = Array.from(allPastDates).sort();

        sortedPastDates.forEach(dStr => {
          const hm = historyMetrics.find(h => h.date === dStr);
          const dayMeals = mealsByDate[dStr] || [];
          const dayWorkouts = workoutsByDate[dStr] || [];

          let dayLog = `- Data ${dStr}: `;
          if (hm) {
            const parts = [];
            if (hm.steps) parts.push(`Kroki: ${hm.steps}`);
            if (hm.active_calories) parts.push(`Kalorie aktywne: ${hm.active_calories} kcal`);
            if (hm.weight) parts.push(`Waga: ${hm.weight} kg`);
            if (hm.sleep_score) parts.push(`Sen: ${hm.sleep_score}/100`);
            if (hm.readiness_score) parts.push(`Gotowość: ${hm.readiness_score}/100`);
            dayLog += parts.join(', ');
          }
          if (dayMeals.length > 0) {
            const totalCal = dayMeals.reduce((sum, m) => sum + m.calories, 0);
            const totalP = dayMeals.reduce((sum, m) => sum + m.protein, 0);
            const totalC = dayMeals.reduce((sum, m) => sum + m.carbs, 0);
            const totalF = dayMeals.reduce((sum, m) => sum + m.fat, 0);
            dayLog += ` | Posiłki (${dayMeals.length}): łącznie zjedzone ${totalCal} kcal (B: ${totalP}g, W: ${totalC}g, T: ${totalF}g)`;
          }
          if (dayWorkouts.length > 0) {
            const workoutsSummary = dayWorkouts.map(w => `${w.workout_type || 'Trening'} ${Math.round(w.duration_minutes || 0)}min${w.avg_heart_rate ? `, śr. tętno ${Math.round(w.avg_heart_rate)}bpm` : ''}`).join('; ');
            dayLog += ` | Treningi: ${workoutsSummary}`;
          }
          weeklyTrendSummary += dayLog + '\n';
        });
      }
    }

    // Formatowanie historii czatu z tej sesji
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      // Filtrowanie pustych wpisów
      let filteredHistory = history.filter(h => h.text && h.text.trim().length > 0);
      
      // Wykluczamy ostatnią wiadomość z historii, jeśli jest identyczna z bieżącym zapytaniem użytkownika
      // (ponieważ bieżące zapytanie jest już dołączone na końcu promptu jako "Pytanie użytkownika")
      if (
        filteredHistory.length > 0 &&
        filteredHistory[filteredHistory.length - 1].sender === 'user' &&
        filteredHistory[filteredHistory.length - 1].text.trim() === message.trim()
      ) {
        filteredHistory.pop();
      }

      // Przycinamy historię do ostatnich 15 wiadomości, by uniknąć rozdęcia promptu (prompt bloat)
      filteredHistory = filteredHistory.slice(-15);

      if (filteredHistory.length > 0) {
        historyContext = '\nHistoria rozmowy w tej sesji (od najstarszej):\n' + filteredHistory.map(h => {
          const roleName = h.sender === 'user' ? 'Użytkownik' : 'Dietetyk AI';
          // Przycinamy długie wiadomości w historii do 500 znaków jako dodatkowa ochrona
          const text = h.text.length > 500 ? h.text.slice(0, 500) + '...' : h.text;
          // B-W2: Wiadomości użytkownika owinięte w user_input zapobiegają prompt injection
          return h.sender === 'user' ? `${roleName}: <user_input>${text}</user_input>` : `${roleName}: ${text}`;
        }).join('\n') + '\n';
      }
    }

    // "Tag dnia" (day_events) z analizowanego okna historii [pastDateStr, queryDate] -
    // żeby AI w czacie też wiedziało o dniach oznaczonych jako choroba/wakacje/późne
    // zaśnięcie i nie sugerowało korekt na bazie nietypowych danych z tych dni
    // (patrz utils/dayEvents.js, ten sam mechanizm co w dashboard.js).
    const dayEventsInWindow = await getDayEventsInRange(req.user.id, pastDateStr, queryDate);
    const dayEventsContext = formatDayEventsForPrompt(dayEventsInWindow);

    // Pobierz klucz API użytkownika (jeśli posiada)
    const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [req.user.id]);
    const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;

    // Cel sylwetki (opis tekstowy, ustawiany w Ustawieniach - patrz routes/account.js).
    // W czacie wykorzystujemy tylko tekst, NIE zdjęcie referencyjne - w odróżnieniu od
    // dashboard.js (gdzie porada AI generowana jest raz dziennie, w tle, z cache),
    // czat odpowiada na KAŻDĄ wiadomość użytkownika "na żywo", więc dociąganie obrazu
    // do każdego zapytania Gemini niepotrzebnie zwiększałoby czas odpowiedzi i koszt.
    const bodyGoalRow = await db.get(`SELECT body_goal_text FROM users WHERE id = ?`, [req.user.id]);
    const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;

    // Imię (jeśli ustawione w Ustawieniach) ma priorytet nad loginem technicznym.
    const displayName = req.user.first_name || req.user.username;
    const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [req.user.id]);
    const language = langRow ? langRow.value : 'pl';

    // Aktualna pogoda i pora dnia (Zadanie: algorytm ma znać i uwzględniać w
    // analizie bieżącą pogodę/czas - patrz utils/weatherContext.js). Nigdy nie
    // rzuca wyjątku, więc nie wymaga dodatkowego try/catch tutaj. Lokalizacja:
    // własna użytkownika (Ustawienia -> Lokalizacja), jeśli ustawiona, inaczej
    // domyślna lokalizacja wdrożenia (patrz stałe w weatherContext.js).
    const userLocation = await getUserLocationOverride(req.user.id);
    const weatherTimeContext = await getWeatherAndTimeContext(language, userLocation?.lat, userLocation?.lon);

    let chatPrompt = '';
    if (language === 'en') {
      chatPrompt = `
You are a professional, empathetic, and goal-oriented AI Dietician and Sports Coach working in the "Dietetyk AI" application.
You are helping user ${displayName} optimize their diet, recovery, sleep, and workouts.
You can also answer workout questions: what workouts to add, what exercises to perform, and how to build strength progression. Base these recommendations on the available data (types and frequency of workouts, their duration and intensity by heart rate, readiness/recovery score, sleep, weight trends, and body measurements) and general strength training principles (load progression, volume, frequency, form, role of protein, and recovery). The app DOES NOT log detailed series/reps/weights for specific exercises - if the user asks for something requiring such data (e.g., "is my bench press weight increasing"), clearly note this limitation and suggest how they can track such progress independently.

User Profile and Goals:
- Target daily calorie intake: ${getTargetCalories(settings)} kcal
- Target macronutrients: Protein: ${settings.target_protein ?? 150}g, Carbs: ${settings.target_carbs ?? 250}g, Fat: ${settings.target_fat ?? 80}g
- BMR (Basal Metabolic Rate): ${bmr} kcal
- User body goal description: ${bodyGoalText || 'not described in Settings'}

Current User Stats for ${queryDate}:
- Food eaten: ${totalEaten.calories} kcal (P: ${totalEaten.protein}g, C: ${totalEaten.carbs}g, F: ${totalEaten.fat}g)
- Active calories burned: ${activeCalories} kcal
- Total energy expenditure: ${totalBurned} kcal (BMR + Active)
- Net balance: ${netCalories} kcal
- Steps: ${health.steps || 0}
- Workouts today: ${todayWorkoutsText}
- Weight: ${displayWeight || 'no data'} kg, Body Fat: ${displayFatRatio || 'no data'}%, Muscle mass: ${displayMuscleMass || 'no data'} kg
- Body measurements (latest from ${latestBodyMeasurement ? latestBodyMeasurement.date : 'N/A'}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Waist: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Waist +2cm (above navel): ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Waist -2cm (below navel): ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Chest: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Shoulders: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Hips: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps Left: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps Right: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Thigh: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'no fields filled' : 'no data in database'}
- Sleep Score: ${health.sleep_score !== null ? health.sleep_score : 'no data'} (Duration: ${health.sleep_duration || 0}h, Deep: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Readiness Score: ${health.readiness_score !== null ? health.readiness_score : 'no data'}
- Resting Heart Rate (RHR): ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms
- Water intake: ${health.water_ml || 0}ml (target: ${getTargetWaterMl(settings)}ml)
- Subjective state (user rating, scale 1-5): Energy: ${health.energy_level != null ? health.energy_level + '/5' : 'not rated'}, Mood: ${health.mood != null ? health.mood + '/5' : 'not rated'}

Current time and weather (context, not a user-provided metric):
${weatherTimeContext}
${weeklyTrendSummary}
${dayEventsContext}
${historyContext}
User's Question: <user_input>${message}</user_input>

Reply concisely, factually, and practically in English (maximum 3-4 short paragraphs). Focus on direct recommendations relating to the user's health metrics above. Refer to session history or trends from the history summary above if relevant to the question. If the user described their body goal, align recommendations to this goal where appropriate—but do not bring it up if the question is unrelated. You may use markdown formatting (bullet lists, bold text). The response should be professional, supportive, and motivating.
`;
    } else {
      chatPrompt = `
Jesteś profesjonalnym, empatycznym i zorientowanym na cele dietetykiem i trenerem sportowym AI pracującym w aplikacji "Dietetyk AI".
Pomagasz użytkownikowi ${displayName} w optymalizacji jego diety, regeneracji, snu i treningów.
Możesz też odpowiadać na pytania o trening: co dodać treningowo, jakie ćwiczenia wykonywać i jak budować progres siłowy - opieraj takie porady na dostępnych danych (typy i częstotliwość treningów, ich długość i intensywność wg tętna, wskaźnik gotowości/regeneracji, sen, trend wagi i obwodów ciała) oraz na ogólnej wiedzy o treningu siłowym (progresja obciążeń, objętość, częstotliwość, technika, rola białka i regeneracji). Aplikacja NIE rejestruje szczegółowego dziennika serii/powtórzeń/ciężarów na konkretnych ćwiczeniach - jeśli użytkownik pyta o coś, co wymagałoby takich danych (np. "czy mój ciężar na wyciskaniu rośnie"), jasno zaznacz ten brak i zaproponuj, jak samodzielnie śledzić taki progres.

Informacje o profilu i celach użytkownika:
- Cel kaloryczny spożycia: ${getTargetCalories(settings)} kcal
- Cel makroskładników: Białko: ${settings.target_protein ?? 150}g, Węglowodany: ${settings.target_carbs ?? 250}g, Tłuszcz: ${settings.target_fat ?? 80}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal
- Cel sylwetki opisany przez użytkownika: ${bodyGoalText || 'nie opisany w Ustawieniach'}

Aktualne statystyki użytkownika na dzień ${queryDate}:
- Spożycie: ${totalEaten.calories} kcal (B: ${totalEaten.protein}g, W: ${totalEaten.carbs}g, T: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Sumaryczny wydatek energetyczny: ${totalBurned} kcal (BMR + Aktywne)
- Bilans netto: ${netCalories} kcal
- Kroki: ${health.steps || 0}
- Treningi dzisiaj: ${todayWorkoutsText}
- Waga: ${displayWeight || 'brak danych'} kg, % Tłuszczu: ${displayFatRatio || 'brak danych'}%, Masa mięśniowa: ${displayMuscleMass || 'brak danych'} kg
- Obwody ciała (ostatni pomiar${latestBodyMeasurement ? ' z dnia ' + latestBodyMeasurement.date : ''}): ${latestBodyMeasurement ? [
    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
    latestBodyMeasurement.waist_above != null && `Pas +2cm (powyżej pępka): ${latestBodyMeasurement.waist_above}cm`,
    latestBodyMeasurement.waist_below != null && `Pas -2cm (poniżej pępka): ${latestBodyMeasurement.waist_below}cm`,
    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
    latestBodyMeasurement.shoulders != null && `Barki: ${latestBodyMeasurement.shoulders}cm`,
    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
    latestBodyMeasurement.biceps_left != null && `Biceps lewy: ${latestBodyMeasurement.biceps_left}cm`,
    latestBodyMeasurement.biceps_right != null && `Biceps prawy: ${latestBodyMeasurement.biceps_right}cm`,
    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
  ].filter(Boolean).join(', ') || 'brak wypełnionych pól' : 'brak danych w bazie'}
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score : 'brak danych'} (Czas: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score : 'brak danych'}
- Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms
- Wypita woda: ${health.water_ml || 0}ml (cel: ${getTargetWaterMl(settings)}ml)
- Samopoczucie (ręczna ocena użytkownika, skala 1-5): Energia: ${health.energy_level != null ? health.energy_level + '/5' : 'nie oceniono'}, Nastrój: ${health.mood != null ? health.mood + '/5' : 'nie oceniono'}

Aktualny czas i pogoda (kontekst, nie metryka wpisana przez użytkownika):
${weatherTimeContext}
${weeklyTrendSummary}
${dayEventsContext}
${historyContext}
Pytanie użytkownika: <user_input>${message}</user_input>

Odpowiedz zwięźle, merytorycznie i praktycznie w języku polskim (maksymalnie 3-4 krótkie akapity). Skup się na bezpośrednich zaleceniach odnoszących się do powyższych danych zdrowotnych użytkownika. Nawiąż do historii rozmowy lub trendów z powyższego podsumowania historii, jeśli to istotne i odpowiada na pytanie. Jeśli użytkownik opisał swój cel sylwetki, odnoś rekomendacje do tego celu tam, gdzie to ma sens dla zadanego pytania - ale nie wspominaj o nim, jeśli pytanie go nie dotyczy. Możesz używać formatowania markdown (listy wypunktowane, pogrubienia). Odpowiedź powinna być profesjonalna, życzliwa i motywująca.
`;
    }

    const forceCustomKeyOnly = req.user.role !== 'admin';
    const aiResponse = await generateContentWithFallback(chatPrompt, false, null, userApiKey, forceCustomKeyOnly);
    res.json({ response: aiResponse.trim() });
  } catch (err) {
    console.error('[CHAT ERROR]', err);
    res.status(500).json({ error: 'Nie udało się uzyskać odpowiedzi od Dietetyka AI.' });
  }
});

module.exports = router;
