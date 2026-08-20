// Testy arytmetyki dat w strefie Europe/Warsaw (utils/dates.js).
//
// This class of bug is unusually expensive because it does not crash anything - the data
// simply lands under the wrong day. The Google Fit fetch window used to start at "now minus
// 7 days", and the daily buckets in dataset:aggregate are aligned to the START POINT - so
// each day ran from the current hour (14:00-14:00, say) rather than from midnight. Weekly
// totals came out roughly correct, which kept the bug invisible, while the time-based
// insights (meal-timing-sleep, sedentary-sleep, early-strain-alert) received activity
// attributed to the wrong day.

const assert = require('assert');
const {
  getWarsawDayStartMillis,
  dateObjToLocalDateString,
  timestampToDateString
} = require('../utils/dates');

const warsawFormat = (date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'medium'
}).format(date);

function testMidnightAlignment() {
  console.log('\n--- TEST 1: the day start falls exactly at midnight in Warsaw ---');

  const cases = [
    { when: '2026-08-20T12:00:00Z', label: 'czas letni, południe UTC' },
    { when: '2026-01-15T23:30:00Z', label: 'czas zimowy, po 23 UTC (w PL już jutro)' },
    { when: '2026-01-01T00:30:00Z', label: 'zaraz po północy UTC, przełom roku' },
    { when: '2026-03-29T05:00:00Z', label: 'dzień zmiany czasu na letni' },
    { when: '2026-10-25T05:00:00Z', label: 'dzień zmiany czasu na zimowy' }
  ];

  for (const { when, label } of cases) {
    for (const delta of [0, -7, 1]) {
      const ms = getWarsawDayStartMillis(new Date(when), delta);
      const rendered = warsawFormat(new Date(ms));
      assert.ok(rendered.endsWith('00:00:00'),
        `${label}, delta=${delta}: początek doby to ${rendered}, a nie północ.`);
    }
    console.log(`  ${label}: OK`);
  }
  console.log('✅ Every day start falls at 00:00:00 Warsaw time.');
}

function testCalendarShiftNotMillisecondShift() {
  console.log('\n--- TEST 2: the shift is computed in the calendar, not in milliseconds ---');

  // A DST changeover day is 23 or 25 hours long - subtracting a fixed number of
  // milliseconds is exactly what would drift here.
  const base = new Date('2026-10-27T10:00:00Z');
  const start = getWarsawDayStartMillis(base, -7);
  const expected = getWarsawDayStartMillis(new Date('2026-10-20T10:00:00Z'), 0);

  console.log(`  -7 dni od 2026-10-27 -> ${warsawFormat(new Date(start))}`);
  assert.strictEqual(start, expected, 'Przesunięcie o 7 dni przez zmianę czasu dało inny dzień.');

  // 22:00 UTC on 31 December is 23:00 Warsaw time on THE SAME day, so +1 day must give
  // 1 January of the following year.
  const forward = getWarsawDayStartMillis(new Date('2026-12-31T22:00:00Z'), 1);
  console.log(`  +1 day across the year boundary -> ${warsawFormat(new Date(forward))}`);
  assert.ok(warsawFormat(new Date(forward)).startsWith('2027-01-01'),
    `Przekroczenie granicy roku dało ${warsawFormat(new Date(forward))} zamiast 2027-01-01.`);

  // The check from the other side of the boundary: 23:30 UTC is already 1 January in
  // Poland, so +1 day is 2 January. Without the timezone conversion both cases would give
  // the same result and the bug would pass unnoticed.
  const acrossMidnight = getWarsawDayStartMillis(new Date('2026-12-31T23:30:00Z'), 1);
  console.log(`  +1 day from past Warsaw midnight -> ${warsawFormat(new Date(acrossMidnight))}`);
  assert.ok(warsawFormat(new Date(acrossMidnight)).startsWith('2027-01-02'),
    `Oczekiwano 2027-01-02, było ${warsawFormat(new Date(acrossMidnight))}.`);

  console.log('✅ Shifts survive the DST change and the year boundary.');
}

function testBucketLabellingSurvivesDstChange() {
  console.log('\n--- TEST 3: labelling buckets by MIDPOINT survives the DST change ---');

  // Reproduces what services/sync.js does: a window starting at Warsaw midnight, fixed 24h
  // buckets (as Google Fit's bucketByTime works), labelled from the bucket midpoint.
  const now = new Date('2026-10-27T10:00:00Z'); // the week spans the 25 Oct DST change
  const start = getWarsawDayStartMillis(now, -7);

  const labels = [];
  for (let i = 0; i < 7; i++) {
    const bucketStart = start + i * 86400000;
    const bucketEnd = bucketStart + 86400000;
    const midpoint = bucketStart + (bucketEnd - bucketStart) / 2;
    labels.push(timestampToDateString(Math.floor(midpoint / 1000)));
  }

  console.log(`  etykiety: ${labels.join(', ')}`);

  const unique = new Set(labels);
  assert.strictEqual(unique.size, labels.length,
    `Dwa kubełki dostały tę samą datę - dane jednego dnia nadpisałyby drugi: ${labels.join(', ')}`);

  // The labels must be consecutive calendar days, with no gaps.
  for (let i = 1; i < labels.length; i++) {
    const prev = new Date(`${labels[i - 1]}T00:00:00Z`);
    const curr = new Date(`${labels[i]}T00:00:00Z`);
    const diffDays = (curr - prev) / 86400000;
    assert.strictEqual(diffDays, 1,
      `Przerwa lub cofnięcie między ${labels[i - 1]} a ${labels[i]}.`);
  }
  console.log('✅ Siedem kolejnych, unikalnych dni mimo zmiany czasu w oknie.');
}

function testLocalDateStringMatchesWarsaw() {
  console.log('\n--- TEST 4: formatowanie daty zawsze w Europe/Warsaw ---');
  // 23:30 UTC in January is already 00:30 the next day in Poland.
  const late = new Date('2026-01-15T23:30:00Z');
  assert.strictEqual(dateObjToLocalDateString(late), '2026-01-16',
    'Data nocna nie została przeliczona na strefę warszawską.');
  console.log(`  2026-01-15T23:30:00Z -> ${dateObjToLocalDateString(late)}`);
  console.log('✅ Formatting independent of the Node process timezone.');
}

function main() {
  console.log('=== DATE ARITHMETIC TESTS (Europe/Warsaw) ===');
  try {
    testMidnightAlignment();
    testCalendarShiftNotMillisecondShift();
    testBucketLabellingSurvivesDstChange();
    testLocalDateStringMatchesWarsaw();
    console.log('\n✅ ALL DATE TESTS PASSED.\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    process.exit(1);
  }
}

main();
