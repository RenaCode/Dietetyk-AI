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
  const date = new Date(timestampSeconds * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
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
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
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

module.exports = {
  getLocalDateString,
  formatDateString,
  timestampToDateString,
  parseHealthAutoExportDate,
  dateObjToLocalDateString,
  getWarsawWallClock,
  getWarsawDayStartMillis
};
