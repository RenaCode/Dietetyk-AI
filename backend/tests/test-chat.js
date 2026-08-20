// Tests for the Dietetyk AI chat logic (utils/chatHistory.js, used by routes/chat.js).
// Pure unit tests - no database, network or Gemini; run with: node tests/test-chat.js

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function testMessageNeedsLongHistory() {
  console.log('\n--- TEST: messageNeedsLongHistory ---');
  const { messageNeedsLongHistory } = require('../utils/chatHistory');

  assert(messageNeedsLongHistory('Co jadłem w tym miesiącu?') === true, 'detects the keyword "miesiącu"');
  assert(messageNeedsLongHistory('Pokaż mój trend wagi') === true, 'detects the keyword "trend"');
  assert(messageNeedsLongHistory('Porównaj marzec i kwiecień') === true, 'detects the keyword "porównaj"');
  assert(messageNeedsLongHistory('Jak wyglądała moja dieta w marcu?') === true, 'detects an inflected month name ("marcu")');
  assert(messageNeedsLongHistory('Co dziś jadłem?') === false, 'a short question about the present does NOT widen the history window');
  assert(messageNeedsLongHistory('Ile kalorii mam dzisiaj do końca dnia?') === false, 'a question about today contains no long-period keywords');
  assert(messageNeedsLongHistory('CO JADŁEM W TYM TYGODNIU') === true, 'detection is case-insensitive (toLowerCase)');
}

function testBuildWeeklyTrendSummaryIncludesWorkouts() {
  console.log('\n--- TEST: buildWeeklyTrendSummary (workout aggregation) ---');
  const { buildWeeklyTrendSummary } = require('../utils/chatHistory');

  // One workout (Running, 40 min) in a 7-day window - no meals or metrics, to check that a
  // workout ALONE is enough to keep the window from being skipped
  // (before the "missing workoutCount" fix in the skip condition, the window vanished from the prompt).
  const historyWorkouts = [
    { date: '2026-07-16', workout_type: 'Running', duration_minutes: 40, active_calories: 400, avg_heart_rate: 150, max_heart_rate: 170 }
  ];
  const summary = buildWeeklyTrendSummary([], [], historyWorkouts, '2026-07-13', '2026-07-20');

  assert(summary.includes('treningi: 1'), 'the summary contains the number of workouts in the window');
  assert(summary.includes('40 min'), 'the summary contains the total workout time');
  assert(summary.includes('Running'), 'podsumowanie zawiera typ treningu');

  // A window with NO data at all (meals/metrics/workouts) must be skipped - existing
  // behaviour from before workouts were added, which must not regress.
  const emptySummary = buildWeeklyTrendSummary([], [], [], '2026-07-13', '2026-07-20');
  assert(emptySummary === '', 'a window with no data at all (workouts included) is skipped rather than producing an empty line');
}

function testBuildWeeklyTrendSummaryAggregatesMealsAndMetrics() {
  console.log('\n--- TEST: buildWeeklyTrendSummary (meals + metrics, no regression) ---');
  const { buildWeeklyTrendSummary } = require('../utils/chatHistory');

  const historyMetrics = [
    { date: '2026-07-14', weight: 80, steps: 10000, sleep_score: 85 },
    { date: '2026-07-15', weight: 79.5, steps: 8000, sleep_score: 90 }
  ];
  const historyMeals = [
    { date: '2026-07-14', calories: 2000, protein: 150, carbs: 200, fat: 60 },
    { date: '2026-07-15', calories: 2200, protein: 160, carbs: 220, fat: 65 }
  ];
  const summary = buildWeeklyTrendSummary(historyMetrics, historyMeals, [], '2026-07-13', '2026-07-20');

  assert(summary.includes('zalogowano 2/7 dni'), 'counts the days with logged meals in the 7-day window correctly');
  assert(summary.includes('waga śr.'), 'contains the average weight when weight data is available');
  assert(/śr\. spożycie 2100 kcal/.test(summary), 'computes the average daily calories from the available days correctly ((2000+2200)/2=2100)');
}

function testMaxChatMessageLength() {
  console.log('\n--- TEST: MAX_CHAT_MESSAGE_LENGTH ---');
  const { MAX_CHAT_MESSAGE_LENGTH } = require('../utils/chatHistory');
  assert(MAX_CHAT_MESSAGE_LENGTH === 2000, 'the chat message length limit has the expected value (a regression guard against a typo or an accidental zmianę)');
}

try {
  testMessageNeedsLongHistory();
  testBuildWeeklyTrendSummaryIncludesWorkouts();
  testBuildWeeklyTrendSummaryAggregatesMealsAndMetrics();
  testMaxChatMessageLength();
  console.log('\n🎉 CHAT TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY CZATU NIEUDANE');
  process.exit(1);
}
