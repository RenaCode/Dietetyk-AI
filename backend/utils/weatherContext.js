// Kontekst "aktualna pogoda i pora dnia" wstrzykiwany do promptów AI (czat i
// codzienna porada dietetyczna) - zalecenia dietetyczno-treningowe mają sens
// inaczej w upał (nawodnienie, lżejsze posiłki) niż w mróz (rozgrzewające
// posiłki, dłuższa rozgrzewka przed treningiem), i inaczej rano niż wieczorem
// (np. sugestia śniadania vs kolacji, kofeina). Pogoda z Open-Meteo (bez
// klucza API, ten sam dostawca co w Ogrodnik-AI - patrz
// Ogrodnik-AI/app/integrations/weather.py).
//
// Lokalizacja: domyślnie Warszawa (aplikacja i tak zakłada Europe/Warsaw
// wszędzie indziej, patrz utils/dates.js). Każdy użytkownik może nadpisać tę
// domyślną lokalizację własną (patrz getUserLocationOverride + endpoint
// GET /api/settings/geocode-location w routes/account.js oraz pole "Lokalizacja"
// w Ustawieniach na froncie) - nadpisanie dla innego wdrożenia całej aplikacji
// możliwe też przez zmienne środowiskowe WEATHER_LAT/WEATHER_LON.

const db = require('../db');
const { fetchWithTimeout } = require('./fetchWithTimeout');
const { getWarsawWallClock } = require('./dates');

const DEFAULT_LAT = 52.2297; // Warszawa
const DEFAULT_LON = 21.0122;
const LAT = process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : DEFAULT_LAT;
const LON = process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : DEFAULT_LON;

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Cache w pamięci procesu, kluczowany po zaokrąglonych współrzędnych - czat
// odpytuje ten moduł przy KAŻDEJ wiadomości użytkownika (potencjalnie wielu
// użytkowników naraz, teraz z różnymi lokalizacjami po dodaniu nadpisania per
// użytkownik), więc bez cache jedna aktywna rozmowa wygenerowałaby dziesiątki
// zapytań do Open-Meteo w kilka minut. Pogoda nie zmienia się na tyle szybko,
// żeby odświeżać ją częściej niż co 20 minut. Zaokrąglenie do 2 miejsc po
// przecinku (~1km) grupuje użytkowników z bardzo zbliżoną lokalizacją pod
// jednym wpisem cache, bez realnej straty dokładności pogody.
const CACHE_TTL_MS = 20 * 60 * 1000;
const weatherCache = new Map(); // klucz "lat,lon" -> { data, fetchedAt }
// Zapobiega równoległym zapytaniom do Open-Meteo dla TEJ SAMEJ lokalizacji,
// gdy kilku użytkowników pyta czat w tej samej chwili przy zimnym cache.
const inFlightRequests = new Map(); // klucz "lat,lon" -> Promise

// Geokodowanie (nazwa miejscowości -> współrzędne) ma osobny, dłuższy cache -
// nazwy miejscowości praktycznie nigdy się nie zmieniają, w odróżnieniu od
// pogody. Klucz to znormalizowane zapytanie użytkownika (lowercase, trim).
const GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const geocodingCache = new Map(); // klucz "query" -> { results, fetchedAt }

// Kody pogodowe WMO zwracane przez Open-Meteo (weather_code) - te same kody,
// niezależnie od języka odpowiedzi, więc mapujemy je osobno na PL/EN.
const WEATHER_CODE_DESCRIPTIONS_PL = {
  0: 'bezchmurnie', 1: 'przeważnie bezchmurnie', 2: 'częściowe zachmurzenie', 3: 'pochmurno',
  45: 'mgła', 48: 'mgła osadzająca szron',
  51: 'mżawka słaba', 53: 'mżawka umiarkowana', 55: 'mżawka gęsta',
  56: 'marznąca mżawka słaba', 57: 'marznąca mżawka gęsta',
  61: 'słaby deszcz', 63: 'umiarkowany deszcz', 65: 'silny deszcz',
  66: 'marznący deszcz słaby', 67: 'marznący deszcz silny',
  71: 'słaby śnieg', 73: 'umiarkowany śnieg', 75: 'silny śnieg', 77: 'ziarna śniegu',
  80: 'słabe przelotne opady deszczu', 81: 'umiarkowane przelotne opady deszczu', 82: 'gwałtowne przelotne opady deszczu',
  85: 'słabe przelotne opady śniegu', 86: 'silne przelotne opady śniegu',
  95: 'burza', 96: 'burza ze słabym gradem', 99: 'burza z silnym gradem'
};

const WEATHER_CODE_DESCRIPTIONS_EN = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail'
};

