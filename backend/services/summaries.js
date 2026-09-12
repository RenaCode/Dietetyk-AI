const db = require('../db');
const { genAI, generateContentWithFallback } = require('../config');
const { getLocalDateString } = require('../utils/dates');
const { sendMailgunEmail } = require('./mailgun');
const { getDefaultHealthMetrics } = require('../utils/defaultHealthMetrics');
const { decrypt } = require('../utils/encryption');
const { getWeatherAndTimeContext, getUserLocationOverride } = require('../utils/weatherContext');

// ===== Shared helpers (extracted from duplication across the three functions below) =====

async function getUserAndEmail(userId, customEmail) {
  const user = await db.get(`SELECT username, email, role, first_name FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }
  const emailToUse = customEmail || user.email;
  if (!emailToUse) {
    throw new Error('Brak zdefiniowanego adresu e-mail dla tego użytkownika.');
  }
  return { user, emailToUse };
}

async function getUserSettings(userId) {
  const settingsRows = await db.all(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  const settings = {};
  settingsRows.forEach(r => {
    settings[r.key] = Number(r.value);
  });
  return {
    targetCalories: settings.target_calories ?? 2500,
    targetProtein: settings.target_protein ?? 150,
    targetCarbs: settings.target_carbs ?? 250,
    targetFat: settings.target_fat ?? 80,
    bmr: settings.bmr ?? 1800,
    targetWaterMl: settings.target_water_ml ?? 2500,
    // 0 = not set (the same convention as in routes/dashboard.js) - the numeric
// the weight target is optional, unlike calories and macros, which have sensible
// defaults.
    targetWeightKg: settings.target_weight_kg || 0
  };
}

// Divergence between the weight goal (the numeric target_weight_kg) and the real rate of
// weight change this week - the only new product logic in this report; the rest is wiring
// into the existing weekly email. It uses only data the app already collects (the weight
// target from settings plus weight history from health_metrics) - nothing new is asked of
// the user.
// Returns null when the rate cannot be judged sensibly (no target, no current weight, or
// too few measurements this week for the rate to be more than a guess from one point) -
// following the established 'do not fabricate conclusions from sparse data' pattern used
// by the other product features (see routes/dashboard.js).
function buildGoalPaceAnalysis(targetWeightKg, currentWeight, weeklyWeightChange) {
  if (!targetWeightKg || currentWeight === null || weeklyWeightChange === null) {
    return null;
  }
  const GOAL_REACHED_TOLERANCE_KG = 0.3;
  const remainingKg = Math.round((currentWeight - targetWeightKg) * 10) / 10; // >0: needs to lose weight, <0: needs to gain
  if (Math.abs(remainingKg) <= GOAL_REACHED_TOLERANCE_KG) {
    return { status: 'reached', remainingKg, currentWeight, targetWeightKg, weeklyWeightChange };
  }
  const goalDirection = remainingKg > 0 ? -1 : 1; // kierunek WYMAGANY przez cel
  const actualDirection = weeklyWeightChange === 0 ? 0 : (weeklyWeightChange > 0 ? 1 : -1);
  const directionMismatch = actualDirection !== 0 && actualDirection !== goalDirection;
  // Round 12 (audit): a minimum-rate threshold. With weeklyWeightChange close to zero
  // (0.01 kg/week, say) the division produced absurd values - hundreds or thousands of
  // weeks - which then went into the AI prompt in the email. Below this threshold the rate
  // is too small to forecast a date from, so we treat it as 'stalled' even though
  // actualDirection may formally have come out non-zero.
  const MIN_WEEKLY_CHANGE_FOR_PROJECTION_KG = 0.05;
  let weeksToGoal = null;
  if (!directionMismatch && actualDirection !== 0 && Math.abs(weeklyWeightChange) >= MIN_WEEKLY_CHANGE_FOR_PROJECTION_KG) {
    weeksToGoal = Math.round(Math.abs(remainingKg / weeklyWeightChange) * 10) / 10;
  }
  return {
    status: directionMismatch ? 'wrong_direction' : (actualDirection === 0 ? 'stalled' : 'on_track'),
    remainingKg, currentWeight, targetWeightKg, weeklyWeightChange, weeksToGoal
  };
}

// Aggregates nutrition and health statistics over a date range (used by the weekly and
async function aggregateNutritionAndHealth(meals, healthMetrics, numDays, userId, startDate) {
// NOTE: totalFiber/totalSugar/totalSodium MUST be declared (let) BEFORE the forEach below
// that uses them - the declaration used to sit lower in the function, so every call with a
// non-empty meal list threw a ReferenceError (temporal dead zone), which broke the weekly
// and monthly reports entirely for every user who had logged any meals.
  let totalEatenCal = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  let totalFiber = 0, totalSugar = 0, totalSodium = 0;
  meals.forEach(m => {
    totalEatenCal += m.calories;
    totalProtein += m.protein;
    totalCarbs += m.carbs;
    totalFat += m.fat;
    totalFiber += m.fiber || 0;
    totalSugar += m.sugar || 0;
    totalSodium += m.sodium || 0;
  });

  let totalSteps = 0, totalActiveCal = 0, totalWaterMl = 0;
  let sleepScoreSum = 0, sleepScoreCount = 0;
  let readinessScoreSum = 0, readinessScoreCount = 0;
  let weightSum = 0, weightCount = 0;
  let fatRatioSum = 0, fatRatioCount = 0;
  let muscleMassSum = 0, muscleMassCount = 0;
  let firstWeight = null, lastWeight = null;
  let firstFatRatio = null, lastFatRatio = null;
  let firstMuscleMass = null, lastMuscleMass = null;
  let bpSystolicSum = 0, bpDiastolicSum = 0, bpCount = 0;
  const supplementsLogged = [];

  const sortedHealthMetrics = [...healthMetrics].sort((a, b) => a.date.localeCompare(b.date));

  sortedHealthMetrics.forEach(h => {
    totalSteps += h.steps || 0;
    totalActiveCal += h.active_calories || 0;
    totalWaterMl += h.water_ml || 0;
    if (h.sleep_score !== null) {
      sleepScoreSum += h.sleep_score;
      sleepScoreCount++;
    }
    if (h.readiness_score !== null) {
      readinessScoreSum += h.readiness_score;
      readinessScoreCount++;
    }
    if (h.weight !== null) {
      weightSum += h.weight;
      weightCount++;
      if (firstWeight === null) firstWeight = h.weight;
      lastWeight = h.weight;
    }
    if (h.fat_ratio !== null) {
      fatRatioSum += h.fat_ratio;
      fatRatioCount++;
      if (firstFatRatio === null) firstFatRatio = h.fat_ratio;
      lastFatRatio = h.fat_ratio;
    }
    if (h.muscle_mass !== null) {
      muscleMassSum += h.muscle_mass;
      muscleMassCount++;
      if (firstMuscleMass === null) firstMuscleMass = h.muscle_mass;
      lastMuscleMass = h.muscle_mass;
    }
    if (h.blood_pressure_systolic !== null && h.blood_pressure_diastolic !== null) {
      bpSystolicSum += h.blood_pressure_systolic;
      bpDiastolicSum += h.blood_pressure_diastolic;
      bpCount++;
    }
    if (h.supplements) {
      supplementsLogged.push(`${h.date}: ${h.supplements}`);
    }
  });

  // Round 12 (audit): workoutsCount used to count DAYS where active_calories > 0, which
  // (a) undercounted days with several workouts, scoring them as 1, and (b) missed workouts
  // with no recorded active calories, such as strength training without watch data. We now
  // count real rows from the dedicated apple_health_workouts table, as already done by
  // routes/dashboard.js (np. recovery-insight/workout-calorie-efficiency).
  const workoutsCount = userId && startDate
    ? (await db.get(`SELECT COUNT(*) AS count FROM apple_health_workouts WHERE user_id = ? AND date >= ?`, [userId, startDate])).count
    : healthMetrics.filter(h => (h.active_calories || 0) > 0).length;

  // FIX (audit round 4): the daily averages computed here were divided by the FIXED window
  // length (numDays = 7 or 30), regardless of how many days in that period the user had
  // actually logged meals or synced data - unlike routes/dashboard.js (aggregateNutrition),
  // which deliberately divides by the real number of days with data (daysLogged) so that
  // irregular logging does not artificially deflate the average (2 days x 2000 kcal / 7 days
  // = ~571 kcal/day instead of the true 2000 kcal/day). Here we compute the equivalent
  // counter of days with real data - separately for meals (by distinct dates) and for health
  // metrics (one health_metrics row means one synced day).
  const mealDaysLogged = new Set(meals.map(m => m.date)).size;
  const nutritionDivisor = mealDaysLogged > 0 ? mealDaysLogged : numDays;
  const healthDaysLogged = sortedHealthMetrics.length;
  const activityDivisor = healthDaysLogged > 0 ? healthDaysLogged : numDays;

  const avgEatenCalories = Math.round(totalEatenCal / nutritionDivisor);
  const avgProtein = Math.round((totalProtein / nutritionDivisor) * 10) / 10;
  const avgCarbs = Math.round((totalCarbs / nutritionDivisor) * 10) / 10;
  const avgFat = Math.round((totalFat / nutritionDivisor) * 10) / 10;

  const avgSteps = Math.round(totalSteps / activityDivisor);
  const avgActiveCalories = Math.round(totalActiveCal / activityDivisor);
  const avgWaterMl = Math.round(totalWaterMl / activityDivisor);

  const avgSleepScore = sleepScoreCount > 0 ? Math.round(sleepScoreSum / sleepScoreCount) : null;
  const avgReadinessScore = readinessScoreCount > 0 ? Math.round(readinessScoreSum / readinessScoreCount) : null;
  const avgWeight = weightCount > 0 ? Math.round((weightSum / weightCount) * 10) / 10 : null;
  const avgFatRatio = fatRatioCount > 0 ? Math.round((fatRatioSum / fatRatioCount) * 10) / 10 : null;
  const avgMuscleMass = muscleMassCount > 0 ? Math.round((muscleMassSum / muscleMassCount) * 10) / 10 : null;
  const avgBpSystolic = bpCount > 0 ? Math.round(bpSystolicSum / bpCount) : null;
  const avgBpDiastolic = bpCount > 0 ? Math.round(bpDiastolicSum / bpCount) : null;
  const avgFiber = Math.round((totalFiber / nutritionDivisor) * 10) / 10;
  const avgSugar = Math.round((totalSugar / nutritionDivisor) * 10) / 10;
  const avgSodium = Math.round(totalSodium / nutritionDivisor);

  const weightChange = (firstWeight !== null && lastWeight !== null) ? Math.round((lastWeight - firstWeight) * 10) / 10 : null;
  const fatRatioChange = (firstFatRatio !== null && lastFatRatio !== null) ? Math.round((lastFatRatio - firstFatRatio) * 10) / 10 : null;
  const muscleMassChange = (firstMuscleMass !== null && lastMuscleMass !== null) ? Math.round((lastMuscleMass - firstMuscleMass) * 10) / 10 : null;

  return {
    avgEatenCalories, avgProtein, avgCarbs, avgFat,
    avgFiber, avgSugar, avgSodium,
    avgSteps, avgActiveCalories, avgWaterMl,
    avgSleepScore, avgReadinessScore, avgWeight, avgFatRatio, avgMuscleMass,
    avgBpSystolic, avgBpDiastolic, supplementsLogged,
    workoutsCount, weightChange, fatRatioChange, muscleMassChange,
  // Raw totals for the whole window (7 or 30 days) - needed where the report compares a
  // period total against a period target (a weekly target being the daily target x 7)
  // rather than a daily average against a daily target (see statRows in
  // sendWeeklySummaryForUser - the target should be per week, not per day).
    totalEatenCalories: Math.round(totalEatenCal),
    totalProteinG: Math.round(totalProtein * 10) / 10,
    totalCarbsG: Math.round(totalCarbs * 10) / 10,
    totalFatG: Math.round(totalFat * 10) / 10
  };
}

// AI invocation with unified API key, fallback and error handling
async function generateAiSummaryText({ userId, user, prompt, shouldGenerate, fallbackMessage, errorLogLabel, errorMessagePrefix }) {
  let result = fallbackMessage;
  const apiKeyRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_api_key'", [userId]);
  const userApiKey = apiKeyRow ? decrypt(apiKeyRow.value) : null;

  if ((genAI || userApiKey || process.env.GEMINI_API_KEY) && shouldGenerate) {
    try {
      const forceCustomKeyOnly = user.role !== 'admin';
      result = await generateContentWithFallback(prompt, false, null, userApiKey, forceCustomKeyOnly);
    } catch (err) {
      console.error(errorLogLabel, err);
      result = errorMessagePrefix + err.message;
    }
  }
  return result;
}

// Converts Gemini's markdown into HTML (identical logic used by all three reports).
// Line by line - handles headings (## / ###), bullet lists ('- ' / '* ') and
// the previous replacement did not close <ul> and did not understand headings, so the new
// structured AI response - '## Analysis' / '## Recommendations' in bullets - rendered flat.
// We escape the HTML first (the text is LLM-generated), just as renderAdviceMarkdown does on the frontend.
function markdownToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = escaped.split('\n');
  let html = '';
  let listOpen = false;
  const closeList = () => {
    if (listOpen) { html += '</ul>'; listOpen = false; }
  };
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    const headingMatch = line.match(/^#{2,3}\s+(.*)/);
    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    if (headingMatch) {
      closeList();
      html += `<h3 style="color:#a78bfa;font-size:1rem;margin:16px 0 8px;">${headingMatch[1]}</h3>`;
    } else if (bulletMatch) {
      if (!listOpen) { html += '<ul style="margin:0 0 12px 0;padding-left:20px;">'; listOpen = true; }
      html += `<li style="margin-bottom:4px;">${bulletMatch[1]}</li>`;
    } else {
      closeList();
      html += line === '' ? '<br/>' : `<p style="margin:0 0 10px 0;">${line}</p>`;
    }
  });
  closeList();
  return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Shared CSS for all summary emails
const EMAIL_STYLE = `
  body {
    font-family: Arial, sans-serif;
    background-color: #0f172a;
    color: #f8fafc;
    margin: 0;
    padding: 20px;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
    padding: 30px;
  }
  h2 {
    color: #a78bfa;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }
  .logo {
    font-size: 2.5rem;
    margin-bottom: 10px;
  }
  .title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #38bdf8;
    margin: 0;
  }
  .section-title {
    font-size: 1.1rem;
    color: #c084fc;
    border-bottom: 1px solid rgba(192, 132, 252, 0.2);
    padding-bottom: 6px;
    margin-top: 24px;
    margin-bottom: 16px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }
  th, td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    color: #f8fafc;
  }
  th {
    color: #94a3b8;
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
  }
  td {
    font-size: 0.95rem;
  }
  .ai-box {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 20px;
    line-height: 1.6;
    font-size: 0.95rem;
    color: #e2e8f0;
  }
  .footer {
    text-align: center;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.8rem;
    color: #64748b;
  }
`;

// Shared HTML email template generator (title, subtitle, statistics table, AI section)
function buildSummaryEmailHtml({ title, headerSubtitleHtml, statsSectionTitle, valueColumnLabel, statRows, aiHtml }) {
  const rowsHtml = statRows.map(r => `
            <tr>
              <td>${r.label}</td>
              <td><strong>${r.value}</strong></td>
              <td>${r.target !== undefined ? r.target : '-'}</td>
            </tr>`).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <style>${EMAIL_STYLE}</style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🥗</div>
          <h1 class="title">${title}</h1>
          <p style="color: #94a3b8; margin: 5px 0 0 0;">${headerSubtitleHtml}</p>
        </div>

        <div class="section-title">📊 ${statsSectionTitle}</div>
        <table>
          <thead>
            <tr>
              <th>Parametr</th>
              <th>${valueColumnLabel}</th>
              <th>Cel</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}
          </tbody>
        </table>

        <div class="section-title">✨ Analiza i Wskazówki Dietetyka AI</div>
        <div class="ai-box">
          ${aiHtml}
        </div>

        <div class="footer">
          Wiadomość wygenerowana automatycznie przez aplikację Dietetyk AI.<br/>
          Dąż do swoich celów każdego dnia! 💪
        </div>
      </div>
    </body>
    </html>
  `;
}

