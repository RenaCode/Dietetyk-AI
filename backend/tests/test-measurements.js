const db = require('../db');

async function runTest() {
  console.log('\n--- DATABASE TEST: BODY CIRCUMFERENCE MEASUREMENTS ---');
  try {
    await db.initDb();

    // Pick a test date
    const testDate = '2026-06-16';
    const testUserId = 1; // admin

    console.log(`Inserting a test measurement for user ${testUserId} on ${testDate}...`);

    // 1. Wstawienie/Aktualizacja pomiaru
    await db.run(`
      INSERT INTO body_measurements (user_id, date, chest, waist, hips, biceps, thigh)
      VALUES (?, ?, 105.5, 88.0, 96.5, 38.5, 58.0)
      ON CONFLICT(user_id, date) DO UPDATE SET
        chest = excluded.chest,
        waist = excluded.waist,
        hips = excluded.hips,
        biceps = excluded.biceps,
        thigh = excluded.thigh
    `, [testUserId, testDate]);

    console.log('✅ Insert/update succeeded.');

    // 2. Fetching the measurement
    const row = await db.get(`
      SELECT * FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    console.log('Pobrane dane z bazy:', row);

    if (row && row.chest === 105.5 && row.waist === 88.0 && row.hips === 96.5 && row.biceps === 38.5 && row.thigh === 58.0) {
      console.log('✅ Data verification succeeded.');
    } else {
      throw new Error('The retrieved data does not match what was saved.');
    }

    // 3. Cleanup (delete)
    console.log('Usuwanie testowego wpisu...');
    await db.run(`
      DELETE FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    const rowAfterDelete = await db.get(`
      SELECT 1 FROM body_measurements 
      WHERE user_id = ? AND date = ?
    `, [testUserId, testDate]);

    if (!rowAfterDelete) {
      console.log('✅ Deleting the entry and cleaning up succeeded.');
    } else {
      throw new Error('The entry was not deleted from the database.');
    }

    console.log('\n=====================================');
    console.log('🎉 BODY MEASUREMENT TESTS PASSED');
    console.log('=====================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ BODY MEASUREMENT TESTS FAILED:', err.message);
    process.exit(1);
  }
}

runTest();
