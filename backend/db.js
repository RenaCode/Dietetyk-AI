const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Konfiguracja katalogu i ścieżki do bazy danych (trwałość danych w Dockerze)
const dbDir = process.env.DATABASE_DIR || __dirname;
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'dietetyk.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Błąd połączenia z bazą SQLite:', err.message);
  } else {
    console.log(`Połączono z bazą danych SQLite pod ścieżką: ${dbPath}`);
  }
});

// UWAGA (Runda 15, korekta komentarza z audytu): faktycznie używany jest journal_mode
// TRUNCATE, nie WAL. TRUNCATE świadomie wybrany ze względu na kompatybilność z wolumenem
// Dockera (./data) - WAL wymaga pamięci dzielonej (shared memory) między procesami
// odwołującymi się do tego samego pliku bazy i bywa zawodny na zamontowanych wolumenach
// sieciowych/bind-mountach, gdzie blokady plikowe nie zawsze działają poprawnie.
// TRUNCATE wciąż zapisuje zmiany od razu do głównego pliku .db (bez osobnego pliku -wal
// do scalania), więc kopiowanie samego pliku .db w backupDatabase() poniżej jest z nim
// zgodne - w przeciwieństwie do WAL, gdzie kopia bez pliku -wal mogłaby nie zawierać
// najnowszych zapisów. busy_timeout sprawia, że krótkie kolizje zapisów (np. godzinowa
// synchronizacja Oura/Withings/Google Fit nakładająca się na zapis użytkownika) czekają
// chwilę i się ponawiają, zamiast od razu zwracać błąd "SQLITE_BUSY: database is locked".
db.run('PRAGMA journal_mode = TRUNCATE;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA journal_mode=TRUNCATE:', err.message);
});
db.run('PRAGMA busy_timeout = 5000;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA busy_timeout:', err.message);
});
// SQLite domyślnie NIE wymusza kluczy obcych ani "ON DELETE CASCADE" zadeklarowanych
// w schemacie (CREATE TABLE) - trzeba to włączyć per-połączenie. Bez tego usunięcie
// użytkownika (np. nowa funkcja usuwania konta, patrz routes/account.js) zostawiałoby
// osierocone wiersze w sessions/oauth_tokens/meals/health_metrics/settings/
// body_measurements zamiast je kaskadowo usuwać.
db.run('PRAGMA foreign_keys = ON;', (err) => {
  if (err) console.error('Błąd ustawiania PRAGMA foreign_keys=ON:', err.message);
});

