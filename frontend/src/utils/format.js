// Shared formatting helpers used by several components (Dashboard, Trends,
// ActivityTracker) - extracted so the same logic is not duplicated in three places,
// where one copy could get fixed and the others silently left behind.

// Formats a value in hours (e.g. 7.5) as "7h 30m".
// The input can arrive as null/undefined/NaN (a day with no sync, for instance) - in
// that case we return '--' rather than blowing up on Math.floor(null) -> "0h NaNm".
export function formatHoursMins(hoursDecimal) {
  if (hoursDecimal === null || hoursDecimal === undefined || isNaN(hoursDecimal)) {
    return '--';
  }
  let hours = Math.floor(hoursDecimal);
  let mins = Math.round((hoursDecimal - hours) * 60);
  // Bug fix: for values close to a full hour (e.g. 7.995) Math.round() could yield
  // 60 minutes instead of carrying into the next hour, which displayed as
  // "7h 60m" zamiast "8h 0m".
  if (mins === 60) {
    hours += 1;
    mins = 0;
  }
  return `${hours}h ${mins}m`;
}

// The clock time a meal was logged at, as HH:MM. The backend stores meal timestamps as
// "YYYY-MM-DD HH:MM:SS" Warsaw wall-clock text, so the time is cut out of the string rather
// than parsed: new Date() would read that text in the BROWSER's timezone and shift it for
// anyone not on Polish time. Anything else (an ISO string from an older entry) falls back
// to the browser's formatting. Shared by the meal log and the dashboard's meal tiles.
export function formatMealTime(timestampStr) {
  if (!timestampStr) return '';
  try {
    const parts = timestampStr.split(' ');
    if (parts.length >= 2) {
      return parts[1].substring(0, 5);
    }
    const d = new Date(timestampStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}
