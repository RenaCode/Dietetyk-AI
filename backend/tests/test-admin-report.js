// Tests for services/adminReport.js - the weekly log and security report, and the one
// question that matters about it: can a report that reached nobody ever look like one that
// was delivered?
//
// WHY THIS FILE WAS REWRITTEN. The previous version of this test could not fail. It was not
// in the `npm test` chain, and run by hand it died at `require` (it never loaded an
// environment, so utils/encryption.js threw on the missing APP_PASSWORD before the first
// line of the test body ran). Even past that it had no assertions at all: the whole body sat
// in a try/catch whose catch printed the error and left the exit code at 0. So the only test
// touching sendWeeklyAdminReport - the function whose failure mode is silence - was itself
// silent. Worse, it called the real sendWeeklyAdminReport with no stub, so adding it to the
// chain unchanged would have e-mailed every active administrator on every `npm test`.
//
// WHAT IT PINS DOWN. scheduler.js writes `last_admin_report_sent = <today>` immediately after
// awaiting this function, and its `if (lastSentDate !== todayStr)` guard then blocks any
// retry until next Monday. A resolved promise is therefore a promise that the report was
// delivered. The loop over administrators used to swallow every send error, so an expired
// Mailgun key (or an APP_PASSWORD rotated without scripts/reencrypt-secrets.js) produced a
// resolved promise, a marker set, a log line reading "Admin report sent" - and a week of
// AUTH_LOCKOUT and AUTH_LOGIN_FAILURE rows nobody was told about, on an application holding
// special-category health data.
//
// Every assertion below injects a known-bad condition and requires a rejection. Nothing here
// touches the network: services/mailgun.js is replaced before adminReport.js is loaded.
//
// Run with: node tests/test-admin-report.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-admin-report-'));
process.env.DATABASE_DIR = tmpDir;
// A temporary password rather than dotenv: loading the real .env would run this test against
// production secrets, which is exactly what tests/test-withings.js does and why that file is
// not in the chain either. Nothing encrypted is exercised here; utils/encryption.js simply
// refuses to load without it.
process.env.APP_PASSWORD = 'test-app-password-for-admin-report';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

// The mailer, replaced before services/adminReport.js captures it. `nextSend` decides what
// each delivery attempt does, so the failure modes are produced deliberately instead of by
// hoping Mailgun misbehaves.
const sentEmails = [];
let nextSend = null;

stubModule('services/mailgun.js', {
  sendMailgunEmail: async (message) => {
    if (typeof nextSend === 'function') {
      const result = nextSend(message);
      if (result && typeof result.then === 'function') return result;
      return result;
    }
    sentEmails.push(message);
    return { id: '<stubbed@example.invalid>' };
  }
});

const db = require('../db');
const logger = require('../services/logger');
const { sendWeeklyAdminReport } = require('../services/adminReport');

const ADMIN_EMAIL = 'admin-one@example.invalid';
const SECOND_ADMIN_EMAIL = 'admin-two@example.invalid';

// Returns the rejection, or null when the call resolved - which for several of the cases
// below is itself the failure being tested for.
async function attempt() {
  sentEmails.length = 0;
  try {
    await sendWeeklyAdminReport();
    return { rejected: false };
  } catch (err) {
    return { rejected: true, err };
  }
}

async function setAdmins(emails) {
  await db.run(`UPDATE users SET role = 'user' WHERE role = 'admin'`);
  await db.run(`DELETE FROM users WHERE username LIKE 'report-admin-%'`);
  for (let i = 0; i < emails.length; i++) {
    await db.run(
      `INSERT INTO users (username, password_hash, sync_token, email, role, status)
       VALUES (?, 'x', ?, ?, 'admin', 'active')`,
      [`report-admin-${i}`, `sync-token-report-admin-${i}`, emails[i]]
    );
  }
}

