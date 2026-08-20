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
