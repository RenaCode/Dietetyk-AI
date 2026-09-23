// Tests for what the AI prompt says about the weather when Open-Meteo is unreachable
// (utils/weatherContext.js).
//
// The bug: the failure branch returned `cached.data` with no age check at all - and `cached`
// is by construction the entry that had just FAILED the freshness test, so during a longer
// outage the prompt kept asserting "Aktualna pogoda: bezchmurnie, 28°C" from a reading of
// arbitrary age. The "chwilowo niedostępna" branch could never run while any entry existed
// for that location, so there was no signal anywhere that the data was not current. Someone
// asking during an evening storm whether to go for a run was answered on that stale reading.
//
// The rule these tests pin down: a reading that is not current is either NAMED as such, with
// the time it was taken, or it is not used at all. This is a health application - "I do not
// know" is more useful than a confident number from three days ago.
//
// Run with: node tests/test-weather-staleness.js

const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

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

// Open-Meteo, under our control: `outage` flips the module between answering and failing the
// way a network error or a 5xx does.
const openMeteo = { outage: false, calls: 0 };

stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async () => {
    openMeteo.calls++;
    if (openMeteo.outage) throw new Error('simulated Open-Meteo outage');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        current: {
          temperature_2m: 28,
          relative_humidity_2m: 40,
          precipitation: 0,
          weather_code: 0,
          wind_speed_10m: 5
        }
      })
    };
  }
});
// weatherContext requires db.js only for the per-user location override, which is not
// exercised here - stubbing it keeps the test free of a database.
stubModule('db.js', { all: async () => [], get: async () => null, run: async () => {} });

const { getWeatherAndTimeContext } = require('../utils/weatherContext');

// A movable clock. weatherContext decides freshness and staleness purely from Date.now(),
// so shifting it is enough to age a cache entry by hours without waiting.
const REAL_NOW = Date.now();
let clockOffsetMs = 0;
Date.now = () => REAL_NOW + clockOffsetMs;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function testFreshReadingIsPresentedAsCurrent() {
  console.log('\n--- TEST: a live reading ---');
  openMeteo.outage = false;
  const context = await getWeatherAndTimeContext('pl', 52.23, 21.01);

  assert(context.includes('Aktualna pogoda: bezchmurnie, 28°C'), 'a successful fetch is presented as the current weather');
  assert(!context.includes('ZMIERZONA OSTATNIO'), 'a live reading carries no stale marker');
}

async function testOutageWithinTheWindowIsLabelledWithItsTime() {
  console.log('\n--- TEST: outage, cached reading still recent ---');
  // Past the 20-minute freshness TTL, so the module tries to refetch - and fails.
  clockOffsetMs += 25 * MINUTE;
  openMeteo.outage = true;

  const context = await getWeatherAndTimeContext('pl', 52.23, 21.01);

  assert(!context.includes('Aktualna pogoda: bezchmurnie'),
    'a reading kept through an outage is NOT presented as the current weather - this is the whole defect');
  assert(context.includes('ZMIERZONA OSTATNIO'), 'the prompt names the reading as the last measurement rather than the current one');
  assert(/ZMIERZONA OSTATNIO o \d{2}:\d{2}/.test(context), 'the prompt states the time the reading was taken, so the model can judge how old it is');
  assert(context.includes('28°C'), 'the measurements themselves are still passed on - recent data is useful, it just must not be mislabelled');
  assert(context.includes('NIE jest pogoda bieżąca'), 'the prompt says outright that this is not the current weather');
}

async function testOutageBeyondTheWindowReportsNoData() {
  console.log('\n--- TEST: outage, cached reading too old ---');
  // Three hours past the observation, well beyond the two-hour limit.
  clockOffsetMs += 3 * HOUR;
  openMeteo.outage = true;

  const context = await getWeatherAndTimeContext('pl', 52.23, 21.01);

  assert(!context.includes('28°C'), 'a reading older than the limit is dropped, not merely relabelled');
  assert(context.includes('chwilowo niedostępna'), 'the prompt says the weather is unavailable');
  assert(context.includes('nie zgaduj'), 'the model is told not to invent the conditions instead');
}

async function testEnglishVariantIsEquallyExplicit() {
  console.log('\n--- TEST: English prompt variant ---');
  // A fresh reading for a second location, then an outage 25 minutes later.
  openMeteo.outage = false;
  await getWeatherAndTimeContext('en', 51.51, -0.13);
  clockOffsetMs += 25 * MINUTE;
  openMeteo.outage = true;

  const context = await getWeatherAndTimeContext('en', 51.51, -0.13);
  assert(!context.includes('Current weather: clear sky'), 'the English variant does not call a stale reading current either');
  assert(/LAST MEASURED at \d{2}:\d{2}/.test(context), 'the English variant states the observation time');
  assert(context.includes('NOT the current weather'), 'the English variant says outright that this is not current');
}

async function testTheFreshPathStillHitsTheNetworkOnlyOncePerTtl() {
  console.log('\n--- TEST: the cache still does its original job ---');
  openMeteo.outage = false;
  const before = openMeteo.calls;
  await getWeatherAndTimeContext('pl', 41.9, 12.5);
  await getWeatherAndTimeContext('pl', 41.9, 12.5);
  assert(openMeteo.calls - before === 1,
    'two requests for the same location inside the TTL still make one Open-Meteo call - the staleness handling must not defeat the cache');
}

async function run() {
  try {
    await testFreshReadingIsPresentedAsCurrent();
    await testOutageWithinTheWindowIsLabelledWithItsTime();
    await testOutageBeyondTheWindowReportsNoData();
    await testEnglishVariantIsEquallyExplicit();
    await testTheFreshPathStillHitsTheNetworkOnlyOncePerTtl();
    console.log('\n✅ ALL WEATHER STALENESS TESTS PASSED');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}

run();