// logger writes to app_logs in the background (see the note in services/logger.js), so a read
// straight after the call can legitimately come up empty. Polling keeps the assertion about
// what was logged rather than about how fast it was logged.
async function waitForLog(category, messagePattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.get(
      `SELECT * FROM app_logs WHERE category = ? ORDER BY id DESC LIMIT 1`,
      [category]
    );
    if (row && messagePattern.test(row.message)) return row;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

// The log rows the report exists to surface. Seeded once; every case below runs against the
// same body of logs, so a difference in outcome is a difference in delivery, not in content.
async function seedLogs() {
  await logger.info('System started successfully.', 'SYSTEM');
  await logger.warn('Withings integration access is close to expiring.', 'INTEGRATIONS', null, '127.0.0.1', 1);

  await logger.error(
    'Gemini API query failed - 404 Model Not Found',
    'GEMINI_AI',
    new Error('models/gemini-1.5-flash is not found or is not supported for generateContent.'),
    '192.168.1.50',
    1
  );
  await logger.error('Invalid session authorisation token', 'HTTP_SERVER', 'Error: jwt expired at Object.verify...', '185.201.112.5', 1);

  // Repeated, to exercise the grouping into the top-10 table.
  for (let i = 0; i < 3; i++) {
    await logger.error('SQLite connection error (SQLITE_BUSY)', 'DATABASE', 'Error: database is locked', '127.0.0.1');
  }

  // The three categories that are the entire point of the report.
  await logger.security('Failed login attempt for account: admin (user does not exist)', 'AUTH_LOGIN_FAILURE', { username: 'admin' }, '80.50.23.14');
  await logger.security('Brute-force lockout for: admin', 'AUTH_LOCKOUT', { key: '80.50.23.14::admin', count: 5 }, '80.50.23.14');
  await logger.security('API request limit exceeded (121/120)', 'RATE_LIMIT', { path: '/api/meals', method: 'POST' }, '45.67.234.12');

  await waitForLog('RATE_LIMIT', /121\/120/);
}

async function testHappyPathDelivers() {
  console.log('\n--- TEST: a report that is actually delivered ---');
  await setAdmins([ADMIN_EMAIL]);
  nextSend = null;

  const result = await attempt();
  assert(result.rejected === false, 'a report delivered to an administrator RESOLVES');
  assert(sentEmails.length === 1, `exactly one e-mail was handed to the mailer (got ${sentEmails.length})`);
  assert(sentEmails[0].to === ADMIN_EMAIL, 'it went to the active administrator');
  assert(/Raport/i.test(sentEmails[0].subject), `the subject names the report (got "${sentEmails[0].subject}")`);

  // Without this the rejection cases below would also pass against a function that never
  // sends anything at all, which would be just as broken in the other direction.
  const html = sentEmails[0].html;
  assert(/AUTH_LOCKOUT/.test(html), 'the report carries the AUTH_LOCKOUT entries it exists to surface');
  assert(/AUTH_LOGIN_FAILURE/.test(html), 'the report carries the failed-login entries');
  assert(/RATE_LIMIT/.test(html), 'the report carries the rate-limit entries');
}

async function testNoAdminRejects() {
  console.log('\n--- TEST: nobody to send to (known-bad) ---');
  await setAdmins([]);
  nextSend = null;

  const result = await attempt();
  assert(result.rejected, 'no active administrator with an e-mail address REJECTS instead of returning quietly');
  assert(sentEmails.length === 0, 'and nothing was sent');
  // This used to be a bare `return`, which the scheduler read as success: the marker was set,
  // "Admin report sent" was logged, and the application went a week with no reachable
  // administrator and no sign of it anywhere.
  assert(/administrator/i.test(result.err.message), `the rejection says why (got: "${result.err.message}")`);
}

async function testInvalidAdminEmailRejects() {
  console.log('\n--- TEST: the only administrator address is malformed (known-bad) ---');
  await setAdmins(['not-an-email-address']);
  nextSend = null;

  const result = await attempt();
  assert(result.rejected, 'an administrator whose address fails validation leaves the report undeliverable, and that rejects');
  assert(sentEmails.length === 0, 'the malformed address was not handed to the mailer');
}

async function testAllSendsFailingRejects() {
  console.log('\n--- TEST: every delivery fails (known-bad) ---');
  await setAdmins([ADMIN_EMAIL, SECOND_ADMIN_EMAIL]);
  // What an expired Mailgun key, or an APP_PASSWORD rotated without re-encrypting the stored
  // key, actually looks like from here.
  nextSend = () => { throw new Error('Mailgun error 401: Forbidden'); };

  const result = await attempt();
  assert(result.rejected, 'a run in which no e-mail reached anyone REJECTS - the scheduler must not mark the week as sent');
  assert(/not sent|failed/i.test(result.err.message), `the rejection describes the outage (got: "${result.err.message}")`);

  // The failure has to reach app_logs, not just the container's stdout: a console line is
  // invisible to the next report, so a week that failed would leave no trace even once the
  // channel came back.
  const logged = await waitForLog('ADMIN_REPORT', /Failed to send/i);
  assert(logged !== null, 'each failed delivery is written through the logger into app_logs, not only to console.error');
  assert(logged.level === 'ERROR', `it is recorded at ERROR level (got ${logged && logged.level})`);
}

async function testPartialFailureStillResolves() {
  console.log('\n--- TEST: one administrator unreachable, another reached ---');
  await setAdmins([ADMIN_EMAIL, SECOND_ADMIN_EMAIL]);
  const delivered = [];
  nextSend = (message) => {
    if (message.to === ADMIN_EMAIL) throw new Error('Mailgun error 550: suppressed recipient');
    delivered.push(message);
    return { id: '<stubbed-partial@example.invalid>' };
  };

  const result = await attempt();
  // A single bad address (a typo, a suppressed recipient) must not become an outage for the
  // administrators who can be reached, nor force a retry that would double-send to them.
  assert(result.rejected === false, 'a run that reached at least one administrator resolves');
  assert(delivered.length === 1 && delivered[0].to === SECOND_ADMIN_EMAIL, 'the reachable administrator still got the report');
}

async function testTimeoutRejects() {
  console.log('\n--- TEST: the mailer times out (known-bad) ---');
  await setAdmins([ADMIN_EMAIL]);
  nextSend = async () => { throw new Error('Request timed out after 15000ms: https://api.mailgun.net/v3/...'); };

  const result = await attempt();
  assert(result.rejected, 'a network timeout on the only delivery rejects rather than resolving into a set marker');
}

async function testRecoveryProvesTheHarness() {
  console.log('\n--- TEST: the harness is not what was failing ---');
  await setAdmins([ADMIN_EMAIL]);
  nextSend = null;

  const result = await attempt();
  assert(result.rejected === false && sentEmails.length === 1,
    'a healthy configuration still delivers after all the injected failures - the rejections came from the injections, not from the test');
}

async function main() {
  await db.initDb();
  await seedLogs();

  await testHappyPathDelivers();
  await testNoAdminRejects();
  await testInvalidAdminEmailRejects();
  await testAllSendsFailingRejects();
  await testPartialFailureStillResolves();
  await testTimeoutRejects();
  await testRecoveryProvesTheHarness();
}

main()
  .then(() => {
    console.log('\n🎉 ADMIN REPORT TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    // The whole reason this file was rewritten: the catch must set the exit code. Without it
    // the test reports a failure to a log nobody reads and the suite goes green.
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ ADMIN REPORT TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
