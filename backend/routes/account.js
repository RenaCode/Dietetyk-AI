const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { sendWeeklySummaryForUser, sendDailySummaryForUser, sendMonthlySummaryForUser } = require('../services/summaries');
const { buildHealthReportPdf } = require('../services/pdfReport');
const { createShareLink, listSharesForUser, revokeShare, VALIDITY_OPTIONS_HOURS } = require('../services/sharedReports');
const { getAppConfig } = require('../services/oauthHelpers');
const { summaryEmailLimiter } = require('../middleware/rateLimit');
const { USER_SECRET_SETTING_KEYS, maskSecretValue, isMaskedSecretWrite } = require('../utils/secretKeys');
const { encrypt } = require('../utils/encryption');
const { geocodeLocation } = require('../utils/weatherContext');

// Prosta walidacja formatu e-maila (nie pełny RFC 5322 - to wystarcza, żeby
// odrzucić oczywiście niepoprawne wartości zapisywane bezpośrednio do bazy /
// używane jako adresat wysyłki Mailgun).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Format godziny HH:MM (00-23 : 00-59), używany przy planowaniu wysyłki podsumowań.
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Walidacja sync_token (Runda 15, naprawa z audytu): token jest generowany domyślnie
// jako 'sync_' + 24 losowe bajty hex (patrz routes/auth.js/admin.js), ale endpoint
// poniżej pozwala użytkownikowi nadpisać go własną wartością. sync_token służy jako
// JEDYNY sekret autoryzujący nieuwierzytelniony webhook Apple Health
// (POST /api/integrations/apple-health/:syncToken, patrz routes/appleHealth.js i
// server.js - ten endpoint celowo nie przechodzi przez requireAuth) - bez minimalnej
// długości/formatu użytkownik mógłby ustawić sobie token typu "abc", co w praktyce
// czyniłoby webhook publicznie zgadywalnym/przejmowalnym.
const SYNC_TOKEN_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
// Limit długości opisu celu sylwetki - bez tego nic nie ograniczało rozmiaru
// tekstu trafiającego później do promptu Gemini (patrz dashboard.js/chat.js),
// analogicznie do MAX_CHAT_MESSAGE_LENGTH w chat.js.
const MAX_BODY_GOAL_TEXT_LENGTH = 1000;
// Limit rozmiaru zdjęcia celu sylwetki w postaci base64 (ok. 3MB danego pliku
// po zakodowaniu base64, ~2.2MB realnego rozmiaru pliku) - zdjęcie jest
// kompresowane/skalowane po stronie frontendu (patrz Settings.jsx), ale to
// jedyna realna ochrona przed kimś, kto wysyła żądanie bezpośrednio do API.
const MAX_BODY_GOAL_PHOTO_LENGTH = 4 * 1024 * 1024;
// Limit rozmiaru avatara - analogicznie do zdjęcia celu sylwetki powyżej. Wcześniej
// endpoint POST /api/user/profile zapisywał `avatar` bez ŻADNEJ walidacji rozmiaru -
// jedyną ochroną był globalny express.json({limit:'20mb'}) w server.js.
const MAX_AVATAR_BASE64_LENGTH = 3 * 1024 * 1024;
// Limit długości zapytania o lokalizację (Ustawienia -> Lokalizacja pogody) -
// zapytanie trafia do zewnętrznego Open-Meteo Geocoding, więc ogranicz rozmiar
// zamiast przepuszczać dowolnie długi string dalej (patrz GET
// /api/settings/geocode-location poniżej).
const MAX_LOCATION_QUERY_LENGTH = 100;

