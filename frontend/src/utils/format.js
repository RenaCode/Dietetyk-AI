// Wspólne helpery formatujące, używane w wielu komponentach (Dashboard, Trends,
// ActivityTracker) - wydzielone, żeby nie duplikować tej samej logiki w 3 miejscach
// i nie ryzykować, że jedna kopia zostanie poprawiona, a inne nie.

// Formatowanie wartości w godzinach (np. 7.5) do postaci "7h 30m".
// Wejście może przyjść jako null/undefined/NaN (np. brak synchronizacji danego dnia) -
// w takim przypadku zwracamy '--' zamiast wywalać się na Math.floor(null) -> "0h NaNm".
export function formatHoursMins(hoursDecimal) {
  if (hoursDecimal === null || hoursDecimal === undefined || isNaN(hoursDecimal)) {
    return '--';
  }
  let hours = Math.floor(hoursDecimal);
  let mins = Math.round((hoursDecimal - hours) * 60);
  // Bug fix: dla wartości blisko pełnej godziny (np. 7.995) Math.round() potrafił
  // dać 60 minut zamiast przeniesienia do kolejnej godziny - wyświetlało się
  // "7h 60m" zamiast "8h 0m".
  if (mins === 60) {
    hours += 1;
    mins = 0;
  }
  return `${hours}h ${mins}m`;
}
