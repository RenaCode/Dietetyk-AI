// Date helpers shared by the whole frontend.
//
// Why this file exists: the backend computes EVERY date in Europe/Warsaw
// (backend/utils/dates.js forces that timezone through Intl, and CLAUDE.md makes it a
// rule). The frontend used to derive "today" from the browser instead
// (getTimezoneOffset()), duplicated in three places - App.jsx, Dashboard.jsx and
// Trends.jsx. The two disagree for every user whose device is not on Polish time.
//
// Observed failure mode: a user travelling in New York (UTC-4) opens the app at 20:00 on
// 22.09; in Warsaw it is already 02:00 on 23.09. The browser said "today = 2026-09-22",
// so dinner was saved with date '2026-09-22' while the backend's streaks, summary
// schedule and Oura/Apple metric writes were all operating on 23.09 - the meal never
// entered the server-side balance for the current day, and the dashboard labelled 22.09
// health metrics as "dzisiaj".

// Today's date (or the date of a given instant) as YYYY-MM-DD in Europe/Warsaw - the same
// calendar day the backend would compute for the same instant.
//
// 'en-CA' is used purely because it formats as YYYY-MM-DD, which is exactly the wire
// format the API expects; no user-visible text comes out of this function.
export function getWarsawDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}
