const crypto = require('crypto');
const db = require('../db');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { encrypt, decrypt } = require('../utils/encryption');

// Sekret do podpisywania (HMAC) parametru `state` w przepływie OAuth.
// Wcześniej w razie braku APP_PASSWORD w środowisku kod po cichu używał
// stałego, znanego z kodu źródłowego ciągu 'default_secret' - co czyniłoby
// podpis trywialnym do podrobienia (atak CSRF na przepływ OAuth) w razie
// pomyłki przy konfiguracji .env na produkcji. Teraz: brak konfiguracji
// = błąd startowy (fail-fast), żeby taka pomyłka nigdy nie przeszła niezauważona.
// Można nadpisać dedykowaną zmienną OAUTH_STATE_SECRET, żeby nie używać
// hasła panelu admina (APP_PASSWORD) jednocześnie jako sekretu kryptograficznego.
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.APP_PASSWORD;
if (!OAUTH_STATE_SECRET) {
  throw new Error(
    'Brak OAUTH_STATE_SECRET (lub zapasowo APP_PASSWORD) w zmiennych środowiskowych. ' +
    'Ustaw jedną z nich w backend/.env, inaczej przepływ OAuth (Oura/Withings/Google) nie jest bezpieczny.'
  );
}

// Helper do pobierania konfiguracji z bazy app_config. decrypt() jest bezpieczne do
// wywołania dla KAŻDEGO klucza (nie tylko sekretnych z APP_SECRET_CONFIG_KEYS) - dla
// wartości nigdy nie zaszyfrowanych przez encrypt() (patrz utils/encryption.js) jest
// no-opem, bo brakuje im rozpoznawalnego prefiksu.
async function getAppConfig(key) {
  if (key === 'app_url' && process.env.APP_URL) {
    return process.env.APP_URL;
  }
  const row = await db.get(`SELECT value FROM app_config WHERE key = ?`, [key]);
  return row ? decrypt(row.value) : null;
}

