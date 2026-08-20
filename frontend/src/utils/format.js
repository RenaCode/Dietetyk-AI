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