// Pomocnicza funkcja do asynchronicznych zapytań (run)
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
  // 1. Tabela Użytkowników
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

  // Migracja: Dodanie kolumn do tabeli users (jeśli nie istnieją)
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

  // Migracja: logowanie przez Google (krok w stronę docelowego usunięcia logowania hasłem)
  try {
    await run("ALTER TABLE users ADD COLUMN google_id TEXT");
  } catch (e) {}
  try {
    await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL");
  } catch (e) {}


  // Migracja: imię i nazwisko - używane do personalizacji zwrotów AI dietetyka
  // ("Cześć Marcin, ..." zamiast bezosobowego tonu) oraz do wyświetlenia w profilu.
  // Oddzielone od `username` (login techniczny, niezmienny) - użytkownik może mieć
  // login typu "mbeczynski", a imię, którym chce być nazywany, to np. "Marcin".
  try {
    await run("ALTER TABLE users ADD COLUMN first_name TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN last_name TEXT");
  } catch (e) {}

  // Migracja: rok urodzenia - pole opcjonalne, używane wyłącznie do realnego
  // wyliczenia maksymalnego tętna (wzór 220 - wiek) na potrzeby stref kardio
  // na Dashboardzie, zamiast zahardkodowanej stałej HRmax=190 (patrz routes/dashboard.js).
  try {
    await run("ALTER TABLE users ADD COLUMN birth_year INTEGER");
  } catch (e) {}

  // Migracja: "Cel sylwetki" - opcjonalny opis tekstowy oraz zdjęcie referencyjne
  // (np. zdjęcie sylwetki, do której użytkownik chce dążyć). Trzymane bezpośrednio
  // na users (tak jak avatar_base64), a nie w tabeli settings (key-value), bo to
  // dane podobne do profilu, nie liczbowy cel/przełącznik. Wykorzystywane przez
  // dashboard.js (porada AI) i chat.js (czat z dietetykiem AI), żeby algorytm
  // realnie brał pod uwagę zarówno opis celu, jak i samo zdjęcie (analiza wizualna).
  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_text TEXT");
  } catch (e) {}

  try {
    await run("ALTER TABLE users ADD COLUMN body_goal_photo_base64 TEXT");
  } catch (e) {}


  // 1a. Tabela globalnej konfiguracji (np. ustawienia Mailgun)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Domyślna wartość flagi `allow_public_registration` (Runda 17, naprawa z audytu) -
  // wcześniej endpoint POST /api/register-public (routes/auth.js) był publicznie
  // dostępny bez żadnego wyłącznika, całkowicie omijając system zaproszeń admina
  // (/api/admin/invite). Domyślnie WYŁĄCZONA ('0') - ta sama konwencja co flaga
  // `force_2fa` w tej samej tabeli (string '1' = włączone, sprawdzane przez
  // === '1' w routes/auth.js) - admin musi świadomie włączyć tę flagę z panelu,
  // żeby pozwolić na samodzielną rejestrację bez zaproszenia.
  await run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('allow_public_registration', '0')`);

  // Wstawienie domyślnego konta admina.
  // Hasło NIE jest zapisane na sztywno w kodzie źródłowym. Przy pierwszym starcie
  // (gdy konto admina jeszcze nie istnieje w bazie) generujemy losowe, bezpieczne
  // hasło, wymuszamy jego zmianę przy pierwszym logowaniu (force_password_change = 1)
  // i wypisujemy je JEDNORAZOWO w logach serwera. Można je też nadpisać zmienną
  // środowiskową ADMIN_INITIAL_PASSWORD przy pierwszym uruchomieniu.
  const existingAdmin = await get(`SELECT id FROM users WHERE id = 1`);
  // B-N4: Email admina z env var — nigdy hardcoded prywatny adres
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
    console.log('[DB INIT] Utworzono konto admina. Tymczasowe hasło logowania:');
    console.log(`[DB INIT]   ${initialPassword}`);
    console.log('[DB INIT] Zostaniesz poproszony o zmianę hasła przy pierwszym logowaniu.');
    console.log('========================================================');
  }

  // Dla istniejących instalacji: zaktualizuj nazwę na admin, ustaw rolę 'admin'
  // oraz e-mail (ale tylko jeśli obecny e-mail jest pusty lub jest domyślnym admin@dietetyk-ai.local
  // i w env zdefiniowano inny adres).
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


  // 2. Tabela Posiłków (meals) z kolumną user_id
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

  // Migracja: Dodanie kolumny image_base64 do meals (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE meals ADD COLUMN image_base64 TEXT`);
  } catch (e) {}

  // Migracja: Dodanie kolumny user_id do meals (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE meals ADD COLUMN user_id INTEGER DEFAULT 1`);
    console.log('[DB MIGRATE] Dodano kolumnę user_id do tabeli meals.');
  } catch (e) {}

  // Migracja: mikroskładniki posiłków (błonnik, cukry, sód) - rozszerzony prompt AI
  // (routes/meals.js) zwraca te pola dodatkowo do kalorii/makro. Mogą być NULL dla
  // starszych posiłków przeanalizowanych przed tą zmianą.
  try {
    await run(`ALTER TABLE meals ADD COLUMN fiber REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sugar REAL DEFAULT NULL`);
  } catch (e) {}
  try {
    await run(`ALTER TABLE meals ADD COLUMN sodium REAL DEFAULT NULL`);
  } catch (e) {}

  // Przypisanie starych posiłków bez user_id do Marcina
  await run(`UPDATE meals SET user_id = 1 WHERE user_id IS NULL OR user_id = 0`);

  // Usuń nieużywaną tabelę synchronizacji Apple Health
  await run(`DROP TABLE IF EXISTS health_sync`);

  // 4. Tabela Ustawień (migracja z klucza głównego na key na composite (user_id, key))
  const settingsCols = await all(`PRAGMA table_info(settings)`);
  const hasUserIdInSettings = settingsCols.some(c => c.name === 'user_id');

  if (!hasUserIdInSettings) {
    console.log('[DB MIGRATE] Rozpoczęto migrację tabeli settings...');
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
    console.log('[DB MIGRATE] Zakończono migrację tabeli settings.');
  }

  // Wstawienie domyślnych celów użytkowników
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

  // UWAGA: Usunięto wstawianie domyślnych ustawień na sztywno dla user_id = 2 ("Paulina").
  // Konto Paulina jest usuwane przy każdym starcie (patrz wyżej) i nowi użytkownicy
  // dołączają wyłącznie przez system zaproszeń/rejestracji (routes/auth.js), który sam
  // wstawia własne wartości domyślne dla nowo utworzonego user_id. Pozostawienie tego
  // hardkodowanego wstawienia dla user_id = 2 powodowało realny błąd: pierwszy nowy
  // użytkownik zarejestrowany w świeżej instalacji dostawał id = 2 (AUTOINCREMENT) i przez
  // "INSERT OR IGNORE" w register-public dziedziczył błędnie te martwe, nieaktualne wartości
  // (2000 kcal / 120g białka) zamiast swoich właściwych domyślnych ustawień (2500/150g).

  // 5. Tabela Sesji (Sessions) z terminem ważności
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      is_verified_2fa INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migracja: Dodanie kolumny is_verified_2fa do sessions (jeśli nie istnieje)
  try {
    await run(`ALTER TABLE sessions ADD COLUMN is_verified_2fa INTEGER DEFAULT 0`);
  } catch (e) {}

  // 5b. Tabela blokady brute-force logowania (login_attempts) - przeniesiona
  // z pamięci procesu (Map) do bazy, żeby blokady przetrwały restart kontenera
  // backendu (np. przy wgrywaniu nowej wersji) - patrz services/loginAttempts.js.
  await run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 6. Tabela Tokenów OAuth (Oura, Withings)
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

  // 7. Tabela Codziennych Wskaźników Zdrowotnych (health_metrics)
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

  // Migracja: licznik wypitej wody (dzienny licznik, podobnie jak steps - zeruje się każdego dnia)
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN water_ml INTEGER DEFAULT 0");
  } catch (e) {}

  // Migracja: źródło danych aktywności (steps/active_calories/total_calories_burned/active_minutes)
  // dla danej daty - 'oura' albo 'apple'. Potrzebne do reguły z synchronizacji Apple Health
  // (webhook Health Auto Export, routes/appleHealth.js): Apple Health dociera szybciej, ale
  // Oura jest traktowana jako bardziej autorytatywna - gdy Oura faktycznie zwróci dane
  // aktywności dla danej daty, NADPISUJE wartości wcześniej zapisane z Apple Health. Webhook
  // Apple Health z kolei NIGDY nie nadpisuje wiersza, który już ma activity_source = 'oura'.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN activity_source TEXT DEFAULT NULL");
  } catch (e) {}

  // Migracja: częstość oddechów ze snu (Oura, pole average_breath z endpointu
  // /v2/usercollection/sleep, który już i tak wywołujemy w sync.js - wcześniej to
  // pole było ignorowane). Karta "Częstość oddechów" na Dashboardzie wcześniej
  // pokazywała zaszytą na sztywno wartość "13,8" - teraz pokazuje to realne pole.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN respiratory_rate REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dobowe SpO2 z Oury (endpoint /v2/usercollection/daily_spo2, NOWE
  // zapytanie w sync.js - dostępne tylko dla pierścionków Gen 3, dla starszych
  // modeli pole zostanie NULL). Karta "Poziom tlenu we krwi" wcześniej pokazywała
  // zaszytą na sztywno wartość "98,4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN spo2_percentage REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: absolutna temperatura nadgarstka z Apple Watch (Health Auto Export,
  // metryka "Wrist Temperature" -> name: "wrist_temperature", patrz
  // routes/appleHealth.js). UWAGA: to jest inna wartość niż Oura
  // `temperature_deviation` (odchylenie od bazowej, nie wartość absolutna) -
  // dostępna tylko z Apple Watch Series 8+/Ultra i tylko jeśli użytkownik włączy tę
  // metrykę w automatyzacji Health Auto Export na telefonie. Karta "Temperatura
  // nadgarstka" wcześniej pokazywała zaszytą na sztywno wartość "35,4".
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN wrist_temperature REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: dystans (metry) - z Oury (equivalent_walking_distance), Google Fit
  // (distance.delta) albo Apple Health (walking_running_distance, webhook). Brane
  // z tego samego źródła co reszta aktywności (priorytet Apple > Oura/Google Fit,
  // patrz activity_source).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN distance_meters REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: rozbicie dnia na minuty wg intensywności aktywności (Oura
  // daily_activity: high/medium/low_activity_time, sedentary_time - w sekundach,
  // zapisujemy po konwersji na minuty). Pozwala pokazać, jak wyglądał dzień, a nie
  // tylko sumę "aktywnych minut". medium+high są już liczone razem jako
  // active_minutes (patrz sync.js) - tu dodajemy tylko brakujące kategorie.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN sedentary_minutes INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN low_activity_minutes INTEGER DEFAULT NULL");
  } catch (e) {}

  // Migracja: realny poziom stresu z Oury (endpoint /v2/usercollection/daily_stress,
  // dostępny tylko dla pierścionków z tą funkcją - inaczej pola zostają NULL).
  // To NIE jest powrót starej, zaszywanej na sztywno sekcji stresu (patrz komentarz
  // przy jej usunięciu w Dashboard.jsx) - to realne dane z API Oury.
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

  // Migracja: ciśnienie tętnicze z Withings (endpoint getmeas, meastype 9 = rozkurczowe
  // (diastolic, mmHg), meastype 10 = skurczowe (systolic, mmHg) - mierzone tym samym
  // ciśnieniomierzem Withings co waga/skład ciała, patrz services/sync.js syncWithings()).
  // Osobne kolumny (nie jedno pole tekstowe), żeby dało się je użyć w trendach/wykresach
  // tak samo jak weight/fat_ratio/muscle_mass.
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_systolic REAL DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN blood_pressure_diastolic REAL DEFAULT NULL");
  } catch (e) {}

  // Migracja: cache krótkiego wyjaśnienia AI "dlaczego" dla największego odchylenia
  // dobowej metryki (sen/gotowość/RHR/HRV) względem własnego baseline danego dnia
  // (styl Oura Advisor/Whoop Coach - patrz /api/dashboard/ai-explanation-insight).
  // Osobna kolumna od ai_advice/ai_advice_generated_at - to inna treść (krótkie,
  // ukierunkowane wyjaśnienie JEDNEGO odchylenia, nie pełna dzienna porada) i inny
  // rytm odświeżania (cache per dzień, nie co 30 min).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_explanation TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN ai_explanation_generated_at TEXT DEFAULT NULL");
  } catch (e) {}

  // Migracja: codzienny tracker samopoczucia (poziom energii i nastrój, skala 1-5).
  // Oba pola ręcznie wpisywane przez użytkownika przez formularz na Dashboardzie
  // (POST /api/feeling w health.js). Dają korelacje z dostępnymi danymi: energia vs.
  // sen/HRV/posiłki, nastrój vs. aktywność/stres — bez żadnych nowych integracji.
  // NULL = brak wpisu na dany dzień (użytkownik nie ocenił).
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN energy_level INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE health_metrics ADD COLUMN mood INTEGER DEFAULT NULL");
  } catch (e) {}

  // Domyślny cel wody (ml) dla istniejącego konta admina/Marcina, jeśli jeszcze nie ustawiony
  await run(`INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (1, 'target_water_ml', '2500')`);

  // 7a. Tabela pojedynczych Treningów z Apple Health (Health Auto Export, "Typ danych:
  // Treningi" - patrz routes/appleHealth.js). Trzymamy tu KAŻDY trening osobno (klucz:
  // user_id + workout_id z payloadu) zamiast od razu sumować do health_metrics, żeby:
  //   1) ponowne wysłanie tego samego treningu przez automatyzację (np. retry, albo
  //      zasięg dat automatyzacji obejmujący ten sam trening więcej niż raz) tylko
  //      NADPISYWAŁO jego własny wiersz (ON CONFLICT DO UPDATE), a nie dodawało
  //      kalorie/minuty po raz drugi do dobowej sumy (podwójne liczenie),
  //   2) wiele różnych treningów tego samego dnia, dostarczonych w OSOBNYCH wywołaniach
  //      webhooka (np. automatyzacja odpala się po zakończeniu każdego treningu), mogło
  //      się prawidłowo zsumować - dobowa suma w health_metrics jest każdorazowo
  //      przeliczana na nowo jako SUM(...) po wszystkich treningach danego dnia z tej
  //      tabeli, a nie inkrementowana "na ślepo".
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

  // Runda 3 (audyt): Tabela na próbki nawodnienia z Apple Health (idempotentność)
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
  // `name` z payloadu Health Auto Export, patrz routes/appleHealth.js). Dodane po
  // tym, jak audyt funkcjonalny wykazał, że /api/dashboard zawsze zwracał pustą
  // listę `workouts: []` na sztywno, mimo że ta tabela faktycznie zbiera treningi -
  // bez typu treningu sekcja "Ostatnia aktywność" na Dashboardzie nie mogłaby
  // pokazać sensownej ikony/etykiety (getWorkoutIcon/typ w Dashboard.jsx).
  try {
    await run("ALTER TABLE apple_health_workouts ADD COLUMN workout_type TEXT DEFAULT NULL");
  } catch (e) {}

  // Migracja: tętno per trening (Health Auto Export, przełącznik "Include Workout
  // Metrics" w automatyzacji na telefonie). Gdy włączony, payload treningu zawiera
  // avgHeartRate/maxHeartRate oraz heartRateData (szereg próbek tętna ZAREJESTROWANYCH
  // W TRAKCIE konkretnego treningu) - wcześniej całkowicie ignorowane, patrz
  // routes/appleHealth.js. zone1_minutes..zone5_minutes to liczba minut TEGO treningu
  // spędzona w każdej z 5 stref Karvonena (ten sam wzór 50/60/70/80/90% rezerwy tętna,
  // co statyczna tabela referencyjna "Strefy Tętna" na Dashboardzie) - liczone RAZ, przy
  // zapisie treningu w appleHealth.js, nie przeliczane na żywo przy każdym odczycie.
  // Wszystkie te kolumny zostają NULL, gdy payload nie zawiera danych tętna albo
  // użytkownik nie podał roku urodzenia w profilu (HRmax nieznany, nie da się policzyć
  // stref) - karty/insighty bazujące na tych danych muszą to NULL traktować jako
  // "brak danych", nie jako zero.
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN avg_heart_rate REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN max_heart_rate REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone1_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone2_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone3_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone4_minutes REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE apple_health_workouts ADD COLUMN zone5_minutes REAL DEFAULT NULL"); } catch (e) {}

  // 8. Tabela Pomiarów Obwodów Ciała (body_measurements)
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

  // Pomocnicze ALTER TABLE dla rozszerzonych obwodów ciała
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_left REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN biceps_right REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN shoulders REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_above REAL DEFAULT NULL"); } catch (e) {}
  try { await run("ALTER TABLE body_measurements ADD COLUMN waist_below REAL DEFAULT NULL"); } catch (e) {}

  // 9. Tabela Logów Aplikacji (app_logs)
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

  // 10. Tabela linków do udostępniania raportu PDF (Produkt: udostępnianie raportu
  // linkiem, read-only) - token zamiast sesji/ciasteczka, bo link ma działać dla
  // lekarza/dietetyki bez konta w aplikacji. `revoked` jako osobna flaga (nie samo
  // DELETE wiersza), żeby właściciel widział historię udostępnień w Ustawieniach,
  // a nie tylko aktualnie aktywne linki. `expires_at` wymagane (NOT NULL) - link bez
  // terminu ważności byłby trwałym, niewygasającym dostępem do danych zdrowotnych.
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

  // 11. Tabela zdarzeń dnia (day_events) - "Tag dnia": użytkownik oznacza zakres dat
  // kontekstem (choroba/wakacje/późne zaśnięcie), żeby (a) widzieć ten kontekst przy
  // przeglądaniu danych z tych dni, (b) pozwolić wybranym insightom na dashboardzie
  // wykluczyć te dni z liczenia baseline/normy, żeby nietypowy okres nie zaburzał
  // trendu. Zakres dat (start_date/end_date), nie pojedyncza data - wakacje/choroba
  // trwają zwykle kilka-kilkanaście dni, klikanie każdego dnia osobno byłoby
  // niewygodne (dla zdarzeń jednodniowych, np. "późne zaśnięcie", start_date=end_date).
  // `type` to zamknięty enum kontrolowany przez backend (patrz routes/dayEvents.js),
  // nie wolny tekst - insighty mapują konkretne typy na konkretne wykluczenia.
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
  // start_date <= ?" (sprawdzanie przecięcia zakresu zdarzenia z oknem insightu).
  await run(`CREATE INDEX IF NOT EXISTS idx_day_events_user_type ON day_events(user_id, type, start_date, end_date)`);

  // Indeksy pod zapytania zakresowe "WHERE user_id = ? AND date >= ?" (agregacje
  // 7/30/90-dniowe w dashboard.js/summaries.js/chat.js). health_metrics i
  // body_measurements mają już taki indeks "za darmo" (PRIMARY KEY(user_id, date)
  // dla health_metrics, UNIQUE(user_id, date) dla body_measurements tworzy
  // niejawny indeks) - brakowało go dla meals i apple_health_workouts, gdzie
  // (user_id, date) nie jest częścią klucza głównego/unikalności.
  await run(`CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON apple_health_workouts(user_id, date)`);

  // Runda 3 (audyt): Czyszczenie wygasłych sesji na starcie bazy
  await cleanupExpiredSessions();

  console.log('Baza danych SQLite została pomyślnie zmigrowana i zainicjalizowana.');
};