const WEEKDAYS_PL = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getDayPart(hour, language) {
  if (hour >= 5 && hour < 10) return language === 'en' ? 'early morning' : 'wczesny poranek';
  if (hour >= 10 && hour < 12) return language === 'en' ? 'late morning' : 'przedpołudnie';
  if (hour >= 12 && hour < 17) return language === 'en' ? 'afternoon' : 'popołudnie';
  if (hour >= 17 && hour < 21) return language === 'en' ? 'evening' : 'wieczór';
  return language === 'en' ? 'night' : 'noc';
}

// Waliduje i normalizuje parę lat/lon nadaną przez wywołującego (np. z
// ustawień użytkownika) - odrzuca wartości spoza sensownego zakresu geograficznego
// zamiast wysyłać je dalej do Open-Meteo (które przy skrajnie błędnych wartościach
// zwróci błąd HTTP, a przy 0/0 - "zgodną z zapytaniem" pogodę znad Zatoki Gwinejskiej,
// co ciche zaakceptowanie skasowanej/uszkodzonej lokalizacji jako "0,0" mogłoby
// niepostrzeżenie wstrzyknąć do promptu AI).
function normalizeCoords(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  if (latNum === 0 && lonNum === 0) return null;
  if (latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) return null;
  return { lat: Math.round(latNum * 100) / 100, lon: Math.round(lonNum * 100) / 100 };
}

async function fetchCurrentWeather(lat, lon) {
  const key = `${lat},${lon}`;
  const now = Date.now();
  const cached = weatherCache.get(key);
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }

  const requestPromise = (async () => {
    try {
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
        timezone: 'Europe/Warsaw'
      });
      const resp = await fetchWithTimeout(`${WEATHER_URL}?${params.toString()}`, {}, 8000);
      if (!resp.ok) {
        throw new Error(`Open-Meteo HTTP ${resp.status}`);
      }
      const json = await resp.json();
      const current = json.current || {};
      const data = {
        temperatureC: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
        humidityPct: typeof current.relative_humidity_2m === 'number' ? current.relative_humidity_2m : null,
        precipitationMm: typeof current.precipitation === 'number' ? current.precipitation : null,
        windKph: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : null,
        weatherCode: typeof current.weather_code === 'number' ? current.weather_code : null
      };
      weatherCache.set(key, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      console.error('[WEATHER] Błąd pobierania pogody z Open-Meteo:', err.message);
      // Nie rzucamy dalej - brak pogody nie może wywalić generowania porady AI
      // (patrz wywołania w chat.js/dashboard.js/summaries.js). Zwracamy
      // poprzednie znane dane dla tej lokalizacji, jeśli są - chwilowa awaria
      // Open-Meteo nie powinna gubić kontekstu pogodowego przy każdej kolejnej
      // wiadomości czatu.
      return cached ? cached.data : null;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, requestPromise);
  return requestPromise;
}

// Buduje gotowy fragment tekstu do wstrzyknięcia w prompt AI - łączy aktualny
// czas (dzień tygodnia, godzina, pora dnia) z aktualną pogodą w jednym
// miejscu, żeby nie duplikować logiki formatowania w chat.js/dashboard.js/
// summaries.js. `lat`/`lon` są opcjonalne - jeśli pominięte lub nieprawidłowe,
// używana jest domyślna lokalizacja wdrożenia (patrz normalizeCoords). Nigdy
// nie rzuca wyjątku - w najgorszym razie zwraca fragment bez danych
// pogodowych, żeby generowanie porady AI nigdy nie padło z powodu
// zewnętrznego API pogodowego.
async function getWeatherAndTimeContext(language = 'pl', lat, lon) {
  const coords = normalizeCoords(lat, lon) || { lat: LAT, lon: LON };

  const wallClock = getWarsawWallClock();
  const weekday = language === 'en' ? WEEKDAYS_EN[wallClock.getUTCDay()] : WEEKDAYS_PL[wallClock.getUTCDay()];
  const hour = wallClock.getUTCHours();
  const minute = wallClock.getUTCMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayPart = getDayPart(hour, language);

  const weather = await fetchCurrentWeather(coords.lat, coords.lon);
  const descriptions = language === 'en' ? WEATHER_CODE_DESCRIPTIONS_EN : WEATHER_CODE_DESCRIPTIONS_PL;
  const weatherDesc = weather && weather.weatherCode !== null
    ? (descriptions[weather.weatherCode] || (language === 'en' ? 'unknown conditions' : 'nieznane warunki'))
    : null;

  if (language === 'en') {
    const weatherLine = weather
      ? `Current weather: ${weatherDesc || 'unknown'}, ${weather.temperatureC ?? '?'}°C, humidity ${weather.humidityPct ?? '?'}%, wind ${weather.windKph ?? '?'} km/h${weather.precipitationMm ? `, precipitation ${weather.precipitationMm}mm` : ''}.`
      : 'Current weather: unavailable right now.';
    return `- Current date/time: ${weekday}, ${timeStr} (${dayPart})\n- ${weatherLine} Take this into account where relevant (e.g. extra hydration on hot/humid days, warming meals in cold weather, workout timing relative to time of day) - but only mention it if it's actually relevant to the recommendation.`;
  }

  const weatherLine = weather
    ? `Aktualna pogoda: ${weatherDesc || 'nieznane'}, ${weather.temperatureC ?? '?'}°C, wilgotność ${weather.humidityPct ?? '?'}%, wiatr ${weather.windKph ?? '?'} km/h${weather.precipitationMm ? `, opady ${weather.precipitationMm}mm` : ''}.`
    : 'Aktualna pogoda: chwilowo niedostępna.';
  return `- Aktualna data/czas: ${weekday}, ${timeStr} (${dayPart})\n- ${weatherLine} Uwzględnij to tam, gdzie ma to znaczenie (np. dodatkowe nawodnienie w upał/wysoką wilgotność, rozgrzewające posiłki przy zimnie, dobór pory na trening względem pory dnia) - ale wspomnij o tym tylko, jeśli faktycznie wpływa na rekomendację.`;
}

