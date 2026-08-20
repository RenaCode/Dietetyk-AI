// Testy arytmetyki dat w strefie Europe/Warsaw (utils/dates.js).
//
// Ta klasa błędów jest wyjątkowo kosztowna, bo nie wywala aplikacji - dane po
// prostu lądują pod złym dniem. Wcześniej okno pobierania z Google Fit zaczynało
// się od "teraz minus 7 dni", a kubełki dobowe w dataset:aggregate są wyrównane do
// PUNKTU STARTU - czyli każda doba biegła od bieżącej godziny (np. 14:00-14:00),
// a nie od północy. Sumy tygodniowe wychodziły z tego mniej więcej poprawne, więc
// błąd był niewidoczny, ale insighty czasowe (meal-timing-sleep, sedentary-sleep,
// early-strain-alert) dostawały aktywność przypisaną do złego dnia.

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
  console.log('\n--- TEST 1: początek doby wypada dokładnie o północy w Warszawie ---');

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
  console.log('✅ Każdy początek doby wypada o 00:00:00 czasu warszawskiego.');
}

function testCalendarShiftNotMillisecondShift() {
  console.log('\n--- TEST 2: przesunięcie liczone w kalendarzu, nie w milisekundach ---');

  // Doba zmiany czasu ma 23 lub 25 godzin - odejmowanie stałej liczby milisekund
  // rozjechałoby się właśnie tutaj.
  const base = new Date('2026-10-27T10:00:00Z');
  const start = getWarsawDayStartMillis(base, -7);
  const expected = getWarsawDayStartMillis(new Date('2026-10-20T10:00:00Z'), 0);

  console.log(`  -7 dni od 2026-10-27 -> ${warsawFormat(new Date(start))}`);
  assert.strictEqual(start, expected, 'Przesunięcie o 7 dni przez zmianę czasu dało inny dzień.');

  // 22:00 UTC 31 grudnia to 23:00 czasu warszawskiego TEGO SAMEGO dnia,
  // więc +1 dzień musi dać 1 stycznia następnego roku.
  const forward = getWarsawDayStartMillis(new Date('2026-12-31T22:00:00Z'), 1);
  console.log(`  +1 dzień przez przełom roku -> ${warsawFormat(new Date(forward))}`);
  assert.ok(warsawFormat(new Date(forward)).startsWith('2027-01-01'),
    `Przekroczenie granicy roku dało ${warsawFormat(new Date(forward))} zamiast 2027-01-01.`);

  // Kontrola z drugiej strony granicy: 23:30 UTC to w Polsce już 1 stycznia,
  // więc +1 dzień to 2 stycznia. Bez przeliczenia strefy oba przypadki
  // dałyby ten sam wynik i błąd przeszedłby niezauważony.
  const acrossMidnight = getWarsawDayStartMillis(new Date('2026-12-31T23:30:00Z'), 1);
  console.log(`  +1 dzień zza północy warszawskiej -> ${warsawFormat(new Date(acrossMidnight))}`);
  assert.ok(warsawFormat(new Date(acrossMidnight)).startsWith('2027-01-02'),
    `Oczekiwano 2027-01-02, było ${warsawFormat(new Date(acrossMidnight))}.`);

  console.log('✅ Przesunięcia przechodzą przez zmianę czasu i przełom roku.');
}

function testBucketLabellingSurvivesDstChange() {
  console.log('\n--- TEST 3: etykietowanie kubełków po ŚRODKU przeżywa zmianę czasu ---');

  // Odtworzenie tego, co robi services/sync.js: okno od północy warszawskiej,
  // kubełki po sztywne 24h (tak działa Google Fit bucketByTime), etykieta z
  // punktu środkowego kubełka.
  const now = new Date('2026-10-27T10:00:00Z'); // tydzień obejmuje zmianę czasu 25.10
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

  // Etykiety muszą być kolejnymi dniami kalendarzowymi, bez luk.
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
  // 23:30 UTC w styczniu to już 00:30 następnego dnia w Polsce.
  const late = new Date('2026-01-15T23:30:00Z');
  assert.strictEqual(dateObjToLocalDateString(late), '2026-01-16',
    'Data nocna nie została przeliczona na strefę warszawską.');
  console.log(`  2026-01-15T23:30:00Z -> ${dateObjToLocalDateString(late)}`);
  console.log('✅ Formatowanie niezależne od strefy procesu Node.');
}

function main() {
  console.log('=== TESTY ARYTMETYKI DAT (Europe/Warsaw) ===');
  try {
    testMidnightAlignment();
    testCalendarShiftNotMillisecondShift();
    testBucketLabellingSurvivesDstChange();
    testLocalDateStringMatchesWarsaw();
    console.log('\n✅ WSZYSTKIE TESTY DAT PRZESZŁY.\n');
  } catch (err) {
    console.error('\n❌ TEST NIE PRZESZEDŁ:', err.message);
    process.exit(1);
  }
}

main();
