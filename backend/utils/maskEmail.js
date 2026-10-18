// E-mail addresses must not reach the logs in clear text (audit 2026-10-10, N6).
//
// Since 15.10.2026 the cluster ships every container's stdout to VictoriaLogs with 30-day
// retention, and app_logs in SQLite keeps 30 days as well. The backend wrote full addresses in
// both: every scheduled summary ("Sending the daily summary to <address>"), every Mailgun send,
// the admin security report, invitations, and - through the failed-login and lockout entries -
// whatever a user typed into the login field, which is an e-mail address whenever they sign in
// with one. Thirty days of who-gets-mail-when is personal data the logs have no use for: the
// UID next to it already identifies the account for debugging.
//
// The mask keeps just enough to tell two addresses apart when reading a log - the first
// character of the local part and of the domain, plus the top-level domain:
// "someone@example.com" -> "s***@e***.com". The domain is masked too, because on a personal
// domain it identifies the person as surely as the full address does.

// Loose on the local part (a log line is not the place to validate addresses, and missing a
// malformed one leaks it) but strict on the domain: dot-separated labels of letters, digits
// and hyphens ending in an alphabetic TLD. Neither side may contain "/", because stack traces
// are full of scoped npm paths - "/app/node_modules/@google/generative-ai/dist/index.js:401"
// matched the first, looser version of this pattern and came out as "/***@g***.js", which is
// worse than useless: the stored-log scrub (db.js, maskEmailsInStoredLogs) rewrites rows in
// place, so a mangled stack trace could never be read again.
const EMAIL_RE = /([^\s@<>()[\]"',;:/\\]+)@((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)\.([A-Za-z]{2,})\b/g;

function maskOne(match, local, domainHead, tld) {
  return `${local[0]}***@${domainHead[0]}***.${tld}`;
}

// Masks every address inside a string; anything that is not a string is returned unchanged,
// so it can wrap values whose type the caller does not control (error messages, details).
function maskEmails(value) {
  if (typeof value !== 'string') return value;
  return value.replace(EMAIL_RE, maskOne);
}

module.exports = { maskEmails };
