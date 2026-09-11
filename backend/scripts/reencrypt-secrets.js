#!/usr/bin/env node

// Re-encrypts every secret in the database from an OLD APP_PASSWORD to the NEW one.
//
// Why this exists as a separate script from scripts/encrypt-existing-secrets.js: that one only
// ever ENCRYPTS plaintext and deliberately SKIPS anything that already carries the enc:v1:
// prefix. After APP_PASSWORD changes, every stored value carries that prefix, so it would skip
// all of them and leave the database silently unreadable - the backend would keep starting,
// and users would only find out when an Oura sync, a Gemini call or a Mailgun send failed.
// ENCRYPTION_KEY = scrypt(APP_PASSWORD, ...) (utils/encryption.js), so a new APP_PASSWORD is a
// new key, and no value written under the old key can be read again without it.
//
// Order of operations matters and is enforced here rather than trusted to the operator:
//   1. the backend must be STOPPED - a token refresh running mid-migration would write a value
//      under one key while this script is rewriting the rest under another,
//   2. a verified copy of the .db file is made BEFORE anything is written,
//   3. every value is decrypted with the old key IN MEMORY first; a single failure aborts the
//      run before a single write happens,
//   4. the writes go in one transaction, so the database is either fully on the old key or
//      fully on the new one - never half.
// The full runbook is in backend/docs/secret-rotation.md.
//
// Usage (locally, from backend/, with nothing else touching the database):
//   APP_PASSWORD_OLD='<previous value>' APP_PASSWORD='<new value>' \
//     node scripts/reencrypt-secrets.js
//
// In production this runs as a one-off Kubernetes Job that mounts the same PVC
// (dietetyk-data-pvc) and the same Secret as the backend, with the Deployment scaled to 0 so no
// other process holds the SQLite file. The ready-made Job manifest and the surrounding steps are
// in backend/docs/secret-rotation.md - do not improvise it, the ORDER is what makes it safe.
//
// No secret value - plaintext or ciphertext - is ever logged; the output only counts rows.

// We load .env explicitly (as config.js does) - this script runs standalone (node scripts/...)
// rather than through server.js, so nothing has loaded dotenv beforehand. Values already present
// in the environment win over .env (dotenv does not overwrite), which is what lets the two
// passwords be passed on the command line while .env is still mid-edit.
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db');
const { deriveKey, encryptWith, decryptWith, ENC_PREFIX } = require('../utils/encryption');
const { USER_SECRET_SETTING_KEYS, APP_SECRET_CONFIG_KEYS } = require('../utils/secretKeys');

const OLD_SECRET = process.env.APP_PASSWORD_OLD;
const NEW_SECRET = process.env.APP_PASSWORD;

if (!OLD_SECRET) {
  console.error(
    'APP_PASSWORD_OLD is missing - set it to the APP_PASSWORD value the database was encrypted ' +
    'with BEFORE the rotation. Without it the stored values cannot be read at all.'
  );
  process.exit(1);
}
if (OLD_SECRET === NEW_SECRET) {
  console.error('APP_PASSWORD_OLD is identical to APP_PASSWORD - nothing to re-encrypt.');
  process.exit(1);
}

const oldKey = deriveKey(OLD_SECRET);
const newKey = deriveKey(NEW_SECRET);

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(ENC_PREFIX);