// ===== Raport tygodniowy =====
async function sendWeeklySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl, targetWeightKg } = await getUserSettings(userId);

  // Fetching the data from the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Only the columns actually used by aggregateNutritionAndHealth below (numeric sums and
    // averages) - SELECT * pulled in image_base64 (potentially several MB per meal) and the
    // full analysis_json unnecessarily, even though the weekly report never shows photos or
    // the full per-meal AI analysis.
  const meals = await db.all(`
    SELECT calories, protein, carbs, fat, fiber, sugar, sodium FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, sevenDaysAgo]);

  const numDays = 7;
  const stats = await aggregateNutritionAndHealth(meals, healthMetrics, numDays, userId, sevenDaysAgo);
  const avgTotalBurned = bmr + stats.avgActiveCalories;
  const avgNetCalories = stats.avgEatenCalories - avgTotalBurned;

    // ===== Divergence between the physique/weight goal and the actual rate. Wired into the
    // existing weekly email because that is the least invasive place: the user receives it
    // once a week anyway, so there is no need for a separate email and scheduler at the same
    // frequency.
  const bodyGoalRow = await db.get(`SELECT body_goal_text FROM users WHERE id = ?`, [userId]);
  const bodyGoalText = bodyGoalRow && bodyGoalRow.body_goal_text ? bodyGoalRow.body_goal_text : null;

    // Current weight = the most recent measurement overall, not only from this week, because
    // the user may not have synced their weight in the last 7 days.
  const latestWeightRow = await db.get(
    `SELECT weight FROM health_metrics WHERE user_id = ? AND weight IS NOT NULL ORDER BY date DESC LIMIT 1`,
    [userId]
  );
  const currentWeight = latestWeightRow ? latestWeightRow.weight : null;

    // stats.weightChange (first minus last measurement in the 7-day window) comes out as an
    // artificial 0 (stagnation) when there is only ONE measurement in the week, which would
    // be misleading for judging the rate - so we require at least 2, or skip the judgement.
  const weightCountThisWeek = healthMetrics.filter(h => h.weight !== null && h.weight !== undefined).length;
  const weeklyWeightChange = weightCountThisWeek >= 2 ? stats.weightChange : null;

  const goalPaceAnalysis = buildGoalPaceAnalysis(targetWeightKg, currentWeight, weeklyWeightChange);

  const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [userId]);
  const language = langRow ? langRow.value : 'pl';

  let advicePrompt = '';
  if (language === 'en') {
    advicePrompt = `
You are a professional AI sports dietician working in the "Dietetyk AI" app.
Analyze the weekly nutrition and training report for user ${user.first_name || user.username}, addressing them by name:
Daily goals:
- Calorie target: ${targetCalories} kcal
- Macronutrients: P:${targetProtein}g, C:${targetCarbs}g, F:${targetFat}g
- BMR: ${bmr} kcal

Weekly stats (daily averages):
- Average daily energy intake: ${stats.avgEatenCalories} kcal (Protein: ${stats.avgProtein}g, Carbs: ${stats.avgCarbs}g, Fat: ${stats.avgFat}g, Fiber: ${stats.avgFiber}g, Sugar: ${stats.avgSugar}g, Sodium: ${stats.avgSodium}mg)
- Average physical activity (active calories): ${stats.avgActiveCalories} kcal
- Average total daily burn: ${avgTotalBurned} kcal
- Average daily net balance: ${avgNetCalories} kcal
- Average daily steps: ${stats.avgSteps}
- Average daily hydration: ${stats.avgWaterMl}ml (target: ${targetWaterMl}ml)
- Supplements recorded this week: ${stats.supplementsLogged.length > 0 ? stats.supplementsLogged.join('; ') : 'none'}
${goalPaceAnalysis ? `
Body goal and pace discrepancy:
- Described body goal: ${bodyGoalText || 'no description'}
- Target weight: ${goalPaceAnalysis.targetWeightKg} kg, current weight: ${goalPaceAnalysis.currentWeight} kg (difference: ${Math.abs(goalPaceAnalysis.remainingKg)} kg ${goalPaceAnalysis.remainingKg > 0 ? 'to lose' : 'to gain'})
- Weight change this week: ${goalPaceAnalysis.weeklyWeightChange > 0 ? '+' : ''}${goalPaceAnalysis.weeklyWeightChange} kg
- Pace status: ${
    goalPaceAnalysis.status === 'reached' ? 'target weight reached (within tolerance)'
    : goalPaceAnalysis.status === 'wrong_direction' ? 'WARNING: weight this week changed in the OPPOSITE direction of the goal'
    : goalPaceAnalysis.status === 'stalled' ? 'weight this week did not change (stalled relative to goal)'
    : `pace aligned with goal, estimated weeks to goal at this pace: ~${goalPaceAnalysis.weeksToGoal} weeks`
  }` : ''}

Oura & Withings data (weekly averages):
- Average sleep score: ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'none'}
- Average readiness score: ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'none'}
- Average weight: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'none'}
- Average body fat percentage: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'none'}
- Average muscle mass: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'none'}
- Average blood pressure: ${stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'no data'}