// Helper do pobierania ustawień konkretnego użytkownika - decrypt() jak wyżej,
// bezpieczne dla wartości niesekretnych (no-op bez prefiksu enc:v1:).
async function getUserSetting(userId, key) {
  const row = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = ?`, [userId, key]);
  return row ? decrypt(row.value) : null;
}

// Weryfikacja tokenu sesji dla tras OAuth INICJUJĄCYCH połączenie (Oura/Withings/
// Google Fit/Google link), które dostają token przez ?token= w query (nawigacja
// najwyższego poziomu, nie fetch z nagłówkiem Authorization - patrz komentarz w
// middleware/auth.js). Te trasy są na liście wyjątków requireAuth, więc same
// odpowiadają za pełną weryfikację - wcześniej sprawdzały TYLKO ważność tokenu
// sesji, NIE sprawdzając, czy użytkownik z włączonym 2FA faktycznie dokończył
// weryfikację kodu (sesja tymczasowa z is_verified_2fa=0 i krótkim TTL mogła
// teoretycznie zainicjować podłączenie konta zewnętrznego). Ta funkcja replikuje
// dokładnie tę samą kontrolę, którą requireAuth stosuje dla tras za nagłówkiem
// Authorization, więc obie ścieżki mają taki sam poziom bezpieczeństwa.
async function getVerifiedSessionByToken(token) {
  if (!token) return null;
  const session = await db.get(`
    SELECT s.user_id, s.expires_at, s.is_verified_2fa, u.totp_enabled
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `, [token]);

  if (!session) return null;
  if (new Date(session.expires_at.replace(' ', 'T') + 'Z') < new Date()) return null;
  if (session.totp_enabled === 1 && session.is_verified_2fa === 0) return null;

  return session;
}

// Bezpieczne generowanie i weryfikacja stanu OAuth (stateless)
function generateOAuthState(userId, service = 'oura') {
  // crypto.randomBytes (CSPRNG) zamiast Math.random() (PRNG nie-kryptograficzny,
  // przewidywalny przy znajomości stanu generatora). Sam HMAC nadal chroni przed
  // podrobieniem state bez znajomości OAUTH_STATE_SECRET, ale sól/nonce w przepływie
  // anty-CSRF powinna być generowana kryptograficznie bezpiecznym generatorem.
  const salt = crypto.randomBytes(16).toString('hex');
  const data = `${userId}:${service}:${salt}`;
  const hmac = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(data).digest('hex');
  return `${userId}:${service}:${salt}:${hmac}`;
}

function verifyOAuthState(state) {
  if (!state) return null;
  // Aktualny format to zawsze 4 części (userId:service:salt:hmac) - generowany
  // wyłącznie przez generateOAuthState powyżej. Usunięto martwą gałąź obsługującą
  // stary, 3-częściowy format (userId:salt:hmac, z domyślnym service='oura') -
  // żaden aktualny generator state już go nie tworzy.
  const parts = state.split(':');
  if (parts.length === 4) {
    const [userId, service, salt, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(`${userId}:${service}:${salt}`).digest('hex');
    // Bug fix: porównanie HMAC-ów przez `===` porównuje string bajt po bajcie i
    // przerywa na pierwszej różnicy, co teoretycznie ujawnia przez czas odpowiedzi,
    // ile początkowych znaków zgadza się z oczekiwanym HMAC-em (timing attack) -
    // ten sam typ ryzyka, przed którym reszta pliku świadomie chroni (patrz komentarz
    // o CSPRNG w generateOAuthState). crypto.timingSafeEqual porównuje w stałym
    // czasie; wymaga buforów o równej długości, więc najpierw porównujemy długość
    // (sama długość HMAC-a SHA-256 w hex jest stała i nie jest sekretem).
    const hmacBuf = Buffer.from(hmac, 'utf8');
    const expectedBuf = Buffer.from(expectedHmac, 'utf8');
    const hmacValid = hmacBuf.length === expectedBuf.length && crypto.timingSafeEqual(hmacBuf, expectedBuf);
    if (hmacValid) {
      return { userId: parseInt(userId, 10), service };
    }
  }
  return null;
}

// Pobieranie / Odświeżanie tokenu OAuth
async function getOrRefreshToken(userId, service) {
  const token = await db.get(`SELECT * FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
  if (!token) return null;
  // Odszyfrowanie od razu po odczycie - reszta funkcji (poniżej) operuje na
  // token.access_token/refresh_token tak, jakby zawsze były plaintextem.
  token.access_token = decrypt(token.access_token);
  token.refresh_token = decrypt(token.refresh_token);

  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // Jeśli token jest ważny dłużej niż 5 minut, zwracamy go
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  console.log(`[OAUTH] Odświeżanie tokenu dla użytkownika ${userId}, serwis: ${service}...`);
  let isPermanentFailure = false;

  try {
    if (service === 'oura') {
      const clientId = await getUserSetting(userId, 'oura_client_id');
      const clientSecret = await getUserSetting(userId, 'oura_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Oura.');
      }

      const response = await fetchWithTimeout('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Oura (Status ${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'oura'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'withings') {
      const clientId = await getUserSetting(userId, 'withings_client_id');
      const clientSecret = await getUserSetting(userId, 'withings_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Withings.');
      }

      const response = await fetchWithTimeout('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Withings (Status ${response.status}): ${errorText}`);
      }

      const resJson = await response.json();
      if (resJson.status !== 0) {
        // Statusy błędów Withings: np. 100 (invalid token), 200 (invalid client), itp.
        // Wykluczamy tymczasowe błędy (np. 503 lub 601) - w ich przypadku nie usuwamy tokenu.
        if (resJson.status === 100 || resJson.status === 200 || resJson.status === 501) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd Withings API: ${resJson.error || 'Status ' + resJson.status}`);
      }

      const data = resJson.body;
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'withings'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    } else if (service === 'google_fit') {
      const clientId = await getAppConfig('google_client_id');
      const clientSecret = await getAppConfig('google_client_secret');
      if (!clientId || !clientSecret) {
        isPermanentFailure = true;
        throw new Error('Brak Client ID lub Secret dla Google (konfiguracja globalna).');
      }

      const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          isPermanentFailure = true;
        }
        throw new Error(`Błąd odświeżania Google Fit (Status ${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await db.run(`
        UPDATE oauth_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?
        WHERE user_id = ? AND service = 'google_fit'
      `, [encrypt(data.access_token), encrypt(data.refresh_token || token.refresh_token), newExpiresAt, userId]);

      return data.access_token;
    }
  } catch (err) {
    console.error(`[OAUTH ERROR] Błąd odświeżania tokenu dla ${service} (użytkownik ${userId}):`, err.message);
    if (isPermanentFailure) {
      console.warn(`[OAUTH] Usuwanie niepoprawnego tokenu z bazy dla ${service} (użytkownik ${userId}) ze względu na trwale niepoprawną autoryzację.`);
      await db.run(`DELETE FROM oauth_tokens WHERE user_id = ? AND service = ?`, [userId, service]);
    } else {
      console.log(`[OAUTH] Zachowywanie tokenu dla ${service} (użytkownik ${userId}) w bazie - błąd ma charakter przejściowy.`);
    }
    return null;
  }
  return null;
}

module.exports = {
  getAppConfig,
  getUserSetting,
  generateOAuthState,
  verifyOAuthState,
  getOrRefreshToken,
  getVerifiedSessionByToken
};
