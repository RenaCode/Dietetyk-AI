const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Database directory and file path (data persistence under Docker)
const dbDir = process.env.DATABASE_DIR || __dirname;
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'dietetyk.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite:', err.message);
  } else {
    console.log(`Connected to the SQLite database at: ${dbPath}`);
  }
});

// NOTE (round 15, comment corrected during the audit): the journal_mode actually in use
// is TRUNCATE, not WAL. TRUNCATE was chosen deliberately for compatibility with the
// Docker volume (./data) - WAL requires shared memory between processes touching the same
// database file and is unreliable on mounted network volumes and bind mounts, where file
// locking does not always behave. TRUNCATE still writes changes straight into the main
// .db file, with no separate -wal file to merge, so copying the .db alone in
// backupDatabase() below is consistent with it - unlike WAL, where a copy without the
// -wal file could miss the most recent writes. busy_timeout makes short write collisions
// (the hourly Oura/Withings/Google Fit sync overlapping a user's own write, say) wait
// briefly and retry instead of failing immediately with "SQLITE_BUSY: database is
// locked".
db.run('PRAGMA journal_mode = TRUNCATE;', (err) => {
  if (err) console.error('Failed to set PRAGMA journal_mode=TRUNCATE:', err.message);
});
db.run('PRAGMA busy_timeout = 5000;', (err) => {
  if (err) console.error('Failed to set PRAGMA busy_timeout:', err.message);
});
// SQLite does NOT enforce foreign keys or "ON DELETE CASCADE" declared in the schema
// (CREATE TABLE) by default - it has to be enabled per connection. Without it, deleting a
// user (the account-deletion feature, see routes/account.js) would leave
// osierocone wiersze w sessions/oauth_tokens/meals/health_metrics/settings/
// body_measurements behind instead of cascading the delete.
db.run('PRAGMA foreign_keys = ON;', (err) => {
  if (err) console.error('Failed to set PRAGMA foreign_keys=ON:', err.message);
});