// Zwraca nadpisaną przez użytkownika lokalizację (patrz "Lokalizacja" w
// Ustawieniach na froncie, zapisywana jako zwykłe klucze w tabeli `settings`:
// weather_lat/weather_lon) albo null, jeśli użytkownik nie ustawił własnej
// lokalizacji / ją wyczyścił / wartość jest uszkodzona - w każdym z tych
// przypadków getWeatherAndTimeContext użyje domyślnej lokalizacji wdrożenia.
//
// UWAGA: celowo NIE korzysta z generycznego obiektu `settings` budowanego w
// chat.js/dashboard.js (`Number(r.value)` dla KAŻDEGO klucza) - dla pustego
// stringa (użytkownik wyczyścił lokalizację) `Number('')` daje 0, więc lat/lon
// wyszłyby jako (0, 0) zamiast "brak nadpisania". Odczyt bezpośrednio z bazy +
// normalizeCoords (która explicit odrzuca (0, 0) i puste/nie-liczbowe wartości)
// unika tej pułapki.
async function getUserLocationOverride(userId) {
  const rows = await db.all(
    `SELECT key, value FROM settings WHERE user_id = ? AND key IN ('weather_lat', 'weather_lon')`,
    [userId]
  );
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  if (map.weather_lat === undefined || map.weather_lon === undefined) return null;
  return normalizeCoords(map.weather_lat, map.weather_lon);
}

// Ręczna "łatka" dla miejscowości, których nie ma w bazie Open-Meteo Geocoding
// (opartej na GeoNames - sprawdzone, że pomija małe wsie typu Malin). Dopisywane
// tu tylko pojedynczo, na wyraźne życzenie (np. wieś, w której faktycznie mieszka
// użytkownik aplikacji) - współrzędne z Wikipedii/OSM, nie zgadywane. Dopasowanie
// po znormalizowanej, dokładnej nazwie (nie substring), żeby nie przesłaniać
// przypadkiem trafniejszych wyników z Open-Meteo dla podobnie brzmiących zapytań.
const MANUAL_GEOCODING_OVERRIDES = {
  'malin': [{
    name: 'Malin',
    admin1: 'Województwo dolnośląskie (gmina Wisznia Mała, powiat trzebnicki)',
    country: 'Polska',
    latitude: 51.21889,
    longitude: 17.06417
  }]
};

// Geokodowanie nazwy miejscowości -> lista kandydatów (Open-Meteo Geocoding API,
// bez klucza). Używane przez GET /api/settings/geocode-location, żeby użytkownik
// mógł wyszukać i wybrać swoją lokalizację w Ustawieniach zamiast wpisywać
// współrzędne ręcznie. Nazwy bywają niejednoznaczne (ta sama nazwa miejscowości
// istnieje w wielu krajach), dlatego zwracamy kilku kandydatów do wyboru, nie
// automatycznie pierwszy wynik.
async function geocodeLocation(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const cached = geocodingCache.get(normalized);
  if (cached && (Date.now() - cached.fetchedAt) < GEOCODING_CACHE_TTL_MS) {
    return cached.results;
  }

  const params = new URLSearchParams({ name: query.trim(), count: '8', language: 'pl', format: 'json' });
  const resp = await fetchWithTimeout(`${GEOCODING_URL}?${params.toString()}`, {}, 8000);
  if (!resp.ok) {
    throw new Error(`Open-Meteo Geocoding HTTP ${resp.status}`);
  }
  const json = await resp.json();
  const apiResults = (json.results || []).map(r => ({
    name: r.name,
    admin1: r.admin1 || null,
    country: r.country || null,
    latitude: r.latitude,
    longitude: r.longitude
  }));
  const manualResults = MANUAL_GEOCODING_OVERRIDES[normalized] || [];
  const results = [...manualResults, ...apiResults];
  geocodingCache.set(normalized, { results, fetchedAt: Date.now() });
  return results;
}

module.exports = { getWeatherAndTimeContext, getUserLocationOverride, geocodeLocation };