const cleanupExpiredSessions = async () => {
  try {
    const result = await run("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')");
    if (result.changes > 0) {
      console.log(`[CLEANUP] Usunięto ${result.changes} przedawnionych sesji.`);
    } else {
      console.log('[CLEANUP] Brak przedawnionych sesji do usunięcia.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Błąd podczas czyszczenia sesji:', err);
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
      console.log(`[CLEANUP] Usunięto obrazy z ${result.changes} posiłków starszych niż 14 dni.`);
      await run('VACUUM');
      console.log('[CLEANUP] Wykonano VACUUM bazy danych.');
    } else {
      console.log('[CLEANUP] Brak starych zdjęć do usunięcia.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Błąd podczas czyszczenia starych zdjęć:', err);
  }
};

const cleanupOldLogs = async () => {
  try {
    const result = await run(`
      DELETE FROM app_logs 
      WHERE timestamp < datetime('now', '-30 days', 'localtime')
    `);
    if (result.changes > 0) {
      console.log(`[CLEANUP] Usunięto ${result.changes} wpisów logów starszych niż 30 dni.`);
    } else {
      console.log('[CLEANUP] Brak starych logów do usunięcia.');
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Błąd podczas czyszczenia starych logów:', err);
  }
};

// Automatyczne kopie zapasowe bazy SQLite (rotacja - domyślnie ostatnie 14 dni).
// Plik bazy żyje w wolumenie Dockera (./data), który nie jest sam w sobie
// kopią zapasową - awaria dysku/przypadkowe `rm -rf`/błąd migracji nadpisałby
// jedyną kopię danych. Kopie trzymane są w podkatalogu backups/ tego samego
// wolumenu - do realnej ochrony przed awarią hosta trzeba je jeszcze zgrywać
// poza serwer (patrz README, sekcja "Kopie zapasowe").
const backupDir = path.join(dbDir, 'backups');
const BACKUP_RETENTION_COUNT = 14;

// Weryfikacja świeżo utworzonej kopii: otwieramy ją jako OSOBNĄ bazę tylko do
// odczytu i sprawdzamy, czy w ogóle da się z niej czytać.
//
// Po co, skoro VACUUM INTO tworzy spójny plik: bo "spójny w momencie zapisu" i
// "nadający się do odtworzenia" to nie to samo. Zapis może zostać ucięty przy braku
// miejsca na dysku, wolumen może odrzucić część zapisu, plik może zostać uszkodzony
// po fakcie. Bez tej kontroli rotacja poniżej z czasem usuwa wszystkie DOBRE kopie,
// zostawiając 14 uszkodzonych - a dowiadujemy się o tym dopiero przy odtwarzaniu,
// czyli w najgorszym możliwym momencie.
const verifyBackupFile = (backupPath) => new Promise((resolve) => {
  const probe = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) {
      resolve({ ok: false, reason: `nie można otworzyć: ${openErr.message}` });
      return;
    }
    // quick_check zamiast integrity_check: wykrywa te same uszkodzenia struktury,
    // ale nie przechodzi całej bazy strona po stronie - przy kopii robionej co 24h
    // pełny skan niepotrzebnie obciążałby dysk na produkcji.
    probe.get('PRAGMA quick_check', (checkErr, row) => {
      const verdict = row && (row.quick_check || row['quick_check']);
      if (checkErr || verdict !== 'ok') {
        probe.close();
        resolve({ ok: false, reason: checkErr ? checkErr.message : `quick_check = ${verdict}` });
        return;
      }
      // Druga kontrola: czy kluczowe tabele są na miejscu i czy są w nich dane.
      // Plik strukturalnie poprawny, ale pusty (np. kopia zrobiona zanim migracja
      // dobiegła końca) przeszedłby quick_check bez zastrzeżeń.
      probe.get('SELECT COUNT(*) AS n FROM users', (countErr, countRow) => {
        probe.close();
        if (countErr) {
          resolve({ ok: false, reason: `brak tabeli users: ${countErr.message}` });
          return;
        }
        if (!countRow || countRow.n === 0) {
          resolve({ ok: false, reason: 'kopia nie zawiera żadnych użytkowników' });
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

    // UWAGA (Runda 15, naprawa z audytu): baza działa w journal_mode TRUNCATE, nie WAL
    // (patrz komentarz przy ustawianiu PRAGMA journal_mode na początku tego pliku) - nie
    // ma więc osobnego pliku -wal do scalania i `PRAGMA wal_checkpoint(FULL)` był tu
    // no-opem. Pod TRUNCATE zapisy trafiają od razu do głównego pliku .db, więc
    // kopiowanie samego pliku poniżej jest z tym journal_mode zgodne.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `dietetyk-${timestamp}.db`);
    await run('VACUUM INTO ?', [backupPath]);

    const verdict = await verifyBackupFile(backupPath);
    if (!verdict.ok) {
      // Uszkodzonej kopii nie zostawiamy w katalogu - inaczej trafiłaby do rotacji
      // i wypchnęła stamtąd sprawną. Stare kopie zostają nietknięte, bo w tej
      // sytuacji są jedynym, co mamy.
      console.error(`[BACKUP ERROR] Kopia nie przeszła weryfikacji (${verdict.reason}) - usuwam plik i ZACHOWUJĘ poprzednie kopie.`);
      await fs.promises.unlink(backupPath).catch(() => {});
      return;
    }
    console.log(`[BACKUP] Zapisano i zweryfikowano kopię zapasową: ${backupPath} (${verdict.users} użytkowników)`);

    // Rotacja - usuń najstarsze kopie powyżej limitu. Wykonywana WYŁĄCZNIE po
    // udanej weryfikacji powyżej, żeby nieudany backup nigdy nie kasował dobrych.
    const files = (await fs.promises.readdir(backupDir))
      .filter(f => f.startsWith('dietetyk-') && f.endsWith('.db'))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - BACKUP_RETENTION_COUNT));
    for (const f of toDelete) {
      await fs.promises.unlink(path.join(backupDir, f));
      console.log(`[BACKUP] Usunięto starą kopię zapasową: ${f}`);
    }
  } catch (err) {
    console.error('[BACKUP ERROR] Błąd podczas tworzenia kopii zapasowej bazy danych:', err);
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
