// Default values for the user's targets (calories/BMR/water) - used as the fallback in
// routes/dashboard.js i routes/chat.js, gdy w tabeli settings brakuje danego klucza
// or when the stored value is not a number (NaN). Every file - often every endpoint
// within the same file - used to hardcode its own fallback: some places used 2000 kcal,
// others 2500, even though db.js/auth.js always SEEDS a new user with 2500 (see
// initDb/registerUser). The effect: if someone deleted the target_calories setting,
// different Dashboard cards and the AI chat showed different calorie targets for the
// same user at the same moment.
// The three constants below are now the ONLY place these defaults are defined - they
// must be kept in sync with the seed in db.js/auth.js if they ever change.
const DEFAULT_TARGET_CALORIES = 2500;
const DEFAULT_BMR = 1800;
const DEFAULT_TARGET_WATER_ML = 2500;

function getTargetCalories(settings) {
  const value = settings && settings.target_calories;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_TARGET_CALORIES : value;
}

function getBmr(settings) {
  const value = settings && settings.bmr;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_BMR : value;
}

function getTargetWaterMl(settings) {
  const value = settings && settings.target_water_ml;
  return value === undefined || value === null || isNaN(value) || !value ? DEFAULT_TARGET_WATER_ML : value;
}

// The user's OWN goal, or null when they never set one (audit 2026-10-09, S2). The getters
// above substitute a default, which is right for arithmetic that needs SOME number (a streak,
// a fallback burn estimate) and wrong wherever the number is SHOWN to the user or quoted to
// the AI as "your target": every account was seeded with the same 2500 kcal / BMR 1800, and
// e-mails and chat replies presented those as the user's choice. 0, NaN and missing all mean
// "not set", the same convention as getTargetCalories.
function userGoal(settings, key) {
  const value = settings ? Number(settings[key]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// How a goal reads in an e-mail, the PDF or an AI prompt - "brak celu" rather than a guess.
function goalText(value, unit, language = 'pl', multiplier = 1) {
  if (value === null || value === undefined) return language === 'en' ? 'not set' : 'brak celu (nieustawiony)';
  return `${Math.round(value * multiplier * 10) / 10}${unit}`;
}

module.exports = {
  userGoal,
  goalText,
  DEFAULT_TARGET_CALORIES,
  DEFAULT_BMR,
  DEFAULT_TARGET_WATER_ML,
  getTargetCalories,
  getBmr,
  getTargetWaterMl
};
