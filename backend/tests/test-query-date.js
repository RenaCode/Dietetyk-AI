// Tests for the query-date helpers in utils/dates.js (audit 2026-09-23).
//
// The bug: `?date=` / `body.date` was accepted on the strength of
// `^\d{4}-\d{2}-\d{2}$` alone, and that pattern says nothing about whether the date exists.
// '2026-13-45' matches it, and then went wrong twice over, differently in each caller:
//
//   - routes/chat.js did `new Date(queryDate)` - an Invalid Date, whose toISOString()
//     throws a RangeError. The handler's catch turned that into a 500 telling the user the
//     AI had failed, when the request was simply malformed.
//   - routes/dashboard.js did `Date.UTC(2026, 12, 45)`, which does NOT throw: it rolls over
//     into February 2027. The endpoint answered 200 with a window around a date nobody
//     asked for and reported "no data" - quieter than a crash, and harder to spot.
//
// The fix was applied in BOTH route files, which left two copies of the same validation one
// edit apart from drifting. This suite guards the single implementation they now share, so
// that the next person to read `isCalendarDateString` does not "simplify" it back to the
// regex - a change every shape-based test would still pass.
//
// Run with: node tests/test-query-date.js

const assert = require('assert');
const {
  shiftDate,
  isCalendarDateString,
  resolveQueryDate,
  getLocalDateString
} = require('../utils/dates');

function ok(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

function testRejectsWellShapedNonDates() {
  console.log('\n--- TEST 1: a well-formed string that is not a date is rejected ---');

  // The exact value from the report: it passes the regex, and the two callers failed on it
  // in two different ways.
  ok(!isCalendarDateString('2026-13-45'), "'2026-13-45' is rejected - month 13, day 45");
  ok(!isCalendarDateString('2026-02-30'), "'2026-02-30' is rejected - February has no 30th");
  ok(!isCalendarDateString('2026-00-10'), "'2026-00-10' is rejected - there is no month 0");
  ok(!isCalendarDateString('2026-09-00'), "'2026-09-00' is rejected - there is no day 0");
  ok(!isCalendarDateString('2026-09-31'), "'2026-09-31' is rejected - September has 30 days");
  ok(!isCalendarDateString(''), 'the empty string is rejected');

  // 2026 is not a leap year; 2024 is. A regex cannot tell these two apart at all.
  ok(!isCalendarDateString('2026-02-29'), "'2026-02-29' is rejected - 2026 is not a leap year");
  ok(isCalendarDateString('2024-02-29'), "'2024-02-29' is accepted - 2024 IS a leap year");
}

function testRejectsWrongShapesAndNonStrings() {
  console.log('\n--- TEST 2: wrong shapes and non-strings are rejected ---');
  ok(!isCalendarDateString('abc'), "'abc' is rejected");
  ok(!isCalendarDateString('2026-9-1'), "'2026-9-1' is rejected - unpadded, not the stored format");
  ok(!isCalendarDateString('2026-09-01T00:00:00Z'), 'an ISO timestamp is rejected - the columns hold dates');
  ok(!isCalendarDateString(undefined), 'undefined is rejected (an absent parameter)');
  ok(!isCalendarDateString(null), 'null is rejected');
  ok(!isCalendarDateString(20260901), 'a number is rejected');
  ok(!isCalendarDateString(['2026-09-01']), 'an array is rejected - Express gives arrays for repeated query keys');
}

function testAcceptsRealDates() {
  console.log('\n--- TEST 3: real dates are accepted unchanged ---');
  for (const value of ['2026-09-23', '2026-01-01', '2026-12-31', '2000-02-29', '1999-06-15']) {
    ok(isCalendarDateString(value), `'${value}' is accepted`);
  }
}

function testResolveQueryDate() {
  console.log('\n--- TEST 4: resolveQueryDate keeps a good date and falls back to today ---');
  const today = getLocalDateString();

  ok(resolveQueryDate('2026-09-23') === '2026-09-23', 'a valid date is returned unchanged');
  // Falling back to today rather than throwing or answering 400 is the deliberate choice:
  // it matches what an absent parameter does, and the frontend always sends a good value.
  ok(resolveQueryDate('2026-13-45') === today, "'2026-13-45' falls back to today rather than crashing a handler");
  ok(resolveQueryDate('2026-02-30') === today, "'2026-02-30' falls back to today");
  ok(resolveQueryDate('') === today, 'an empty string falls back to today');
  ok(resolveQueryDate(undefined) === today, 'an absent value falls back to today');

  // The point of the fallback: whatever comes out is always safe to hand to shiftDate,
  // which is the arithmetic that used to throw the RangeError.
  ok(isCalendarDateString(resolveQueryDate('2026-13-45')), 'the fallback is itself a valid calendar date');
}

function testShiftDate() {
  console.log('\n--- TEST 5: shiftDate is calendar arithmetic, not millisecond arithmetic ---');
  ok(shiftDate('2026-09-23', 0) === '2026-09-23', 'a zero shift is the identity');
  ok(shiftDate('2026-09-23', -1) === '2026-09-22', 'one day back');
  ok(shiftDate('2026-09-23', 7) === '2026-09-30', 'seven days forward');
  ok(shiftDate('2026-09-30', 1) === '2026-10-01', 'crossing a month boundary');
  ok(shiftDate('2026-01-01', -1) === '2025-12-31', 'crossing a year boundary backwards');
  ok(shiftDate('2024-02-28', 1) === '2024-02-29', 'a leap day is reached, not skipped');
  ok(shiftDate('2026-02-28', 1) === '2026-03-01', 'and is skipped in a non-leap year');

  // Poland moves its clocks on 2026-03-29 and 2026-10-25. A day is then 23 or 25 hours
  // long, so anything built on "subtract 24h in milliseconds" lands on the wrong calendar
  // day exactly twice a year - the class of bug utils/dates.js exists to prevent.
  ok(shiftDate('2026-03-28', 1) === '2026-03-29', 'the spring clock change does not shift the date');
  ok(shiftDate('2026-03-29', 1) === '2026-03-30', 'nor does the day after it');
  ok(shiftDate('2026-10-25', -1) === '2026-10-24', 'nor does the autumn clock change');

  ok(shiftDate('2026-09-23', -365) === '2025-09-23', 'a long shift stays exact');
}

function main() {
  console.log('=== QUERY DATE TESTS ===');
  try {
    testRejectsWellShapedNonDates();
    testRejectsWrongShapesAndNonStrings();
    testAcceptsRealDates();
    testResolveQueryDate();
    testShiftDate();
    console.log('\n🎉 QUERY DATE TESTS PASSED\n');
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ QUERY DATE TESTS FAILED');
    process.exit(1);
  }
}

main();
