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

  assert(sanitizeNumber(500, 0, 5000, 0) === 500, 'a value within the allowed range passes through unchanged');
  assert(sanitizeNumber(-100, 0, 5000, 0) === 0, 'a negative value (a Gemini hallucination, for instance) is clamped to the minimum');
  assert(sanitizeNumber(999999, 0, 5000, 0) === 5000, 'a value above the maximum is clamped to the maximum');
  assert(sanitizeNumber('nie-liczba', 0, 5000, 0) === 0, 'a non-numeric value returns the fallback (0)');
  assert(sanitizeNumber(undefined, 0, 5000, 0) === 0, 'a missing value (undefined) returns the fallback (0)');
  assert(sanitizeNumber(NaN, 0, 500, 42) === 42, 'NaN zwraca podany fallback, nie zawsze 0');
  assert(sanitizeNumber(Infinity, 0, 5000, 0) === 0, 'Infinity is not finite (Number.isFinite) - it returns the fallback');
}

function testSanitizeNullableNumber() {
  console.log('\n--- TEST: sanitizeNullableNumber ---');
  const { sanitizeNullableNumber } = require('../utils/mealSanitize');

  assert(sanitizeNullableNumber(undefined, 0, 100) === null, 'a missing value returns null (it does not fabricate a zero)');
  assert(sanitizeNullableNumber(null, 0, 100) === null, 'null zwraca null');
  assert(sanitizeNullableNumber('', 0, 100) === null, 'pusty string zwraca null');
  assert(sanitizeNullableNumber(-5, 0, 100) === 0, 'a supplied negative value is clamped to the minimum rather than becoming null');
  assert(sanitizeNullableNumber(9999, 0, 100) === 100, 'a supplied value above the maximum is clamped to the maximum');
  assert(sanitizeNullableNumber('abc', 0, 100) === null, 'a non-numeric value returns null');
  assert(sanitizeNullableNumber(50, 0, 100) === 50, 'a valid in-range value passes through unchanged');
}

function testAllowedMimeTypes() {
  console.log('\n--- TEST: ALLOWED_MEAL_IMAGE_MIME_TYPES ---');
  const { ALLOWED_MEAL_IMAGE_MIME_TYPES } = require('../utils/mealSanitize');

  ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].forEach(mime => {
    assert(ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mime), `${mime} is on the whitelist of allowed photo types`);
  });
  ['application/octet-stream', 'text/html', 'image/svg+xml', 'application/pdf'].forEach(mime => {
    assert(!ALLOWED_MEAL_IMAGE_MIME_TYPES.includes(mime), `${mime} is NOT on the whitelist (rejected)`);
  });
}

function testMaxImageSize() {
  console.log('\n--- TEST: MAX_MEAL_IMAGE_BASE64_CHARS ---');
  const { MAX_MEAL_IMAGE_BASE64_CHARS } = require('../utils/mealSanitize');
  assert(MAX_MEAL_IMAGE_BASE64_CHARS === 7 * 1024 * 1024, 'the meal photo size limit has the expected value (a regression guard against an accidental change)');
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