Write a professional, concise, and motivating weekly report in English, analyzing all the data provided above. Consider:
1. Energy balance (adhering to targets).
2. Macronutrient and micronutrient coverage (fiber, sugars, sodium) - with specific dietary modifications, e.g., when and how to add protein for muscle recovery, how to balance macros, or how to reduce sodium/sugar.
3. Workout summary and cardio zones estimated from active calories, RHR, and HRV.
4. Recovery, body composition changes, and blood pressure.
5. Hydration and its effect.
6. Supplements consistency.
7. Goal-pace discrepancy.

Format the response strictly in Markdown: short introductory sentence, header "## Analysis" (concise paragraphs summarizing the week), header "## Recommendations" with a bullet list (3 specific points for the upcoming week, each starting with "- "). Use **bolding** for key numbers and phrases. Address the user directly.
`;
  } else {
    advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj tygodniowy raport żywieniowo-treningowy użytkownika ${user.first_name || user.username}, zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Tygodniowe statystyki (średnie dzienne):
- Średnie dzienne spożycie energii: ${stats.avgEatenCalories} kcal (Białko: ${stats.avgProtein}g, Węglowodany: ${stats.avgCarbs}g, Tłuszcz: ${stats.avgFat}g, Błonnik: ${stats.avgFiber}g, Cukry: ${stats.avgSugar}g, Sód: ${stats.avgSodium}mg)
- Średnia aktywność fizyczna (aktywne kalorie): ${stats.avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${stats.avgSteps}
- Średnie dobowe nawodnienie: ${stats.avgWaterMl}ml (cel: ${targetWaterMl}ml)
- Suplementy zapisane w tym tygodniu: ${stats.supplementsLogged.length > 0 ? stats.supplementsLogged.join('; ') : 'brak zapisanych suplementów'}
${goalPaceAnalysis ? `
Cel sylwetki i rozbieżność tempa:
- Opisany cel sylwetki użytkownika: ${bodyGoalText || 'brak opisu słownego'}
- Liczbowy cel wagi: ${goalPaceAnalysis.targetWeightKg} kg, aktualna waga: ${goalPaceAnalysis.currentWeight} kg (różnica do celu: ${Math.abs(goalPaceAnalysis.remainingKg)} kg ${goalPaceAnalysis.remainingKg > 0 ? 'do zrzucenia' : 'do przybrania'})
- Zmiana wagi w tym tygodniu: ${goalPaceAnalysis.weeklyWeightChange > 0 ? '+' : ''}${goalPaceAnalysis.weeklyWeightChange} kg
- Status tempa względem celu: ${
    goalPaceAnalysis.status === 'reached' ? 'cel wagowy osiągnięty (w granicach tolerancji)'
    : goalPaceAnalysis.status === 'wrong_direction' ? 'UWAGA: waga w tym tygodniu zmieniała się w kierunku PRZECIWNYM do celu'
    : goalPaceAnalysis.status === 'stalled' ? 'waga w tym tygodniu się nie zmieniła (stagnacja względem celu)'
    : `tempo zgodne z kierunkiem celu, szacowany czas do celu przy tym tempie: ~${goalPaceAnalysis.weeksToGoal} tyg.`
  }` : ''}

Dane z Oura & Withings (średnie tygodniowe):
- Średni wynik snu (Sleep Score): ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'brak'}
- Średni procent tłuszczu: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'brak'}
- Średnia masa mięśniowa: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'brak'}
- Średnie ciśnienie tętnicze: ${stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'brak danych'}

Napisz profesjonalny, zwięzły i motywujący tygodniowy raport w języku polskim, analizując wszystkie dane podane powyżej. Weź pod uwagę:
1. Bilans energetyczny (trzymanie celów).
2. Pokrycie makroskładników i mikroelementów (błonnik, cukry, sód) - ze szczególnym naciskiem na modyfikacje i sugestie dietetyczne, np. kiedy i jak dorzucić więcej białka w celu odbudowy mięśni, jak zbilansować pozostałe makro, lub jak ograniczyć nadmiar sodu/cukrów prostych.
3. Podsumowanie aktywności treningowej, w tym szacunkowe strefy kardio po treningu (strefa spalania tłuszczu vs. wysoka intensywność tlenowa/beztlenowa) oszacowane na podstawie spalonych aktywnych kalorii oraz wskaźników tętna spoczynkowego (RHR) i HRV z Oura.
4. Regenerację i zmiany w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej) oraz ciśnienie tętnicze, jeśli dostępne.
5. Poziom nawodnienia względem celu i jego wpływ na regenerację i wydolność.
6. Suplementy: jeśli użytkownik zapisał suplementy w tym tygodniu, skomentuj krótko ich regularność i przydatność.
7. Rozbieżność cel-tempo: jeśli powyżej podano status tempa względem celu wagi, odnieś się do niego wprost - czy obecne tempo realnie prowadzi do celu (i w jakim horyzoncie czasowym), czy kierunek jest odwrotny od celu, czy waga stoi w miejscu - i w każdym z tych przypadków zaproponuj konkretną korektę diety/treningu. Jeśli ta sekcja nie została podana (brak ustawionego celu wagi lub za mało pomiarów), pomiń ten punkt bez wzmianki o jego braku.

Sformatuj odpowiedź w strukturze Markdown: krótkie zdanie wstępu, nagłówek "## Analiza" (zwięzłe akapity podsumowujące tydzień na bazie powyższych punktów), nagłówek "## Rekomendacje" z listą punktowaną (3 konkretne punkty na nadchodzący tydzień, każdy zaczynający się od "- "). Używaj **pogrubienia** dla kluczowych liczb i fraz. Pisz bezpośrednio do użytkownika.
`;
  }

  const aiSummary = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || stats.avgActiveCalories > 0 || stats.avgSleepScore !== null,
    fallbackMessage: "Tygodniowy raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!",
    errorLogLabel: '[API ERROR] Błąd generowania raportu tygodniowego AI:',
    errorMessagePrefix: 'Błąd podczas generowania podsumowania tygodniowego przez AI: '
  });

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Tygodniowe',
    headerSubtitleHtml: `Raport dla użytkownika <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki Tygodniowe',
    valueColumnLabel: 'Tydzień',
    statRows: [
    // Calories and macros: the WEEKLY TOTAL against the WEEKLY target (daily x 7). This used
    // to compare the daily average (stats.avgX) against the daily target, which with
    // irregular meal logging (mealDaysLogged < 7) could produce misleadingly high 'averages'
    // measured against a daily target. Steps, calories burned and water stay as daily
    // averages, because those are metrics the user genuinely syncs and tracks day by day
    // rather than weekly.
      { label: 'Kalorie Spożyte (tydzień)', value: `${stats.totalEatenCalories} kcal`, target: `${targetCalories * 7} kcal` },
      { label: 'Białko (tydzień)', value: `${stats.totalProteinG}g`, target: `${targetProtein * 7}g` },
      { label: 'Węglowodany (tydzień)', value: `${stats.totalCarbsG}g`, target: `${targetCarbs * 7}g` },
      { label: 'Tłuszcz (tydzień)', value: `${stats.totalFatG}g`, target: `${targetFat * 7}g` },
      { label: 'Kroki (śr. dobowa)', value: stats.avgSteps },
      { label: 'Kalorie Spalone (śr. dobowa, Aktywne)', value: `${stats.avgActiveCalories} kcal` },
      { label: 'Treningi w tygodniu', value: stats.workoutsCount },
      { label: 'Woda (śr. dobowa)', value: `${stats.avgWaterMl}ml`, target: `${targetWaterMl}ml` },
    // The weight-goal row is shown only when there is enough data to compute the rate (see
    // buildGoalPaceAnalysis above) - otherwise the table would imply a judgement of pace
    // made without sufficient data.
      ...(goalPaceAnalysis ? [{
        label: 'Zmiana wagi (tydzień)',
        value: `${goalPaceAnalysis.weeklyWeightChange > 0 ? '+' : ''}${goalPaceAnalysis.weeklyWeightChange} kg`,
        target: `cel: ${goalPaceAnalysis.targetWeightKg} kg`
      }] : [])
    ],
    aiHtml: markdownToHtml(aiSummary)
  });

  console.log(`[MAILGUN] Sending the weekly summary to ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Tygodniowe Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// ===== Raport codzienny =====
