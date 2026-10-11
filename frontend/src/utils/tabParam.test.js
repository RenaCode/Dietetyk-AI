// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTabParam } from './tabParam.js';

// N-S2 (audit round 2): `?tab=settings` from the Google flows opened a tab that does not exist.
test('the legacy settings tab name opens the setup tab', () => {
  assert.equal(resolveTabParam('settings'), 'setup');
  assert.equal(resolveTabParam('setup'), 'setup');
});

test('an unknown tab name is ignored, not rendered as an empty page', () => {
  assert.equal(resolveTabParam('nonsense'), null);
  assert.equal(resolveTabParam(null), null);
});

// Google sign-in was removed on 2026-10-11 (Google Fit stays, switched off by default). The
// return from the sign-in flows used to be read from the URL (a one-time code, error and link
// parameters) and the login screen asked /api/auth/google/enabled; no source file may do either
// any more, or the frontend calls endpoints that answer 401/404 and shows buttons that lead
// nowhere.
test('no frontend source refers to the removed Google sign-in endpoints or return parameters', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
        const source = fs.readFileSync(full, 'utf8');
        // `/api/auth/google/` and `has_google"` (with the trailing slash and quote) so that
        // Google Fit - kept behind a switch: /api/auth/google-fit, has_google_fit - does not match.
        for (const needle of ['/api/auth/google/', "'/api/auth/google'", 'google_code', 'google_error', 'google_link', 'google_reauth', '/api/user/unlink-google', '/api/user/set-password', 'has_google)', 'has_google ', 'has_google?']) {
          if (source.includes(needle)) offenders.push(`${path.relative(srcDir, full)}: ${needle}`);
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});