// Helper for asynchronous queries (run)
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// Pomocnicza funkcja do pobierania jednego wiersza (get)
const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Pomocnicza funkcja do pobierania wielu wierszy (all)
const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Inicjalizacja tabel i migracje
const initDb = async () => {
  // 1. Users table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      sync_token TEXT UNIQUE NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      avatar_base64 TEXT,
      email TEXT,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      invitation_token TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      force_password_change INTEGER DEFAULT 0,
      force_2fa INTEGER DEFAULT 0,
      first_name TEXT,
      last_name TEXT
    )
  `);

  // Migration: add columns to the users table if they do not exist
  try {
    await run(`ALTER TABLE users ADD COLUMN avatar_base64 TEXT`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN email TEXT`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
  } catch (e) {}

  try {
    await run(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'`);
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN invitation_token TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN created_at TEXT");
  } catch (e) {}

  try {
    await run("UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN force_password_change INTEGER DEFAULT 0");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN force_2fa INTEGER DEFAULT 0");
  } catch (e) {}

  // Migration: Google sign-in (a step towards eventually dropping password login)
  try {
    await run("ALTER TABLE users ADD COLUMN google_id TEXT");
  } catch (e) {}
  try {
    await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL");
  } catch (e) {}


  // Migration: first and last name - used to personalise the AI dietician's phrasing
  // ("Hi Marcin, ..." rather than an impersonal tone) and shown in the profile.
  // Kept separate from `username`, the immutable technical login: a user may log in as
  // "mbeczynski" while the name they want to be called is "Marcin".
  try {
    await run("ALTER TABLE users ADD COLUMN first_name TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN last_name TEXT");
  } catch (e) {}

  // Migration: birth year - optional, used solely to compute a real maximum heart rate
  // (the 220 - age formula) for the cardio zones on the Dashboard, instead of the
  // hardcoded HRmax=190 constant (see routes/dashboard.js).
  try {
    await run("ALTER TABLE users ADD COLUMN birth_year INTEGER");
  } catch (e) {}

  // Migration: "physique goal" - an optional text description plus a reference photo
  // (a picture of the physique the user is working towards, for instance). Stored directly
  // on users (like avatar_base64) rather than in the key-value settings table, because
  // this is profile-like data, not a numeric target or a toggle. Used by dashboard.js
  // (AI advice) and chat.js (the AI dietician chat) so the model genuinely takes both the
  // written goal and the photo itself into account.
  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_text TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_photo_base64 TEXT");
  } catch (e) {}


  // 1a. Global configuration table (Mailgun settings, for instance)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Default for the `allow_public_registration` flag (round 17 audit fix). The
  // POST /api/register-public endpoint (routes/auth.js) used to be publicly reachable with
  // no kill switch at all, bypassing the admin invitation system (/api/admin/invite)
  // entirely. It defaults to OFF ('0'), following the same convention as the `force_2fa`
  // flag in this table (the string '1' means enabled, checked with === '1' in
  // routes/auth.js) - an admin must deliberately turn it on from the panel to allow
  // self-registration without an invitation.
  await run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('allow_public_registration', '0')`);

  // Create the default admin account.
  // The password is NOT hardcoded in the source. On first start, when no admin account
  // exists yet, we generate a random secure password, force a change at first login
  // (force_password_change = 1) and print it ONCE to the server log. It can also be
  // overridden with the ADMIN_INITIAL_PASSWORD environment variable on first run.
  const existingAdmin = await get(`SELECT id FROM users WHERE id = 1`);
  // B-N4: admin email from an env var - never a hardcoded private address
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@dietetyk-ai.local';
  if (!existingAdmin) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const adminHash = await bcrypt.hash(initialPassword, 10);
    const adminSyncToken = crypto.randomBytes(16).toString('hex');

    const forcePasswordChange = (process.env.CI === 'true' || process.env.ADMIN_INITIAL_PASSWORD) ? 0 : 1;
    await run(`
      INSERT INTO users (id, username, password_hash, sync_token, totp_enabled, email, role, status, force_password_change)
      VALUES (1, 'admin', ?, ?, 0, ?, 'admin', 'active', ?)
    `, [adminHash, adminSyncToken, adminEmail, forcePasswordChange]);

    console.log('========================================================');
    console.log('[DB INIT] Admin account created. Temporary login password:');
    console.log(`[DB INIT]   ${initialPassword}`);
    console.log('[DB INIT] You will be asked to change it at first login.');
    console.log('========================================================');
  }

  // For existing installations: rename to admin, set the 'admin' role
  // and the email (but only when the current email is empty or the default admin@dietetyk-ai.local
  // and a different address is configured in the environment).
  try {
    const currentAdmin = await get(`SELECT email FROM users WHERE id = 1`);
    if (currentAdmin) {
      const currentEmail = currentAdmin.email || '';
      const shouldUpdateEmail = !currentEmail || (process.env.ADMIN_EMAIL && currentEmail === 'admin@dietetyk-ai.local' && currentEmail !== process.env.ADMIN_EMAIL);
      
      if (shouldUpdateEmail) {
        await run(`UPDATE users SET username = 'admin', email = ?, role = 'admin' WHERE id = 1`, [adminEmail]);
      } else {
        await run(`UPDATE users SET username = 'admin', role = 'admin' WHERE id = 1`);
      }
    }
  } catch (e) {}


  // 2. Meals table, with a user_id column
  await run(`
    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      date TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now', 'localtime')),
      raw_text TEXT NOT NULL,
      calories INTEGER NOT NULL,
      protein REAL NOT NULL,
      carbs REAL NOT NULL,
      fat REAL NOT NULL,
      analysis_json TEXT NOT NULL,
      image_base64 TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migration: add the image_base64 column to meals if missing
  try {
    await run(`ALTER TABLE meals ADD COLUMN image_base64 TEXT`);
  } catch (e) {}

  // Migration: add the user_id column to meals if missing
  try {
    await run(`ALTER TABLE meals ADD COLUMN user_id INTEGER DEFAULT 1`);
    console.log('[DB MIGRATE] Added the user_id column to the meals table.');
  } catch (e) {}

  // Migration: meal micronutrients (fiber, sugar, sodium) - the extended AI prompt
  // (routes/meals.js) returns these alongside calories and macros. They may be NULL for
  // older meals analysed before this change.
  try {
    await run(`ALTER TABLE meals ADD COLUMN fiber REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sugar REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sodium REAL DEFAULT NULL`);
  } catch (e) {}

  // Assign legacy meals without a user_id to the first user
  await run(`UPDATE meals SET user_id = 1 WHERE user_id IS NULL OR user_id = 0`);

  // Drop the unused Apple Health sync table
  await run(`DROP TABLE IF EXISTS health_sync`);

  // 4. Settings table (migrated from a primary key on `key` to a composite (user_id, key))
  const settingsCols = await all(`PRAGMA table_info(settings)`);
  const hasUserIdInSettings = settingsCols.some(c => c.name === 'user_id');

  if (!hasUserIdInSettings) {
    console.log('[DB MIGRATE] Starting the settings table migration...');
    const tableExists = settingsCols.length > 0;
    if (tableExists) {
      await run(`ALTER TABLE settings RENAME TO settings_old`);
    }

    await run(`
      CREATE TABLE settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    if (tableExists) {
      await run(`
        INSERT INTO settings (user_id, key, value)
        SELECT 1, key, value FROM settings_old
      `);
      await run(`DROP TABLE settings_old`);
    }
    console.log('[DB MIGRATE] Settings table migration finished.');
  }

  // Insert the default user targets
  const defaultMarcinSettings = [
    { key: 'target_calories', value: '2500' },
    { key: 'target_protein', value: '150' },
    { key: 'target_carbs', value: '250' },
    { key: 'target_fat', value: '80' },
    { key: 'bmr', value: '1800' }
  ];
  for (const s of defaultMarcinSettings) {
    await run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (1, ?, ?)`, [s.key, s.value]);
  }

  // NOTE: the hardcoded default settings for user_id = 2 ("Paulina") were removed.
  // That account is deleted on every start (see above) and new users join exclusively
  // through the invitation/registration flow (routes/auth.js), which inserts its own
  // defaults for the newly created user_id. Leaving the hardcoded insert for user_id = 2
  // caused a real bug: the first new user registered on a fresh installation received
  // id = 2 (AUTOINCREMENT) and, because of the "INSERT OR IGNORE" in register-public,
  // silently inherited those dead, outdated values (2000 kcal / 120 g protein) instead of
  // the correct defaults (2500 / 150 g).

  // 5. Sessions table, with an expiry
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      is_verified_2fa INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migration: add the is_verified_2fa column to sessions if missing
  try {
    await run(`ALTER TABLE sessions ADD COLUMN is_verified_2fa INTEGER DEFAULT 0`);
  } catch (e) {}

  // 5b. Tabela blokady brute-force logowania (login_attempts) - przeniesiona
  // from process memory (a Map) into the database, so that blocks survive a restart of the
  // backend container - during a deploy, for instance. See services/loginAttempts.js.
  await run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 6. OAuth tokens table (Oura, Withings)
  await run(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      user_id INTEGER NOT NULL,
      service TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      PRIMARY KEY(user_id, service),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 7. Daily health metrics table (health_metrics)
  await run(`
    CREATE TABLE IF NOT EXISTS health_metrics (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      steps INTEGER DEFAULT 0,
      active_calories INTEGER DEFAULT 0,
      total_calories_burned INTEGER DEFAULT 0,
      sleep_score INTEGER DEFAULT NULL,
      sleep_duration REAL DEFAULT NULL,
      sleep_deep REAL DEFAULT NULL,
      sleep_rem REAL DEFAULT NULL,
      readiness_score INTEGER DEFAULT NULL,
      hrv REAL DEFAULT NULL,
      rhr REAL DEFAULT NULL,
      temperature_deviation REAL DEFAULT NULL,
      weight REAL DEFAULT NULL,
      fat_ratio REAL DEFAULT NULL,
      muscle_mass REAL DEFAULT NULL,
      last_sync TEXT DEFAULT NULL,
      ai_advice TEXT DEFAULT NULL,
      ai_advice_generated_at TEXT DEFAULT NULL,
      last_meal_modified_at TEXT DEFAULT NULL,
      supplements TEXT DEFAULT NULL,
      PRIMARY KEY(user_id, date),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN active_minutes INTEGER DEFAULT 0");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_advice TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_advice_generated_at TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN last_meal_modified_at TEXT DEFAULT NULL");
  } catch (e) {}

  // Migration: water intake counter (a daily counter, like steps - resets each day)
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN water_ml INTEGER DEFAULT 0");
  } catch (e) {}

  // Migration: the source of the activity data (steps/active_calories/
  // total_calories_burned/active_minutes) for a given date - 'oura' or 'apple'. Needed for
  // the Apple Health sync rule described in routes/appleHealth.js. At the time this column
  // was introduced Oura was treated as the more authoritative source: when Oura actually
  // returned activity data for a date, it OVERWROTE values previously written by Apple
  // Health, while the Apple Health webhook NEVER overwrote a row already marked
  // activity_source = 'oura'. That priority has since been inverted and centralised - see
  // utils/activitySources.js.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN activity_source TEXT DEFAULT NULL");
  } catch (e) {}

  // Migration: respiratory rate during sleep (Oura, the average_breath field from the
  // /v2/usercollection/sleep endpoint we already call in sync.js - this field used to be
  // ignored). The "Respiratory rate" card on the Dashboard previously showed a hardcoded
  // "13.8"; it now shows this real value.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN respiratory_rate REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dobowe SpO2 z Oury (endpoint /v2/usercollection/daily_spo2, NOWE
  // request in sync.js - available only on Gen 3 rings; on older models the field stays
  // NULL). The "Blood oxygen" card previously showed a hardcoded "98.4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN spo2_percentage REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: absolutna temperatura nadgarstka z Apple Watch (Health Auto Export,
  // the "Wrist Temperature" metric arrives as name: "wrist_temperature", see
  // routes/appleHealth.js). NOTE: this is a different value from Oura's
  // `temperature_deviation`, which is a deviation from baseline rather than an absolute
  // reading. It is available only on Apple Watch Series 8+/Ultra, and only when the user
  // enables that metric in the Health Auto Export automation on their phone. The "Wrist
  // temperature" card previously showed a hardcoded "35.4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN wrist_temperature REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dystans (metry) - z Oury (equivalent_walking_distance), Google Fit
  // (distance.delta) or Apple Health (walking_running_distance, via the webhook). Taken
  // from the same source as the rest of the activity data (priority apple > google_fit >
  // oura, see activity_source and utils/activitySources.js).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN distance_meters REAL DEFAULT NULL");
  } catch (e) {}

  // Migration: the day broken down into minutes by activity intensity (Oura returns
  // seconds; we store minutes after conversion). This shows what the day actually looked
  // like rather than just a total of "active minutes". medium+high are already counted
  // together as active_minutes (see sync.js) - here we only add the missing categories.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN sedentary_minutes INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN low_activity_minutes INTEGER DEFAULT NULL");
  } catch (e) {}

  // Migracja: realny poziom stresu z Oury (endpoint /v2/usercollection/daily_stress,
  // available only on rings that support it - otherwise the fields stay NULL).
  // This is NOT a revival of the old hardcoded stress section (see the comment where it was
  // removed in Dashboard.jsx) - these are real values from the Oura API.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_high_minutes REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_recovery_minutes REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN stress_summary TEXT DEFAULT NULL");
  } catch (e) {}

  try {
    await run("ALTER TABLE health_metrics ADD COLUMN supplements TEXT DEFAULT NULL");
  } catch (e) {}

  // Migration: blood pressure from Withings (the getmeas endpoint, meastype 9 = diastolic
  // and 10 = systolic; measured with a Withings blood pressure monitor synced through the
  // same account as weight and body composition, see syncWithings in services/sync.js).
  // Separate columns rather than one text field, so the values can be used in trends and
  // charts.
  // tak samo jak weight/fat_ratio/muscle_mass.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_systolic REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_diastolic REAL DEFAULT NULL");
  } catch (e) {}

  // Migration: cache for the short AI "why" explanation covering the largest deviation of a
  // daily metric (sleep/readiness/RHR/HRV) from that day's own baseline - in the style of
  // Oura Advisor or Whoop Coach, see /api/dashboard/ai-explanation-insight.
  // Kept in its own column, separate from ai_advice/ai_advice_generated_at, because it is
  // different content (a short, targeted explanation of ONE deviation rather than the full
  // daily advice) on a different refresh rhythm (cached per day, not every 30 minutes).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_explanation TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_explanation_generated_at TEXT DEFAULT NULL");
  } catch (e) {}

  // Migration: the daily wellbeing tracker (energy level and mood, on a 1-5 scale).
  // Both fields are entered by hand through the form on the Dashboard (POST /api/feeling in
  // health.js). They enable correlations against data the app already has: energy versus
  // sleep/HRV/meals, mood versus activity/stress - with no new integrations.
  // NULL means no entry for that day (the user did not rate it).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN energy_level INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN mood INTEGER DEFAULT NULL");
  } catch (e) {}

  // Default water target (ml) for the existing admin account, if not already set
  await run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (1, 'target_water_ml', '2500')`);

  // 7a. Individual workouts from Apple Health (Health Auto Export, "Data type: Workouts" -
  // see routes/appleHealth.js). We keep EVERY workout as its own row (key: user_id +
  // workout_id from the payload) rather than summing straight into health_metrics, so that:
  //   1) re-sending the same workout (a retry, or an automation date range that covers the
  //      same workout more than once) only OVERWRITES its own row (ON CONFLICT DO UPDATE)
  //      instead of adding its calories and minutes to the daily total a second time -
  //      double counting;
  //   2) several different workouts on the same day, delivered in SEPARATE webhook calls
  //      (an automation that fires after each workout, for instance), can add up correctly:
  //      the daily total in health_metrics is recomputed from scratch as SUM(...) over all
  //      of that day's workouts in this table, rather than being incremented blindly.
  await run(`
    CREATE TABLE IF NOT EXISTS apple_health_workouts (
      user_id INTEGER NOT NULL,
      workout_id TEXT NOT NULL,
      date TEXT NOT NULL,
      active_calories REAL DEFAULT 0,
      duration_minutes REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY(user_id, workout_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Round 3 (audit): table for Apple Health hydration samples, for idempotency
  await run(`
    CREATE TABLE IF NOT EXISTS apple_health_water_samples (
      user_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      date TEXT NOT NULL,
      qty REAL NOT NULL,
      PRIMARY KEY(user_id, timestamp),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migracja: typ treningu (np. "Running", "Functional Strength Training" - pole
  // the `name` field from the Health Auto Export payload, see routes/appleHealth.js).
  // Added after a functional audit found that /api/dashboard always returned a hardcoded
  // empty `workouts: []` even though this table was in fact collecting workouts - without
  // the workout type, the "Latest activity" section on the Dashboard could not show a
  // meaningful icon or label (getWorkoutIcon and the type field in Dashboard.jsx).
  try {
    await run("ALTER TABLE apple_health_workouts ADD COLUMN workout_type TEXT DEFAULT NULL");
  } catch (e) {}

  // Migration: per-workout heart rate (Health Auto Export, the "Include Workout Metrics"
  // toggle in the phone automation). When enabled, the workout payload carries
  // avgHeartRate/maxHeartRate and heartRateData - a series of heart-rate samples RECORDED
  // DURING that specific workout - all of which used to be ignored entirely; see
  // routes/appleHealth.js. zone1_minutes..zone5_minutes hold how many minutes of THAT
  // workout were spent in each of the five Karvonen zones (the same 50/60/70/80/90% of
  // heart-rate reserve as the static "Heart rate zones" reference table on the Dashboard).
  // They are computed ONCE, when the workout is saved in appleHealth.js, rather than
  // recalculated live on every read.
  // All of these columns stay NULL when the payload carries no heart-rate data, or when the
  // user has not set a birth year in their profile (HRmax unknown, so zones cannot be
  // computed) - cards and insights built on them must treat NULL as "no data", not zero.
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN avg_heart_rate REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN max_heart_rate REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone1_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone2_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone3_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone4_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone5_minutes REAL DEFAULT NULL"); } catch (e) {}

  // 8. Body circumference measurements table (body_measurements)
  await run(`
    CREATE TABLE IF NOT EXISTS body_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      chest REAL DEFAULT NULL,
      waist REAL DEFAULT NULL,
      hips REAL DEFAULT NULL,
      biceps REAL DEFAULT NULL,
      thigh REAL DEFAULT NULL,
      biceps_left REAL DEFAULT NULL,
      biceps_right REAL DEFAULT NULL,
      shoulders REAL DEFAULT NULL,
      waist_above REAL DEFAULT NULL,
      waist_below REAL DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    )
  `);

  // Supporting ALTER TABLE statements for the extended body circumferences
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_left REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_right REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN shoulders REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_above REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_below REAL DEFAULT NULL"); } catch (e) {}

  // 9. Application log table (app_logs)
  await run(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime')),
      level TEXT NOT NULL,      -- INFO, WARN, ERROR, SECURITY
      category TEXT NOT NULL,   -- AUTH, API, SYSTEM, etc.
      message TEXT NOT NULL,
      ip TEXT,
      user_id INTEGER,
      details TEXT,             -- JSON string lub stack trace
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON app_logs(timestamp)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level)`);

  // 10. Table of PDF report sharing links (product feature: share a report by link,
  // read-only) - a token rather than a session or cookie, because the link must work for a
  // doctor or dietician with no account in the app. `revoked` is a separate flag rather
  // than deleting the row, so the owner can see the sharing history in Settings and not
  // only the links that are currently active. `expires_at` is required (NOT NULL) - a link
  // with no expiry would be permanent, never-expiring access to health data.
  await run(`
    CREATE TABLE IF NOT EXISTS shared_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      expires_at TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_shared_reports_user ON shared_reports(user_id)`);

  // 11. Day events table (day_events) - the "day tag": the user marks a date range with
  // context (illness/holiday/late bedtime) so that (a) the context is visible when
  // reviewing those days, and (b) selected dashboard insights can exclude them from the
  // baseline calculation, keeping an atypical period from distorting the trend.
  // A date range (start_date/end_date) rather than a single date, because a holiday or an
  // illness usually spans several days and clicking each one separately would be tedious
  // (for single-day events such as "late bedtime", start_date equals end_date).
  // `type` is a closed enum controlled by the backend (see routes/dayEvents.js),
  // not free text - insights map specific types to specific exclusions.
  await run(`
    CREATE TABLE IF NOT EXISTS day_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      note TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  // Indeks pod zapytania "WHERE user_id = ? AND type = ? AND end_date >= ? AND
  // start_date <= ?" (checking that an event range intersects the insight window).
  await run(`CREATE INDEX IF NOT EXISTS idx_day_events_user_type ON day_events(user_id, type, start_date, end_date)`);

  // Indeksy pod zapytania zakresowe "WHERE user_id = ? AND date >= ?" (agregacje
  // 7/30/90-dniowe w dashboard.js/summaries.js/chat.js). health_metrics i
  // body_measurements already get such an index for free (PRIMARY KEY(user_id, date) for
  // health_metrics, UNIQUE(user_id, date) for body_measurements each create an implicit
  // index) - it was missing for meals and apple_health_workouts, where (user_id, date) is
  // not part of the primary key or a uniqueness constraint.
  await run(`CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON apple_health_workouts(user_id, date)`);

  // Round 3 (audit): clean up expired sessions when the database starts
  await cleanupExpiredSessions();

  console.log('SQLite database migrated and initialised successfully.');
};

const cleanupExpiredSessions = async () => {
  try {
    const result = await run("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')");
    if (result.changes > 0) {
      console.log(`[CLEANUP] Removed ${result.changes} expired sessions.`);
    } else {
      console.log('[CLEANUP] No expired sessions to remove.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Failed to clean up sessions:', err);
  }
};

const cleanupOldImages = async () => {
  try {
    const result = await run(`
      UPDATE meals 
      SET image_base64 = NULL 
      WHERE image_base64 IS NOT NULL 
        AND timestamp < datetime('now', '-14 days', 'localtime')
    `);
    if (result.changes > 0) {
      console.log(`[CLEANUP] Removed images from ${result.changes} meals older than 14 days.`);
      await run('VACUUM');
      console.log('[CLEANUP] Wykonano VACUUM bazy danych.');
    } else {
      console.log('[CLEANUP] No old photos to remove.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Failed to clean up old photos:', err);
  }
};

const cleanupOldLogs = async () => {
  try {
    const result = await run(`
      DELETE FROM app_logs 
      WHERE timestamp < datetime('now', '-30 days', 'localtime')
    `);
    if (result.changes > 0) {
      console.log(`[CLEANUP] Removed ${result.changes} log entries older than 30 days.`);
    } else {
      console.log('[CLEANUP] No old logs to remove.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Failed to clean up old logs:', err);
  }
};

  // Automatic SQLite backups, rotated - the last 14 by default.
  // The database file lives on a Docker volume (./data), which is not itself a backup: a
  // disk failure, an accidental `rm -rf` or a bad migration would overwrite the only copy
  // of the data. The copies live in a backups/ subdirectory of that same volume - real
  // protection against host failure additionally requires shipping them off the server
  // (see the "Backups" section of the README).
const backupDir = path.join(dbDir, 'backups');
const BACKUP_RETENTION_COUNT = 14;

// Verifying a freshly created backup: we open it as a SEPARATE read-only database and
// check that it can be read at all.
//
// Why bother, given that VACUUM INTO produces a consistent file? Because "consistent at
// the moment of writing" and "restorable" are not the same thing. The write can be
// truncated when the disk fills up, the volume can reject part of it, the file can be
// corrupted afterwards. Without this check the rotation below eventually deletes every
// GOOD copy and leaves 14 broken ones - and you find out at restore time, which is the
// worst possible moment.
const verifyBackupFile = (backupPath) => new Promise((resolve) => {
  const probe = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) {
      resolve({ ok: false, reason: `cannot open: ${openErr.message}` });
      return;
    }
    // quick_check zamiast integrity_check: wykrywa te same uszkodzenia struktury,
    // but does not walk the whole database page by page - for a backup taken every 24h a
    // full scan would load the production disk for no good reason.
    probe.get('PRAGMA quick_check', (checkErr, row) => {
      const verdict = row && (row.quick_check || row['quick_check']);
      if (checkErr || verdict !== 'ok') {
        probe.close();
        resolve({ ok: false, reason: checkErr ? checkErr.message : `quick_check = ${verdict}` });
        return;
      }
      // Second check: are the key tables present, and do they hold anything? A file that is
      // structurally valid but empty - a copy taken before a migration finished, say - would
      // pass quick_check without complaint.
      probe.get('SELECT COUNT(*) AS n FROM users', (countErr, countRow) => {
        probe.close();
        if (countErr) {
          resolve({ ok: false, reason: `brak tabeli users: ${countErr.message}` });
          return;
        }
        if (!countRow || countRow.n === 0) {
          resolve({ ok: false, reason: 'the backup contains no users' });
          return;
        }
        resolve({ ok: true, users: countRow.n });
      });
    });
  });
});

const backupDatabase = async () => {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // NOTE (round 15 audit fix): the database runs in journal_mode TRUNCATE, not WAL (see
    // the comment where PRAGMA journal_mode is set at the top of this file) - so there is no
    // separate -wal file to merge and `PRAGMA wal_checkpoint(FULL)` was a no-op here. Under
    // TRUNCATE writes land directly in the main .db file, so copying that file alone is
    // consistent with this journal_mode.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `dietetyk-${timestamp}.db`);
    await run('VACUUM INTO ?', [backupPath]);

    const verdict = await verifyBackupFile(backupPath);
    if (!verdict.ok) {
      // A corrupted copy is not left in the directory - it would enter the rotation and push
      // a working one out. Older copies stay untouched, because in that situation they are
      // all we have.
      console.error(`[BACKUP ERROR] The backup failed verification (${verdict.reason}) - deleting it and KEEPING the previous copies.`);
      await fs.promises.unlink(backupPath).catch(() => {});
      return;
    }
    console.log(`[BACKUP] Backup written and verified: ${backupPath} (${verdict.users} users)`);

    // Rotation - delete the oldest copies beyond the limit. Runs ONLY after the successful
    // verification above, so a failed backup can never delete good ones.
    const files = (await fs.promises.readdir(backupDir))
      .filter(f => f.startsWith('dietetyk-') && f.endsWith('.db'))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - BACKUP_RETENTION_COUNT));
    for (const f of toDelete) {
      await fs.promises.unlink(path.join(backupDir, f));
      console.log(`[BACKUP] Removed old backup: ${f}`);
    }
  } catch (err) {
    console.error('[BACKUP ERROR] Failed to create the database backup:', err);
  }
};

module.exports = {
  initDb,
  cleanupExpiredSessions,
  cleanupOldImages,
  cleanupOldLogs,
  backupDatabase,
  run,
  get,
  all,
  db
};
