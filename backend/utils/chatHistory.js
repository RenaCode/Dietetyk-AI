// Logika budowania kontekstu historii dla czatu Dietetyka AI (routes/chat.js) -
// extracted into its own module (like utils/mealAnomaly.js) so it can be unit tested
// without booting the whole Express server and database.

// Character limit for a single chat message. Without it nothing bounded the length of
// `message` going straight into the Gemini prompt - the 20 MB body limit in server.js was
// set for the Apple Health webhook, not for chat - so a user could send an enormous text,
// drastically increasing the cost and latency of the AI call or causing an error on
// Gemini's side.
const MAX_CHAT_MESSAGE_LENGTH = 2000;

// Chat with access to long history: by default the chat sees only the last 7 days
// (CHAT_DEFAULT_LOOKBACK_DAYS), which is enough for typical "today" / "recent days"
// questions and keeps the prompt short. When the message suggests the user is asking
// about a wider period (a month, a trend, a specific month name and so on), we widen the
// window to CHAT_EXTENDED_LOOKBACK_DAYS - 90 days, the same value other "long term"
// features use, e.g. SLEEP_INSIGHT_LOOKBACK_DAYS in dashboard.js. With the wider window
// we also swap the detailed DAILY log for a compact WEEKLY summary (see
// buildWeeklyTrendSummary): dozens of individual days in the prompt would raise Gemini's
// cost and latency without adding real value to the answer.
//
// The keyword list below stays in Polish deliberately - it is matched against the user's
// Polish message, so translating it would break the detection.
const CHAT_DEFAULT_LOOKBACK_DAYS = 7;
const CHAT_EXTENDED_LOOKBACK_DAYS = 90;

const LONG_HISTORY_KEYWORDS = [
  'miesiąc', 'miesiącu', 'miesiące', 'miesięcy', 'miesiącach',
  'tygodni', 'tygodnie', 'tygodniach', 'kwartał', 'kwartale',
  '30 dni', '60 dni', '90 dni', 'dłuższy okres', 'dłuższym okresie',
  'od dawna', 'dawniej', 'histori', 'trend', 'w ciągu', 'ostatnich tygodni',
  'styczni', 'lutego', 'lutym', 'marca', 'marcu', 'kwietnia', 'kwietniu',
  'maja', 'maju', 'czerwca', 'czerwcu', 'lipca', 'lipcu', 'sierpnia', 'sierpniu',
  'września', 'wrześniu', 'października', 'październiku', 'listopada', 'listopadzie',
  'grudnia', 'grudniu', ' rok', 'roku', 'porównaj', 'porównanie'
];

// A keyword heuristic - not perfect (it will not catch a question about a specific date
// with no cue word), but simple, deterministic, and free of the cost of an extra AI call
// just to classify intent.
function messageNeedsLongHistory(msg) {
  const lower = msg.toLowerCase();
  return LONG_HISTORY_KEYWORDS.some(kw => lower.includes(kw));
}

