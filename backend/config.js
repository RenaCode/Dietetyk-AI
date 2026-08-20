const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Wczytaj zmienne środowiskowe
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3000;

// --- WYBÓR MODELU GEMINI ---
//
// Jedno miejsce, w którym rozstrzyga się, jaki model faktycznie leci do API.
// Wcześniej ta sama logika ("jeśli ustawiono gemini-1.5-flash, użyj mimo to 2.5")
// była zduplikowana w dwóch miejscach tego pliku - działała, ale każda zmiana
// wymagała pamiętania o obu, a lektura kodu sugerowała, że gdzieś naprawdę
// używamy 1.5.
//
// Dlaczego 1.5 jest podmieniane, a nie po prostu odrzucane: README przez długi
// czas podawał GEMINI_MODEL=gemini-1.5-flash jako zalecaną konfigurację
// produkcyjną, więc istniejące pliki .env na serwerach mają tam tę wartość.
// Model zwraca 404 w tym SDK, a twarde odrzucenie zatrzymałoby analizy AI po
// aktualizacji. Podmiana jest cicha, ale logowana przy starcie.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEPRECATED_GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro'];

function resolveGeminiModel() {
  const configured = process.env.GEMINI_MODEL;
  if (!configured) return DEFAULT_GEMINI_MODEL;
  if (DEPRECATED_GEMINI_MODELS.includes(configured)) {
    console.warn(
      `[AI] GEMINI_MODEL=${configured} jest wycofany i zwraca 404 w tym SDK - używam ${DEFAULT_GEMINI_MODEL}. ` +
      `Zaktualizuj backend/.env, żeby ten komunikat zniknął.`
    );
    return DEFAULT_GEMINI_MODEL;
  }
  return configured;
}

const ACTIVE_GEMINI_MODEL = resolveGeminiModel();

// Inicjalizacja Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY;
let genAI = null;
let model = null;

if (geminiApiKey) {
  try {
    genAI = new GoogleGenerativeAI(geminiApiKey);
    model = genAI.getGenerativeModel({
      model: ACTIVE_GEMINI_MODEL
    });
    console.log(`Zainicjalizowano Gemini API z modelem: ${ACTIVE_GEMINI_MODEL}`);
  } catch (err) {
    console.error('Błąd inicjalizacji Gemini API:', err.message);
  }
} else {
  console.warn('Ostrzeżenie: Brak GEMINI_API_KEY w pliku .env. Analiza AI nie będzie działać!');
}

// Pomocnicza funkcja do generowania treści z obsługą modeli zapasowych (fallback) i logowaniem
async function generateContentWithFallback(promptText, isJson = false, imagePart = null, customApiKey = null, forceCustomKeyOnly = false) {
  const apiKeyToUse = customApiKey || (forceCustomKeyOnly ? null : process.env.GEMINI_API_KEY);
  if (!apiKeyToUse) {
    throw new Error('Usługa AI jest obecnie niedostępna (brak klucza API). Upewnij się, że klucz jest wprowadzony w zakładce Ustawienia.');
  }

  const localGenAI = new GoogleGenerativeAI(apiKeyToUse);

  // Model skonfigurowany (po podmianie wycofanych wersji) plus domyślny jako
  // zapasowy - jeśli oba są takie same, uniqueModels sprowadzi to do jednej próby.
  const modelsToTry = [ACTIVE_GEMINI_MODEL, DEFAULT_GEMINI_MODEL].filter(Boolean);

  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  console.log(`[AI LOG] Rozpoczęcie generowania z promptem o długości ${promptText.length} znaków.`);

  for (const modelName of uniqueModels) {
    try {
      console.log(`[AI LOG] Próba wysłania zapytania (JSON=${isJson}, Obraz=${!!imagePart}) do modelu: ${modelName}`);
      const tempModel = localGenAI.getGenerativeModel({ model: modelName });

      const config = {
        temperature: 0.2,
      };
      if (isJson) {
        config.responseMimeType = "application/json";
      }

      const parts = [{ text: promptText }];
      if (imagePart) {
        parts.push(imagePart);
      }

      const response = await tempModel.generateContent({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: config
      });

      const text = response.response.text();
      console.log(`[AI LOG] Sukces! Użyto modelu: ${modelName}. Długość odpowiedzi: ${text.length} znaków.`);
      return text;
    } catch (err) {
      console.warn(`[AI WARNING] Model ${modelName} zgłosił błąd: ${err.message}`);
      lastError = err;
      
      // Jeśli błąd dotyczy niepoprawnego klucza API lub braku autoryzacji (401/403),
      // nie ma sensu ponawiać próby dla innych modeli z tym samym kluczem.
      const errText = err.message || '';
      if (
        err.status === 401 ||
        err.status === 403 ||
        errText.includes('API key not valid') ||
        errText.includes('API_KEY_INVALID') ||
        errText.includes('API_KEY_SERVICE_BLOCKED') ||
        errText.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')
      ) {
        console.error(`[AI ERROR] Krytyczny błąd klucza API. Przerywam próby dla innych modeli.`);
        break;
      }
    }
  }

  console.error(`[AI ERROR] Wszystkie dostępne modele (${uniqueModels.join(', ')}) zawiodły.`);
  throw lastError || new Error("Wszystkie skonfigurowane modele Gemini zwróciły błąd.");
}

module.exports = {
  PORT,
  genAI,
  model,
  generateContentWithFallback,
  // Eksportowane do testów i diagnostyki - pozwala sprawdzić, jaki model realnie
  // zostanie użyty, bez czytania logów startowych.
  ACTIVE_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL
};
