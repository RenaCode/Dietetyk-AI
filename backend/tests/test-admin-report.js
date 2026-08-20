const db = require('../db');
const logger = require('../services/logger');
const { sendWeeklyAdminReport } = require('../services/adminReport');

async function runTest() {
  console.log('Starting the log module and admin report test...');
  
  try {
    // 1. Run the table migrations
    await db.initDb();

    // 2. Add a few test log entries at different levels
    console.log('Adding test log entries...');
    
    await logger.info('System started successfully.', 'SYSTEM');
    await logger.warn('Withings integration access is close to expiring.', 'INTEGRATIONS', null, '127.0.0.1', 1);
    
    // Add errors (ERROR)
    await logger.error(
      'Błąd odpytywania Gemini API - 404 Model Not Found', 
      'GEMINI_AI', 
      new Error('models/gemini-1.5-flash is not found or is not supported for generateContent.'),
      '192.168.1.50',
      1
    );
    await logger.error(
      'Niepoprawny token autoryzacji sesji', 
      'HTTP_SERVER', 
      'Error: jwt expired at Object.verify...',
      '185.201.112.5',
      1
    );
    
    // Add a repeated error to verify grouping (top 10)
    for (let i = 0; i < 3; i++) {
      await logger.error(
        'Błąd połączenia z bazą SQLite (SQLITE_BUSY)',
        'DATABASE',
        'Error: database is locked',
        '127.0.0.1'
      );
    }

    // Add security events (SECURITY)
    await logger.security(
      'Nieudana próba logowania na konto: admin (użytkownik nie istnieje)',
      'AUTH_LOGIN_FAILURE',
      { username: 'admin' },
      '80.50.23.14'
    );
    await logger.security(
      'Blokada brute-force (lockout) dla: admin',
      'AUTH_LOCKOUT',
      { key: '80.50.23.14::admin', count: 5 },
      '80.50.23.14'
    );
    await logger.security(
      'Przekroczono limit żądań API (121/120)',
      'RATE_LIMIT',
      { path: '/api/meals', method: 'POST' },
      '45.67.234.12'
    );

    console.log('Log entries written to the database.');

    // Display the log entries just added
    const logs = await db.all('SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT 5');
    console.log('\nThe 5 most recent log entries:', logs);

    // 3. Generate and send the report
    console.log('\nGenerating and sending the email report...');
    await sendWeeklyAdminReport();

    console.log('\nTest completed successfully.');
  } catch (err) {
    console.error('The test run failed:', err);
  }
}

runTest();