async function sendDailySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl } = await getUserSettings(userId);

  const date = getLocalDateString();

    // Today's meals. Only the columns needed for the list in the email (raw_text plus the
    // numeric values) - no image_base64 or full analysis_json, which are never displayed here
    // (see advicePrompt below - name and macros only).
  const mealRows = await db.all(`SELECT id, raw_text, calories, protein, carbs, fat FROM meals WHERE user_id = ? AND date = ?`, [userId, date]);
  let totalEaten = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const meals = mealRows.map(r => {
    totalEaten.calories += r.calories;
    totalEaten.protein += r.protein;
    totalEaten.carbs += r.carbs;
    totalEaten.fat += r.fat;
    // NOTE: this row used to overwrite calories/protein/carbs/fat with the raw, unsanitised
    // analysis_json (the same class of bug as in meals.js/dashboard.js, overlooked here at
    // the time) - so the meal list in the daily email could show different values from the
    // totals summed in totalEaten above. Now that the query no longer pulls analysis_json,
    // this row simply returns the sanitised columns.
    return { id: r.id, raw_text: r.raw_text, calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat };
  });

  totalEaten.protein = Math.round(totalEaten.protein * 10) / 10;
  totalEaten.carbs = Math.round(totalEaten.carbs * 10) / 10;
  totalEaten.fat = Math.round(totalEaten.fat * 10) / 10;

    // Today's health data. The fallback used when no health_metrics row exists for a day used
    // to be a third, unsynchronised copy of the default object - alongside dashboard.js and
    // chat.js, which had long since moved to the shared getDefaultHealthMetrics(). That copy
    // lacked respiratory_rate, spo2_percentage and blood pressure, which is easy to overlook
    // when extending the report with new metrics later.
  const health = await db.get(`SELECT * FROM health_metrics WHERE user_id = ? AND date = ?`, [userId, date]) || getDefaultHealthMetrics();

  const activeCalories = health.active_calories || 0;
  const totalBurned = health.total_calories_burned || (bmr + activeCalories);
  const netCalories = totalEaten.calories - totalBurned;

  const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [userId]);
  const language = langRow ? langRow.value : 'pl';

    // Current weather and time of day (the model should know and account for both - see
    // utils/weatherContext.js), fetched automatically from Open-Meteo with nothing for the
    // user to enter.
    // Location: the user's own (Settings -> Location) when set, otherwise the deployment's
    // default location.
  const userLocation = await getUserLocationOverride(userId);
  const weatherTimeContext = await getWeatherAndTimeContext(language, userLocation?.lat, userLocation?.lon);

  let advicePrompt = '';
  if (language === 'en') {
    advicePrompt = `
You are a professional, friendly AI sports dietician working in the "Dietetyk AI" app.
Analyze today's balance for user ${user.first_name || user.username} for date ${date}, addressing them by name:
User Goals:
- Calorie target: ${targetCalories} kcal
- Protein target: ${targetProtein}g, Carbs target: ${targetCarbs}g, Fat target: ${targetFat}g
- BMR: ${bmr} kcal

Today's Balance:
- Total eaten: ${totalEaten.calories} kcal (Protein: ${totalEaten.protein}g, Carbs: ${totalEaten.carbs}g, Fat: ${totalEaten.fat}g)
- Active calories burned: ${activeCalories} kcal
- Total calories burned (BMR + Active): ${totalBurned} kcal
- Net balance (eaten - burned): ${netCalories} kcal
- Steps today: ${health.steps || 0}
- Water intake today: ${health.water_ml || 0}ml (target: ${targetWaterMl}ml)

Current time and weather (context, not a user-logged metric):
${weatherTimeContext}

Oura Sleep/Readiness & Withings Body Composition:
- Sleep Score: ${health.sleep_score !== null ? health.sleep_score + '/100' : 'no data'} (Duration: ${health.sleep_duration || 0}h, Deep: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Heart & Temp parameters: Resting HR: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms, Body temp deviation: ${health.temperature_deviation !== null ? health.temperature_deviation + ' °C' : 'none'}
- Readiness Score: ${health.readiness_score !== null ? health.readiness_score + '/100' : 'no data'}
- Body Composition: Weight: ${health.weight !== null ? health.weight + ' kg' : 'no data'}, Body fat percentage: ${health.fat_ratio !== null ? health.fat_ratio + '%' : 'no data'}, Muscle mass: ${health.muscle_mass !== null ? health.muscle_mass + ' kg' : 'no data'}
- Blood Pressure: ${health.blood_pressure_systolic !== null && health.blood_pressure_systolic !== undefined ? health.blood_pressure_systolic + '/' + health.blood_pressure_diastolic + ' mmHg' : 'no data'}

Today's meals list:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fat}g)`).join('\n') || 'No meals logged'}

