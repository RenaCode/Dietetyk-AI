// Run with: npm test  (node:test, part of Node - no test dependency is added)
// This file runs under Node, not in the browser; the eslint config in this package only
// declares browser globals, hence the explicit declaration below.
/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWarsawDateString } from './dates.js';

// The exact instant from the audit's scenario: 20:00 on 22.09 in New York (UTC-4), which
// is already 02:00 on 23.09 in Warsaw.
const TRAVELLING_USER_DINNER = new Date('2026-09-23T00:00:00Z');

// Reproduces the helper the frontend used before the fix - today's date derived from the
// BROWSER's offset. Kept in the test so the divergence is visible rather than asserted
// from memory.
function browserLocalDateString(d) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

test('the date follows Europe/Warsaw, not the device timezone', () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(getWarsawDateString(TRAVELLING_USER_DINNER), '2026-09-23');
    // This is the bug: the old helper filed the meal under 22.09 while the backend's day
    // had already rolled over, so it never entered "today's" server-side balance.
    assert.equal(browserLocalDateString(TRAVELLING_USER_DINNER), '2026-09-22');

    // East of Warsaw the old helper ran ahead instead of behind.
    process.env.TZ = 'Asia/Tokyo';
    const warsawEvening = new Date('2026-09-22T21:30:00Z'); // 23:30 on 22.09 in Warsaw
    assert.equal(getWarsawDateString(warsawEvening), '2026-09-22');
    assert.equal(browserLocalDateString(warsawEvening), '2026-09-23');
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('the output is always the YYYY-MM-DD wire format the API expects', () => {
  assert.match(getWarsawDateString(new Date('2026-01-05T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(getWarsawDateString(new Date('2026-01-05T12:00:00Z')), '2026-01-05');
});

test('the DST boundary is handled by Intl, not by a fixed offset', () => {
  // Poland leaves CEST (UTC+2) for CET (UTC+1) on 25.10.2026 at 03:00 local time.
  assert.equal(getWarsawDateString(new Date('2026-10-24T22:30:00Z')), '2026-10-25'); // 00:30 CEST
  assert.equal(getWarsawDateString(new Date('2026-10-25T23:30:00Z')), '2026-10-26'); // 00:30 CET
});