// Weekly summary (7-day buckets starting from the oldest date in range) - used with the
// extended history window. Buckets with no data at all (no meals, weight, steps, sleep or
// workouts) are skipped, so the prompt is not littered with "no data" lines.
//
// The summary text itself is Polish on purpose: it goes into the Gemini prompt and is
// what keeps the model answering in Polish.
function buildWeeklyTrendSummary(historyMetrics, historyMeals, historyWorkouts, startDateStr, endDateStr) {
  const mealsByDate = {};
  historyMeals.forEach(m => {
    if (!mealsByDate[m.date]) mealsByDate[m.date] = [];
    mealsByDate[m.date].push(m);
  });
  const metricsByDate = {};
  historyMetrics.forEach(hm => { metricsByDate[hm.date] = hm; });
  const workoutsByDate = {};
  historyWorkouts.forEach(w => {
    if (!workoutsByDate[w.date]) workoutsByDate[w.date] = [];
    workoutsByDate[w.date].push(w);
  });

  const msPerDay = 24 * 60 * 60 * 1000;
  const startTime = new Date(startDateStr).getTime();
  const endTime = new Date(endDateStr).getTime();
  const totalDays = Math.round((endTime - startTime) / msPerDay);

  let summary = '';
  for (let bucketStart = 0; bucketStart < totalDays; bucketStart += 7) {
    const bucketLen = Math.min(7, totalDays - bucketStart);
    const bucketStartDate = new Date(startTime + bucketStart * msPerDay).toISOString().slice(0, 10);
    const bucketEndDate = new Date(startTime + (bucketStart + bucketLen) * msPerDay).toISOString().slice(0, 10);

    let daysWithMeals = 0, calSum = 0, pSum = 0, cSum = 0, fSum = 0;
    const weightVals = [];
    const stepsVals = [];
    const sleepVals = [];
    let workoutCount = 0, workoutMinutes = 0;
    const workoutTypes = new Set();

    for (let d = bucketStart; d < bucketStart + bucketLen; d++) {
      const dateStr = new Date(startTime + d * msPerDay).toISOString().slice(0, 10);
      const dayMeals = mealsByDate[dateStr];
      if (dayMeals && dayMeals.length > 0) {
        daysWithMeals++;
        calSum += dayMeals.reduce((s, m) => s + m.calories, 0);
        pSum += dayMeals.reduce((s, m) => s + m.protein, 0);
        cSum += dayMeals.reduce((s, m) => s + m.carbs, 0);
        fSum += dayMeals.reduce((s, m) => s + m.fat, 0);
      }
      const hm = metricsByDate[dateStr];
      if (hm) {
        if (hm.weight) weightVals.push(hm.weight);
        if (hm.steps) stepsVals.push(hm.steps);
        if (hm.sleep_score) sleepVals.push(hm.sleep_score);
      }
      const dayWorkouts = workoutsByDate[dateStr];
      if (dayWorkouts && dayWorkouts.length > 0) {
        workoutCount += dayWorkouts.length;
        dayWorkouts.forEach(w => {
          workoutMinutes += w.duration_minutes || 0;
          if (w.workout_type) workoutTypes.add(w.workout_type);
        });
      }
    }

    if (daysWithMeals === 0 && weightVals.length === 0 && stepsVals.length === 0 && sleepVals.length === 0 && workoutCount === 0) {
      continue;
    }

    const avg = (arr) => (arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length);
    const parts = [];
    if (daysWithMeals > 0) {
      parts.push(`śr. spożycie ${Math.round(calSum / daysWithMeals)} kcal/dzień (B:${Math.round(pSum / daysWithMeals)}g W:${Math.round(cSum / daysWithMeals)}g T:${Math.round(fSum / daysWithMeals)}g), zalogowano ${daysWithMeals}/${bucketLen} dni`);
    }
    if (weightVals.length > 0) parts.push(`waga śr. ${Math.round(avg(weightVals) * 10) / 10} kg`);
    if (stepsVals.length > 0) parts.push(`kroki śr. ${Math.round(avg(stepsVals))}`);
    if (sleepVals.length > 0) parts.push(`sen śr. ${Math.round(avg(sleepVals))}/100`);
    if (workoutCount > 0) parts.push(`treningi: ${workoutCount} (łącznie ${Math.round(workoutMinutes)} min, typy: ${Array.from(workoutTypes).join(', ') || 'nieznane'})`);

    summary += `- Okres ${bucketStartDate} – ${bucketEndDate}: ${parts.join(', ')}\n`;
  }
  return summary;
}

module.exports = {
  MAX_CHAT_MESSAGE_LENGTH,
  CHAT_DEFAULT_LOOKBACK_DAYS,
  CHAT_EXTENDED_LOOKBACK_DAYS,
  messageNeedsLongHistory,
  buildWeeklyTrendSummary
};
