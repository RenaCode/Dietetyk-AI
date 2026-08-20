// The 'current weather and time of day' context injected into AI prompts (the chat and the
// daily dietary advice) - diet and training recommendations make different sense in a
// heatwave (hydration, lighter meals) than in freezing weather (warming meals, a longer
// warm-up), and different sense in the morning than in the evening (suggesting breakfast
// versus dinner, caffeine). Weather comes from Open-Meteo (no API key, the same provider as
// in Ogrodnik-AI - see
// Ogrodnik-AI/app/integrations/weather.py).
//
// Location: Warsaw by default (the application assumes Europe/Warsaw everywhere else
// anyway, see utils/dates.js). Each user can override that default with their own (see
// getUserLocationOverride, the GET /api/settings/geocode-location endpoint in
// routes/account.js and the 'Location' field in Settings on the frontend). A whole
// deployment can also be overridden through the WEATHER_LAT/WEATHER_LON environment
// variables.

const db = require('../db');
const { fetchWithTimeout } = require('./fetchWithTimeout');
const { getWarsawWallClock } = require('./dates');

const DEFAULT_LAT = 52.2297; // Warszawa
const DEFAULT_LON = 21.0122;
const LAT = process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : DEFAULT_LAT;
const LON = process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : DEFAULT_LON;

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// An in-process cache keyed by rounded coordinates - the chat queries this module on EVERY
// user message (potentially many users at once, now with different locations since the
// per-user override was added), so without a cache one active conversation would generate
// dozens of Open-Meteo requests in a few minutes. Weather does not change fast enough to
// warrant refreshing more often than every 20 minutes. Rounding to two decimal places
// (~1 km) groups users with very similar locations under one cache entry, with no real loss
// of weather accuracy.
const CACHE_TTL_MS = 20 * 60 * 1000;
const weatherCache = new Map(); // klucz "lat,lon" -> { data, fetchedAt }
// Prevents parallel Open-Meteo requests for THE SAME location when several users query the
// chat at the same moment with a cold cache.
const inFlightRequests = new Map(); // klucz "lat,lon" -> Promise

// Geocoding (place name -> coordinates) has its own, longer cache - place names essentially
// never change, unlike the weather. The key is the user's normalised query (lowercased,
// trimmed).
const GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const geocodingCache = new Map(); // klucz "query" -> { results, fetchedAt }

// WMO weather codes returned by Open-Meteo (weather_code) - the same codes regardless of
// the response language, so we map them to Polish and English separately.
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

// Validates and normalises a lat/lon pair supplied by the caller (from the user's settings,
// for instance) - rejecting values outside a sensible geographic range rather than passing
// them on to Open-Meteo, which returns an HTTP error for extreme values but, for 0/0,
// returns perfectly 'valid' weather over the Gulf of Guinea. Silently accepting a cleared or
// corrupted location as '0,0' could inject that into the AI prompt unnoticed.
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
      console.error('[WEATHER] Failed to fetch weather from Open-Meteo:', err.message);
      // We do not rethrow - missing weather must not break AI advice generation (see the
      // callers in chat.js, dashboard.js and summaries.js). We return the previously known
      // data for this location if we have it: a transient Open-Meteo outage should not drop
      // the weather context from every subsequent chat message.
      return cached ? cached.data : null;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, requestPromise);
  return requestPromise;
}

// Builds the ready-made text fragment to inject into the AI prompt - combining the current
// time (weekday, hour, part of day) with the current weather in one place, so the formatting
// logic is not duplicated across chat.js, dashboard.js and summaries.js. `lat`/`lon` are
// optional - when omitted or invalid, the deployment's default location is used (see
// normalizeCoords). This never throws: at worst it returns a fragment without weather data,
// so AI advice generation can never fail because of an external weather API.
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

// Returns the user's location override (see 'Location' in Settings on the frontend, stored
// as ordinary keys in the `settings` table: weather_lat/weather_lon), or null when the user
// has not set their own location, has cleared it, or the value is corrupted - in each of
// those cases getWeatherAndTimeContext falls back to the deployment default.
//
// NOTE: this deliberately does NOT use the generic `settings` object built in chat.js and
// dashboard.js (`Number(r.value)` for EVERY key) - for an empty string, meaning the user
// cleared their location, `Number('')` is 0, so lat/lon would come out as (0, 0) rather than
// 'no override'. Reading straight from the database and passing through normalizeCoords,
// which explicitly rejects (0, 0) and empty or non-numeric values, avoids that trap.
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

// A manual patch for places missing from the Open-Meteo geocoding database (which is based
// on GeoNames - confirmed to omit small villages such as Malin). Entries are added here one
// at a time, on explicit request (a village a user actually lives in, for instance), with
// coordinates taken from Wikipedia or OSM rather than guessed. Matching is on the exact
// normalised name, not a substring, so it cannot accidentally shadow better Open-Meteo
// results for similar-sounding queries.
const MANUAL_GEOCODING_OVERRIDES = {
  'malin': [{
    name: 'Malin',
    admin1: 'Województwo dolnośląskie (gmina Wisznia Mała, powiat trzebnicki)',
    country: 'Polska',
    latitude: 51.21889,
    longitude: 17.06417
  }]
};

// Geocoding a place name into a list of candidates (Open-Meteo Geocoding API, no key).
// Used by GET /api/settings/geocode-location so a user can search for and pick their
// location in Settings instead of entering coordinates by hand. Names are often ambiguous -
// the same place name exists in several countries - which is why we return several
// candidates to choose from rather than
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
