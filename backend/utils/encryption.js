const crypto = require('crypto');

// Encryption of secrets stored in SQLite (OAuth tokens for Oura/Withings/Google Fit in
// `oauth_tokens`, plus per-user and global secrets in `settings`/`app_config` - see
// utils/secretKeys.js for the list of keys treated as secret). All of these used to sit
// in the database as plain text: anyone with access to the .db file alone (via the
// dietetyk-db container or a backup) had ready-to-use access tokens for users' Oura and
// Withings accounts, plus the Gemini/Mailgun/Google API keys.
//
// The key is derived from APP_PASSWORD (scrypt + a fixed, unique "context" string)
// rather than from a new dedicated environment variable such as ENCRYPTION_KEY.
// APP_PASSWORD is ALREADY required for the backend to start (see OAUTH_STATE_SECRET in
// oauthHelpers.js) and is maintained by hand in the .env on the production VPS
// (docker-compose.yml mounts backend/.env into the container). Introducing another
// required secret would risk the backend refusing to start after the next deploy until
// someone updated that file on the server. The separate "context" string in scrypt keeps
// the keys isolated - the field-encryption key differs from OAUTH_STATE_SECRET even
// though both derive from the same base secret.
const APP_SECRET = process.env.APP_PASSWORD;
if (!APP_SECRET) {
  throw new Error(
    'APP_PASSWORD is missing from the environment - it is required, among other things, to encrypt secrets in the database.'
  );
}

const ENCRYPTION_KEY = crypto.scryptSync(APP_SECRET, 'dietetyk-ai:field-encryption:v1', 32);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:v1:';

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// Returns the value untouched when the ENC_PREFIX is absent - this covers both
// empty/missing values and data written BEFORE this encryption was introduced (legacy
// plaintext). That removes the need for a separate migration script: old values still
// read correctly and get encrypted on their next write.
function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
