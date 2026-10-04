// One shared formatter instead of a new Intl.DateTimeFormat per call. Constructing one costs
// ~40 µs (far more on a throttled container), and the Apple Health webhook calls
// dateObjToLocalDateString once per sample: a 300 000-sample export spent ~24 s of a 0.5-CPU
// pod in this constructor alone, blocking the event loop until nginx answered the phone with
// a 504 and the readiness probe pulled the pod (audit 2026-10-02). Formatting is stateless,
// so sharing the instance is safe.
const WARSAW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function getLocalDateString() {
  // NOTE: this used to be computed via d.getTimezoneOffset(), i.e. the timezone of
  // the NODE PROCESS, not of the application. Every other function in this file
  // (timestampToDateString, dateObjToLocalDateString) deliberately forces
  // Europe/Warsaw through Intl.DateTimeFormat, because the app is Polish. On a
  // server/container running in UTC (typical for hosting), this function - used as
  // "today's date" in the dashboard, the chat, the summary scheduler and the sync -
  // returned a date shifted by the timezone difference during roughly 22:00-23:59
  // Europe/Warsaw (when UTC is already on the next day) or 00:00-01:59 (when UTC is
  // still on the previous one), drifting apart from the rest of the date logic.
  return dateObjToLocalDateString(new Date());
}

// Formats a date as YYYY-MM-DD.
// NOTE: this used to be computed via dateObj.getFullYear()/getMonth()/getDate() -
// the timezone of the NODE PROCESS, not Europe/Warsaw. services/sync.js uses this
// function to build date keys (metricsByDate) for Oura data, whose `day` field is
// expressed in the user's/device's local date. On a server running in UTC, during
// the Polish night window, the key computed here did not match the key coming from
// Oura and that day's data was silently lost (metricsByDate[dateStr] was undefined).
// We delegate to dateObjToLocalDateString, which correctly forces Europe/Warsaw -
// like the rest of the functions in this file.
function formatDateString(dateObj) {
  return dateObjToLocalDateString(dateObj);
}

// Converts a Unix timestamp to a YYYY-MM-DD date in the Europe/Warsaw timezone.
function timestampToDateString(timestampSeconds) {
  return WARSAW_DATE_FORMATTER.format(new Date(timestampSeconds * 1000));
}

// Parses a date from the Apple Health webhook (the Health Auto Export app). The app
// sends "yyyy-MM-dd HH:mm:ss Z", e.g. "2024-01-01 12:00:00 +0100" - `new Date()` in
// Node does not parse that reliably (space instead of 'T', offset without a colon),
// so we normalise the string to valid ISO 8601 before parsing.
function parseHealthAutoExportDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  let normalized = dateStr.trim();
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2');
  normalized = normalized.replace(/\s+([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Like timestampToDateString, but takes a Date object rather than Unix seconds -
// used when grouping Apple Health webhook entries into calendar days in Europe/Warsaw.
function dateObjToLocalDateString(date) {
  return WARSAW_DATE_FORMATTER.format(date);
}

// Returns "wall clock" weekday/hour/minute values in the Europe/Warsaw timezone,
// independent of the Node process timezone. Needed everywhere the scheduler
// (scheduler.js) compares the current time against a time the user configured
// (e.g. "send the summary on Monday at 18:00") - those settings are in Polish time,
// while a bare `new Date().getHours()/getDay()` returns the server's timezone
// (typically UTC on hosting), which shifted the schedule by 1-2 hours away from what
// the user intended. The trick: format the date in Europe/Warsaw, then rebuild a new
// Date from those components via Date.UTC - so that the plain getUTCDay()/
// getUTCHours()/getUTCMinutes() getters on the returned object yield Warsaw clock
// values, regardless of which timezone the Node process runs in.
function getWarsawWallClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  return new Date(Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  ));
}

// Returns the timestamp (ms) of Europe/Warsaw midnight for the day `deltaDays` away
// from the given date. Needed wherever an external API splits data into daily buckets
// aligned to the START OF THE WINDOW (Google Fit dataset:aggregate + bucketByTime) -
// passing "now minus N days" would produce days counted from the current hour rather
// than calendar days, and would attribute activity to the wrong day.
//
// Handles daylight saving: a day can be 23 or 25 hours long, so this cannot be
// computed by subtracting a fixed number of milliseconds. Instead we take the
// calendar date in Warsaw, shift it by deltaDays in the calendar, and then look for
// the real UTC instant that falls at 00:00 in Warsaw on that day.
function getWarsawDayStartMillis(date = new Date(), deltaDays = 0) {
  const [year, month, day] = dateObjToLocalDateString(date).split('-').map(Number);

  // Shift in the calendar (not in milliseconds) - Date.UTC normalises crossing
  // month/year boundaries.
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const targetDateStr = shifted.toISOString().slice(0, 10);

  // Warsaw midnight is the UTC instant that, formatted in Europe/Warsaw, yields the
  // target date at hour 00. Poland's offset is +1 or +2 hours, so the candidate
  // "UTC midnight minus offset" sits in a narrow range - we check both variants and
  // pick the one that really lands at 00:00 in Warsaw.
  const utcMidnight = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()
  );
  for (const offsetHours of [1, 2]) {
    const candidate = utcMidnight - offsetHours * 3600 * 1000;
    const wall = getWarsawWallClock(new Date(candidate));
    if (wall.toISOString().slice(0, 10) === targetDateStr && wall.getUTCHours() === 0) {
      return candidate;
    }
  }
  // Should never happen for Europe/Warsaw, but if the timezone rules ever changed,
  // returning UTC midnight beats throwing in the middle of a sync.
  return utcMidnight;
}

