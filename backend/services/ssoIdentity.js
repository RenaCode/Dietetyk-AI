const db = require('../db');

// Single sign-on through Authelia (renacode-infra docs/sso-tozsamosc.md, "the contract").
//
// With `sso.enabled` the chart puts Traefik's forwardAuth in front of the whole host, and every
// request that reaches us has passed Authelia's password + second factor. Traefik then adds
// Remote-User / Remote-Email / Remote-Groups / Remote-Name, after stripping whatever the client
// sent under those names. This file turns those headers into "which account is this".
//
// THE HEADERS ARE TRUSTED ONLY WITH SSO_NAGLOWKI=1. The chart sets that variable from the very
// same `sso.enabled` switch that attaches the stripping middleware, so trust and stripping are
// one value in values.yaml. Without the flag nothing here reads a header at all: a router
// without the middleware passes `Remote-User: admin` from anybody straight through (measured
// in the contract's k3s trial), and an application that believed it would hand out sessions
// to whoever typed a name.
//
// Read on every call, not once at start, so the tests can drive both modes against one app
// and so nothing caches a stale answer.
const isSsoEnabled = () => process.env.SSO_NAGLOWKI === '1';

// Authelia admits a user to dietetyk.renacode.com only in one of these groups (renacode-infra
// k3s/platforma/authelia.yaml, rule for the host). Checked here as well, so that a rule
// widened by mistake on the Authelia side - or a host attached to the middleware before its
// rule was written - does not silently become access to health data. This decides ENTRY
// only: the application role (admin or not) still comes from users.role, never from the
// header, so membership of `admins` in Authelia does not make anyone an admin here.
const ALLOWED_GROUPS = ['admins', 'dietetyk'];

// The contract's charset for Remote-User. Authelia's user names fit it; anything else means
// the header did not come from Authelia, and guessing what was meant is how a lenient parser
// becomes an injection.
const REMOTE_USER_RE = /^[a-z0-9._-]{1,64}$/;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// Where "Wyloguj" sends the browser: the portal ends the Authelia session (for every
// renacode.com application at once - the cookie is domain-wide) and comes back here. The
// chart renders SSO_LOGOUT_URL from the ingress host; the fallback covers a run outside the
// chart. Built only from configuration, never from the request's Host header, which would
// make this an open redirect.
const DEFAULT_PORTAL_URL = 'https://auth.renacode.com';
function ssoLogoutUrl() {
  if (process.env.SSO_LOGOUT_URL) return process.env.SSO_LOGOUT_URL;
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  return `${DEFAULT_PORTAL_URL}/logout` + (appUrl ? `?rd=${encodeURIComponent(appUrl + '/')}` : '');
}

// How many times a header occurs in the raw request. Node folds repeated unknown headers into
// one comma-joined string in req.headers, so `Remote-User: a` twice reads as "a, a" there -
// and a repeated identity header is exactly what the contract says to refuse (400), because
// it means two parties set it and we cannot know which one Traefik was.
function headerOccurrences(req, name) {
  const raw = req.rawHeaders || [];
  const values = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) values.push(String(raw[i + 1]));
  }
  return values;
}

const fail = (status, error, extra = {}) => ({ error: { status, body: { error, ...extra } } });

// The identity carried by this request, as one of:
//   null               - SSO is off, or no Remote-User: not an SSO request (break-glass via
//                        `kubectl port-forward`, or a machine route) - ordinary auth applies;
//   { error }          - the headers are present but unusable: { status, body } to send;
//   { identity }       - { user, email, groups } - valid, in an allowed group. NOT yet mapped
//                        to an account; see findAccountForIdentity.
function readSsoIdentity(req) {
  if (!isSsoEnabled()) return null;

  const users = headerOccurrences(req, 'remote-user');
  if (users.length === 0) return null;
  if (users.length > 1) return fail(400, 'Nieprawidłowa tożsamość SSO (powtórzony nagłówek).');
  const user = users[0].trim();
  if (!REMOTE_USER_RE.test(user)) return fail(400, 'Nieprawidłowa tożsamość SSO (niedozwolone znaki w nazwie użytkownika).');

  const emails = headerOccurrences(req, 'remote-email');
  if (emails.length !== 1) return fail(400, 'Nieprawidłowa tożsamość SSO (brak lub powtórzony adres e-mail).');
  const email = emails[0].trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) return fail(400, 'Nieprawidłowa tożsamość SSO (niepoprawny adres e-mail).');

  const groupHeaders = headerOccurrences(req, 'remote-groups');
  if (groupHeaders.length > 1) return fail(400, 'Nieprawidłowa tożsamość SSO (powtórzony nagłówek grup).');
  const groups = (groupHeaders[0] || '').split(',').map(g => g.trim()).filter(Boolean);
  if (!groups.some(g => ALLOWED_GROUPS.includes(g))) {
    return fail(403, `Użytkownik ${user} nie należy do grupy z dostępem do Dietetyka. Poproś administratora o dodanie do grupy „dietetyk”.`, { ssoDenied: 'group' });
  }

  return { identity: { user, email, groups } };
}

// Maps an Authelia identity onto an EXISTING account, by e-mail, ignoring case (the contract,
// section 3). Dietetyk usernames are picked by the users at registration and have no reason
// to match the Authelia login; the address is in both places and unique here
// (idx_users_email_unique on lower(TRIM(email)), db.js).
//
// No account is ever created on the fly: an account carries a role, settings and history, and
// an empty one appearing for a typo in users.yml would be worse than a clear refusal. A pending
// invitation is not an account yet either - its row exists with the invited address, but with
// a placeholder username and a password nobody knows until the invitee finishes registering.
//
// Returns { user } or { error } in the shape readSsoIdentity uses.
async function findAccountForIdentity(identity) {
  const rows = await db.all(
    `SELECT * FROM users WHERE email IS NOT NULL AND lower(TRIM(email)) = lower(?)`,
    [identity.email]
  );
  if (rows.length === 0) {
    return fail(403, `Brak konta w Dietetyku dla adresu ${identity.email} (użytkownik SSO ${identity.user}). Poproś administratora o zaproszenie na ten adres.`, { ssoDenied: 'no_account' });
  }
  // Only possible where the unique index could not be created over existing duplicates
  // (db.js reports that at start). Picking one of two accounts by query plan is how the
  // login path once let one user lock out another - refuse instead.
  if (rows.length > 1) {
    return fail(403, `Adres ${identity.email} jest przypisany do kilku kont. Administrator musi to rozdzielić, zanim zalogujesz się przez SSO.`, { ssoDenied: 'ambiguous' });
  }
  const user = rows[0];
  if (user.status !== 'active') {
    return fail(403, `Konto dla adresu ${identity.email} nie jest aktywne. Dokończ rejestrację z zaproszenia albo poproś administratora.`, { ssoDenied: 'inactive' });
  }
  return { user };
}

// Whether an account row is the one this identity maps to - used by requireAuth to refuse a
// session of a DIFFERENT user than the one Authelia says is at the keyboard (a shared browser
// where one person logged out of Authelia and another logged in, with the first one's token
// still in localStorage).
const identityMatchesEmail = (identity, email) =>
  !!email && String(email).trim().toLowerCase() === identity.email.toLowerCase();

module.exports = {
  isSsoEnabled,
  readSsoIdentity,
  findAccountForIdentity,
  identityMatchesEmail,
  ssoLogoutUrl,
  ALLOWED_GROUPS
};
