// Tests for the bedtime / wake time columns (sleep_start, sleep_end, sleep_times_source) -
// see utils/sleepTimes.js for the rules they pin down.
//
// Before these columns existed the Apple Health webhook parsed every sleep fragment's start
// and end and threw them away after computing a duration, and the Oura sync never read
// bedtime_start/bedtime_end. The cases below are the ones that make "store the night's
// times" harder than it sounds:
//  - a night recorded as many stage segments, crossing midnight, with an awakening inside;
//  - a nap on the wake-up day, which must not become the wake time;
//  - the night clocks go back (25.10.2026), when 02:00-03:00 happens twice and comparing the
//    stored strings instead of the instants gives the wrong order;
//  - the same night arriving in pieces over several webhook requests;
//  - Oura and Apple writing the same night, where Oura wins but a nap-only Oura day must not
//    erase Apple's night;
//  - a database from before this change (the columns appear on start, old rows survive).
//
// Run with: node tests/test-sleep-times.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-sleep-times-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-sleep-times';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-sleep-times';

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

// The fake Oura API, keyed by the endpoint name in the URL (same harness as
// tests/test-oura-readiness.js).
const ouraResponses = {};
stubModule('services/oauthHelpers.js', {
  getOrRefreshToken: async () => 'fake-oura-access-token',
  getUserSetting: async () => null
});
stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async (url) => {
    const endpoint = url.split('/usercollection/')[1].split('?')[0];
    const body = ouraResponses[endpoint] || { data: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
});

const express = require('express');
const db = require('../db');
const { toWarsawIsoString, formatDateString, getWarsawDayStartMillis, dateObjToLocalDateString } = require('../utils/dates');
const { mainSleepBlocksByDay, ouraMainSleepTimes } = require('../utils/sleepTimes');
const { syncOura } = require('../services/sync');

