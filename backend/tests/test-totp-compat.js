// Compatibility of stored credentials across the bcryptjs 2 -> 3 and otplib 12 -> 13 upgrades
// (10.2026).
//
// Both libraries verify values written by their previous major version: password hashes in
// users.password_hash and TOTP secrets in users.totp_secret, plus the codes the users'
// authenticator apps derive from those secrets. A mismatch here does not fail loudly - it is
// every existing user getting "wrong password" or "wrong code" after the deploy. The fixtures
// below were produced by bcryptjs 2.4.3 and otplib 12.0.1 (authenticator, default options),
// and must keep verifying with whatever versions package.json now pins.
//
// Run with: node tests/test-totp-compat.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-totp-compat-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-totp-compat';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-totp-compat';

const bcrypt = require('bcryptjs');
const db = require('../db');
const { verifyTotpOnce, newTotpSecret, totpKeyUri, totpCode, matchingTimeStep } = require('../utils/totp');
const { freshTotpCode } = require('./helpers/totp');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// bcryptjs 2.4.3, hashSync(password, cost). It wrote the $2a$ prefix; 3.x writes $2b$.
const BCRYPTJS_2_HASHES = [
  ['correct horse battery staple', '$2a$10$OXcQlNBQL.ayvkS0SkGFxuDjITroSasY4H5WWE8ip1SuNczu3eZva'],
  ['zażółć gęślą jaźń', '$2a$10$zMC777805mhR5FMMHODf4e6teuyIeIf0LjErHz.6JdpCC6YTdGTvG'],
  ['x'.repeat(80), '$2a$10$OkoDpdI7Bl3fA4F1WJk8m.HEz4DhUkh/5JHRb03jDypnhS/IWtT5i'],
  ['Test1234', '$2a$10$A7FacupgvqRXtC5DlLFhDOsPs1nnCT4LRPXdC/lcZAMsriBlxEoFC'],
  ['Test1234', '$2a$04$d9yg0aLIUWxQtLBHWA/d7eRkBQPEx5OAvWdywBOp.bdU0NiZYnDGa']
];

// otplib 12.0.1: authenticator.generateSecret() (10 bytes, 16 base32 characters - the
// format of every secret enrolled before the upgrade), one 20-byte secret, and the textbook
// JBSWY3DPEHPK3PXP; codes from authenticator.generate() at the given Unix time.
const OTPLIB_12_CODES = [
  ['OA4WUKIRDUWX4SRW', 1760000000, '649688'],
  ['OA4WUKIRDUWX4SRW', 1791776954, '221025'],
  ['OA4WUKIRDUWX4SRW', 2000000015, '257177'],
  ['CQ4QCB2OIFVEEAZE', 1760000000, '172584'],
  ['CQ4QCB2OIFVEEAZE', 1791776954, '054326'],
  ['CQ4QCB2OIFVEEAZE', 2000000015, '506831'],
  ['CJ6AGEYKGVYEGOZT', 1760000000, '835126'],
  ['CJ6AGEYKGVYEGOZT', 1791776954, '982910'],
  ['CJ6AGEYKGVYEGOZT', 2000000015, '328929'],
  ['JBSWY3DPEHPK3PXP', 1760000000, '885822'],
  ['JBSWY3DPEHPK3PXP', 1791776954, '153028'],
  ['JBSWY3DPEHPK3PXP', 2000000015, '620710'],
  ['AUBS26DBMQQRE6DRDESXMJTWAEMGOOLD', 1760000000, '092709'],
  ['AUBS26DBMQQRE6DRDESXMJTWAEMGOOLD', 1791776954, '777152'],
  ['AUBS26DBMQQRE6DRDESXMJTWAEMGOOLD', 2000000015, '866851']
];

async function testBcryptHashesFromV2() {
  console.log('\n--- TEST: password hashes written by bcryptjs 2.4.3 still verify ---');
  // The wrong password differs in its FIRST character: bcrypt ignores everything past byte 72,
  // so a suffix would not make the 80-character one wrong.
  for (const [password, hash] of BCRYPTJS_2_HASHES) {
    assert(await bcrypt.compare(password, hash), `${hash.slice(0, 7)} hash of a ${password.length}-character password verifies`);
    assert(!(await bcrypt.compare('#' + password.slice(1), hash)), `and a different password is refused against it (known-bad sample)`);
  }

  // A $2b$ hash is what 3.x writes from now on. Same algorithm, only the prefix differs, so
  // a hash with the prefix swapped verifies too - and a rollback to 2.4.3 reads $2b$ as well.
  const swapped = BCRYPTJS_2_HASHES[3][1].replace('$2a$', '$2b$');
  assert(await bcrypt.compare('Test1234', swapped), 'the same hash with the $2b$ prefix verifies');
  const fresh = await bcrypt.hash('Test1234', 10);
  assert(fresh.startsWith('$2b$10$') && await bcrypt.compare('Test1234', fresh), `a new hash is $2b$, cost 10, and verifies (got ${fresh.slice(0, 7)})`);
}

