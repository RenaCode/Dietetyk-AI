const crypto = require('crypto');

// Encryption of secrets stored in SQLite (OAuth tokens for Oura/Withings/Google Fit in
// `oauth_tokens`, plus per-user and global secrets in `settings`/`app_config` - see
// utils/secretKeys.js for the list of keys treated as secret). All of these used to sit
// in the database as plain text: anyone with access to the .db file alone (via the
// dietetyk-db container or a backup) had ready-to-use access tokens for users' Oura and
// Withings accounts, plus the Gemini/Mailgun/Google API keys.
//
// The key is derived from APP_PASSWORD (scrypt + a fixed, unique "context" string) rather than
// from a separate ENCRYPTION_KEY variable: APP_PASSWORD is already required, and in production
// the whole .env arrives as ONE value - the `dotenv` key of the Kubernetes Secret
// `dietetyk-backend-secret`, mounted as /app/.env (charts/dietetyk/templates/backend-deployment.yaml).
// A second required secret would live in that same blob, with the same blast radius, and buy no
// isolation. The "context" string is what keeps this key distinct from any other use of the same
// base secret.
//
// What the base secret must NOT be is a value anybody can look up. backend/.env.example used to
// ship a CONCRETE APP_PASSWORD, which reduced "encrypted at rest" to "obfuscated at rest":
// scrypt over a published string reproduces ENCRYPTION_KEY byte for byte, so a stolen .db file
// (a copy from backend/backups/, the Docker volume, or the db-viewer container) decrypts with no
// secret knowledge at all. Rotating APP_PASSWORD is therefore a real operation, not a formality -
// and it must be done in the order described in backend/docs/secret-rotation.md, because a new
// APP_PASSWORD means a new ENCRYPTION_KEY, and every value already stored under the old key
// becomes unreadable until scripts/reencrypt-secrets.js has rewritten it.
const APP_SECRET = process.env.APP_PASSWORD;
if (!APP_SECRET) {
  throw new Error(
    'APP_PASSWORD is missing from the environment - it is required, among other things, to encrypt secrets in the database.'
  );
}

// The scrypt "context" is part of the key identity: change it and every stored value becomes
// undecryptable, exactly as if APP_PASSWORD had changed. Treat it as frozen; a new scheme gets a
// new ENC_PREFIX version instead.
const KEY_CONTEXT = 'dietetyk-ai:field-encryption:v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:v1:';

// Exported so scripts/reencrypt-secrets.js can hold TWO keys at once - the old APP_PASSWORD to
// decrypt with and the new one to encrypt with - during a rotation. Application code never calls
// this: it uses encrypt()/decrypt() below, which are bound to the key from the environment.
function deriveKey(secret) {
  if (!secret) {
    throw new Error('deriveKey() requires a non-empty secret.');
  }
  return crypto.scryptSync(secret, KEY_CONTEXT, 32);
}

const ENCRYPTION_KEY = deriveKey(APP_SECRET);

function encryptWith(key, plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// Returns the value untouched when the ENC_PREFIX is absent - this covers both
// empty/missing values and data written BEFORE this encryption was introduced (legacy
// plaintext). That removes the need for a separate migration script: old values still
// read correctly and get encrypted on their next write.
function decryptWith(key, value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encrypt(plaintext) {
  return encryptWith(ENCRYPTION_KEY, plaintext);
}

function decrypt(value) {
  return decryptWith(ENCRYPTION_KEY, value);
}

module.exports = { encrypt, decrypt, deriveKey, encryptWith, decryptWith, ENC_PREFIX };
