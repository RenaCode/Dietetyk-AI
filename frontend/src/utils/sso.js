// Single sign-on through Authelia - the browser half (backend: services/ssoIdentity.js,
// POST /api/auth/sso; contract: renacode-infra docs/sso-tozsamosc.md).
//
// With SSO on, every request to this host - the page and each /api call - passes Traefik's
// forwardAuth, which adds the identity headers. The app session is still a Bearer token in
// localStorage like any other; the difference is only where it comes from: the frontend asks
// POST /api/auth/sso for one instead of showing the login form.

// localStorage keys. SSO_HOST: the backend said the flag is on (any answer with
// `ssoEnabled: true`), which is what lets a failed /api call reload the page instead of showing
// "connection error". LOGOUT_URL: where "Wyloguj" goes when POST /api/logout itself cannot
// answer (the session already gone).
export const SSO_HOST_KEY = 'diet_sso_host';
export const SSO_LOGOUT_URL_KEY = 'diet_sso_logout_url';
const RELOAD_AT_KEY = 'diet_sso_reload_at';

// Asks the backend for a session from the identity headers. Never throws. One of:
//   { kind: 'session', token, logoutUrl } - logged in;
//   { kind: 'off' }      - SSO is not enabled on this instance: show the login form;
//   { kind: 'none' }     - SSO on, but this request carried no identity: break-glass
//                          (`kubectl port-forward`), show the login form;
//   { kind: 'denied', error } - identity present but refused (no account, wrong group): show
//                          the message on the login screen;
//   { kind: 'lost' }     - no answer from the backend at all: a network error or a response
//                          that is not ours. Behind Authelia that is an expired Authelia
//                          session - fetch cannot follow the redirect to the portal.
export async function requestSsoSession(fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl('/api/auth/sso', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  } catch {
    return { kind: 'lost' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  // Only a JSON body carrying `ssoEnabled` is the backend's own answer; Authelia's 401 for an
  // XHR, or a proxy error page, is something else and means "the session upstream is gone".
  if (!data || typeof data.ssoEnabled !== 'boolean') {
    return { kind: 'lost' };
  }
  if (res.ok && data.token) {
    return { kind: 'session', token: data.token, logoutUrl: data.logoutUrl || '' };
  }
  if (data.ssoEnabled === false) return { kind: 'off' };
  if (res.status === 401) return { kind: 'none' };
  return { kind: 'denied', error: data.error || '' };
}

// Reload at most once per window. The reload is what sends the browser through Authelia's
// login (a top-level navigation can follow the redirect a fetch cannot) and brings it back to
// the same address. If the page comes back and fails the same way at once, something other
// than an expired session is wrong, and reloading again would only spin; the caller then
// falls back to its ordinary error handling.
export const RELOAD_MIN_GAP_MS = 30 * 1000;

export function shouldReload(lastReloadAt, now, minGapMs = RELOAD_MIN_GAP_MS) {
  const last = Number(lastReloadAt);
  return !Number.isFinite(last) || last <= 0 || now - last >= minGapMs;
}

// Returns true when it reloaded (the caller should stop), false when it did not.
export function reloadForSso(win = window) {
  let last = null;
  try {
    last = win.sessionStorage.getItem(RELOAD_AT_KEY);
  } catch {
    last = null;
  }
  const now = Date.now();
  if (!shouldReload(last, now)) return false;
  try {
    win.sessionStorage.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    // Without storage the guard cannot hold; reloading once more is still the right move.
  }
  win.location.reload();
  return true;
}

const isOwnApiRequest = (input, origin) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('/api/')) return true;
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
};

// The contract's "on a network error from /api, reload": when the Authelia session expires
// mid-work, every /api fetch is redirected to the portal on another domain and rejects with a
// TypeError, which the components report as "connection error" - for ever, because nothing
// they do can log the user in again. Wrapping fetch once here covers the dozens of call sites.
// Active only on a host that said it is behind SSO, and never while the browser says it is
// offline (a real network outage is not fixed by reloading).
export function installSsoFetchGuard(win = window) {
  const original = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    try {
      return await original(input, init);
    } catch (err) {
      const onSsoHost = (() => {
        try { return win.localStorage.getItem(SSO_HOST_KEY) === '1'; } catch { return false; }
      })();
      const online = !win.navigator || win.navigator.onLine !== false;
      if (err instanceof TypeError && onSsoHost && online && isOwnApiRequest(input, win.location.origin)) {
        reloadForSso(win);
      }
      throw err;
    }
  };
  return () => { win.fetch = original; };
}
