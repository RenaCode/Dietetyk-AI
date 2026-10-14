// Regression test for the 2026-10-14 production crash loop: the app must start when its
// secrets arrive the way production delivers them - through .env, loaded by config.js - and
// not only when they are already in the process environment.
//
// #86 made routes/catering.js require a module that loads utils/encryption.js before
// config.js had run dotenv. encryption.js throws at load time without APP_PASSWORD, so the
// backend died on every start. Every other test passed, because CI sets APP_PASSWORD in the
// real environment and the ordering never mattered there.
//
// The child process below starts WITHOUT APP_PASSWORD / OAUTH_STATE_SECRET. A preload hook
// puts them into process.env at the exact moment config.js finishes loading - which is what
// dotenv.config() does in production - and then requires app.js. Anything that reads the
// environment before config.js fails here the way it failed in production.
//
// Run with: node tests/test-startup-env-order.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-env-order-'));
const hook = path.join(dir, 'simulate-dotenv.js');
fs.writeFileSync(hook, `
const Module = require('module');
const configPath = ${JSON.stringify(path.join(__dirname, '..', 'config.js'))};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const result = load.apply(this, arguments);
  if (Module._resolveFilename(request, parent, isMain) === configPath && !process.env.APP_PASSWORD) {
    process.env.APP_PASSWORD = 'test-app-password-from-dotenv';
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-from-dotenv';
  }
  return result;
};
`);

const env = { ...process.env, DATABASE_DIR: dir, NODE_ENV: 'test' };
delete env.APP_PASSWORD;
delete env.OAUTH_STATE_SECRET;

const child = spawnSync(process.execPath, ['-r', hook, '-e', "require('./app'); console.log('APP_LOADED'); process.exit(0)"], {
  cwd: path.join(__dirname, '..'),
  env,
  encoding: 'utf8',
  timeout: 60000
});

const out = `${child.stdout}\n${child.stderr}`;
if (child.status === 0 && out.includes('APP_LOADED')) {
  console.log('✅ the app loads when APP_PASSWORD only appears once config.js has loaded .env');
  console.log('\n🎉 STARTUP ENV ORDER TEST PASSED\n');
  process.exit(0);
}
console.error('❌ the app does not load when its secrets come from .env via config.js:');
console.error(`status=${child.status} signal=${child.signal}`);
console.error(out.split('\n').filter(l => /Error|at Object|missing/.test(l)).slice(0, 6).join('\n'));
console.error('❌ STARTUP ENV ORDER TEST FAILED');
process.exit(1);
