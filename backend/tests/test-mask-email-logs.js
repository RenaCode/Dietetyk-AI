// E-mail addresses must not reach the logs in clear text (audit 2026-10-10, N6).
//
// Container stdout is kept 30 days in VictoriaLogs and app_logs 30 days in SQLite. Both used
// to carry full addresses: scheduled summaries, Mailgun sends, the admin report, and failed
// logins that quote the typed login - an address whenever the user signs in with one.
// Placeholder addresses only (example.com/example.org) - never real ones in tests.
//
// Run with: node tests/test-mask-email-logs.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-mask-email-'));
process.env.DATABASE_DIR = tmpDir;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const db = require('../db');
const logger = require('../services/logger');
const { maskEmails } = require('../utils/maskEmail');

const ADDRESS = 'someone.private@example.org';

// Collects everything written to the console while `fn` runs.
async function captureConsole(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(original)) {
    console[k] = (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

async function run() {
  await db.initDb();

  console.log('\n--- TEST: the mask ---');
  assert(maskEmails(`to ${ADDRESS} now`) === 'to s***@e***.org now', `an address is masked to first letters + TLD (got "${maskEmails(`to ${ADDRESS} now`)}")`);
  assert(maskEmails('a@mail.example.com, c@example.net') === 'a***@m***.com, c***@e***.net', 'several addresses and subdomains are masked');
  assert(maskEmails(maskEmails(ADDRESS)) === maskEmails(ADDRESS), 'masking is idempotent');
  assert(maskEmails('user 42 logged in from 192.0.2.1') === 'user 42 logged in from 192.0.2.1', 'text without an address is unchanged');
  // Stack traces are full of scoped npm paths; the first version of the pattern turned this
  // one into "/***@g***.js", and the stored-log scrub would have rewritten it for good.
  const stack = 'at Object.<anonymous> (/app/node_modules/@google/generative-ai/dist/index.js:401:15)';
  assert(maskEmails(stack) === stack, 'a stack trace with a scoped npm path is left intact');
  assert(maskEmails('installed @scope/pkg@1.2.3') === 'installed @scope/pkg@1.2.3', 'a scoped package with a version is not an address');
  assert(maskEmails(null) === null && maskEmails(undefined) === undefined, 'non-strings pass through');

  console.log('\n--- TEST: the logger masks the console line and the stored row ---');
  const out = await captureConsole(async () => {
    await logger.security(`Failed login attempt for account: ${ADDRESS} (no such user)`, 'AUTH_LOGIN_FAILURE', { username: ADDRESS }, '127.0.0.1');
  });
  assert(!out.includes(ADDRESS), 'stdout carries no clear-text address');
  assert(out.includes('s***@e***.org'), 'stdout still says which (masked) login failed');
  await new Promise(r => setTimeout(r, 50)); // the database write is fire-and-forget
  const row = await db.get(`SELECT message, details FROM app_logs WHERE category = 'AUTH_LOGIN_FAILURE' ORDER BY id DESC LIMIT 1`);
  assert(row && !row.message.includes(ADDRESS) && !row.details.includes(ADDRESS), 'app_logs message and details carry no clear-text address');
  assert(JSON.parse(row.details).username === 's***@e***.org', 'details stay valid JSON');

  console.log('\n--- TEST: rows written before the fix are masked by the daily cleanup ---');
  await db.run(`INSERT INTO app_logs (level, category, message, details) VALUES ('INFO', 'LEGACY', ?, ?)`,
    [`Sending the daily summary to ${ADDRESS}`, JSON.stringify({ to: ADDRESS })]);
  await db.run(`INSERT INTO app_logs (level, category, message, details) VALUES ('ERROR', 'LEGACY_STACK', 'Gemini call failed', ?)`,
    [`Error: 503\n    ${stack}`]);
  await captureConsole(() => db.cleanupOldLogs());
  const legacy = await db.get(`SELECT message, details FROM app_logs WHERE category = 'LEGACY'`);
  assert(!legacy.message.includes(ADDRESS) && !legacy.details.includes(ADDRESS), 'the stored legacy row is masked');
  const legacyStack = await db.get(`SELECT details FROM app_logs WHERE category = 'LEGACY_STACK'`);
  assert(legacyStack.details === `Error: 503\n    ${stack}`, 'a stored stack trace is not rewritten');
  assert(await captureConsole(() => db.maskEmailsInStoredLogs()) === '', 'a second pass finds nothing to change');

  console.log('\n--- TEST: no console call interpolates an address unmasked ---');
  // Static guard for the sites that logged addresses directly: any console.* template that
  // interpolates something named like an e-mail address or a recipient must go through
  // maskEmails(). Scripts run by hand on a terminal (backend/scripts) are not container logs.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'tests', 'scripts'].includes(e.name)) walk(full);
      } else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(__dirname, '..'));
  const offenders = [];
  const interpolation = /\$\{([^}]*)\}/g;
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/console\.(log|warn|error|info)\(/.test(line)) return;
      let m;
      while ((m = interpolation.exec(line)) !== null) {
        const expr = m[1];
        if (/(e-?mail|recipient|emailToUse|\bto\b)/i.test(expr) && !/maskEmails\(/.test(expr)) {
          offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}: ${line.trim()}`);
        }
      }
    });
  }
  assert(offenders.length === 0, `every interpolated address is masked${offenders.length ? `:\n  ${offenders.join('\n  ')}` : ''}`);
}

run()
  .then(() => {
    console.log('\n🎉 E-MAIL MASKING TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + (err.stack || err.message || err));
    console.error('❌ E-MAIL MASKING TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
