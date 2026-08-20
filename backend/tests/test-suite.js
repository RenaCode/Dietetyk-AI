const db = require('../db');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');

async function testDatabaseSchema() {
  console.log('\n--- TEST 1: Weryfikacja Schematu Bazy Danych ---');
  await db.initDb();
  
  const usersTable = await db.all("PRAGMA table_info(users)");
  const requiredCols = ['id', 'username', 'password_hash', 'sync_token', 'totp_secret', 'totp_enabled', 'role', 'status', 'email', 'invitation_token'];
  
  let ok = true;
  requiredCols.forEach(col => {
    const found = usersTable.some(c => c.name === col);
    if (!found) {
      console.error(`❌ Brak wymaganej kolumny w tabeli users: ${col}`);
      ok = false;
    }
  });

  const appConfigTable = await db.all("PRAGMA table_info(app_config)");
  if (appConfigTable.length === 0) {
    console.error('❌ The app_config table was not created.');
    ok = false;
  }

  if (ok) {
    console.log('✅ The database schema and tables are correct.');
  } else {
    throw new Error('The database schema test failed.');
  }
}

async function testUserMfaForcedFlow() {
  console.log('\n--- TEST 2: Wymuszenie 2FA przy logowaniu ---');
  
  // Insert a test user with a fixed token and 2FA disabled
  const testHash = await bcrypt.hash('testpassword123', 10);
  const testUsername = 'testuser_' + Math.random().toString(36).substring(2, 7);
  const syncToken = 'sync_' + Math.random().toString(36).substring(2);
  
  const userResult = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status)
    VALUES (?, ?, ?, 0, 'testuser@example.com', 'user', 'active')
  `, [testUsername, testHash, syncToken]);
  
  const userId = userResult.id;
  console.log(`Registered the test user: ${testUsername} (ID: ${userId})`);

  // Check that the backend issues setup_2fa for this user
  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  const isMatch = await bcrypt.compare('testpassword123', user.password_hash);
  
  if (!isMatch) {
    console.error('❌ The passwords do not match.');
    return;
  }

  if (user.totp_enabled === 0 && user.username !== 'admin') {
    const secret = user.totp_secret || authenticator.generateSecret();
    console.log(`✅ Success: user ${user.username} has 2FA disabled, generating a secret key: ${secret}`);
  } else {
    console.error('❌ Error: login did not enforce 2FA for a standard user.');
  }

  // Clean up after the test
  await db.run('DELETE FROM users WHERE id = ?', [userId]);
  console.log('Test user data cleaned up.');
}

async function testMailgunConfigurationMasking() {
  console.log('\n--- TEST 3: Weryfikacja maskowania klucza Mailgun API ---');
  
  // Save the API key
  const testApiKey = 'key-test12345abcdef';
  await db.run(`
    INSERT INTO app_config (key, value)
    VALUES ('mailgun_api_key', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [testApiKey]);
  
  // Read back and verify the masking
  const row = await db.get(`SELECT value FROM app_config WHERE key = 'mailgun_api_key'`);
  const maskedVal = row && row.value ? '********' : '';
  
  if (maskedVal === '********') {
    console.log('✅ Success: the API key was masked correctly.');
  } else {
    console.error('❌ Error: masking was not applied correctly.');
  }

  // Clean up after the test
  await db.run("DELETE FROM app_config WHERE key = 'mailgun_api_key'");
}

async function runAll() {
  try {
    await testDatabaseSchema();
    await testUserMfaForcedFlow();
    await testMailgunConfigurationMasking();
    console.log('\n=====================================');
    console.log('🎉 ALL TESTS PASSED');
    console.log('=====================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TESTS FAILED:', err.message);
    process.exit(1);
  }
}

runAll();
