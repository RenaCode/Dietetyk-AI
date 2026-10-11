// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSsoSession, shouldReload, reloadForSso, installSsoFetchGuard, safeLogoutUrl, SSO_HOST_KEY } from './sso.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('a session answer is a session', async () => {
  const r = await requestSsoSession(async () => jsonResponse(200, { token: 'sess_x', logoutUrl: 'https://auth/logout', ssoEnabled: true }));
  assert.deepEqual(r, { kind: 'session', token: 'sess_x', logoutUrl: 'https://auth/logout' });
});

test('SSO switched off means the login form, not a retry', async () => {
  const r = await requestSsoSession(async () => jsonResponse(404, { error: 'off', ssoEnabled: false }));
  assert.equal(r.kind, 'off');
});

test('SSO on without identity is the break-glass login form', async () => {
  const r = await requestSsoSession(async () => jsonResponse(401, { error: 'x', ssoEnabled: true }));
  assert.equal(r.kind, 'none');
});

test('a refusal carries the backend message for the login screen', async () => {
  const r = await requestSsoSession(async () => jsonResponse(403, { error: 'Brak konta', ssoDenied: 'no_account', ssoEnabled: true }));
  assert.deepEqual(r, { kind: 'denied', error: 'Brak konta' });
});

// The expired-Authelia cases: fetch cannot follow the cross-domain redirect (TypeError), or
// Authelia answers an XHR with its own 401 - neither is the backend speaking.
test('a network error or a foreign 401 means the upstream session is lost', async () => {
  assert.equal((await requestSsoSession(async () => { throw new TypeError('Failed to fetch'); })).kind, 'lost');
  assert.equal((await requestSsoSession(async () => jsonResponse(401, { status: 'Unauthorized' }))).kind, 'lost');
  assert.equal((await requestSsoSession(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('html'); } }))).kind, 'lost');
});

test('reloads are spaced, so a page that fails at once does not spin', () => {
  assert.equal(shouldReload(null, 100_000), true);
  assert.equal(shouldReload('0', 100_000), true);
  assert.equal(shouldReload(String(90_000), 100_000), false);
  assert.equal(shouldReload(String(60_000), 100_000), true);
});

function fakeWindow({ ssoHost = true, online = true, fetchImpl } = {}) {
  const store = new Map();
  const session = new Map();
  if (ssoHost) store.set(SSO_HOST_KEY, '1');
  const win = {
    reloads: 0,
    location: { origin: 'https://dietetyk.example', reload: () => { win.reloads += 1; } },
    navigator: { onLine: online },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, v) },
    fetch: fetchImpl || (async () => { throw new TypeError('Failed to fetch'); })
  };
  return win;
}

test('reloadForSso reloads once per window', () => {
  const win = fakeWindow();
  assert.equal(reloadForSso(win), true);
  assert.equal(reloadForSso(win), false);
  assert.equal(win.reloads, 1);
});

test('the fetch guard reloads on a network error from our /api on an SSO host', async () => {
  const win = fakeWindow();
  installSsoFetchGuard(win);
  await assert.rejects(win.fetch('/api/dashboard?date=2026-10-11'), TypeError);
  assert.equal(win.reloads, 1);
});

test('the fetch guard leaves everything else alone', async () => {
  for (const [opts, url] of [
    [{ ssoHost: false }, '/api/dashboard'],             // not behind SSO
    [{ online: false }, '/api/dashboard'],              // the browser is offline
    [{}, 'https://api.open-meteo.com/v1/forecast'],     // not our API
    [{}, '/index.html']                                 // not an API call
  ]) {
    const win = fakeWindow(opts);
    installSsoFetchGuard(win);
    await assert.rejects(win.fetch(url), TypeError);
    assert.equal(win.reloads, 0, JSON.stringify({ opts, url }));
  }
  const ok = fakeWindow({ fetchImpl: async () => jsonResponse(200, {}) });
  installSsoFetchGuard(ok);
  assert.equal((await ok.fetch('/api/x')).status, 200);
  assert.equal(ok.reloads, 0);
});

test('only an https portal address is followed on logout', async () => {
  assert.equal(safeLogoutUrl('https://auth.example/logout?rd=x'), 'https://auth.example/logout?rd=x');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://auth.example/logout', 'data:text/html,x', '//evil.example', '', null, 42]) {
    assert.equal(safeLogoutUrl(bad), '', String(bad));
  }
  const r = await requestSsoSession(async () => jsonResponse(200, { token: 'sess_x', logoutUrl: 'javascript:alert(1)', ssoEnabled: true }));
  assert.deepEqual(r, { kind: 'session', token: 'sess_x', logoutUrl: '' });
});
