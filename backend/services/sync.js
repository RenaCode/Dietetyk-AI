const db = require('../db');
const { formatDateString, timestampToDateString, getWarsawDayStartMillis } = require('../utils/dates');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const {
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
} = require('../utils/activitySources');

const { getOrRefreshToken } = require('./oauthHelpers');

const OURA_RANK = getActivitySourceRank('oura');
const GOOGLE_FIT_RANK = getActivitySourceRank('google_fit');

// Kolumny, których niezerowa wartość oznacza "to źródło realnie dostarczyło dane
// o aktywności za ten dzień" - decydują o tym, czy etykieta activity_source zostaje
// przy dotychczasowym (wyżej notowanym) źródle.
const ACTIVITY_LABEL_COLUMNS = [
  'steps', 'active_calories', 'total_calories_burned', 'active_minutes', 'distance_meters'
];
const GOOGLE_FIT_LABEL_COLUMNS = ['steps', 'active_calories', 'distance_meters'];

async function syncOura(userId) {
  const accessToken = await getOrRefreshToken(userId, 'oura');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Oura. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 7);

  const startDate = formatDateString(past);
  const endDate = formatDateString(now);

  console.log(`[SYNC OURA] Pobieranie danych gotowości/snu/aktywności dla użytkownika ${userId} od ${startDate} do ${endDate}...`);

  try {
    const sleepRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!sleepRes.ok) {
      const errText = await sleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania snu Oura (Status ${sleepRes.status}): ${detail}`);
    }
    const sleepData = await sleepRes.json();

    const dailySleepRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!dailySleepRes.ok) {
      const errText = await dailySleepRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania dziennego podsumowania snu Oura (Status ${dailySleepRes.status}): ${detail}`);
    }
    const dailySleepData = await dailySleepRes.json();

    const actRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!actRes.ok) {
      const errText = await actRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania aktywności Oura (Status ${actRes.status}): ${detail}`);
    }
    const actData = await actRes.json();

    const readRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!readRes.ok) {
      const errText = await readRes.text();
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail) detail = parsed.detail;
      } catch (e) {}
      throw new Error(`Błąd pobierania gotowości Oura (Status ${readRes.status}): ${detail}`);
    }
    const readData = await readRes.json();

    // Dobowe SpO2 (Oura Gen 3+) - osobny endpoint, NIE część odpowiedzi /sleep.
    // Dla pierścionków starszych niż Gen 3 Oura po prostu zwraca pustą tablicę
    // `data` (nie błąd 4xx) - wtedy spo2_percentage zostaje null dla każdej daty.
    const spo2Res = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_spo2?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let spo2Data = null;
    if (spo2Res.ok) {
      spo2Data = await spo2Res.json();
    } else {
      // Celowo nie przerywamy całej synchronizacji błędem SpO2 - to dodatkowa,
      // nieobowiązkowa metryka. Logujemy i kontynuujemy bez niej.
      console.warn(`[SYNC OURA] Pominięto SpO2 (Status ${spo2Res.status}) - kontynuuję bez tej metryki.`);
    }

    // Realny poziom stresu (endpoint /v2/usercollection/daily_stress) - dostępny
    // tylko dla pierścionków z tą funkcją, dla starszych modeli `data` jest puste
    // (nie błąd 4xx). Tak jak SpO2, brak tej metryki nie przerywa synchronizacji.
    const stressRes = await fetchWithTimeout(`https://api.ouraring.com/v2/usercollection/daily_stress?start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let stressData = null;
    if (stressRes.ok) {
      stressData = await stressRes.json();
    } else {
      console.warn(`[SYNC OURA] Pominięto poziom stresu (Status ${stressRes.status}) - kontynuuję bez tej metryki.`);
    }

    const metricsByDate = {};
    for (let i = 0; i < 7; i++) { // B-N2: < zamiast <= (7 dni, nie 8)
      const d = new Date();
      d.setDate(now.getDate() - i);
      const dateStr = formatDateString(d);
      metricsByDate[dateStr] = {
        steps: null,
        active_calories: null,
        total_calories: null,
        sleep_score: null,
        sleep_duration: null,
        sleep_deep: null,
        sleep_rem: null,
        readiness_score: null,
        hrv: null,
        rhr: null,
        temperature_deviation: null,
        active_minutes: null,
        respiratory_rate: null,
        spo2_percentage: null,
        distance_meters: null,
        sedentary_minutes: null,
        low_activity_minutes: null,
        stress_high_minutes: null,
        stress_recovery_minutes: null,
        stress_summary: null
      };
    }

    if (sleepData && sleepData.data) {
      // Grupujemy wpisy snu według dni, aby poprawnie obsłużyć wiele wpisów (np. drzemki).
      const sleepByDay = {};
      sleepData.data.forEach(item => {
        const dateStr = item.day;
        if (!sleepByDay[dateStr]) {
          sleepByDay[dateStr] = [];
        }
        sleepByDay[dateStr].push(item);
      });

      for (const [dateStr, items] of Object.entries(sleepByDay)) {
        if (metricsByDate[dateStr]) {
          let totalDurationSec = 0;
          let totalDeepSec = 0;
          let totalRemSec = 0;
          let hasLongSleep = false;

          // Wybieramy główny rekord (główny sen 'long_sleep', a jeśli go brak - najdłuższą drzemkę)
          // do wyciągnięcia pozostałych parametrów fizjologicznych (tętno spoczynkowe, HRV itp.).
          let primaryRecord = null;
          items.forEach(item => {
            totalDurationSec += item.total_sleep_duration || 0;
            totalDeepSec += item.deep_sleep_duration || 0;
            totalRemSec += item.rem_sleep_duration || 0;
            if (item.type === 'long_sleep') {
              hasLongSleep = true;
            }

            if (!primaryRecord) {
              primaryRecord = item;
            } else if (item.type === 'long_sleep' && primaryRecord.type !== 'long_sleep') {
              primaryRecord = item;
            } else if (item.type === primaryRecord.type && (item.total_sleep_duration || 0) > (primaryRecord.total_sleep_duration || 0)) {
              primaryRecord = item;
            }
          });

          metricsByDate[dateStr].sleep_duration = totalDurationSec ? Math.round((totalDurationSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_deep = totalDeepSec ? Math.round((totalDeepSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].sleep_rem = totalRemSec ? Math.round((totalRemSec / 3600) * 10) / 10 : null;
          metricsByDate[dateStr].has_long_sleep = hasLongSleep;

          if (primaryRecord) {
            metricsByDate[dateStr].rhr = primaryRecord.lowest_heart_rate || null;
            metricsByDate[dateStr].hrv = primaryRecord.average_hrv || null;
            // `average_breath` - mimo że dokumentacja Oury nazywa to pole "breaths/second",
            // realne wartości w odpowiedziach API (np. 12.1, 12.4) są w oczywisty sposób
            // oddechami/MINUTĘ (norma snu to 12-20/min). Zapisujemy wartość bez konwersji,
            // zaokrągloną do 1 miejsca po przecinku.
            metricsByDate[dateStr].respiratory_rate = primaryRecord.average_breath ? Math.round(primaryRecord.average_breath * 10) / 10 : null;
          }
        }
      }
    }

    if (spo2Data && spo2Data.data) {
      spo2Data.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr] && item.spo2_percentage && typeof item.spo2_percentage.average === 'number') {
          metricsByDate[dateStr].spo2_percentage = Math.round(item.spo2_percentage.average * 10) / 10;
        }
      });
    }

    if (dailySleepData && dailySleepData.data) {
      dailySleepData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].sleep_score = item.score || null;
        }
      });
    }

    if (actData && actData.data) {
      actData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].steps = item.steps || 0;
          metricsByDate[dateStr].active_calories = item.active_calories || 0;
          metricsByDate[dateStr].total_calories = item.total_calories || 0;
          metricsByDate[dateStr].active_minutes = Math.round(((item.medium_activity_time || 0) + (item.high_activity_time || 0)) / 60) || 0;
          // Dystans - Oura zwraca "ekwiwalent dystansu pieszego" w metrach (uwzględnia
          // też inną aktywność przeliczoną na kroki/dystans, nie tylko czysty chodzony
          // dystans GPS) - najlepsze dostępne realne pole dystansu z tego API.
          metricsByDate[dateStr].distance_meters = item.equivalent_walking_distance || null;
          // Rozbicie dnia wg intensywności (sekundy -> minuty) - uzupełnia istniejące
          // active_minutes (medium+high) o resztę dnia.
          metricsByDate[dateStr].sedentary_minutes = item.sedentary_time != null ? Math.round(item.sedentary_time / 60) : null;
          metricsByDate[dateStr].low_activity_minutes = item.low_activity_time != null ? Math.round(item.low_activity_time / 60) : null;
        }
      });
    }

    if (readData && readData.data) {
      readData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].readiness_score = item.score || null;
          // BUG (do 2026-06): Oura API v2 zwraca "temperature_deviation" jako
          // płaskie pole na obiekcie readiness, NIE zagnieżdżone pod
          // "temperature.deviation" (takiego zagnieżdżonego pola nie ma w
          // ogóle w odpowiedzi /v2/usercollection/daily_readiness) - stara
          // ścieżka item.temperature?.deviation była więc zawsze undefined,
          // więc kolumna zawsze wpadała w fallback null. Stąd permanentne
          // "--" przy "Odchylenie temperatury" na karcie Oura Ring Status.
          metricsByDate[dateStr].temperature_deviation = item.temperature_deviation ?? null;
        }
      });
    }

    if (stressData && stressData.data) {
      stressData.data.forEach(item => {
        const dateStr = item.day;
        if (metricsByDate[dateStr]) {
          metricsByDate[dateStr].stress_high_minutes = item.stress_high != null ? Math.round((item.stress_high / 60) * 10) / 10 : null;
          metricsByDate[dateStr].stress_recovery_minutes = item.recovery_high != null ? Math.round((item.recovery_high / 60) * 10) / 10 : null;
          metricsByDate[dateStr].stress_summary = item.day_summary || null;
        }
      });
    }

    const lastSyncTime = new Date().toISOString();
    for (const [dateStr, metrics] of Object.entries(metricsByDate)) {
      if (metrics.steps !== null || metrics.sleep_score !== null || metrics.readiness_score !== null) {
        // Sprawdzamy czy w bazie istnieje już wiersz z nie-nullowym czasem snu
        const existing = await db.get(
          'SELECT sleep_duration, sleep_score, sleep_deep, sleep_rem, rhr, hrv, readiness_score FROM health_metrics WHERE user_id = ? AND date = ?',
          [userId, dateStr]
        );

        if (existing && existing.sleep_duration !== null && !metrics.has_long_sleep) {
          // Jeśli w bazie jest już czas snu, a Oura nie ma na ten dzień głównego snu (long_sleep),
          // tylko np. same drzemki lub brak danych snu, nie nadpisujemy istniejącego czasu snu ani wskaźników.
          metrics.sleep_duration = existing.sleep_duration;
          metrics.sleep_score = existing.sleep_score;
          metrics.sleep_deep = existing.sleep_deep;
          metrics.sleep_rem = existing.sleep_rem;
          metrics.rhr = existing.rhr;
          metrics.hrv = existing.hrv;
          metrics.readiness_score = existing.readiness_score;
        }

        // PRIORYTET: patrz utils/activitySources.js - hierarchia
        // apple > google_fit > oura, wspólna dla WSZYSTKICH upsertów aktywności.
        // Wcześniej każdy upsert bronił się wyłącznie przed nadpisaniem danych
        // z 'apple', przez co Google Fit i Oura nadpisywały się nawzajem i wynik
        // dla tej samej doby zależał od kolejności synchronizacji w danej godzinie.
        //
        // POPRAWKA (2026-06-19): blokada "activity_source = 'apple' -> nie nadpisuj"
        // chroniła kolumnę NIEZALEŻNIE od tego, czy Apple faktycznie wysłało dla niej
        // realne dane. Jeśli webhook Apple Health zapisał dla danej daty same
        // zera/null (np. automatyzacja odpaliła się, zanim zegarek zsynchronizował
        // kroki, albo wysłała tylko część metryk), dzień zostawał trwale zablokowany
        // na zerze - żaden kolejny resync Oury (mimo realnych, niezerowych danych) go
        // nie poprawiał. Teraz blokada per-kolumna działa tylko, gdy istniejąca
        // wartość Apple jest faktycznie > 0 - w przeciwnym razie Oura może ją
        // uzupełnić. activity_source wraca na 'oura' tylko wtedy, gdy żadna z kolumn
        // aktywności Apple nie miała realnych danych (czyli wszystkie zostały właśnie
        // uzupełnione przez Oura) - jeśli chociaż jedna kolumna Apple była realna,
        // etykieta źródła zostaje 'apple', zgodnie z tym, co faktycznie nadpisano.
        // POPRAWKA (runda 4 audytu): wcześniej activitySource zależał WYŁĄCZNIE od
        // metrics.steps !== null. Jeśli Oura dla danej daty dostarczyła np. tylko
        // active_calories/active_minutes (kroki spóźnione lub niedostępne z danego
        // modelu pierścionka), activitySource wpadał w null mimo zapisania realnych
        // danych aktywności z Oura - dashboard/API błędnie pokazywały brak/nieznane
        // źródło aktywności za ten dzień. Teraz źródło 'oura' jest ustawiane, gdy
        // JAKAKOLWIEK kolumna aktywności ma realną wartość.
        const hasOuraActivityData = metrics.steps !== null || metrics.active_calories !== null
          || metrics.active_minutes !== null || metrics.distance_meters !== null
          || metrics.total_calories !== null;
        const activitySource = hasOuraActivityData ? 'oura' : null;
        await db.run(`
          INSERT INTO health_metrics (
            user_id, date, steps, active_calories, total_calories_burned,
            sleep_score, sleep_duration, sleep_deep, sleep_rem,
            readiness_score, hrv, rhr, temperature_deviation, active_minutes,
            respiratory_rate, spo2_percentage, distance_meters, sedentary_minutes,
            low_activity_minutes, stress_high_minutes, stress_recovery_minutes,
            stress_summary, activity_source, last_sync
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            ${preserveHigherPriority('steps', OURA_RANK)},
            ${preserveHigherPriority('active_calories', OURA_RANK)},
            ${preserveHigherPriority('total_calories_burned', OURA_RANK)},
            sleep_score = COALESCE(excluded.sleep_score, sleep_score),
            sleep_duration = COALESCE(excluded.sleep_duration, sleep_duration),
            sleep_deep = COALESCE(excluded.sleep_deep, sleep_deep),
            sleep_rem = COALESCE(excluded.sleep_rem, sleep_rem),
            readiness_score = COALESCE(excluded.readiness_score, readiness_score),
            hrv = COALESCE(excluded.hrv, hrv),
            rhr = COALESCE(excluded.rhr, rhr),
            temperature_deviation = COALESCE(excluded.temperature_deviation, temperature_deviation),
            ${preserveHigherPriority('active_minutes', OURA_RANK)},
            respiratory_rate = COALESCE(excluded.respiratory_rate, respiratory_rate),
            spo2_percentage = COALESCE(excluded.spo2_percentage, spo2_percentage),
            ${preserveHigherPriority('distance_meters', OURA_RANK)},
            sedentary_minutes = COALESCE(excluded.sedentary_minutes, sedentary_minutes),
            low_activity_minutes = COALESCE(excluded.low_activity_minutes, low_activity_minutes),
            stress_high_minutes = COALESCE(excluded.stress_high_minutes, stress_high_minutes),
            stress_recovery_minutes = COALESCE(excluded.stress_recovery_minutes, stress_recovery_minutes),
            stress_summary = COALESCE(excluded.stress_summary, stress_summary),
            -- Runda 12 (audyt): distance_meters MUSI być na liście kolumn decydujących
            -- o zachowaniu etykiety - bez tego dni, w których wyżej notowane źródło
            -- dostarczyło WYŁĄCZNIE dystans (bez kroków/kalorii/minut w tym imporcie),
            -- traciły ochronę i etykieta przechodziła na źródło niższego rzędu.
            ${preserveSourceLabel(OURA_RANK, ACTIVITY_LABEL_COLUMNS)},
            last_sync = excluded.last_sync
        `, [
          userId, dateStr,
          metrics.steps, metrics.active_calories, metrics.total_calories,
          metrics.sleep_score, metrics.sleep_duration, metrics.sleep_deep, metrics.sleep_rem,
          metrics.readiness_score, metrics.hrv, metrics.rhr, metrics.temperature_deviation,
          // BŁĄD (naprawione): było `metrics.active_minutes || 0`. Jeśli dane
          // aktywności Oura nie trafiały dla danej daty, metrics.active_minutes
          // było null/undefined, a `|| 0` zamieniało to na liczbę 0 - w
          // przeciwieństwie do wszystkich innych pól powyżej, które poprawnie
          // przechodzą jako null. Ponieważ UPDATE używa
          // COALESCE(excluded.active_minutes, active_minutes), a COALESCE
          // traktuje 0 jako realną wartość (nie NULL), KAŻDA synchronizacja bez
          // dopasowanych danych aktywności na tę datę zerowała już zapisaną,
          // prawdziwą wartość minut aktywności z poprzedniej synchronizacji.
          metrics.active_minutes,
          metrics.respiratory_rate, metrics.spo2_percentage,
          metrics.distance_meters, metrics.sedentary_minutes, metrics.low_activity_minutes,
          metrics.stress_high_minutes, metrics.stress_recovery_minutes, metrics.stress_summary,
          activitySource,
          lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC OURA ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja danych Withings
async function syncWithings(userId) {
  const accessToken = await getOrRefreshToken(userId, 'withings');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Withings. Połącz się ponownie w Ustawieniach.' };
  }

  const now = new Date();
  const past = new Date();
  past.setDate(now.getDate() - 30);
  const startTimestamp = Math.floor(past.getTime() / 1000);

  console.log(`[SYNC WITHINGS] Pobieranie pomiarów wagi dla użytkownika ${userId}...`);

  try {
    const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/measure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: new URLSearchParams({
        action: 'getmeas',
        // 1: waga (kg), 6: % tłuszczu, 76: mięśnie (kg), 9: ciśnienie rozkurczowe
        // (diastolic, mmHg), 10: ciśnienie skurczowe (systolic, mmHg) - z ciśnieniomierza
        // Withings (np. BPM Core), zapisywane w tej samej grupie pomiarowej co waga.
        meastypes: '1,6,76,9,10',
        category: '1',
        lastupdate: String(startTimestamp)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Withings: ${errText}`);
    }

    const resJson = await response.json();
    if (resJson.status !== 0) {
      throw new Error(`Withings API status: ${resJson.status}`);
    }

    const measureGrps = resJson.body?.measuregrps || [];
    const lastSyncTime = new Date().toISOString();

    for (const grp of measureGrps) {
      const dateStr = timestampToDateString(grp.date);
      let weight = null;
      let fatRatio = null;
      let muscleMass = null;
      let bpSystolic = null;
      let bpDiastolic = null;

      grp.measures.forEach(m => {
        const val = m.value * Math.pow(10, m.unit);
        // B-W3: Pomiń pomiar jeśli jednostka jest undefined → NaN propaguje do SQLite
        if (isNaN(val) || !isFinite(val)) return;
        if (m.type === 1) weight = Math.round(val * 100) / 100;
        if (m.type === 6) fatRatio = Math.round(val * 100) / 100;
        if (m.type === 76) muscleMass = Math.round(val * 100) / 100;
        if (m.type === 10) bpSystolic = Math.round(val);
        if (m.type === 9) bpDiastolic = Math.round(val);
      });

      if (weight !== null || fatRatio !== null || muscleMass !== null || bpSystolic !== null || bpDiastolic !== null) {
        await db.run(`
          INSERT INTO health_metrics (user_id, date, weight, fat_ratio, muscle_mass, blood_pressure_systolic, blood_pressure_diastolic, last_sync)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            weight = COALESCE(excluded.weight, weight),
            fat_ratio = COALESCE(excluded.fat_ratio, fat_ratio),
            muscle_mass = COALESCE(excluded.muscle_mass, muscle_mass),
            blood_pressure_systolic = COALESCE(excluded.blood_pressure_systolic, blood_pressure_systolic),
            blood_pressure_diastolic = COALESCE(excluded.blood_pressure_diastolic, blood_pressure_diastolic),
            last_sync = excluded.last_sync
        `, [userId, dateStr, weight, fatRatio, muscleMass, bpSystolic, bpDiastolic, lastSyncTime]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC WITHINGS ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja Google Fit (kroki, kalorie aktywne) - w przeciwieństwie do Apple Health
// (webhook/push z apki Health Auto Export), Google Fit nie ma mechanizmu push, więc
// dane pobieramy aktywnie przez REST API (dataset:aggregate), analogicznie do Oura/Withings.
async function syncGoogleFit(userId) {
  const accessToken = await getOrRefreshToken(userId, 'google_fit');
  if (!accessToken) {
    return { success: false, error: 'Brak aktywnego tokenu Google Fit. Połącz się ponownie w Ustawieniach.' };
  }

  // Granice okna MUSZĄ zaczynać się dokładnie o północy czasu Europe/Warsaw.
  // bucketByTime w Google Fit dzieli okno na kubełki od startTimeMillis co
  // durationMillis - czyli kubełki są wyrównane do PUNKTU STARTU, nie do UTC.
  // Wcześniej startem był "teraz minus 7 dni", więc każdy kubełek obejmował dobę
  // liczoną od bieżącej godziny (np. 14:00-14:00), a nie dobę kalendarzową.
  // Sumy 7-dniowe wychodziły z tego mniej więcej poprawne, ale przypisanie do
  // konkretnego DNIA było przesunięte - a na tym opierają się insighty czasowe
  // (meal-timing-sleep, sedentary-sleep, early-strain-alert), gdzie przesunięcie
  // zmienia wniosek, nie tylko liczbę. Start ustawiony na północ warszawską
  // sprawia, że każdy kubełek to dokładnie jedna doba kalendarzowa w tej samej
  // strefie, w której liczy je reszta aplikacji (patrz utils/dates.js).
  const now = new Date();
  const startTimeMillis = getWarsawDayStartMillis(now, -7);
  const endTimeMillis = now.getTime();

  console.log(`[SYNC GOOGLE FIT] Pobieranie kroków/kalorii dla użytkownika ${userId}...`);

  try {
    const response = await fetchWithTimeout('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        aggregateBy: [
          { dataTypeName: 'com.google.step_count.delta' },
          { dataTypeName: 'com.google.calories.expended' },
          { dataTypeName: 'com.google.distance.delta' }
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: String(startTimeMillis),
        endTimeMillis: String(endTimeMillis)
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Google Fit API (Status ${response.status}): ${errText}`);
    }

    const data = await response.json();
    const buckets = data.bucket || [];
    const lastSyncTime = new Date().toISOString();

    for (const bucket of buckets) {
      // Kubełki są wyrównane do północy warszawskiej (patrz startTimeMillis wyżej),
      // ale durationMillis to sztywne 24h, więc po zmianie czasu letni/zimowy
      // kolejne kubełki w oknie dryfują o godzinę (np. zaczynają się o 23:00 dnia
      // poprzedniego). Etykietujemy więc kubełek po jego ŚRODKU, a nie po początku:
      // dla kubełka wyrównanego środek wypada w południe tego samego dnia, a dla
      // przesuniętego o godzinę - nadal w obrębie właściwej doby. Dzięki temu
      // przypisanie do dnia jest poprawne również w tygodniu ze zmianą czasu.
      // (Sama zawartość kubełka jest wtedy przesunięta o godzinę - tego przy
      // sztywnym durationMillis uniknąć się nie da bez 7 osobnych zapytań do API.)
      const bucketStartMs = Number(bucket.startTimeMillis);
      const bucketEndMs = Number(bucket.endTimeMillis) || (bucketStartMs + 86400000);
      const bucketMidpointMs = bucketStartMs + (bucketEndMs - bucketStartMs) / 2;
      const dateStr = timestampToDateString(Math.floor(bucketMidpointMs / 1000));

      let steps = 0;
      let calories = 0;
      let distance = 0;
      (bucket.dataset || []).forEach(ds => {
        (ds.point || []).forEach(point => {
          const val = point.value && point.value[0];
          if (!val) return;
          if (ds.dataSourceId && ds.dataSourceId.includes('step_count')) {
            steps += val.intVal || 0;
          } else if (ds.dataSourceId && ds.dataSourceId.includes('calories')) {
            calories += val.fpVal || 0;
          } else if (ds.dataSourceId && ds.dataSourceId.includes('distance')) {
            distance += val.fpVal || 0;
          }
        });
      });
      calories = Math.round(calories);
      distance = Math.round(distance);

      if (steps > 0 || calories > 0 || distance > 0) {
        // Ten sam wzorzec ochrony kolumn co w syncOura, z jednej wspólnej hierarchii
        // (utils/activitySources.js): apple > google_fit > oura. Google Fit stoi wyżej
        // od Oury, bo jak Apple Health raportuje na bieżąco z telefonu, a Oura domyka
        // dobę dopiero następnego ranka.
        await db.run(`
          INSERT INTO health_metrics (user_id, date, steps, active_calories, distance_meters, activity_source, last_sync)
          VALUES (?, ?, ?, ?, ?, 'google_fit', ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            ${preserveHigherPriority('steps', GOOGLE_FIT_RANK)},
            ${preserveHigherPriority('active_calories', GOOGLE_FIT_RANK)},
            ${preserveHigherPriority('distance_meters', GOOGLE_FIT_RANK)},
            ${preserveSourceLabel(GOOGLE_FIT_RANK, GOOGLE_FIT_LABEL_COLUMNS)},
            last_sync = excluded.last_sync
        `, [
          userId, dateStr,
          // Runda 12 (audyt): usunięto "|| null". Te wartości startują od 0 i są zliczane
          // przez sumowanie punktów z Google Fit - 0 jest tu legalną, realną wartością
          // dnia (np. faktycznie 0 kroków), a nie "brakiem danych". Konwersja na null
          // psuła wzorzec ON CONFLICT (COALESCE(excluded.x, x)): null powodował, że
          // SQLite zachowywał STARĄ wartość z bazy, więc dzień z realnym zerem nigdy nie
          // nadpisywał błędnych/nieaktualnych danych z wcześniejszej synchronizacji.
          steps, calories, distance, lastSyncTime
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`[SYNC GOOGLE FIT ERROR] Użytkownik ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

// Synchronizacja Oura dla wszystkich użytkowników (wywoływana przez wspólny harmonogram godzinowy, 5:00-22:00)
async function syncAllOura() {
  console.log('[CRON OURA] Synchronizacja danych Oura Ring...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'oura'`);
    for (const t of tokens) {
      await syncOura(t.user_id);
    }
    console.log(`[CRON OURA] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Oura:', err);
  }
}

// Synchronizacja Withings dla wszystkich użytkowników (wywoływana przez wspólny harmonogram godzinowy, 5:00-22:00)
async function syncAllWithings() {
  console.log('[CRON WITHINGS] Synchronizacja danych Withings...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'withings'`);
    for (const t of tokens) {
      await syncWithings(t.user_id);
    }
    console.log(`[CRON WITHINGS] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Withings:', err);
  }
}

// Synchronizacja Google Fit dla wszystkich użytkowników (wywoływana przez wspólny harmonogram godzinowy, 5:00-22:00)
async function syncAllGoogleFit() {
  console.log('[CRON GOOGLE FIT] Synchronizacja danych Google Fit...');
  try {
    const tokens = await db.all(`SELECT DISTINCT user_id FROM oauth_tokens WHERE service = 'google_fit'`);
    for (const t of tokens) {
      await syncGoogleFit(t.user_id);
    }
    console.log(`[CRON GOOGLE FIT] Zsynchronizowano ${tokens.length} użytkownik(ów).`);
  } catch (err) {
    console.error('[CRON ERROR] Błąd synchronizacji Google Fit:', err);
  }
}

module.exports = {
  syncOura,
  syncWithings,
  syncGoogleFit,
  syncAllOura,
  syncAllWithings,
  syncAllGoogleFit
};