router.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [req.user.id]);
    const user = await db.get(`SELECT sync_token FROM users WHERE id = ?`, [req.user.id]);
    const settings = {
      sync_token: user ? user.sync_token : ''
    };
    rows.forEach(r => {
      if (USER_SECRET_SETTING_KEYS.includes(r.key) && r.value) {
        settings[r.key] = maskSecretValue(r.key, r.value, USER_SECRET_SETTING_KEYS);
      } else if (r.value === '') {
        // UWAGA: Number('') === 0, a isNaN('') === false - więc bez tego wyjątku
        // pusty string byłby tu zamieniany na liczbę 0. To był realny błąd:
        // withings_client_id/oura_client_id zapisane jako '' (np. przez
        // niezamierzony pusty zapis całego formularza ustawień) wracały z tego
        // endpointu jako 0, a 0 w JS to liczba, więc kod budujący URL OAuth
        // (sprawdzający tylko `if (!clientId)`) je odrzucał - ale string "0"
        // (po zapisaniu z powrotem przez POST) już nie jest falsy i przechodził
        // dalej, dając w efekcie client_id=0 w adresie autoryzacji Withings/Oura.
        settings[r.key] = '';
      } else {
        settings[r.key] = isNaN(r.value) ? r.value : Number(r.value);
      }
    });
    // Uwaga: BRAK fallbacku do globalnych zmiennych środowiskowych (OURA_CLIENT_ID/SECRET,
    // WITHINGS_CLIENT_ID/SECRET) - każdy użytkownik, włącznie z adminem, musi skonfigurować
    // własne dane aplikacji Oura/Withings. Dzięki temu nowy użytkownik nigdy nie łączy się
    // poprzez aplikację OAuth innego użytkownika.
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania ustawień.' });
  }
});

// 6. Zapisanie ustawień i celów dobowych
// Pola poświadczeń integracji - nigdy nie wolno ich nadpisać puste/zerowe,
// bo psuje to OAuth (patrz komentarz przy GET /api/settings powyżej). Każdy
// zapis ustawień z frontendu wysyła CAŁY obiekt stanu formularza (nie tylko
// zmienione pole), więc np. zapisanie samych celów kalorycznych mogłoby
// przypadkowo "wyczyścić" Client ID/Secret, jeśli w danym momencie stan
// formularza miał je puste/nieustawione.
const CREDENTIAL_KEYS = ['oura_client_id', 'oura_client_secret', 'withings_client_id', 'withings_client_secret'];

router.post('/api/settings', async (req, res) => {
  const settings = req.body; // Klucze i wartości
  try {
    for (const [key, val] of Object.entries(settings)) {
      if (key === 'sync_token') continue; // Pole tylko do odczytu
      if (isMaskedSecretWrite(key, val, USER_SECRET_SETTING_KEYS)) {
        continue; // Pomijamy aktualizację sekretów, jeśli przesłano maskę
      }
      if (CREDENTIAL_KEYS.includes(key) && (val === '' || val === null || val === undefined || val === 0)) {
        continue; // Nie zapisuj puste/zerowej wartości poświadczeń - patrz komentarz wyżej
      }
      // Sekrety (gemini_api_key, oura/withings_client_secret) trzymamy w bazie
      // zaszyfrowane (patrz utils/encryption.js) - encrypt() jest no-opem dla
      // pozostałych, niesekretnych kluczy ustawień.
      const storedValue = USER_SECRET_SETTING_KEYS.includes(key) ? encrypt(String(val)) : String(val);
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, key, storedValue]);
    }
    res.json({ success: true, message: 'Ustawienia zostały zaktualizowane.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu ustawień.' });
  }
});

// Wyszukiwanie miejscowości dla pola "Lokalizacja" w Ustawieniach (kontekst
// pogody wstrzykiwany do promptów AI - patrz utils/weatherContext.js). Zwraca
// listę kandydatów do wyboru na froncie (Open-Meteo Geocoding, bez klucza API) -
// nazwy miejscowości bywają niejednoznaczne, więc NIE wybieramy automatycznie
// pierwszego wyniku. Sam wybór lokalizacji (POST) idzie przez istniejący,
// generyczny endpoint POST /api/settings (weather_lat/weather_lon/
// weather_location_label to zwykłe klucze w tabeli settings) - ten endpoint
// tylko wyszukuje, nic nie zapisuje.
router.get('/api/settings/geocode-location', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    return res.status(400).json({ error: 'Podaj nazwę miejscowości.' });
  }
  if (query.length > MAX_LOCATION_QUERY_LENGTH) {
    return res.status(400).json({ error: `Zapytanie jest zbyt długie (maks. ${MAX_LOCATION_QUERY_LENGTH} znaków).` });
  }
  try {
    const results = await geocodeLocation(query);
    res.json({ results });
  } catch (err) {
    console.error('[GEOCODING ERROR]', err);
    res.status(502).json({ error: 'Błąd wyszukiwania lokalizacji (usługa geokodowania jest chwilowo niedostępna).' });
  }
});

