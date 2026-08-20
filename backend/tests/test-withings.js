const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
const db = require('../db');

async function testWithingsConnection() {
  console.log('\n--- TEST ZINTEGROWANIA WITHINGS ---');
  await db.initDb();

  // 1. Checking the variables in .env
  const envClientId = process.env.WITHINGS_CLIENT_ID;
  const envClientSecret = process.env.WITHINGS_CLIENT_SECRET;

  // 2. Checking in the database
  const adminRow = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  let dbClientId = null;
  let dbClientSecret = null;
  if (adminRow) {
    const rows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [adminRow.id]);
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    dbClientId = settings.withings_client_id;
    dbClientSecret = settings.withings_client_secret;
  }

  const clientId = envClientId || dbClientId;
  const clientSecret = envClientSecret || dbClientSecret;

  console.log(`Environment (.env): Client ID: ${envClientId ? 'present' : 'missing'}, Client Secret: ${envClientSecret ? 'present' : 'missing'}`);
  console.log(`Baza danych (ustawienia admin): Client ID: ${dbClientId ? 'obecny' : 'brak'}, Client Secret: ${dbClientSecret ? 'obecny' : 'brak'}`);

  if (!clientId || !clientSecret) {
    console.error('❌ Error: no Withings Client ID or Client Secret in .env or the database.');
    console.log('\nTo fix this, add the following lines to backend/.env:');
    console.log('WITHINGS_CLIENT_ID=twoj_client_id_withings');
    console.log('WITHINGS_CLIENT_SECRET=twoj_client_secret_withings');
    process.exit(1);
  }

  console.log(`Using Client ID: ${clientId}`);
  console.log('Sending a probe request to the Withings API to verify connectivity...');

  try {
    const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken',
        grant_type: 'authorization_code',
        code: 'mock_code_test_123',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'https://dietetyk.renacode.com/api/auth/withings/callback'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP connection error talking to the Withings API: ${response.status} - ${errText}`);
    }

    const resJson = await response.json();
    console.log('Response from the Withings API:', resJson);

    // An authorisation error means the connection itself worked: the code/client_secret were sent and DNS resolved
    if (resJson.status === 293 || resJson.status === 100 || resJson.status === 200 || resJson.status === 503) {
      console.log('\n✅ Reached the Withings API successfully (received a network/authorisation status response).');
      console.log('Integracja Withings jest poprawnie skonfigurowana od strony sieciowej.');
      process.exit(0);
    } else {
      console.warn('\n⚠️ Unexpected response from the Withings API. Check that the keys are correct.');
      process.exit(0);
    }
  } catch (err) {
    console.error('\n❌ Failed to reach the Withings API:', err.message);
    process.exit(1);
  }
}

testWithingsConnection();