const USER_ID = 1;
const HOUR = 60 * 60 * 1000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(require('../routes/appleHealth'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let baseUrl;
let syncToken;

async function postSleep(entries) {
  const res = await fetch(`${baseUrl}/api/integrations/apple-health/${syncToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { metrics: [{ name: 'sleep_analysis', data: entries }] } })
  });
  assert(res.status === 200, `webhook accepted the sleep payload (status ${res.status})`);
}

function readDay(date) {
  return db.get('SELECT * FROM health_metrics WHERE user_id = ? AND date = ?', [USER_ID, date]);
}

const seg = (startDate, endDate, value) => ({ startDate, endDate, value });

async function testMigrationOnExistingDatabase() {
  console.log('\n--- TEST 1: a database from before this change gains the columns and keeps its rows ---');
  // Production has every earlier migration applied and none of these three columns. Dropping
  // them from a fully migrated database reproduces exactly that schema.
  for (const column of ['sleep_start', 'sleep_end', 'sleep_times_source']) {
    await db.run(`ALTER TABLE health_metrics DROP COLUMN ${column}`);
  }
  await db.run(
    `INSERT INTO health_metrics (user_id, date, sleep_duration, sleep_score, steps) VALUES (?, '2026-01-10', 7.4, 88, 9000)`,
    [USER_ID]
  );
  const before = (await db.all('PRAGMA table_info(health_metrics)')).map(c => c.name);
  assert(!before.includes('sleep_start'), 'precondition: the legacy schema has no sleep_start');

  await db.initDb();
  const after = (await db.all('PRAGMA table_info(health_metrics)')).map(c => c.name);
  assert(['sleep_start', 'sleep_end', 'sleep_times_source'].every(c => after.includes(c)),
    'initDb adds sleep_start, sleep_end and sleep_times_source to an existing table');
  const row = await readDay('2026-01-10');
  assert(row.sleep_duration === 7.4 && row.sleep_score === 88 && row.steps === 9000,
    'the existing row keeps its data');
  assert(row.sleep_start === null && row.sleep_end === null && row.sleep_times_source === null,
    'the existing row reads as "times unknown" (no invented backfill)');

  await db.initDb();
  console.log('✅ a second initDb is a no-op (the migration is idempotent)');
}

function testWarsawIsoAcrossDst() {
  console.log('\n--- TEST 2: instants are written with the Warsaw offset of their own moment ---');
  assert(toWarsawIsoString(new Date('2026-10-25T00:30:00Z')) === '2026-10-25T02:30:00+02:00',
    'the first 02:30 of 25.10.2026 is +02:00');
  assert(toWarsawIsoString(new Date('2026-10-25T01:30:00Z')) === '2026-10-25T02:30:00+01:00',
    'the second 02:30 of 25.10.2026 is +01:00');
  assert(toWarsawIsoString(new Date('2026-03-29T01:30:00Z')) === '2026-03-29T03:30:00+02:00',
    'spring forward: 01:30Z on 29.03.2026 is 03:30+02:00');
  // KNOWN-BAD SAMPLE for any reader that compares the stored strings: the later instant sorts
  // first. utils/sleepTimes.js uses julianday() for exactly this reason.
  const earlier = toWarsawIsoString(new Date('2026-10-25T00:30:00Z'));
  const later = toWarsawIsoString(new Date('2026-10-25T01:15:00Z'));
  assert(later < earlier && Date.parse(later) > Date.parse(earlier),
    `string order is wrong across the change (${later} < ${earlier}), instant order is right`);
}

function testBlockRule() {
  console.log('\n--- TEST 3: fragments -> main block per wake-up day ---');
  const d = (s) => new Date(s);
  const blocks = mainSleepBlocksByDay([
    { start: d('2026-09-20T23:10:00+02:00'), end: d('2026-09-20T23:55:00+02:00'), asleepHours: 0.75 },
    { start: d('2026-09-20T23:55:00+02:00'), end: d('2026-09-21T03:00:00+02:00'), asleepHours: 3.08 },
    // 40 minutes awake at 3 a.m. - still the same night
    { start: d('2026-09-21T03:40:00+02:00'), end: d('2026-09-21T06:50:00+02:00'), asleepHours: 3.17 },
    // afternoon nap on the wake-up day
    { start: d('2026-09-21T14:00:00+02:00'), end: d('2026-09-21T14:40:00+02:00'), asleepHours: 0.67 }
  ], dateObjToLocalDateString);
  assert(Object.keys(blocks).join(',') === '2026-09-21',
    'the segment that ends before midnight does not create a "night" on the previous day');
  assert(toWarsawIsoString(blocks['2026-09-21'].start) === '2026-09-20T23:10:00+02:00'
    && toWarsawIsoString(blocks['2026-09-21'].end) === '2026-09-21T06:50:00+02:00',
    'bedtime = earliest start, wake = latest end of the main block; the nap is ignored');
}

async function testAppleSegmentsWithNap() {
  console.log('\n--- TEST 4: webhook, stage segments across midnight + awakening + nap ---');
  await postSleep([
    seg('2026-09-20 23:10:00 +0200', '2026-09-20 23:55:00 +0200', 'Core'),
    seg('2026-09-20 23:55:00 +0200', '2026-09-21 00:40:00 +0200', 'Deep'),
    seg('2026-09-21 00:40:00 +0200', '2026-09-21 03:00:00 +0200', 'Core'),
    seg('2026-09-21 03:00:00 +0200', '2026-09-21 03:20:00 +0200', 'Awake'),
    seg('2026-09-21 03:20:00 +0200', '2026-09-21 06:30:00 +0200', 'Core'),
    seg('2026-09-21 06:30:00 +0200', '2026-09-21 06:50:00 +0200', 'REM'),
    seg('2026-09-21 14:00:00 +0200', '2026-09-21 14:40:00 +0200', 'Core')
  ]);
  const row = await readDay('2026-09-21');
  assert(row.sleep_start === '2026-09-20T23:10:00+02:00', `bedtime 23:10 (got ${row.sleep_start})`);
  assert(row.sleep_end === '2026-09-21T06:50:00+02:00', `wake time 06:50, not the nap's 14:40 (got ${row.sleep_end})`);
  assert(row.sleep_times_source === 'apple', 'source recorded as apple');
  const prev = await readDay('2026-09-20');
  assert(!prev || prev.sleep_start === null, 'no times on the evening before the wake-up day');
}

async function testAppleAggregatedEntry() {
  console.log('\n--- TEST 5: webhook, aggregated entry - asleep window, not in-bed window ---');
  await postSleep([{
    date: '2026-09-23 00:00:00 +0200',
    inBedStart: '2026-09-22 23:05:00 +0200', inBedEnd: '2026-09-23 07:00:00 +0200',
    sleepStart: '2026-09-22 23:30:00 +0200', sleepEnd: '2026-09-23 06:45:00 +0200',
    core: 4.5, deep: 1.2, rem: 1.3, awake: 0.25, totalSleep: 7, inBed: 7.9
  }]);
  const row = await readDay('2026-09-23');
  assert(row.sleep_start === '2026-09-22T23:30:00+02:00' && row.sleep_end === '2026-09-23T06:45:00+02:00',
    `times come from sleepStart/sleepEnd (got ${row.sleep_start} - ${row.sleep_end})`);

  // A nap exported on its own later the same day must not replace the night.
  await postSleep([seg('2026-09-23 15:00:00 +0200', '2026-09-23 15:40:00 +0200', 'Core')]);
  const after = await readDay('2026-09-23');
  assert(after.sleep_start === '2026-09-22T23:30:00+02:00' && after.sleep_end === '2026-09-23T06:45:00+02:00',
    `a separate later nap keeps the night (got ${after.sleep_start} - ${after.sleep_end})`);
}

async function testAppleNightInPieces() {
  console.log('\n--- TEST 6: webhook, the same night sent in pieces across requests ---');
  await postSleep([seg('2026-09-25 23:00:00 +0200', '2026-09-26 03:00:00 +0200', 'Core')]);
  let row = await readDay('2026-09-26');
  assert(row.sleep_end === '2026-09-26T03:00:00+02:00', 'the 03:00 export stores the night so far');
  await postSleep([
    seg('2026-09-25 23:00:00 +0200', '2026-09-26 03:00:00 +0200', 'Core'),
    seg('2026-09-26 03:00:00 +0200', '2026-09-26 07:10:00 +0200', 'Core')
  ]);
  row = await readDay('2026-09-26');
  assert(row.sleep_start === '2026-09-25T23:00:00+02:00' && row.sleep_end === '2026-09-26T07:10:00+02:00',
    `the morning export extends it to 07:10 (got ${row.sleep_start} - ${row.sleep_end})`);

  // Nap stored first, night afterwards: the longer, separate sleep takes over.
  await postSleep([seg('2026-09-28 13:00:00 +0200', '2026-09-28 13:30:00 +0200', 'Core')]);
  await postSleep([seg('2026-09-27 23:20:00 +0200', '2026-09-28 06:40:00 +0200', 'Core')]);
  row = await readDay('2026-09-28');
  assert(row.sleep_start === '2026-09-27T23:20:00+02:00' && row.sleep_end === '2026-09-28T06:40:00+02:00',
    `a night arriving after a nap replaces it (got ${row.sleep_start} - ${row.sleep_end})`);

  // A watch with no stages: in-bed only. Every spelling of the stage name must be recognised -
  // the matcher used to miss "In Bed" (with a space), which then counted for nothing.
  const spellings = ['In Bed', 'in_bed', 'inBed', 'inbed', 'IN-BED'];
  for (let i = 0; i < spellings.length; i++) {
    // August, far from today's date, which TEST 8 uses for the Oura sync window.
    const wake = `2026-08-1${i + 1}`;
    const evening = `2026-08-1${i}`;
    await postSleep([seg(`${evening} 22:50:00 +0200`, `${wake} 06:40:00 +0200`, spellings[i])]);
    row = await readDay(wake);
    assert(row.sleep_start === `${evening}T22:50:00+02:00` && row.sleep_end === `${wake}T06:40:00+02:00`,
      `in-bed fallback recognises "${spellings[i]}" (got ${row.sleep_start} - ${row.sleep_end})`);
    assert(row.sleep_duration === 7.8,
      `"${spellings[i]}" also feeds the sleep_duration in-bed fallback (got ${row.sleep_duration})`);
  }
}

async function testAppleDstNight() {
  console.log('\n--- TEST 7: webhook, the night clocks go back (24 -> 25.10.2026) ---');
  // Two pieces, sent in REVERSE order in separate requests. 02:30+02:00 is 00:30Z and
  // 02:15+01:00 is 01:15Z: 45 minutes apart, one night. As strings "02:15" < "02:30", which
  // would make the second piece look like it overlaps the first by a quarter of an hour.
  await postSleep([seg('2026-10-25 02:15:00 +0100', '2026-10-25 07:00:00 +0100', 'Core')]);
  await postSleep([seg('2026-10-24 23:00:00 +0200', '2026-10-25 02:30:00 +0200', 'Core')]);
  let row = await readDay('2026-10-25');
  assert(row.sleep_start === '2026-10-24T23:00:00+02:00', `bedtime keeps its summer offset (got ${row.sleep_start})`);
  assert(row.sleep_end === '2026-10-25T07:00:00+01:00', `wake time keeps its winter offset (got ${row.sleep_end})`);
  assert((Date.parse(row.sleep_end) - Date.parse(row.sleep_start)) / HOUR === 9,
    'the stored pair spans 9 real hours (the clock shows 8)');

  // The same night in one payload attributes the whole night to the wake-up day.
  await db.run('DELETE FROM health_metrics WHERE user_id = ? AND date IN (?, ?)', [USER_ID, '2026-10-24', '2026-10-25']);
  await postSleep([
    seg('2026-10-24 23:00:00 +0200', '2026-10-24 23:50:00 +0200', 'Core'),
    seg('2026-10-25 00:05:00 +0200', '2026-10-25 02:30:00 +0200', 'Deep'),
    seg('2026-10-25 02:15:00 +0100', '2026-10-25 07:00:00 +0100', 'Core')
  ]);
  row = await readDay('2026-10-25');
  assert(row.sleep_start === '2026-10-24T23:00:00+02:00' && row.sleep_end === '2026-10-25T07:00:00+01:00',
    `single payload: 23:00+02:00 - 07:00+01:00 (got ${row.sleep_start} - ${row.sleep_end})`);
}

async function testOuraLongSleepAndPriority() {
  console.log('\n--- TEST 8: Oura long_sleep vs nap, and oura > apple ---');
  // syncOura only looks at the last 7 days, so this test works on today's Warsaw date.
  const DAY = formatDateString(new Date());
  const midnight = getWarsawDayStartMillis(new Date());
  const at = (h) => new Date(midnight + h * HOUR);
  const iso = (h) => toWarsawIsoString(at(h));

  // Overnight the Apple webhook stores the night.
  await postSleep([seg(iso(-1), iso(6.5), 'Core')]);
  let row = await readDay(DAY);
  assert(row.sleep_times_source === 'apple' && row.sleep_start === iso(-1), 'Apple wrote the night first');

  // syncOura writes a day only when it has a score, steps or readiness for it.
  ouraResponses.daily_sleep = { data: [{ day: DAY, score: 80 }] };

  // The ring recorded only a nap that day: Apple's night stays.
  const nap = { day: DAY, type: 'sleep', bedtime_start: iso(13), bedtime_end: iso(13.5), total_sleep_duration: 1500, latency: 120 };
  ouraResponses.sleep = { data: [nap] };
  assert((await syncOura(USER_ID)).success, 'nap-only Oura sync succeeds');
  row = await readDay(DAY);
  assert(row.sleep_start === iso(-1) && row.sleep_end === iso(6.5) && row.sleep_times_source === 'apple',
    `a nap-only Oura day does not erase or replace Apple's night (got ${row.sleep_start} - ${row.sleep_end}, ${row.sleep_times_source})`);

  // Now the ring has the night, split in two long_sleep records 40 min apart, plus the nap.
  ouraResponses.sleep = {
    data: [
      { day: DAY, type: 'long_sleep', bedtime_start: iso(-1.5), bedtime_end: iso(2), total_sleep_duration: 11000, latency: 900 },
      { day: DAY, type: 'long_sleep', bedtime_start: iso(2 + 40 / 60), bedtime_end: iso(7), total_sleep_duration: 14000, latency: 300 },
      nap
    ]
  };
  assert((await syncOura(USER_ID)).success, 'Oura sync with long_sleep succeeds');
  row = await readDay(DAY);
  assert(row.sleep_start === toWarsawIsoString(new Date(at(-1.5).getTime() + 900 * 1000)),
    `bedtime = first long_sleep bedtime_start + latency (got ${row.sleep_start})`);
  assert(row.sleep_end === iso(7), `wake time = last long_sleep bedtime_end, not the nap (got ${row.sleep_end})`);
  assert(row.sleep_times_source === 'oura', 'Oura replaced Apple as the source of the pair');

  // Apple re-sends its night afterwards: Oura's pair is kept.
  await postSleep([seg(iso(-1), iso(6.5), 'Core')]);
  row = await readDay(DAY);
  assert(row.sleep_times_source === 'oura' && row.sleep_end === iso(7),
    `Apple does not overwrite times Oura wrote (got ${row.sleep_end}, ${row.sleep_times_source})`);

  // A later nap-only Oura sync keeps Oura's own night too.
  ouraResponses.sleep = { data: [nap] };
  await syncOura(USER_ID);
  row = await readDay(DAY);
  assert(row.sleep_end === iso(7), 'a nap-only resync does not erase the night');

  // Unit: no long_sleep -> no times.
  assert(ouraMainSleepTimes([nap]) === null, 'ouraMainSleepTimes ignores naps entirely');
}

async function testHistoryExposesTimes() {
  console.log('\n--- TEST 9: /api/health/history returns the times ---');
  const src = fs.readFileSync(path.join(BACKEND_DIR, 'routes/health.js'), 'utf8');
  const historySelect = src.split("'/api/health/history'")[1].split('FROM health_metrics')[0];
  assert(/\bsleep_start\b/.test(historySelect) && /\bsleep_end\b/.test(historySelect),
    'the history SELECT lists sleep_start and sleep_end');
}

async function main() {
  console.log('=== SLEEP TIMES TESTS ===');
  let server;
  try {
    await db.initDb();
    const user = await db.get('SELECT sync_token FROM users WHERE id = ?', [USER_ID]);
    syncToken = user.sync_token;
    const started = await startServer();
    server = started.server;
    baseUrl = started.baseUrl;

    await testMigrationOnExistingDatabase();
    testWarsawIsoAcrossDst();
    testBlockRule();
    await testAppleSegmentsWithNap();
    await testAppleAggregatedEntry();
    await testAppleNightInPieces();
    await testAppleDstNight();
    await testOuraLongSleepAndPriority();
    await testHistoryExposesTimes();

    console.log('\n🎉 SLEEP TIMES TESTS PASSED\n');
    server.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.stack ? err.stack : err));
    console.error('❌ SLEEP TIMES TESTS FAILED');
    if (server) server.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
