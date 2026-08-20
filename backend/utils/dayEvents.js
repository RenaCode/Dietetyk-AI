const db = require('../db');

// Labels for day-event types ("day tag") - must stay consistent with VALID_TYPES in
// routes/dayEvents.js. Trzymane tu osobno, bo ten plik jest importowany przez
// prompty AI (dashboard.js, chat.js), a routes/dayEvents.js przez CRUD endpointy -
// rozdzielenie unika cyklicznego importu routera tam, gdzie potrzebny jest tylko odczyt.
const DAY_EVENT_TYPE_LABELS = {
  illness: 'Choroba',
  vacation: 'Wakacje/urlop',
  late_sleep: 'Późne zaśnięcie'
};

// The user's day events overlapping the given date range (inclusive) - used to
// (a) exclude tagged days from the baseline in insights (see getExcludedDates in
// dashboard.js) and (b) enrich the AI prompt context below, so the model does not treat
// unusual days as a normal pattern.
async function getDayEventsInRange(userId, startDate, endDate) {
  return db.all(
    `SELECT type, start_date, end_date, note FROM day_events
     WHERE user_id = ? AND end_date >= ? AND start_date <= ?
     ORDER BY start_date ASC`,
    [userId, startDate, endDate]
  );
}

// Formats day events into a compact Polish description to inject into the AI prompt.
// The wording stays Polish on purpose: it is prompt content, and it is what makes Gemini
// answer in Polish. Returns an empty string when the range contains no events, so we do
// not append an empty section on the majority of days where nothing was tagged.
function formatDayEventsForPrompt(events) {
  if (!events || events.length === 0) return '';
  const lines = events.map(ev => {
    const label = DAY_EVENT_TYPE_LABELS[ev.type] || ev.type;
    const range = ev.start_date === ev.end_date ? ev.start_date : `${ev.start_date} – ${ev.end_date}`;
    return `- ${label}: ${range}${ev.note ? ` (notatka użytkownika: ${ev.note})` : ''}`;
  });
  return `\nDni oznaczone przez użytkownika jako "Tag dnia" (specjalny kontekst) w analizowanym okresie:\n${lines.join('\n')}\nWAŻNE: jeśli dane z powyższych dni odbiegają od normy, weź pod uwagę ten kontekst - NIE traktuj ich jako typowy wzorzec użytkownika i nie buduj na ich podstawie rekomendacji korygujących dietę/trening/sen (np. wyższe kalorie czy gorszy sen w trakcie wakacji, podniesione tętno/gorsze parametry przy chorobie, gorszy sen po nocy z bardzo późnym zaśnięciem - to oczekiwane, już wyjaśnione wyjątki, nie sygnał do zmiany planu).\n`;
}

module.exports = { getDayEventsInRange, formatDayEventsForPrompt, DAY_EVENT_TYPE_LABELS };
