// Tests for the database secret encryption (utils/encryption.js, round 18 audit fix:
// OAuth tokens and API keys used to sit in SQLite as plain text).
// Pure unit tests - no database or network, run with: node tests/test-encryption.js

// utils/encryption.js requires APP_PASSWORD and fails fast without it - we load .env
// explicitly, as config.js does, so this test can run standalone regardless of whether
// anything earlier in the require chain already loaded dotenv.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function run() {
  console.log('\n--- TESTY: utils/encryption.js ---');
  const { encrypt, decrypt } = require('../utils/encryption');

  const secret = 'AIzaSy-fake-test-key-1234567890';
  const encrypted = encrypt(secret);

  assert(typeof encrypted === 'string' && encrypted.startsWith('enc:v1:'), 'encrypt() returns a value with the recognisable enc:v1: prefix');
  assert(!encrypted.includes(secret), 'the encrypted value does not contain the original secret in plain text');
  assert(decrypt(encrypted) === secret, 'decrypt(encrypt(x)) === x (round-trip)');

  // Encrypting the same value twice must produce DIFFERENT ciphertext (random IV) -
  // otherwise two identical secrets, such as the same API key held by two users, would be
  // recognisable from the stored value alone.
  const encryptedAgain = encrypt(secret);
  assert(encrypted !== encryptedAgain, 'the same input encrypted twice yields different ciphertext (random IV)');
  assert(decrypt(encryptedAgain) === secret, 'the second ciphertext also decrypts correctly');

  // Legacy passthrough: values written BEFORE encryption was introduced (plain text, no
  // prefix) must keep working without a database migration.
  assert(decrypt('plain-legacy-value') === 'plain-legacy-value', 'decrypt() zwraca niezaszyfrowany (legacy) plaintext bez zmian');

  // Empty or missing values - a common case, e.g. a user who never configured their own
  // Gemini key - must not throw.
  assert(encrypt('') === '', 'encrypt() na pustym stringu zwraca pusty string (no-op)');
  assert(encrypt(null) === null, 'encrypt() na null zwraca null (no-op)');
  assert(decrypt('') === '', 'decrypt() na pustym stringu zwraca pusty string (no-op)');
  assert(decrypt(null) === null, 'decrypt() na null zwraca null (no-op)');

  // Integrity: tampered ciphertext - a bit flip from unauthorised access to the database
  // file, say - must be detected by the AES-GCM auth tag rather than silently returning
  // corrupted data.
  const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  let threw = false;
  try {
    decrypt(tampered);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'tampered ciphertext throws instead of silently returning wrong data (GCM auth tag)');

  console.log('\n🎉 ENCRYPTION TESTS PASSED\n');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY SZYFROWANIA NIEUDANE');
  process.exit(1);
}