Your analysis must consider all the data provided above. Consider:
1. Exercise intensity and cardio zones after training based on active calories and heart parameters (RHR, HRV).
2. Precise dietary changes based on today's meals and workouts.
3. Oura readiness and Withings weight/muscle/fat trends.

Format the response strictly in Markdown: one short introductory sentence, header "## Analysis" (2-3 sentences), header "## Recommendations" with a bullet list (2-3 points, each starting with "- "). Use **bolding** for key numbers and phrases. Write directly to the user in English.
`;
  } else {
    advicePrompt = `
Jesteś profesjonalnym, przyjaznym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj dzisiejszy bilans użytkownika ${user.first_name || user.username} dla dnia ${date}, zwracając się do niego po imieniu:
Cele użytkownika:
- Cel kaloryczny spożycia: ${targetCalories} kcal
- Cel Białka: ${targetProtein}g, Węglowodanych: ${targetCarbs}g, Tłuszczu: ${targetFat}g
- BMR (Podstawowa Przemiana Materii): ${bmr} kcal

Aktualny bilans dzisiejszy:
- Łącznie zjedzone: ${totalEaten.calories} kcal (Białko: ${totalEaten.protein}g, Węgle: ${totalEaten.carbs}g, Tłuszcz: ${totalEaten.fat}g)
- Aktywne kalorie spalone: ${activeCalories} kcal
- Łącznie spalone kalorie (BMR + Aktywne): ${totalBurned} kcal
- Bilans netto (zjedzone - spalone): ${netCalories} kcal
- Wykonane kroki dzisiaj: ${health.steps || 0}
- Wypita woda dzisiaj: ${health.water_ml || 0}ml (cel: ${targetWaterMl}ml)