// 6a. Pobranie profilu użytkownika (nazwa, email, avatar, rola i status 2FA)
router.get('/api/user/profile', async (req, res) => {
  try {
    const user = await db.get(`SELECT username, email, avatar_base64, role, totp_enabled, first_name, last_name, google_id, birth_year, body_goal_text, body_goal_photo_base64 FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const summaryEnabledRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_enabled'`, [req.user.id]);
    const summaryDayRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_day'`, [req.user.id]);
    const summaryTimeRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'weekly_summary_time'`, [req.user.id]);

    const monthlyEnabledRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_enabled'`, [req.user.id]);
    const monthlyDayRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_day'`, [req.user.id]);
    const monthlyTimeRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'monthly_summary_time'`, [req.user.id]);
    const langRow = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = 'language'`, [req.user.id]);

    const hasOuraRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'oura'`, [req.user.id]);
    const hasWithingsRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'withings'`, [req.user.id]);
    const hasGoogleFitRow = await db.get(`SELECT 1 FROM oauth_tokens WHERE user_id = ? AND service = 'google_fit'`, [req.user.id]);

    res.json({
      username: user.username,
      email: user.email || '',
      avatar_base64: user.avatar_base64,
      role: user.role,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      // birth_year to liczba (albo brak danych) - w odróżnieniu od first_name/last_name
      // NIE zamieniamy braku wartości na pusty string, żeby front mógł rozróżnić "nie ustawiono"
      birth_year: user.birth_year || null,
      // Cel sylwetki (opis tekstowy + opcjonalne zdjęcie referencyjne) - patrz
      // migracja w db.js. Brak wartości = pusty string/null, analogicznie do
      // pozostałych opcjonalnych pól profilu powyżej.
      body_goal_text: user.body_goal_text || '',
      body_goal_photo_base64: user.body_goal_photo_base64 || null,
      totp_enabled: user.totp_enabled === 1,
      weekly_summary_enabled: summaryEnabledRow ? summaryEnabledRow.value === '1' : false,
      weekly_summary_day: summaryDayRow ? Number(summaryDayRow.value) : 1,
      weekly_summary_time: summaryTimeRow ? summaryTimeRow.value : '18:00',
      monthly_summary_enabled: monthlyEnabledRow ? monthlyEnabledRow.value === '1' : false,
      monthly_summary_day: monthlyDayRow ? Number(monthlyDayRow.value) : 1,
      monthly_summary_time: monthlyTimeRow ? monthlyTimeRow.value : '09:00',
      language: langRow ? langRow.value : 'pl',
      has_oura: !!hasOuraRow,
      has_withings: !!hasWithingsRow,
      has_google: !!user.google_id,
      has_google_fit: !!hasGoogleFitRow
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania profilu.' });
  }
});

