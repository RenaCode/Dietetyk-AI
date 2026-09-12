#!/usr/bin/env node

// Jednorazowy, idempotentny skrypt migracyjny: szyfruje sekrety zapisane w bazie
// BEFORE utils/encryption.js was introduced (round 18 audit fix). Without this script the
// existing OAuth tokens (oauth_tokens) and API keys (settings.gemini_api_key,
// settings.oura_client_secret, settings.withings_client_secret, app_config.mailgun_api_key,
// app_config.google_client_secret) would only be encrypted on their NEXT write - an OAuth
// token refresh, or settings being saved again - which for rarely refreshed values (a Gemini
// key set once and never edited) could mean weeks or months of delay.
//
// Safe to run repeatedly: it skips values that are already encrypted (recognisable by the
// enc:v1: prefix - see utils/encryption.js) or empty.
// It never logs any decrypted or plaintext secret value.
//
// Usage:
//   cd backend && node scripts/encrypt-existing-secrets.js
//   (in production: run INSIDE the backend container so DATABASE_DIR points at the correct
//   .db file, e.g. `docker compose exec dietetyk-backend
//   node scripts/encrypt-existing-secrets.js`)

// We load .env explicitly (as config.js does) - this script runs standalone (node
// scripts/...) rather than through server.js, so nothing has loaded dotenv beforehand.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../db');
const { encrypt } = require('../utils/encryption');
const { USER_SECRET_SETTING_KEYS, APP_SECRET_CONFIG_KEYS } = require('../utils/secretKeys');

const ENC_PREFIX = 'enc:v1:';
const isAlreadyEncrypted = (value) => typeof value === 'string' && value.startsWith(ENC_PREFIX);

async function migrateSettings() {
  let migrated = 0;
  const placeholders = USER_SECRET_SETTING_KEYS.map(() => '?').join(',');
  const rows = await db.all(`SELECT user_id, key, value FROM settings WHERE key IN (${placeholders})`, USER_SECRET_SETTING_KEYS);
  for (const row of rows) {
    if (!row.value || isAlreadyEncrypted(row.value)) continue;
    await db.run(`UPDATE settings SET value = ? WHERE user_id = ? AND key = ?`, [encrypt(row.value), row.user_id, row.key]);
    migrated++;
  }
  console.log(`[settings] Zaszyfrowano ${migrated}/${rows.length} pasujących wierszy (pominięto już zaszyfrowane/puste).`);
}

async function migrateAppConfig() {
  let migrated = 0;
  const placeholders = APP_SECRET_CONFIG_KEYS.map(() => '?').join(',');
  const rows = await db.all(`SELECT key, value FROM app_config WHERE key IN (${placeholders})`, APP_SECRET_CONFIG_KEYS);
  for (const row of rows) {
    if (!row.value || isAlreadyEncrypted(row.value)) continue;
    await db.run(`UPDATE app_config SET value = ? WHERE key = ?`, [encrypt(row.value), row.key]);
    migrated++;
  }
  console.log(`[app_config] Zaszyfrowano ${migrated}/${rows.length} pasujących wierszy (pominięto już zaszyfrowane/puste).`);
}

async function migrateOauthTokens() {
  let migrated = 0;
  const rows = await db.all(`SELECT user_id, service, access_token, refresh_token FROM oauth_tokens`);
  for (const row of rows) {
    const needsAccess = row.access_token && !isAlreadyEncrypted(row.access_token);
    const needsRefresh = row.refresh_token && !isAlreadyEncrypted(row.refresh_token);
    if (!needsAccess && !needsRefresh) continue;
    await db.run(
      `UPDATE oauth_tokens SET access_token = ?, refresh_token = ? WHERE user_id = ? AND service = ?`,
      [
        needsAccess ? encrypt(row.access_token) : row.access_token,
        needsRefresh ? encrypt(row.refresh_token) : row.refresh_token,
        row.user_id,
        row.service
      ]
    );
    migrated++;
  }
  console.log(`[oauth_tokens] Zaszyfrowano ${migrated}/${rows.length} wierszy (pominięto już zaszyfrowane/puste).`);
}

async function run() {
  await db.initDb();
  console.log('Starting the one-off encryption of existing secrets in the database...\n');
  await migrateSettings();
  await migrateAppConfig();
  await migrateOauthTokens();
  console.log('\n✅ Done. Safe to run again - already encrypted values will be skipped.');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('❌ The migration failed:', err);
  process.exit(1);
});