Aktualny czas i pogoda (kontekst, nie metryka zapisana przez użytkownika):
${weatherTimeContext}

Dane gotowości, snu (Oura) i składu ciała (Withings):
- Wynik Snu: ${health.sleep_score !== null ? health.sleep_score + '/100' : 'Brak danych'} (Czas trwania: ${health.sleep_duration || 0}h, Głęboki: ${health.sleep_deep || 0}h, REM: ${health.sleep_rem || 0}h)
- Parametry serca i temp: Tętno spoczynkowe: ${health.rhr || '-'} bpm, HRV: ${health.hrv || '-'} ms, Odchylenie temperatury ciała: ${health.temperature_deviation !== null ? health.temperature_deviation + ' °C' : 'brak'}
- Wynik Gotowości (Readiness): ${health.readiness_score !== null ? health.readiness_score + '/100' : 'Brak danych'}
- Skład Ciała: Waga: ${health.weight !== null ? health.weight + ' kg' : 'brak danych'}, Procent tłuszczu: ${health.fat_ratio !== null ? health.fat_ratio + '%' : 'brak danych'}, Masa mięśniowa: ${health.muscle_mass !== null ? health.muscle_mass + ' kg' : 'brak danych'}
- Ciśnienie tętnicze: ${health.blood_pressure_systolic !== null && health.blood_pressure_systolic !== undefined ? health.blood_pressure_systolic + '/' + health.blood_pressure_diastolic + ' mmHg' : 'brak danych'}

Lista dzisiejszych posiłków:
${meals.map(m => `- ${m.raw_text} (${m.calories} kcal, B:${m.protein}g, W:${m.carbs}g, T:${m.fat}g)`).join('\n') || 'Brak wprowadzonych posiłków'}

Twoja analiza ma uwzględniać wszystkie dane podane powyżej (dzisiejsze posiłki i wartości, gotowość Oura, skład ciała Withings) - to kluczowa funkcja tej aplikacji. Weź pod uwagę przy analizie i rekomendacjach:
1. Intensywność wysiłku i strefy kardio po treningu na bazie aktywnych kalorii oraz parametrów serca (RHR, HRV) - oceń, czy trening sprzyjał tlenowemu spalaniu tłuszczu (strefa spalania tłuszczu, niska intensywność) czy wszedł w wyższe strefy beztlenowe/kardio.
2. Precyzyjne zmiany w diecie na bazie dzisiejszych posiłków i treningu (np. zalecenie dorzucenia większej ilości białka w celu wsparcia regeneracji włókien mięśniowych po ciężkim wysiłku beztlenowym lub redukcji węglowodanów w dni o niskim wysiłku aerobowym).
3. Gotowość Oura i trendy wagi/mięśni/tłuszczu z Withings.

