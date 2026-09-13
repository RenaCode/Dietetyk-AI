// Tests for services/mailgun.js - specifically, that a send which did NOT happen can never
// be mistaken for one that did.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT OPTIONAL. sendMailgunEmail() is not only the
// application's e-mail path. /opt/dietetyk-ai/health-check.sh on the VPS runs from cron every
// 15 minutes and sends its alerts like this:
//
//   kubectl exec <ready backend pod> -c backend -- node -e "
//     require('dotenv').config({ path: '/app/.env' });
//     const { sendMailgunEmail } = require('/app/services/mailgun');
//     sendMailgunEmail({ ... }).then(...).catch(e => process.exit(1));"
//
// That makes this function the alerting channel for the WHOLE VPS - the only one that has ever
// actually delivered a failure e-mail from this cluster - even though nothing in this
// repository says so. The caller's only signal is whether the promise rejects. If any failure
// path here ever resolved instead of throwing, the script would log "Alert email sent", cron
// would be happy, and an unreported outage would look exactly like a healthy machine.
//
// So every assertion below injects a KNOWN-BAD condition and requires a rejection. A green run
// of the "it sends" case alone would prove nothing about the failure paths, which are the ones
// that matter here.
//
// Nothing in this file touches the network: the one external call is stubbed, so the failures
// are produced deliberately rather than by hoping the internet misbehaves.
//
// Run with: node tests/test-mailgun-failure-modes.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-test-mailgun-'));
process.env.DATABASE_DIR = tmpDir;
process.env.APP_PASSWORD = 'test-app-password-for-mailgun-failure-modes';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// The single outbound call, replaced before mailgun.js is loaded so it captures this object.
// `nextResponse` decides what the "Mailgun API" does on the next attempt.
let nextResponse = null;
let requestCount = 0;

function stubModule(relativePath, exports) {
  const full = require.resolve(path.join(BACKEND_DIR, relativePath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

stubModule('utils/fetchWithTimeout.js', {
  fetchWithTimeout: async () => {
    requestCount += 1;
    if (typeof nextResponse === 'function') return nextResponse();
    return nextResponse;
  }
});

const db = require('../db');
const { encryptWith, deriveKey } = require('../utils/encryption');
const { sendMailgunEmail } = require('../services/mailgun');

const MESSAGE = { to: 'alerts@example.invalid', subject: '[TEST]', html: '<pre>test</pre>' };

async function setConfig(rows) {
  await db.run(`DELETE FROM app_config WHERE key LIKE 'mailgun_%'`);
  for (const [key, value] of rows) {
    await db.run(`INSERT INTO app_config (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  }
}

// Returns the rejection, or null when the call resolved - which for this function is itself
// the failure being tested for.
async function attempt() {
  try {
    const result = await sendMailgunEmail(MESSAGE);
    return { rejected: false, result };
  } catch (err) {
    return { rejected: true, err };
  }
}

async function run() {
  console.log('\n--- TESTS: services/mailgun.js failure modes (VPS alerting channel) ---');

  await db.initDb();

  // Baseline: a send that genuinely succeeds resolves with Mailgun's response. Without this the
  // rejections below would also pass against a function that rejects unconditionally, which
  // would be just as broken in the opposite direction.
  await setConfig([
    ['mailgun_api_key', encryptWith(deriveKey(process.env.APP_PASSWORD), 'key-0000000000000000000000000000000')],
    ['mailgun_domain', 'mg.example.invalid']
  ]);
  nextResponse = { ok: true, status: 200, json: async () => ({ id: '<queued@mg.example.invalid>' }) };
  const ok = await attempt();
  assert(ok.rejected === false && ok.result && ok.result.id, 'a successful send RESOLVES with the Mailgun response id - success is a distinguishable outcome');

  // KNOWN-BAD 1: Mailgun rejects the credentials. This is what a revoked or rotated Mailgun key
  // looks like, and it is the most likely way this channel dies quietly.
  nextResponse = { ok: false, status: 401, text: async () => 'Forbidden' };
  const unauthorized = await attempt();
  assert(unauthorized.rejected, 'a 401 from Mailgun THROWS - a rejected send never resolves (known-bad sample)');
  assert(/401/.test(unauthorized.err.message), `the rejection carries the HTTP status, so health-check.sh logs something diagnosable (got: ${unauthorized.err.message})`);

  // KNOWN-BAD 2: Mailgun accepted the request but refused the message (over quota, unverified
  // domain, suppressed recipient). A 2xx-looking shape that is not ok must not slip through.
  nextResponse = { ok: false, status: 402, text: async () => 'Payment Required' };
  const quota = await attempt();
  assert(quota.rejected, 'a non-2xx response of any kind throws, not just 4xx auth errors (known-bad sample)');

  // KNOWN-BAD 3: the network call itself fails - DNS gone, egress blocked, or the 15s timeout in
  // utils/fetchWithTimeout firing. The rejection has to propagate rather than being absorbed.
  nextResponse = () => { throw new Error('Request timed out after 15000ms: https://api.mailgun.net/v3/...'); };
  const timeout = await attempt();
  assert(timeout.rejected, 'a network error or timeout propagates out of sendMailgunEmail (known-bad sample)');
  assert(/timed out/i.test(timeout.err.message), 'the timeout reason survives to the caller');

  // KNOWN-BAD 4: the configuration is simply not there. This is the state a fresh or restored
  // database is in, and it must not read as "sent".
  nextResponse = { ok: true, status: 200, json: async () => ({ id: 'must-not-be-reached' }) };
  const before = requestCount;
  await setConfig([]);
  const unconfigured = await attempt();
  assert(unconfigured.rejected, 'a missing Mailgun configuration throws (known-bad sample)');
  assert(requestCount === before, 'and it throws BEFORE any request is made, so "no config" cannot be confused with "sent"');

  // KNOWN-BAD 5: the one that ties this file to the APP_PASSWORD rotation runbook
  // (docs/secret-rotation.md). The Mailgun key is stored encrypted under a key derived from
  // APP_PASSWORD. Rotate APP_PASSWORD without re-encrypting and this row stops decrypting -
  // AES-GCM authentication fails - which takes the VPS alerting channel down with it. The
  // failure must be a throw, not an empty key silently posted to Mailgun.
  await setConfig([
    ['mailgun_api_key', encryptWith(deriveKey('a-different-app-password-as-after-an-unmigrated-rotation'), 'key-1111111111111111111111111111111')],
    ['mailgun_domain', 'mg.example.invalid']
  ]);
  const wrongKey = await attempt();
  assert(wrongKey.rejected, 'a Mailgun key encrypted under a DIFFERENT APP_PASSWORD throws instead of sending with a broken key (known-bad sample)');

  // Finally, prove the stub itself is not what makes things fail - restore a good config and
  // send again. If this did not pass, every rejection above would be unattributable.
  await setConfig([
    ['mailgun_api_key', encryptWith(deriveKey(process.env.APP_PASSWORD), 'key-0000000000000000000000000000000')],
    ['mailgun_domain', 'mg.example.invalid']
  ]);
  nextResponse = { ok: true, status: 200, json: async () => ({ id: '<queued-again@mg.example.invalid>' }) };
  const okAgain = await attempt();
  assert(okAgain.rejected === false, 'a good configuration still sends after all the injected failures - the failures came from the injections, not from the harness');
}

run()
  .then(() => {
    console.log('\n🎉 MAILGUN FAILURE MODE TESTS PASSED\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ MAILGUN FAILURE MODE TESTS FAILED');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
