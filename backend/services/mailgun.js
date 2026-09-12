// LOAD-BEARING OUTSIDE THIS REPOSITORY - DO NOT RENAME, MOVE, OR CHANGE THE EXPORT.
//
// Besides the application's own mail (summaries, the admin report, test sends), this module is
// the alerting channel for the entire VPS. /opt/dietetyk-ai/health-check.sh runs from root's
// crontab every 15 minutes and sends its alerts by reaching INTO a running backend pod:
//
//   kubectl exec <first pod with Ready=True> -c backend -- node -e "
//     require('dotenv').config({ path: '/app/.env' });
//     const { sendMailgunEmail } = require('/app/services/mailgun');
//     sendMailgunEmail({ to, subject, html }).then(...).catch(e => process.exit(1));"
//
// It does that to avoid keeping a second copy of the Mailgun credentials on the host - the
// decrypted key never leaves the container. The cost is that the file path
// `/app/services/mailgun`, the export name `sendMailgunEmail`, and its `{ to, subject, html }`
// argument shape are a PUBLIC INTERFACE consumed by a caller that no test, no import graph and
// no CI job in this repository can see. Rename any of them and every unit test and the whole
// pipeline stay green while the VPS quietly loses the only alerting channel that has ever
// delivered a failure e-mail from this cluster. Changing what the module requires at load time
// counts too: the chain `db.js` -> `utils/encryption.js` already means a missing or wrong
// APP_PASSWORD takes alerting down with it.
//
// Every failure path below therefore THROWS rather than returning something falsy - the shell
// caller's only signal is whether the promise rejects, and a resolved promise is logged as
// "Alert email sent". tests/test-mailgun-failure-modes.js injects five known-bad conditions
// (401, non-2xx, network timeout, missing configuration, and a key encrypted under a different
// APP_PASSWORD) and requires a rejection for each, so this property cannot regress unnoticed.
//
// Two structural limits that no change in this file can remove, both reported in the audit of
// 2026-09-12: the alert cannot go out when no backend pod is Ready - which is precisely the
// outage most worth reporting - and it cannot go out while the Deployment is scaled to 0, as
// Runbook B in docs/secret-rotation.md requires.
const db = require('../db');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { decrypt } = require('../utils/encryption');

async function sendMailgunEmail({ to, subject, html }) {
  // We select only the columns actually needed here (round 17, a fix
  // from the audit) - `SELECT * FROM app_config` used to pull EVERY configuration row
  // (including google_client_secret and force_2fa) even though this function only needs
  // the Mailgun settings. `app_config` is a key-value table (PRIMARY KEY(key)), so we
  // filter by key rather than by column.
  const configRows = await db.all(
    `SELECT key, value FROM app_config WHERE key IN ('mailgun_api_key', 'mailgun_domain', 'mailgun_region', 'mailgun_from')`
  );
  const config = {};
  configRows.forEach(r => {
    config[r.key] = r.value;
  });

  const apiKey = decrypt(config.mailgun_api_key);
  const domain = config.mailgun_domain;
  const region = config.mailgun_region || 'us';
  const from = config.mailgun_from || `"Dietetyk AI" <noreply@${domain || 'dietetyk.ai'}>`;

  if (!apiKey || !domain) {
    throw new Error('Silnik e-mail (Mailgun) nie został jeszcze skonfigurowany przez administratora.');
  }

  const apiBase = region.toLowerCase() === 'eu'
    ? 'https://api.eu.mailgun.net/v3'
    : 'https://api.mailgun.net/v3';

  const url = `${apiBase}/${domain}/messages`;
  
  const formData = new URLSearchParams();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);

  const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;

  console.log(`[MAILGUN] Sending email to ${to} via domain ${domain}...`);

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mailgun API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`[MAILGUN] Sent successfully. ID: ${result.id}`);
  return result;
}

module.exports = { sendMailgunEmail };