Sformatuj odpowiedź w strukturze Markdown: jedno krótkie zdanie wstępu, nagłówek "## Analiza" (2-3 zdania), nagłówek "## Rekomendacje" z listą punktowaną (2-3 punkty, każdy zaczynający się od "- "). Używaj **pogrubienia** dla kluczowych liczb i fraz. Pisz bezpośrednio do użytkownika w języku polskim. Bądź konkretny, motywujący i merytoryczny, bez lania wody.
`;
  }

  let aiAdvice = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || activeCalories > 0 || health.sleep_score !== null,
    fallbackMessage: "Zmień swoje integracje w profilu i dodaj dzisiejsze posiłki, aby otrzymać wskazówki od AI.",
    errorLogLabel: '[API ERROR] Błąd generowania porady AI do maila:',
    errorMessagePrefix: 'Błąd generowania analizy AI.'
  });
  aiAdvice = aiAdvice.trim();

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Codzienne',
    headerSubtitleHtml: `Raport z dnia <strong>${date}</strong> dla <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki Dzisiejsze',
    valueColumnLabel: 'Dzisiaj',
    statRows: [
      { label: 'Kalorie Spożyte', value: `${totalEaten.calories} kcal`, target: `${targetCalories} kcal` },
      { label: 'Białko', value: `${totalEaten.protein}g`, target: `${targetProtein}g` },
      { label: 'Węglowodany', value: `${totalEaten.carbs}g`, target: `${targetCarbs}g` },
      { label: 'Tłuszcz', value: `${totalEaten.fat}g`, target: `${targetFat}g` },
      { label: 'Kroki', value: health.steps || 0 },
      { label: 'Kalorie Spalone (Aktywne)', value: `${activeCalories} kcal` },
      { label: 'Waga ciała', value: health.weight !== null ? health.weight + ' kg' : 'brak' },
      { label: 'Woda', value: `${health.water_ml || 0}ml`, target: `${targetWaterMl}ml` }
    ],
    aiHtml: markdownToHtml(aiAdvice)
  });

  console.log(`[MAILGUN] Sending the daily summary to ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Codzienne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

// ===== Monthly report (mirrors the weekly one, over a 30-day window) =====
async function sendMonthlySummaryForUser(userId, customEmail = null) {
  const { user, emailToUse } = await getUserAndEmail(userId, customEmail);
  const { targetCalories, targetProtein, targetCarbs, targetFat, bmr, targetWaterMl } = await getUserSettings(userId);

  // Fetching the data from the last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // See the comment in sendWeeklySummaryForUser - only the numeric columns needed for the
    // aggregation, without image_base64 or analysis_json (the monthly report shows individual
    // meal photos even less than the weekly one).
  const meals = await db.all(`
    SELECT calories, protein, carbs, fat, fiber, sugar, sodium FROM meals WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const healthMetrics = await db.all(`
    SELECT * FROM health_metrics WHERE user_id = ? AND date >= ?
  `, [userId, thirtyDaysAgo]);

  const numDays = 30;
  const stats = await aggregateNutritionAndHealth(meals, healthMetrics, numDays, userId, thirtyDaysAgo);
  const avgTotalBurned = bmr + stats.avgActiveCalories;
  const avgNetCalories = stats.avgEatenCalories - avgTotalBurned;

  const langRow = await db.get("SELECT value FROM settings WHERE user_id = ? AND key = 'language'", [userId]);
  const language = langRow ? langRow.value : 'pl';

  let advicePrompt = '';
  if (language === 'en') {
    advicePrompt = `
You are a professional AI sports dietician working in the "Dietetyk AI" app.
Analyze the monthly nutrition and training report for user ${user.first_name || user.username} (last 30 days), addressing them by name:
Daily goals:
- Calorie target: ${targetCalories} kcal
- Macronutrients: P:${targetProtein}g, C:${targetCarbs}g, F:${targetFat}g
- BMR: ${bmr} kcal

Monthly stats (daily averages from last 30 days):
- Average daily energy intake: ${stats.avgEatenCalories} kcal (Protein: ${stats.avgProtein}g, Carbs: ${stats.avgCarbs}g, Fat: ${stats.avgFat}g, Fiber: ${stats.avgFiber}g, Sugar: ${stats.avgSugar}g, Sodium: ${stats.avgSodium}mg)
- Average physical activity (active calories): ${stats.avgActiveCalories} kcal
- Average total daily burn: ${avgTotalBurned} kcal
- Average daily net balance: ${avgNetCalories} kcal
- Average daily steps: ${stats.avgSteps}
- Workout days in the month: ${stats.workoutsCount}
- Average daily hydration: ${stats.avgWaterMl}ml (target: ${targetWaterMl}ml)
- Supplements recorded this month: ${stats.supplementsLogged.length > 0 ? stats.supplementsLogged.length + ' entries - ' + stats.supplementsLogged.slice(0, 10).join('; ') : 'none'}

Oura & Withings data (monthly averages and change trend from start to end):
- Average sleep score: ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'none'}
- Average readiness score: ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'none'}
- Average weight: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'none'} (change: ${stats.weightChange !== null ? (stats.weightChange > 0 ? '+' : '') + stats.weightChange + ' kg' : 'no data'})
- Average body fat percentage: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'none'} (change: ${stats.fatRatioChange !== null ? (stats.fatRatioChange > 0 ? '+' : '') + stats.fatRatioChange + ' pp' : 'no data'})
- Average muscle mass: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'none'} (change: ${stats.muscleMassChange !== null ? (stats.muscleMassChange > 0 ? '+' : '') + stats.muscleMassChange + ' kg' : 'no data'})
- Average blood pressure: ${stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'no data'}

Write a professional, concise, and motivating monthly report in English, analyzing all the data provided above. Consider:
1. Overall monthly trend of energy balance (adhering to targets, consistency), including quality of diet (fiber, sugars, sodium).
2. Long-term changes in body composition from Withings (muscle mass gain vs. fat loss over the month) and blood pressure trends.
3. Consistency in workouts, recovery, and supplementation.
4. Hydration status and its impact.

Format the response strictly in Markdown: short introductory sentence, header "## Analysis" (concise paragraphs summarizing the month), header "## Recommendations" with a bullet list (3 specific, long-term points for the upcoming month, each starting with "- "). Use **bolding** for key numbers and phrases. Address the user directly.
`;
  } else {
    advicePrompt = `
Jesteś profesjonalnym dietetykiem sportowym AI pracującym w aplikacji "Dietetyk AI".
Przeanalizuj miesięczny raport żywieniowo-treningowy użytkownika ${user.first_name || user.username} (ostatnie 30 dni), zwracając się do niego po imieniu:
Cele dobowe:
- Cel kaloryczny: ${targetCalories} kcal
- Makroskładniki: B:${targetProtein}g, W:${targetCarbs}g, T:${targetFat}g
- BMR: ${bmr} kcal

Miesięczne statystyki (średnie dzienne z ostatnich 30 dni):
- Średnie dzienne spożycie energii: ${stats.avgEatenCalories} kcal (Białko: ${stats.avgProtein}g, Węglowodany: ${stats.avgCarbs}g, Tłuszcz: ${stats.avgFat}g, Błonnik: ${stats.avgFiber}g, Cukry: ${stats.avgSugar}g, Sód: ${stats.avgSodium}mg)
- Średnia aktywność fizyczna (aktywne kalorie): ${stats.avgActiveCalories} kcal
- Średnia całkowitego dziennego spalania: ${avgTotalBurned} kcal
- Średni dobowy bilans netto: ${avgNetCalories} kcal
- Średni dobowy kroki: ${stats.avgSteps}
- Liczba dni z treningiem w miesiącu: ${stats.workoutsCount}
- Średnie dobowe nawodnienie: ${stats.avgWaterMl}ml (cel: ${targetWaterMl}ml)
- Suplementy zapisane w tym miesiącu: ${stats.supplementsLogged.length > 0 ? stats.supplementsLogged.length + ' wpisów - ' + stats.supplementsLogged.slice(0, 10).join('; ') : 'brak zapisanych suplementów'}

Dane z Oura & Withings (średnie miesięczne i zmiana trendu od początku do końca okresu):
- Średni wynik snu (Sleep Score): ${stats.avgSleepScore !== null ? stats.avgSleepScore + '/100' : 'brak'}
- Średni wynik gotowości (Readiness Score): ${stats.avgReadinessScore !== null ? stats.avgReadinessScore + '/100' : 'brak'}
- Średnia waga ciała: ${stats.avgWeight !== null ? stats.avgWeight + ' kg' : 'brak'} (zmiana w miesiącu: ${stats.weightChange !== null ? (stats.weightChange > 0 ? '+' : '') + stats.weightChange + ' kg' : 'brak danych'})
- Średni procent tłuszczu: ${stats.avgFatRatio !== null ? stats.avgFatRatio + '%' : 'brak'} (zmiana w miesiącu: ${stats.fatRatioChange !== null ? (stats.fatRatioChange > 0 ? '+' : '') + stats.fatRatioChange + ' pp' : 'brak danych'})
- Średnia masa mięśniowa: ${stats.avgMuscleMass !== null ? stats.avgMuscleMass + ' kg' : 'brak'} (zmiana w miesiącu: ${stats.muscleMassChange !== null ? (stats.muscleMassChange > 0 ? '+' : '') + stats.muscleMassChange + ' kg' : 'brak danych'})
- Średnie ciśnienie tętnicze w miesiącu: ${stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'brak danych'}

Napisz profesjonalny, zwięzły i motywujący miesięczny raport w języku polskim, analizując wszystkie dane podane powyżej. Weź pod uwagę:
1. Ogólny trend bilansu energetycznego w skali miesiąca (utrzymanie celów, konsekwencja), w tym jakość diety pod kątem błonnika, cukrów i sodu.
2. Długoterminowe zmiany w składzie ciała z Withings (przyrost masy mięśniowej vs spadek tkanki tłuszczowej w skali miesiąca) oraz trend ciśnienia tętniczego, jeśli dostępny - odnieś się konkretnie do zmiany wagi/tłuszczu/mięśni/ciśnienia podanej powyżej.
3. Konsekwencję w treningach, regeneracji (gotowość Oura) i suplementacji na przestrzeni miesiąca.
4. Poziom nawodnienia względem celu w skali miesiąca i jego wpływ na regenerację.

Sformatuj odpowiedź w strukturze Markdown: krótkie zdanie wstępu, nagłówek "## Analiza" (zwięzłe akapity podsumowujące miesiąc na bazie powyższych punktów), nagłówek "## Rekomendacje" z listą punktowaną (3 konkretne, długoterminowe punkty na nadchodzący miesiąc, każdy zaczynający się od "- "). Używaj **pogrubienia** dla kluczowych liczb i fraz. Pisz bezpośrednio do użytkownika.
`;
  }

  const aiSummary = await generateAiSummaryText({
    userId, user, prompt: advicePrompt,
    shouldGenerate: meals.length > 0 || stats.avgActiveCalories > 0 || stats.avgSleepScore !== null,
    fallbackMessage: "Miesięczny raport dietetyczno-treningowy: brak wystarczających danych do pełnej analizy. Wprowadzaj posiłki i synchronizuj gotowości/kroki!",
    errorLogLabel: '[API ERROR] Błąd generowania raportu miesięcznego AI:',
    errorMessagePrefix: 'Błąd podczas generowania podsumowania miesięcznego przez AI: '
  });

  const emailHtml = buildSummaryEmailHtml({
    title: 'Dietetyk AI: Podsumowanie Miesięczne',
    headerSubtitleHtml: `Raport za ostatnie 30 dni dla użytkownika <strong>${user.username}</strong>`,
    statsSectionTitle: 'Twoje Statystyki (Średnia Dobowa, 30 dni)',
    valueColumnLabel: 'Średnia',
    statRows: [
      { label: 'Kalorie Spożyte', value: `${stats.avgEatenCalories} kcal`, target: `${targetCalories} kcal` },
      { label: 'Białko', value: `${stats.avgProtein}g`, target: `${targetProtein}g` },
      { label: 'Węglowodany', value: `${stats.avgCarbs}g`, target: `${targetCarbs}g` },
      { label: 'Tłuszcz', value: `${stats.avgFat}g`, target: `${targetFat}g` },
      { label: 'Kroki', value: stats.avgSteps },
      { label: 'Kalorie Spalone (Aktywne)', value: `${stats.avgActiveCalories} kcal` },
      { label: 'Treningi w miesiącu', value: stats.workoutsCount },
      { label: 'Woda', value: `${stats.avgWaterMl}ml`, target: `${targetWaterMl}ml` },
      { label: 'Zmiana wagi', value: stats.weightChange !== null ? (stats.weightChange > 0 ? '+' : '') + stats.weightChange + ' kg' : 'brak danych' },
      { label: 'Zmiana % tłuszczu', value: stats.fatRatioChange !== null ? (stats.fatRatioChange > 0 ? '+' : '') + stats.fatRatioChange + ' pp' : 'brak danych' },
      { label: 'Zmiana masy mięśniowej', value: stats.muscleMassChange !== null ? (stats.muscleMassChange > 0 ? '+' : '') + stats.muscleMassChange + ' kg' : 'brak danych' }
    ],
    aiHtml: markdownToHtml(aiSummary)
  });

  console.log(`[MAILGUN] Sending the monthly summary to ${emailToUse}`);
  await sendMailgunEmail({
    to: emailToUse,
    subject: `Dietetyk AI: Twoje Miesięczne Podsumowanie (${user.username})`,
    html: emailHtml
  });
}

module.exports = {
  sendWeeklySummaryForUser,
  sendDailySummaryForUser,
  sendMonthlySummaryForUser,
// Also exported as standalone helpers - used by services/pdfReport.js (the PDF export for a
// doctor or dietician) so the same statistics and settings aggregation logic is not
// duplicated.
  getUserSettings,
  aggregateNutritionAndHealth,
// Also used by routes/dashboard.js (/api/dashboard/weight-goal-forecast) - the same weight
// goal status and pace logic as the weekly email, surfaced there as a permanent dashboard
// card rather than only in periodic emails.
  buildGoalPaceAnalysis
};
