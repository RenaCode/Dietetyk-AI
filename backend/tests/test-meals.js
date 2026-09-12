// Tests for AI response sanitisation and meal photo validation (utils/mealSanitize.js, used
// by routes/meals.js POST /api/meals - meal and photo analysis through Gemini).
// Pure unit tests - no database, network or Gemini; run with: node tests/test-meals.js

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function testSanitizeNumber() {
  console.log('\n--- TEST: sanitizeNumber ---');
  const { sanitizeNumber } = require('../utils/mealSanitize');

  assert(sanitizeNumber(500, 0, 5000, 0) === 500, 'wartość w dozwolonym zakresie przechodzi bez zmian');
  assert(sanitizeNumber(-100, 0, 5000, 0) === 0, 'ujemna wartość (np. halucynacja Gemini) jest odcinana do min');
  assert(sanitizeNumber(999999, 0, 5000, 0) === 5000, 'wartość powyżej maksimum jest odcinana do max');
  assert(sanitizeNumber('nie-liczba', 0, 5000, 0) === 0, 'wartość nie-numeryczna zwraca fallback (0)');
  assert(sanitizeNumber(undefined, 0, 5000, 0) === 0, 'brak wartości (undefined) zwraca fallback (0)');
  assert(sanitizeNumber(NaN, 0, 500, 42) === 42, 'NaN zwraca podany fallback, nie zawsze 0');
  assert(sanitizeNumber(Infinity, 0, 5000, 0) === 0, 'Infinity nie jest skończone (Number.isFinite) - zwraca fallback');
}

function testSanitizeNullableNumber() {
  console.log('\n--- TEST: sanitizeNullableNumber ---');
  const { sanitizeNullableNumber } = require('../utils/mealSanitize');

  assert(sanitizeNullableNumber(undefined, 0, 100) === null, 'brak wartości zwraca null (nie fabrykuje zera)');
  assert(sanitizeNullableNumber(null, 0, 100) === null, 'null zwraca null');
  assert(sanitizeNullableNumber('', 0, 100) === null, 'pusty string zwraca null');
  assert(sanitizeNullableNumber(-5, 0, 100) === 0, 'podana ujemna wartość jest odcinana do min, nie staje się null');
  assert(sanitizeNullableNumber(9999, 0, 100) === 100, 'podana wartość powyżej max jest odcinana do max');
  assert(sanitizeNullableNumber('abc', 0, 100) === null, 'nie-numeryczna wartość zwraca null');
  assert(sanitizeNullableNumber(50, 0, 100) === 50, 'poprawna wartość w zakresie przechodzi bez zmian');
}

function testAllowedMimeTypes() {
  console.log('\n--- TEST: ALLOWED_MEAL_IMAGE_MIME_TYPES ---');
  const { ALLOWED_MEAL_IMAGE_MIME_TYPES } = require('../utils/mealSanitize');

  ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].forEach(mime => {
    assert(ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mime), `${mime} jest na białej liście dozwolonych typów zdjęcia`);
  });
  ['application/octet-stream', 'text/html', 'image/svg+xml', 'application/pdf'].forEach(mime => {
    assert(!ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mime), `${mime} NIE jest na białej liście (odrzucane)`);
  });
}

function testMaxImageSize() {
  console.log('\n--- TEST: MAX_MEAL_IMAGE_BASE64_CHARS ---');
  const { MAX_MEAL_IMAGE_BASE64_CHARS } = require('../utils/mealSanitize');
  assert(MAX_MEAL_IMAGE_BASE64_CHARS === 7 * 1024 * 1024, 'limit rozmiaru zdjęcia posiłku ma oczekiwaną wartość (regresja na przypadkową zmianę)');
}

try {
  testSanitizeNumber();
  testSanitizeNullableNumber();
  testAllowedMimeTypes();
  testMaxImageSize();
  console.log('\n🎉 MEAL ANALYSIS TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ MEAL ANALYSIS TESTS FAILED');
  process.exit(1);
}
