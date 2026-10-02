// What the page should do with the URL it was loaded with after "Sign in with Google".
//
// The backend used to redirect to `/#google_token=<session>` and the page stored any token
// such a URL carried - so a link with the ATTACKER's session token, opened by a victim,
// silently logged the victim into the attacker's account (login CSRF; audit 2026-10, H2).
// The callback now hands out only a one-time `#google_code=`, which the page trades at
// POST /api/auth/google/exchange; the backend accepts it only together with an HttpOnly
// cookie that exists solely in the browser that went through Google. `google_token` and
// `google_temp_token` are deliberately NOT recognised any more: no URL can set a session.
//
// Returns { code } / { error } / null. Pure, so tests/googleReturn.test.js can pin it down.
export function parseGoogleReturn(hash, search) {
  const hashParams = new URLSearchParams((hash || '').replace(/^#/, ''));
  const code = hashParams.get('google_code');
  if (code) return { code };
  const error = new URLSearchParams(search || '').get('google_error');
  if (error) return { error };
  return null;
}
