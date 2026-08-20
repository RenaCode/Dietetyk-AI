const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3000;

// --- GEMINI MODEL SELECTION ---
//
// The single place that decides which model actually goes to the API.
// The same logic ("if gemini-1.5-flash is configured, use 2.5 anyway") used to be
// duplicated in two spots in this file - it worked, but every change required
// remembering both, and reading the code suggested that 1.5 was genuinely in use
// somewhere.
//
// Why 1.5 is substituted rather than rejected outright: the README recommended
// GEMINI_MODEL=gemini-1.5-flash as the production configuration for a long time, so
// existing .env files on servers carry that value. The model returns 404 in this SDK, and
// a hard rejection would stop AI analysis after
// aktualizacji. Podmiana jest cicha, ale logowana przy starcie.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEPRECATED_GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro'];

function resolveGeminiModel() {
  const configured = process.env.GEMINI_MODEL;
  if (!configured) return DEFAULT_GEMINI_MODEL;
  if (DEPRECATED_GEMINI_MODELS.includes(configured)) {
    console.warn(
      `[AI] GEMINI_MODEL=${configured} is deprecated and returns 404 in this SDK - using ${DEFAULT_GEMINI_MODEL} instead. ` +
      `Update backend/.env to silence this warning.`
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
    console.error('Failed to initialise the Gemini API:', err.message);
  }
} else {
  console.warn('Warning: GEMINI_API_KEY is missing from .env. AI analysis will not work.');
}

// Helper for generating content, with model fallback and logging
async function generateContentWithFallback(promptText, isJson = false, imagePart = null, customApiKey = null, forceCustomKeyOnly = false) {
  const apiKeyToUse = customApiKey || (forceCustomKeyOnly ? null : process.env.GEMINI_API_KEY);
  if (!apiKeyToUse) {
    throw new Error('Usługa AI jest obecnie niedostępna (brak klucza API). Upewnij się, że klucz jest wprowadzony w zakładce Ustawienia.');
  }

  const localGenAI = new GoogleGenerativeAI(apiKeyToUse);

  // The configured model (after substituting deprecated versions) plus the default as a
  // fallback - when both are the same, uniqueModels collapses it to a single attempt.
  const modelsToTry = [ACTIVE_GEMINI_MODEL, DEFAULT_GEMINI_MODEL].filter(Boolean);

  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  console.log(`[AI LOG] Starting generation with a prompt of ${promptText.length} characters.`);

  for (const modelName of uniqueModels) {
    try {
      console.log(`[AI LOG] Sending request (JSON=${isJson}, image=${!!imagePart}) to model: ${modelName}`);
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
      console.log(`[AI LOG] Success. Model used: ${modelName}. Response length: ${text.length} characters.`);
      return text;
    } catch (err) {
      console.warn(`[AI WARNING] Model ${modelName} returned an error: ${err.message}`);
      lastError = err;
      
      // If the error is an invalid API key or missing authorisation (401/403), retrying
      // other models with the same key is pointless.
      const errText = err.message || '';
      if (
        err.status === 401 ||
        err.status === 403 ||
        errText.includes('API key not valid') ||
        errText.includes('API_KEY_INVALID') ||
        errText.includes('API_KEY_SERVICE_BLOCKED') ||
        errText.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')
      ) {
        console.error(`[AI ERROR] Fatal API key error. Skipping the remaining models.`);
        break;
      }
    }
  }

  console.error(`[AI ERROR] Every available model (${uniqueModels.join(', ')}) failed.`);
  throw lastError || new Error("Every configured Gemini model returned an error.");
}

module.exports = {
  PORT,
  genAI,
  model,
  generateContentWithFallback,
  // Exported for tests and diagnostics - lets you check which model will actually be used
  // without reading the startup logs.
  ACTIVE_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL
};