// Returns the timestamp (ms) of the next moment, strictly after `now`, when the Warsaw wall
// clock reads `hhmm` ('HH:MM'). Used by the daily backup (server.js), which has to land at a
// fixed hour before the off-site copy picks it up - a setInterval(24 h) counted from process
// start drifted with every restart (audit 04.10.2026, D-12).
//
// Daylight saving: starts from Warsaw midnight of the right calendar day
// (getWarsawDayStartMillis) and then corrects by whatever the wall clock actually shows, so on
// the 23- and 25-hour days 04:30 is still 04:30. A time inside the spring-forward gap
// (02:00-03:00 on the last Sunday of March) does not exist and lands an hour early on that one
// day - harmless for a backup, and the default is outside the gap.
function nextWarsawTimeMillis(hhmm, now = new Date()) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const targetMinutes = hours * 60 + minutes;
  for (let delta = 0; delta <= 2; delta++) {
    let candidate = getWarsawDayStartMillis(now, delta) + targetMinutes * 60 * 1000;
    const wall = getWarsawWallClock(new Date(candidate));
    const wallMinutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
    candidate += (targetMinutes - wallMinutes) * 60 * 1000;
    if (candidate > now.getTime()) return candidate;
  }
  // Unreachable for a valid HH:MM: tomorrow's slot is always in the future.
  return now.getTime() + 24 * 60 * 60 * 1000;
}

// Shifts a 'YYYY-MM-DD' string by N days (negative goes back) using pure calendar
// arithmetic through Date.UTC, so no timezone offset and no daylight-saving hour can move
// the result onto a neighbouring day. Date.UTC normalises the month and year rollover, so
// shiftDate('2026-12-31', 1) is '2027-01-01' without any special case here.
//
// It must be given a real calendar date: on a malformed string the arithmetic produces an
// Invalid Date and toISOString() throws a RangeError, which is how a bad ?date= used to
// surface as a 500. Validate with isCalendarDateString (or go through resolveQueryDate)
// before calling this with anything that came from a request.
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a string that is BOTH shaped like YYYY-MM-DD and a date that exists.
 *
 * THE REGEX ALONE IS NOT ENOUGH, and the difference is not academic - do not "simplify"
 * this back to the pattern test. '2026-13-45' matches `^\d{4}-\d{2}-\d{2}$` perfectly and
 * is not a date. The two ways it then went wrong were both silent in their own way:
 *
 *   - `new Date('2026-13-45')` is an Invalid Date, and toISOString() on it throws a
 *     RangeError. In routes/chat.js that landed in the handler's catch and came back as a
 *     500 telling the user the AI had failed, when the input was simply malformed.
 *   - `Date.UTC(2026, 12, 45)` does NOT throw - it rolls month 13 day 45 over into
 *     February 2027. The dashboard therefore answered 200 with a window around a date
 *     nobody asked for, reporting "no data", which is harder to notice than an error.
 *
 * So the check is a round trip: build the date, format it back, and require the same
 * string. That also rejects 2026-02-30, 2026-00-10 and the other near-misses that are
 * well-formed but do not exist.
 */
function isCalendarDateString(value) {
  if (typeof value !== 'string' || !DATE_STRING_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Resolves the date a request is asking about: the given value when it is a real calendar
 * date, otherwise today in Europe/Warsaw.
 *
 * Takes the RAW VALUE rather than the request object, because the two callers read it from
 * different places - routes/dashboard.js from `req.query.date`, routes/chat.js from
 * `req.body.date`. A helper that reached into `req` itself could serve only one of them,
 * and serving only one is what left two copies of this validation in the first place.
 *
 * A bad value falls back to today instead of producing a 400, matching what happens when
 * the parameter is absent: the frontend always sends a correct value, so a malformed one is
 * a bug in a caller rather than something the user could act on.
 */
function resolveQueryDate(rawDate) {
  return isCalendarDateString(rawDate) ? rawDate : getLocalDateString();
}

module.exports = {
  getLocalDateString,
  formatDateString,
  timestampToDateString,
  parseHealthAutoExportDate,
  dateObjToLocalDateString,
  getWarsawWallClock,
  getWarsawDayStartMillis,
  nextWarsawTimeMillis,
  shiftDate,
  isCalendarDateString,
  resolveQueryDate
};
