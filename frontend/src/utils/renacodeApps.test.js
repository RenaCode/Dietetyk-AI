// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renacodeApps, CURRENT_APP_ID } from './renacodeApps.js';

test('the switcher lists Trader, Kidwatch and Dietetyk with their addresses', () => {
  assert.deepEqual(
    renacodeApps().map((app) => [app.id, app.name, app.url]),
    [
      ['trader', 'Trader', 'https://trader.renacode.com/'],
      ['kidwatch', 'Kidwatch', 'https://kidwatch.renacode.com/'],
      ['dietetyk', 'Dietetyk', 'https://dietetyk.renacode.com/']
    ]
  );
});

// The URLs go straight into href. Anything other than https on a renacode.com host would
// either break SSO (the Authelia cookie is scoped to the domain) or, for a `javascript:`
// value, run code on this origin.
test('every app address is https on a renacode.com host', () => {
  for (const app of renacodeApps(undefined, { showArgo: true })) {
    const url = new URL(app.url);
    assert.equal(url.protocol, 'https:', app.id);
    assert.ok(url.hostname.endsWith('.renacode.com'), app.id);
  }
});

test('exactly one entry is the current app, and ids are unique', () => {
  for (const showArgo of [false, true]) {
    const apps = renacodeApps(undefined, { showArgo });
    assert.equal(apps.filter((app) => app.id === CURRENT_APP_ID).length, 1);
    assert.equal(new Set(apps.map((app) => app.id)).size, apps.length);
  }
});

// Argo CD is for the owner only. The decision is the backend's (profile.show_argo); the list
// adds the entry only for a literal `true`, so a missing field, a profile still loading or a
// truthy string never shows it to family or ordinary users.
test('Argo CD is listed only with showArgo === true', () => {
  const ids = (options) => renacodeApps(undefined, options).map((app) => app.id);
  assert.deepEqual(ids(), ['trader', 'kidwatch', 'dietetyk']);
  for (const showArgo of [false, undefined, null, 'true', 1, {}]) {
    assert.ok(!ids({ showArgo }).includes('argocd'), `showArgo=${JSON.stringify(showArgo)}`);
  }
  assert.deepEqual(ids({ showArgo: true }), ['trader', 'kidwatch', 'dietetyk', 'argocd']);
  const argo = renacodeApps((text) => `[${text}]`, { showArgo: true }).find((app) => app.id === 'argocd');
  assert.deepEqual(
    { name: argo.name, url: argo.url, description: argo.description, adminOnly: argo.adminOnly },
    { name: 'Argo CD', url: 'https://argocd.renacode.com/', description: '[Wdrożenia i klaster]', adminOnly: true }
  );
});

test('only Argo CD is flagged admin-only', () => {
  assert.deepEqual(renacodeApps(undefined, { showArgo: true }).filter((app) => app.adminOnly).map((app) => app.id), ['argocd']);
});

test('descriptions go through the translator it is given', () => {
  const apps = renacodeApps((text) => `[${text}]`);
  assert.deepEqual(apps.map((app) => app.description), ['[Handel i ryzyko]', '[Czas ekranowy dzieci]', '[Dieta i zdrowie]']);
  assert.equal(apps.length, 3, 'no admin-only entry without showArgo');
  assert.equal(renacodeApps()[2].description, 'Dieta i zdrowie');
});

// Without the switcher in the header's markup none of the above reaches the user. A render
// test would need a DOM and a JSX transform, which this suite deliberately does without, so
// this checks the wiring at the source level: the main layout renders it, and the component
// keeps the accessibility contract (name, expanded state, popup type, Escape).
test('the main layout renders the switcher with its accessible contract', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = fs.readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
  const start = app.indexOf('<header className="app-header">');
  assert.ok(start !== -1, 'App.jsx has no app header');
  const header = app.slice(start, app.indexOf('</header>', start));
  // The flag comes from the backend's decision in the profile, compared with literal true.
  assert.match(header, /<AppSwitcher\s+showArgo=\{userProfile\.show_argo === true\}\s*\/>/);

  const component = fs.readFileSync(path.join(srcDir, 'components', 'AppSwitcher.jsx'), 'utf8');
  // Every tile has its own colour class; a new app without one would render a white letter on nothing.
  const css = fs.readFileSync(path.join(srcDir, 'index.css'), 'utf8');
  for (const entry of renacodeApps(undefined, { showArgo: true })) {
    assert.ok(css.includes(`.app-switcher-tile-${entry.id} {`), `index.css lacks .app-switcher-tile-${entry.id}`);
  }

  for (const needle of ["aria-label={t('Przełącz aplikację')}", 'aria-expanded={open}', 'aria-haspopup', 'aria-current', "'Escape'", 'renacodeApps(t, { showArgo })', '{ showArgo = false }']) {
    assert.ok(component.includes(needle), `AppSwitcher.jsx lacks ${needle}`);
  }
});