function testOtplib12CodesStillMatch() {
  console.log('\n--- TEST: codes otplib 12 produced for stored secrets still match ---');
  for (const [secret, epoch, code] of OTPLIB_12_CODES) {
    const step = matchingTimeStep(secret, code, epoch);
    assert(step === Math.floor(epoch / 30), `${secret.length}-character secret at ${epoch}: ${code} matches, step ${step}`);
    assert(totpCode(secret, epoch) === code, `and the code generated now for it is the same ${code}`);
  }

  // RFC 6238 appendix B, SHA-1, T = 59 s; the 6-digit tail of 94287082. The secret is the
  // ASCII "12345678901234567890" in base32.
  assert(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59) === '287082', 'the RFC 6238 SHA-1 test vector holds');
}

function testToleranceWindowUnchanged() {
  console.log('\n--- TEST: the tolerance window is still a single 30-second step ---');
  const [secret, epoch, code] = OTPLIB_12_CODES[0];
  const stepStart = Math.floor(epoch / 30) * 30;
  assert(matchingTimeStep(secret, code, stepStart) !== null, 'the code matches at the first second of its step');
  assert(matchingTimeStep(secret, code, stepStart + 29) !== null, 'and at the last second of it');
  assert(matchingTimeStep(secret, code, stepStart + 30) === null, 'but not in the next step (known-bad sample)');
  assert(matchingTimeStep(secret, code, stepStart - 1) === null, 'nor in the previous one (known-bad sample)');
}

function testMalformedInputIsNoMatch() {
  console.log('\n--- TEST: malformed codes and secrets are "no match", not an exception ---');
  const [secret, epoch, code] = OTPLIB_12_CODES[0];
  for (const bad of ['', code.slice(1), code + '1', 'abcdef', ' ' + code]) {
    assert(matchingTimeStep(secret, bad, epoch) === null, `code ${JSON.stringify(bad)} is refused without throwing`);
  }
  assert(matchingTimeStep('NOT*BASE32', code, epoch) === null, 'a secret that is not base32 is refused without throwing');
  assert(matchingTimeStep('AAAAAAAA', code, epoch) === null, 'a secret shorter than any we ever issued is refused without throwing');
}

function testNewSecretsAndUri() {
  console.log('\n--- TEST: new secrets and the QR code URI ---');
  const secret = newTotpSecret();
  assert(/^[A-Z2-7]{32}$/.test(secret), `a new secret is 20 bytes of base32 (got ${secret.length} characters)`);
  const now = Math.floor(Date.now() / 1000);
  assert(matchingTimeStep(secret, totpCode(secret, now), now) !== null, 'a code for a new secret verifies');

  const uri = new URL(totpKeyUri('test user', 'JBSWY3DPEHPK3PXP'));
  assert(uri.protocol === 'otpauth:' && uri.host === 'totp', `the URI is otpauth://totp (got ${uri.protocol}//${uri.host})`);
  assert(decodeURIComponent(uri.pathname) === '/Dietetyk AI:test user', `the label is "issuer:username" as before (got ${decodeURIComponent(uri.pathname)})`);
  assert(uri.searchParams.get('secret') === 'JBSWY3DPEHPK3PXP' && uri.searchParams.get('issuer') === 'Dietetyk AI', 'secret and issuer are in the query');
  // otplib 12 wrote period=30&digits=6&algorithm=SHA1; 13 omits defaults. Either is fine, a
  // DIFFERENT value is not - apps would derive other codes.
  for (const [key, expected] of [['period', '30'], ['digits', '6'], ['algorithm', 'SHA1']]) {
    const value = uri.searchParams.get(key);
    assert(value === null || value.toUpperCase() === expected, `${key} is absent or ${expected} (got ${value})`);
  }
}

async function testVerifyTotpOnceWithLegacySecret() {
  console.log('\n--- TEST: verifyTotpOnce accepts a code for a stored 10-byte secret, once ---');
  await db.initDb();
  const secret = 'OA4WUKIRDUWX4SRW';
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, totp_secret)
    VALUES (?, ?, ?, 1, ?)
  `, ['totp_compat_' + Math.random().toString(36).substring(2, 8), BCRYPTJS_2_HASHES[3][1], 'sync_' + 'c'.repeat(32), secret]);
  const userId = result.id;

  // Generate and verify inside the same step, so the test cannot straddle a step boundary.
  const code = await freshTotpCode(secret);
  assert(await verifyTotpOnce(userId, secret, code) === true, 'the current code for a legacy secret is accepted');
  assert(await verifyTotpOnce(userId, secret, code) === false, 'and refused the second time (replay protection still works)');
  const row = await db.get(`SELECT totp_last_step FROM users WHERE id = ?`, [userId]);
  assert(row.totp_last_step === Math.floor(Date.now() / 1000 / 30), `the stored step is floor(unix / 30), as before (got ${row.totp_last_step})`);
}

async function run() {
  await testBcryptHashesFromV2();
  testOtplib12CodesStillMatch();
  testToleranceWindowUnchanged();
  testMalformedInputIsNoMatch();
  testNewSecretsAndUri();
  await testVerifyTotpOnceWithLegacySecret();
}

run()
  .then(() => {
    console.log('\n🎉 CREDENTIAL COMPATIBILITY TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ CREDENTIAL COMPATIBILITY TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