// 6b. Aktualizacja profilu użytkownika (avatar, email, syncToken)
router.post('/api/user/profile', async (req, res) => {
  const { avatar, email, syncToken, first_name, last_name, birth_year, weekly_summary_enabled, weekly_summary_day, weekly_summary_time, monthly_summary_enabled, monthly_summary_day, monthly_summary_time, body_goal_text, body_goal_photo, target_weight_kg, target_body_fat_pct } = req.body;
  try {
    if (syncToken !== undefined) {
      const trimmedToken = syncToken.trim();
      if (!trimmedToken) {
        return res.status(400).json({ error: 'Token synchronizacji nie może być pusty.' });
      }
      if (!SYNC_TOKEN_REGEX.test(trimmedToken)) {
        return res.status(400).json({ error: 'Token synchronizacji musi mieć 16-128 znaków (litery, cyfry, "_" lub "-").' });
      }
      const existing = await db.get(`SELECT id FROM users WHERE sync_token = ? AND id != ?`, [trimmedToken, req.user.id]);
      if (existing) {
        return res.status(400).json({ error: 'Ten token synchronizacji jest już przypisany do innego użytkownika.' });
      }
      await db.run(`UPDATE users SET sync_token = ? WHERE id = ?`, [trimmedToken, req.user.id]);
    }

    // Walidacja formatu e-maila - pole jest później używane jako domyślny
    // adresat wysyłki Mailgun (podsumowania), więc oczywiście niepoprawna
    // wartość nie powinna trafić do bazy.
    if (email !== undefined && email !== '' && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Niepoprawny format adresu e-mail.' });
    }

    if (avatar !== undefined && avatar !== null && avatar.length > MAX_AVATAR_BASE64_LENGTH) {
      return res.status(400).json({ error: 'Zdjęcie profilowe jest zbyt duże.' });
    }

    if (avatar !== undefined && email !== undefined) {
      await db.run(`UPDATE users SET avatar_base64 = ?, email = ? WHERE id = ?`, [avatar, email, req.user.id]);
    } else if (avatar !== undefined) {
      await db.run(`UPDATE users SET avatar_base64 = ? WHERE id = ?`, [avatar, req.user.id]);
    } else if (email !== undefined) {
      await db.run(`UPDATE users SET email = ? WHERE id = ?`, [email, req.user.id]);
    }

    // Imię/nazwisko - używane przez AI dietetyka do personalizacji zwrotów
    // (np. "Cześć Marcin"). Trim + zamiana pustego stringa na NULL, żeby AI nie
    // dostawało literalnie pustego ciągu jako "imienia" użytkownika.
    if (first_name !== undefined) {
      const trimmedFirstName = String(first_name).trim();
      await db.run(`UPDATE users SET first_name = ? WHERE id = ?`, [trimmedFirstName || null, req.user.id]);
    }
    if (last_name !== undefined) {
      const trimmedLastName = String(last_name).trim();
      await db.run(`UPDATE users SET last_name = ? WHERE id = ?`, [trimmedLastName || null, req.user.id]);
    }

    // Rok urodzenia - używany przez Dashboard do realnego wyliczenia HRmax (220 - wiek)
    // w strefach kardio. Pusty string/null oznacza, że użytkownik czyści pole (np. nie
    // chce podawać wieku) - w takim przypadku zapisujemy NULL, a front wraca do
    // zahardkodowanego fallbacku. Inaczej wymagamy realnego, sensownego roku.
    if (birth_year !== undefined) {
      if (birth_year === '' || birth_year === null) {
        await db.run(`UPDATE users SET birth_year = ? WHERE id = ?`, [null, req.user.id]);
      } else {
        const birthYearNum = Number(birth_year);
        const isValidBirthYear = Number.isInteger(birthYearNum) && birthYearNum >= 1920 && birthYearNum <= new Date().getFullYear() - 5;
        if (!isValidBirthYear) {
          return res.status(400).json({ error: 'Nieprawidłowy rok urodzenia.' });
        }
        await db.run(`UPDATE users SET birth_year = ? WHERE id = ?`, [birthYearNum, req.user.id]);
      }
    }

    // Cel sylwetki - opis tekstowy. Pusty string/null = czyszczenie pola, tak jak
    // przy imieniu/nazwisku powyżej. Algorytm AI (dashboard.js, chat.js) czyta tę
    // wartość przy każdej generacji porady/odpowiedzi czatu.
    if (body_goal_text !== undefined) {
      const trimmedGoalText = String(body_goal_text || '').trim();
      if (trimmedGoalText.length > MAX_BODY_GOAL_TEXT_LENGTH) {
        return res.status(400).json({ error: `Opis celu sylwetki jest zbyt długi (maks. ${MAX_BODY_GOAL_TEXT_LENGTH} znaków).` });
      }
      await db.run(`UPDATE users SET body_goal_text = ? WHERE id = ?`, [trimmedGoalText || null, req.user.id]);
    }

    // Cel sylwetki - zdjęcie referencyjne. body_goal_photo === null oznacza
    // usunięcie zdjęcia (analogicznie do usuwania avatara w Settings.jsx).
    if (body_goal_photo !== undefined) {
      if (body_goal_photo === null) {
        await db.run(`UPDATE users SET body_goal_photo_base64 = NULL WHERE id = ?`, [req.user.id]);
      } else {
        if (typeof body_goal_photo !== 'string' || !body_goal_photo.startsWith('data:image/')) {
          return res.status(400).json({ error: 'Nieprawidłowy format zdjęcia.' });
        }
        if (body_goal_photo.length > MAX_BODY_GOAL_PHOTO_LENGTH) {
          return res.status(400).json({ error: 'Zdjęcie jest zbyt duże.' });
        }
        await db.run(`UPDATE users SET body_goal_photo_base64 = ? WHERE id = ?`, [body_goal_photo, req.user.id]);
      }
    }

    if (weekly_summary_enabled !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_enabled', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, weekly_summary_enabled ? '1' : '0']);
    }
    if (weekly_summary_day !== undefined) {
      // scheduler.js interpretuje weekly_summary_day jako dzień tygodnia 1-7
      // (1=poniedziałek..7=niedziela, patrz currentDay w scheduler.js) - poza
      // tym zakresem podsumowanie tygodniowe po prostu nigdy by się nie wysłało
      // (currentDay === scheduledDay nigdy prawdziwe), co jest cichym, trudnym
      // do zdiagnozowania zepsuciem funkcji, nie podatnością bezpieczeństwa -
      // ale warto to odrzucić wprost na wejściu.
      const dayNum = Number(weekly_summary_day);
      if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 7) {
        return res.status(400).json({ error: 'Dzień tygodnia podsumowania musi być liczbą 1-7.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_day', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, dayNum]);
    }
    if (weekly_summary_time !== undefined) {
      if (!TIME_REGEX.test(weekly_summary_time)) {
        return res.status(400).json({ error: 'Godzina podsumowania musi być w formacie HH:MM.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'weekly_summary_time', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, weekly_summary_time]);
    }

    if (monthly_summary_enabled !== undefined) {
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_enabled', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthly_summary_enabled ? '1' : '0']);
    }
    if (monthly_summary_day !== undefined) {
      // scheduler.js i tak przycina wartość do liczby dni w danym miesiącu
      // (Math.min(monthlyScheduledDayRaw, daysInCurrentMonth)), ale jawne
      // odrzucenie wartości spoza 1-31 na wejściu jest czytelniejsze niż
      // poleganie wyłącznie na tym przycinaniu po stronie schedulera.
      const monthDayNum = Number(monthly_summary_day);
      if (!Number.isInteger(monthDayNum) || monthDayNum < 1 || monthDayNum > 31) {
        return res.status(400).json({ error: 'Dzień miesiąca podsumowania musi być liczbą 1-31.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_day', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthDayNum]);
    }
    if (monthly_summary_time !== undefined) {
      if (!TIME_REGEX.test(monthly_summary_time)) {
        return res.status(400).json({ error: 'Godzina podsumowania musi być w formacie HH:MM.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'monthly_summary_time', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, monthly_summary_time]);
    }

    if (target_weight_kg !== undefined) {
      const numWeight = target_weight_kg === '' ? null : Number(target_weight_kg);
      if (numWeight !== null && (isNaN(numWeight) || numWeight < 30 || numWeight > 200)) {
        return res.status(400).json({ error: 'Waga docelowa musi być liczbą w zakresie 30-200 kg.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'target_weight_kg', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, numWeight !== null ? String(numWeight) : '']);
    }

    if (target_body_fat_pct !== undefined) {
      const numFat = target_body_fat_pct === '' ? null : Number(target_body_fat_pct);
      if (numFat !== null && (isNaN(numFat) || numFat < 0 || numFat > 60)) {
        return res.status(400).json({ error: 'Docelowy % tłuszczu musi być liczbą w zakresie 0-60%.' });
      }
      await db.run(`
        INSERT INTO settings (user_id, key, value)
        VALUES (?, 'target_body_fat_pct', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `, [req.user.id, numFat !== null ? String(numFat) : '']);
    }

    res.json({ success: true, message: 'Profil został zaktualizowany.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd aktualizacji profilu.' });
  }
});

router.post('/api/user/setup-2fa', async (req, res) => {
  try {
    const user = await db.get(`SELECT username, totp_secret FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const secret = authenticator.generateSecret();
    await db.run(`UPDATE users SET totp_secret = ? WHERE id = ?`, [secret, req.user.id]);

    const tempToken = 'temp_' + crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(`
      INSERT INTO sessions (token, user_id, expires_at, is_verified_2fa)
      VALUES (?, ?, ?, 0)
    `, [tempToken, req.user.id, expiresAt]);

    const otpauth = authenticator.keyuri(user.username, 'Dietetyk AI', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    res.json({
      secret,
      qrCode: qrCodeDataUrl,
      tempToken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd generowania konfiguracji 2FA.' });
  }
});

// 6b-2. Włączenie 2FA po zweryfikowaniu kodu przez zalogowanego użytkownika
router.post('/api/user/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Token i kod są wymagane.' });
  }

  try {
    const session = await db.get(`
      SELECT s.*, u.totp_secret
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.user_id = ? AND datetime(s.expires_at) > datetime('now')
    `, [tempToken, req.user.id]);

    if (!session) {
      return res.status(400).json({ error: 'Tymczasowa sesja wygasła lub jest niepoprawna. Spróbuj ponownie.' });
    }

    const isValid = authenticator.verify({
      token: code,
      secret: session.totp_secret
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Niepoprawny kod 2FA.' });
    }

    // Aktywuj 2FA dla użytkownika
    await db.run(`UPDATE users SET totp_enabled = 1 WHERE id = ?`, [req.user.id]);
    // Usuń tymczasową sesję
    await db.run(`DELETE FROM sessions WHERE token = ?`, [tempToken]);

    res.json({ success: true, message: 'Dwuetapowa weryfikacja (2FA) została włączona.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd aktywacji 2FA.' });
  }
});

// 6b-3. Wyłączenie 2FA przez zalogowanego użytkownika
// UWAGA: wymagamy ponownej weryfikacji aktualnym hasłem przed wyłączeniem 2FA - bez tego
// samo posiadanie aktywnej, zalogowanej sesji (np. przejęty/skradziony token sesji, urządzenie
// zostawione bez blokady) wystarczało do trwałego wyłączenia drugiego czynnika logowania,
// bez znajomości hasła czy aktualnego kodu TOTP. Ten sam wzorzec re-weryfikacji hasłem już
// stosujemy przy zmianie hasła i usuwaniu konta (patrz wyżej w tym pliku).
router.post('/api/user/disable-2fa', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Wymagane jest podanie aktualnego hasła, aby wyłączyć 2FA.' });
  }
  try {
    const user = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Niepoprawne hasło.' });
    }

    await db.run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`, [req.user.id]);
    res.json({ success: true, message: 'Dwuetapowa weryfikacja (2FA) została wyłączona.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd dezaktywacji 2FA.' });
  }
});

// Odłączenie konta Google - logowanie hasłem (lub Google Fit, jeśli był połączony
// wyłącznie przy okazji logowania Google) pozostaje dostępne, bo konto zawsze ma
// password_hash (losowy, jeśli konto powstało przez Google - można go zresetować).
router.post('/api/user/unlink-google', async (req, res) => {
  try {
    await db.run(`UPDATE users SET google_id = NULL WHERE id = ?`, [req.user.id]);
    res.json({ success: true, message: 'Odłączono konto Google.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd odłączania konta Google.' });
  }
});

// 6c. Zmiana hasła użytkownika
router.post('/api/user/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Obecne i nowe hasło są wymagane.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Hasło musi mieć co najmniej 8 znaków.' });
  }
  if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Hasło musi zawierać co najmniej jedną literę i jedną cyfrę.' });
  }

  try {
    const user = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Obecne hasło jest niepoprawne.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);
    res.json({ success: true, message: 'Hasło zostało pomyślnie zmienione.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zmiany hasła serwera.' });
  }
});

router.post('/api/user/send-weekly-summary', summaryEmailLimiter, async (req, res) => {
  try {
    const customEmail = req.body.email;
    if (customEmail && !EMAIL_REGEX.test(customEmail)) {
      return res.status(400).json({ error: 'Niepoprawny format adresu e-mail.' });
    }
    await sendWeeklySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Tygodniowe podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania tygodniowego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// 6ii. Wysyłanie podsumowania codziennego na e-mail (Mailgun)
router.post('/api/user/send-daily-summary', summaryEmailLimiter, async (req, res) => {
  try {
    const customEmail = req.body.email;
    if (customEmail && !EMAIL_REGEX.test(customEmail)) {
      return res.status(400).json({ error: 'Niepoprawny format adresu e-mail.' });
    }
    await sendDailySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Codzienne podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania codziennego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// 6iii. Wysyłanie podsumowania miesięcznego na e-mail (Mailgun)
router.post('/api/user/send-monthly-summary', summaryEmailLimiter, async (req, res) => {
  try {
    const customEmail = req.body.email;
    if (customEmail && !EMAIL_REGEX.test(customEmail)) {
      return res.status(400).json({ error: 'Niepoprawny format adresu e-mail.' });
    }
    await sendMonthlySummaryForUser(req.user.id, customEmail);
    res.json({
      success: true,
      message: 'Miesięczne podsumowanie zostało pomyślnie wysłane.'
    });
  } catch (err) {
    console.error('[API ERROR] Błąd wysyłania podsumowania miesięcznego:', err);
    res.status(500).json({ error: 'Błąd serwera podczas wysyłania e-maila: ' + err.message });
  }
});

// Eksport danych użytkownika (RODO/GDPR, art. 20 - prawo do przenoszenia danych).
// Aplikacja przetwarza dane zdrowotne (waga, skład ciała, aktywność, sen) z Oura/
// Withings/Apple Health/Google Fit - to dane szczególnej kategorii (art. 9 RODO),
// więc użytkownik musi mieć możliwość samodzielnego pobrania własnych danych bez
// proszenia administratora. Hasła/sekrety (password_hash, totp_secret, tokeny OAuth)
// są świadomie WYŁĄCZONE z eksportu - to nie są "dane osobowe do przenoszenia" tylko
// poświadczenia bezpieczeństwa konta.
router.get('/api/user/export', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await db.get(`
      SELECT username, email, first_name, last_name, role, created_at
      FROM users WHERE id = ?
    `, [userId]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const [settings, meals, healthMetrics, bodyMeasurements, workouts] = await Promise.all([
      db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [userId]),
      // B-S1: Pominięcie image_base64 zapobiega OOM przy eksporcie RODO dużych kont
      db.all(`SELECT id, user_id, date, timestamp, raw_text, calories, protein, carbs, fat, fiber, sugar, sodium, health_rating, analysis_json FROM meals WHERE user_id = ? ORDER BY timestamp`, [userId]),
      db.all(`SELECT * FROM health_metrics WHERE user_id = ? ORDER BY date`, [userId]),
      db.all(`SELECT * FROM body_measurements WHERE user_id = ? ORDER BY date`, [userId]),
      db.all(`SELECT * FROM apple_health_workouts WHERE user_id = ? ORDER BY date`, [userId])
    ]);

    // Sekrety/poświadczenia OAuth (oura_client_secret, withings_client_secret,
    // gemini_api_key) maskowane tak samo jak w GET /api/settings - eksport profilu
    // nie powinien ujawniać sekretów integracji w pliku, który użytkownik może
    // gdzieś zapisać/wysłać dalej.
    const maskedSettings = {};
    settings.forEach(r => {
      maskedSettings[r.key] = maskSecretValue(r.key, r.value, USER_SECRET_SETTING_KEYS);
    });

    res.setHeader('Content-Disposition', 'attachment; filename="dietetyk-ai-eksport-danych.json"');
    res.json({
      exported_at: new Date().toISOString(),
      profile: {
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        created_at: user.created_at
      },
      settings: maskedSettings,
      meals,
      health_metrics: healthMetrics,
      body_measurements: bodyMeasurements,
      apple_health_workouts: workouts
    });
  } catch (err) {
    console.error('[EXPORT ERROR]', err);
    res.status(500).json({ error: 'Błąd eksportu danych.' });
  }
});

// Eksport PDF dla lekarza/dietetyka (Produkt: eksport PDF dla lekarza/dietetyka) -
// niezależny od eksportu JSON powyżej: ten dokument jest zwięzłym, czytelnym
// podsumowaniem (cele, średnie z okresu, sen/skład ciała, obwody, suplementy),
// a nie surowym zrzutem wszystkich wierszy z bazy. Parametr days ograniczony w
// buildHealthReportPdf (services/pdfReport.js) do maks. PDF_REPORT_MAX_DAYS dni.
router.get('/api/user/export-pdf-report', async (req, res) => {
  try {
    const pdfBuffer = await buildHealthReportPdf(req.user.id, req.query.days);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dietetyk-ai-raport-${dateStr}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[PDF EXPORT ERROR]', err);
    res.status(500).json({ error: 'Błąd generowania raportu PDF.' });
  }
});

// Udostępnianie raportu PDF linkiem (Produkt: udostępnianie raportu linkiem,
// read-only) - alternatywa dla pobrania pliku powyżej: zamiast samodzielnie
// wysłać plik lekarzowi/dietetykowi, użytkownik wysyła link, który ten może
// otworzyć bez konta w aplikacji (patrz routes/sharedReport.js, publiczny
// endpoint zamontowany w server.js przed requireAuth).
router.post('/api/user/shared-reports', async (req, res) => {
  try {
    const validityKey = Object.prototype.hasOwnProperty.call(VALIDITY_OPTIONS_HOURS, req.body.validityKey)
      ? req.body.validityKey
      : undefined;
    const { token, days, expiresAt } = await createShareLink(req.user.id, req.body.days, validityKey);

    const appUrl = await getAppConfig('app_url');
    const base = appUrl ? appUrl.replace(/\/$/, '') : `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.get('host')}`;
    const url = `${base}/api/public/shared-reports/${token}`;

    res.json({ url, days, expiresAt });
  } catch (err) {
    console.error('[SHARE LINK CREATE ERROR]', err);
    res.status(500).json({ error: 'Błąd tworzenia linku udostępniania.' });
  }
});

// Lista udostępnień użytkownika - bez samych tokenów (patrz komentarz w
// listSharesForUser), tylko metadane potrzebne do wyświetlenia historii i
// pozwolenia na odwołanie.
router.get('/api/user/shared-reports', async (req, res) => {
  try {
    const shares = await listSharesForUser(req.user.id);
    res.json({ shares });
  } catch (err) {
    console.error('[SHARE LIST ERROR]', err);
    res.status(500).json({ error: 'Błąd pobierania listy udostępnień.' });
  }
});

// Odwołanie udostępnienia - revokeShare sprawdza własność (user_id w WHERE), więc
// nie trzeba tu dodatkowego sprawdzenia poza tym, że żądanie jest uwierzytelnione.
router.delete('/api/user/shared-reports/:id', async (req, res) => {
  try {
    const ok = await revokeShare(req.user.id, req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Nie znaleziono udostępnienia.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[SHARE REVOKE ERROR]', err);
    res.status(500).json({ error: 'Błąd odwoływania udostępnienia.' });
  }
});

// Usunięcie własnego konta (RODO/GDPR, art. 17 - prawo do bycia zapomnianym).
// Wymaga podania aktualnego hasła, żeby ktoś, kto przejął WYŁĄCZNIE token sesji
// (np. zostawiony otwarty w przeglądarce), nie mógł trwale usunąć konta bez
// znajomości hasła. Konta zalogowane przez Google bez ustawionego hasła
// (teoretyczny przypadek - rejestracja przez Google ustawia losowy hash) są
// obsłużone tym samym sprawdzeniem bcrypt.
router.delete('/api/user/account', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Potwierdzenie hasłem jest wymagane do usunięcia konta.' });
  }

  try {
    const user = await db.get(`SELECT password_hash, role FROM users WHERE id = ?`, [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Niepoprawne hasło.' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        error: 'Konto administratora nie może zostać usunięte samodzielnie z tego miejsca. Skontaktuj się z drugim administratorem lub usuń konto bezpośrednio w bazie danych.'
      });
    }

    // PRAGMA foreign_keys=ON (patrz db.js) zapewnia kaskadowe usunięcie wierszy
    // powiązanych z tym user_id (sessions, oauth_tokens, meals, settings,
    // health_metrics, body_measurements, apple_health_workouts).
    await db.run(`DELETE FROM users WHERE id = ?`, [req.user.id]);

    res.json({ success: true, message: 'Konto i wszystkie powiązane dane zostały usunięte.' });
  } catch (err) {
    console.error('[ACCOUNT DELETE ERROR]', err);
    res.status(500).json({ error: 'Błąd usuwania konta.' });
  }
});

module.exports = router;