// Collects the work without touching the database: for every secret column, the value re-encrypted
// under the new key plus the SQL to write it back. Values that are still legacy plaintext (no
// prefix - see utils/encryption.js) are encrypted with the new key here, so a rotation also
// finishes whatever encrypt-existing-secrets.js never got to.
async function planMigration() {
  const plan = [];
  let legacyPlaintext = 0;

  const reencrypt = (value, where) => {
    if (!value) return null;
    if (!isEncrypted(value)) {
      legacyPlaintext++;
      return encryptWith(newKey, value);
    }
    let plaintext;
    try {
      plaintext = decryptWith(oldKey, value);
    } catch (err) {
      // AES-GCM authentication failed: this value was not written with APP_PASSWORD_OLD. Either
      // the old password is wrong, or the database is already (partly) on the new key. Both cases
      // must stop the run - re-encrypting the rest would produce a database with two keys in it.
      const e = new Error(
        `Cannot decrypt ${where} with APP_PASSWORD_OLD (GCM authentication failed). ` +
        'Nothing has been written. Check that APP_PASSWORD_OLD is exactly the previous value ' +
        'and that this migration has not already run.'
      );
      e.cause = err;
      throw e;
    }
    return encryptWith(newKey, plaintext);
  };

  const settingsPlaceholders = USER_SECRET_SETTING_KEYS.map(() => '?').join(',');
  const settings = await db.all(
    `SELECT user_id, key, value FROM settings WHERE key IN (${settingsPlaceholders})`,
    USER_SECRET_SETTING_KEYS
  );
  for (const row of settings) {
    const value = reencrypt(row.value, `settings.${row.key} (user ${row.user_id})`);
    if (value === null) continue;
    plan.push({
      sql: `UPDATE settings SET value = ? WHERE user_id = ? AND key = ?`,
      params: [value, row.user_id, row.key]
    });
  }

  const configPlaceholders = APP_SECRET_CONFIG_KEYS.map(() => '?').join(',');
  const config = await db.all(
    `SELECT key, value FROM app_config WHERE key IN (${configPlaceholders})`,
    APP_SECRET_CONFIG_KEYS
  );
  for (const row of config) {
    const value = reencrypt(row.value, `app_config.${row.key}`);
    if (value === null) continue;
    plan.push({ sql: `UPDATE app_config SET value = ? WHERE key = ?`, params: [value, row.key] });
  }

  const tokens = await db.all(`SELECT user_id, service, access_token, refresh_token FROM oauth_tokens`);
  for (const row of tokens) {
    const access = reencrypt(row.access_token, `oauth_tokens.access_token (${row.service}, user ${row.user_id})`);
    const refresh = reencrypt(row.refresh_token, `oauth_tokens.refresh_token (${row.service}, user ${row.user_id})`);
    if (access === null && refresh === null) continue;
    plan.push({
      sql: `UPDATE oauth_tokens SET access_token = ?, refresh_token = ? WHERE user_id = ? AND service = ?`,
      params: [
        access === null ? row.access_token : access,
        refresh === null ? row.refresh_token : refresh,
        row.user_id,
        row.service
      ]
    });
  }

  return { plan, legacyPlaintext, scanned: settings.length + config.length + tokens.length };
}

// A copy taken with VACUUM INTO rather than a file copy, for the same reason db.js uses it: it
// produces a consistent snapshot. The name deliberately does NOT start with "dietetyk-", so the
// 14-copy rotation in db.js backupDatabase() can never delete it - this one has to outlive the
// rotation until the new key is confirmed working.
async function backupBeforeWriting() {
  const dbDir = process.env.DATABASE_DIR || path.join(__dirname, '..');
  const backupDir = path.join(dbDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pre-rotation-${timestamp}.db`);
  await db.run('VACUUM INTO ?', [backupPath]);

  const size = fs.existsSync(backupPath) ? fs.statSync(backupPath).size : 0;
  if (size === 0) {
    throw new Error(`The pre-rotation backup was not written (${backupPath}). Aborting without any changes.`);
  }
  console.log(`[BACKUP] Pre-rotation copy written: ${backupPath} (${size} bytes)`);
  return backupPath;
}

async function run() {
  await db.initDb();
  console.log('Re-encrypting database secrets from APP_PASSWORD_OLD to APP_PASSWORD...\n');
  console.log('Stop the backend before running this - a concurrent token refresh would write a value under the other key.\n');

  const { plan, legacyPlaintext, scanned } = await planMigration();
  console.log(`[PLAN] ${scanned} secret columns scanned, ${plan.length} rows to rewrite (${legacyPlaintext} of them still legacy plaintext).`);
  console.log('[PLAN] Every value decrypted with the old key successfully - proceeding to write.\n');

  if (plan.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const backupPath = await backupBeforeWriting();

  // BEGIN IMMEDIATE rather than a plain BEGIN: it takes the write lock up front, so if anything
  // else has the database open for writing we fail here, before the first UPDATE, instead of
  // halfway through.
  await db.run('BEGIN IMMEDIATE');
  try {
    for (const step of plan) {
      await db.run(step.sql, step.params);
    }
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }

  console.log(`\n✅ ${plan.length} rows re-encrypted under the new APP_PASSWORD.`);
  console.log(`   Keep ${backupPath} until the integrations have been verified against the new key,`);
  console.log('   then delete it - it is a full database readable with the OLD password.');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('\n❌ The re-encryption failed:', err.message);
  console.error('   The database has NOT been modified unless the failure happened after "[BACKUP]" above,');
  console.error('   and even then the writes ran in one transaction and were rolled back.');
  process.exit(1);
});
