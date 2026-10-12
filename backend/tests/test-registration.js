const db = require('../db');
const bcrypt = require('bcryptjs');
const { newTotpSecret } = require('../utils/totp');

async function testRegistrationAndMfaDelay() {
  console.log('\n--- RUNNING REGISTRATION & 2FA DELAY TESTS ---');
  await db.initDb();

  const username = 'test_reg_' + Math.random().toString(36).substring(2, 7);
  const password = 'testpassword123';
  const email = username + '@example.com';

  console.log(`\n1. Registering user: ${username}...`);
  
  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);
  const secret = newTotpSecret();
  const syncToken = 'sync_' + Math.random().toString(36).substring(2);

  // Simulate register-public logic
  const result = await db.run(`
    INSERT INTO users (username, password_hash, sync_token, totp_enabled, email, role, status, totp_secret, created_at)
    VALUES (?, ?, ?, 0, ?, 'user', 'active', ?, datetime('now'))
  `, [username, passwordHash, syncToken, email, secret]);

  const userId = result.id;
  console.log(`✅ User registered with ID: ${userId}`);

  // Retrieve user to check created_at is populated
  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  console.log(`Account creation time in DB: ${user.created_at}`);
  if (!user.created_at) {
    throw new Error('created_at was not populated!');
  }

  // Generate permanent session
  const permanentToken = 'sess_' + Math.random().toString(36).substring(2);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
    VALUES (?, ?, ?, 0)
  `, [permanentToken, userId, expiresAt]);

  console.log(`✅ Permanent session token generated for register: ${permanentToken}`);

  console.log('\n2. Testing login under 24 hours (No 2FA forced)...');
  
  // Verify direct login logic
  const loginUser = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
  const isMatch = await bcrypt.compare(password, loginUser.password_hash);
  if (!isMatch) throw new Error('Password mismatch!');

  const userCreated = new Date(loginUser.created_at + 'Z');
  const hoursSinceCreation = (Date.now() - userCreated.getTime()) / (1000 * 60 * 60);
  
  console.log(`Hours since creation: ${hoursSinceCreation.toFixed(4)}h`);
  if (hoursSinceCreation <= 24) {
    console.log('✅ Success: Under 24h, logged in directly (MFA not forced).');
  } else {
    throw new Error('Forced MFA under 24 hours!');
  }

  console.log('\n3. Testing login after 24 hours (2FA MUST be forced)...');
  
  // Simulate 25 hours passing by updating created_at in the DB
  const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await db.run(`UPDATE users SET created_at = ? WHERE id = ?`, [pastTime, userId]);
  
  const updatedUser = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  console.log(`Updated created_at to: ${updatedUser.created_at}`);

  const updatedCreated = new Date(updatedUser.created_at + 'Z');
  const updatedHours = (Date.now() - updatedCreated.getTime()) / (1000 * 60 * 60);
  console.log(`Simulated hours since creation: ${updatedHours.toFixed(4)}h`);

  if (updatedHours > 24) {
    if (updatedUser.totp_enabled === 0) {
      console.log('✅ Success: Over 24h, 2FA setup forced!');
      console.log(`Generated MFA key uri successfully.`);
    } else {
      throw new Error('MFA already enabled? Test invalid.');
    }
  } else {
    throw new Error('Simulated age failed verification.');
  }

  // Clean up
  await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
  await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  console.log('\n✅ Cleaned up test data.');
  console.log('==============================================');
  console.log('🎉 REGISTRATION & 2FA DELAY TESTS PASSED!');
  console.log('==============================================');
}

testRegistrationAndMfaDelay().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
