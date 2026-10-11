// Round 12 (audit): the lists of "secret" keys (masked as '********' on read
// and never overwritten when the frontend sends the mask back) were duplicated
// independently inside two files - routes/account.js (3 places: GET/POST /api/settings
// and GET /api/user/export) and routes/admin.js (2 places: GET/POST /api/admin/config).
// The real risk of that duplication: someone adds a new secret (a new integration key,
// say) and updates only one of several places in the file - the result is a secret
// leaking in plaintext from one endpoint while the others still mask it.
//
// Two SEPARATE lists (not one shared list), because they cover two different settings
// domains:
// - USER_SECRET_SETTING_KEYS: PER-USER integration secrets, in the `settings` table
//   (each user configures their own Oura/Withings/Gemini keys).
// - APP_SECRET_CONFIG_KEYS: sekrety konfiguracji GLOBALNEJ aplikacji, w tabeli
//   `app_config` (Mailgun/Google OAuth, configured once by an admin for the whole app).

const USER_SECRET_SETTING_KEYS = ['gemini_api_key', 'oura_client_secret', 'withings_client_secret'];
const APP_SECRET_CONFIG_KEYS = ['mailgun_api_key', 'google_client_secret'];

// Returns a masked value ('********') when `key` is a secret from the given list and has
// a non-empty value - otherwise returns the value unchanged.
function maskSecretValue(key, value, secretKeys) {
  if (secretKeys.includes(key) && value) {
    return '********';
  }
  return value;
}

// Checks whether a given entry should be SKIPPED on save (POST) - that is, whether it is
// a secret for which the frontend sent back just the mask rather than a new value.
function isMaskedSecretWrite(key, value, secretKeys) {
  return secretKeys.includes(key) && value === '********';
}

module.exports = {
  USER_SECRET_SETTING_KEYS,
  APP_SECRET_CONFIG_KEYS,
  maskSecretValue,
  isMaskedSecretWrite
};
