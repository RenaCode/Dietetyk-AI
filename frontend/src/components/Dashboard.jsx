import React, { useState, useEffect, useRef } from 'react';
import { getTemperatureStatus } from '../utils/health';
import { formatHoursMins } from '../utils/format';
import { t } from '../utils/i18n';
import { useInsights } from '../utils/useInsights';

// Insights are fetched with ONE batched request (/api/dashboard/insights).
// Previously each of them had its own useEffect and its own fetch - opening the
// dashboard meant about 50 parallel HTTP requests and just as many separate series
// of SQLite queries.
//
// Two cases are deliberately left out of this list:
//   - calorie-target-suggestion: it has an extra dependency (caloriesTrigger), because
//     it must refresh after clicking "Zastosuj", not only when the date changes;
//   - the day/history data (/api/dashboard, /api/health/history), which have their own
//     lifecycle and different dependencies.
// ai-explanation-insight and training-plan-insight ARE in the batch, but they also have
// an overlay that can override the result (polling for background generation / the
// "Odśwież" button) - see the comments next to them in the component.
//
// The constant is defined outside the component on purpose: useInsights reduces the list
// to a string as its dependency key, and a new array reference on every render would fire
// the fetch over and over.
const BATCHED_INSIGHT_IDS = [
  'energy-battery',
  'wellness-score',
  'activity-appetite-insight',
  'ai-explanation-insight',
  'body-proportions-insight',
  'body-recomposition-insight',
  'body-symmetry-insight',
  'bp-trend-insight',
  'calorie-balance',
  'diet-quality-weight-pace-insight',
  'early-strain-alert',
  'favorite-meal-drift-insight',
  'fiber-sleep-insight',
  'hr-polarization-insight',
  'hr-zones-insight',
  'hydration-readiness-insight',
  'meal-frequency-adherence-insight',
  'meal-quality-trend-insight',
  'meal-timing-sleep-insight',
  'muscle-protein-insight',
  'nutrition-comparison',
  'pace-trend-insight',
  'readiness-workout-insight',
  'recovery-insight',
  'rhr-drift-insight',
  'sedentary-performance-insight',
  'sedentary-sleep-insight',
  'self-benchmark-insight',
  'sleep-insight',
  'sleep-workout-performance-insight',
  'sodium-bp-insight',
  'spo2-trend-insight',
  'streak-drift-insight',
  'streak-weight-effect-insight',
  'stress-nutrition-insight',
  'supplements-sleep-insight',
  'temperature-divergence-insight',
  'training-plan-insight',
  'training-readiness',
  'water-sleep-insight',
  'weekend-effect-insight',
  'weight-goal-forecast',
  'whr-insight',
  'workout-efficiency-insight',
  'workout-recovery-hrv-insight',
  'workout-rest-performance-insight',
  'workout-type-sleep-insight',
  'workout-variety-insight'
];

// Colour of the energy battery bar and number. The thresholds match the labels returned
// by the backend ("Naładowana" / "Dobra" / "Niska" / "Na rezerwie"), so the colour and
// the word never say two different things.
const batteryColor = (value) => {
  if (value >= 75) return 'var(--success-light)';
  if (value >= 50) return '#4ade80';
  if (value >= 30) return '#fbbf24';
  return 'var(--danger-light)';
};

// Progress Circle Helper Component (SVG)
const RenderProgressCircle = ({ size = 80, strokeWidth = 6, percentage = 0, color = "#7c3aed" }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(Math.max(percentage, 0), 100) / 100) * circumference;
  
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      {/* Background Track */}
      <circle
        stroke="rgba(255, 255, 255, 0.05)"
        fill="transparent"
        strokeWidth={strokeWidth}
        r={radius}
        cx={size / 2}
        cy={size / 2}
      />
      {/* Progress Line */}
      <circle
        stroke={color}
        fill="transparent"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        r={radius}
        cx={size / 2}
        cy={size / 2}
        style={{ transition: 'stroke-dashoffset 0.8s ease-in-out' }}
      />
    </svg>
  );
};

// Sleep Stage Horizontal Bar with range brackets
const SleepStageBar = ({ label, durationText, percentage, typicalStart, typicalEnd, colorClass }) => {
  return (
    <div className="sleep-stage-row">
      <div className="sleep-stage-header">
        <span style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.8rem' }}>{label}</span>
        <span style={{ fontWeight: '700', fontSize: '0.85rem' }}>{durationText}</span>
      </div>
      <div className="sleep-stage-bar-container">
        <div className="sleep-stage-bar-bg"></div>
        {/* Typical Range Bracket */}
        <div 
          className="sleep-stage-typical-bracket" 
          style={{ left: `${typicalStart}%`, width: `${typicalEnd - typicalStart}%` }}
          title="Typowy zakres"
        ></div>
        {/* Fill Bar */}
        <div 
          className={`sleep-stage-bar-fill ${colorClass}`} 
          style={{ width: `${percentage}%` }}
        ></div>
      </div>
    </div>
  );
};

const getWorkoutIcon = (type) => {
// type may not come from the backend (a workout with no assigned category) - without a
// fallback to '' the app would crash on .toLowerCase() of undefined.
  const t = (type || '').toLowerCase();
  if (t.includes('run') || t.includes('bieg')) return '🏃';
  if (t.includes('walk') || t.includes('spacer') || t.includes('marsz')) return '🚶';
  if (t.includes('cycle') || t.includes('rower')) return '🚴';
  if (t.includes('swim') || t.includes('pływ')) return '🏊';
  if (t.includes('strength') || t.includes('siłownia') || t.includes('ciężar')) return '🏋️';
  if (t.includes('cardio') || t.includes('aerob')) return '⚡';
  if (t.includes('yoga') || t.includes('joga')) return '🧘';
  if (t.includes('box') || t.includes('boks') || t.includes('walka')) return '🥊';
  return '💪';
};

// Daily Goal grid cell
const DailyGoalCard = ({ title, val1, unit1, val2, unit2, percentage, barType }) => {
  return (
    <div className="daily-goal-card">
      <div className="daily-goal-title">{title}</div>
      <div className="daily-goal-value-row">
        <span className="daily-goal-value">{val1}</span>
        <span className="daily-goal-unit" style={{ marginRight: val2 ? '6px' : '0' }}>{unit1}</span>
        {val2 && (
          <>
            <span className="daily-goal-value">{val2}</span>
            <span className="daily-goal-unit">{unit2}</span>
          </>
        )}
      </div>
      <div className="daily-goal-progress-container">
        <div className="daily-goal-progress-track">
          <div 
            className={`daily-goal-progress-fill ${barType}`} 
            style={{ width: `${percentage}%` }}
          ></div>
        </div>
        <div className="daily-goal-pct">{percentage}%</div>
      </div>
    </div>
  );
};

// Trend range 3-segment bar
const TrendRangeBar = ({ activeSegment, color }) => {
  const getSegmentClass = (seg) => {
    if (activeSegment !== seg) return 'trend-range-segment';
    return `trend-range-segment active-${color}`;
  };
  
  return (
    <div className="trend-range-bar">
      <div className={getSegmentClass('left')}>
        {activeSegment === 'left' && <div className="trend-range-knob"></div>}
      </div>
      <div className={getSegmentClass('middle')}>
        {activeSegment === 'middle' && <div className="trend-range-knob"></div>}
      </div>
      <div className={getSegmentClass('right')}>
        {activeSegment === 'right' && <div className="trend-range-knob"></div>}
      </div>
    </div>
  );
};

// Trend cell component
const TrendCard = ({ title, valueText, unitText, activeSegment, color, footerText, status }) => {
  return (
    <div className="trend-health-card">
      <div className="trend-health-title">{title}</div>
      <div className="trend-health-value-row">
        <span className="trend-health-value">{valueText}</span>
        <span className="trend-health-unit">{unitText}</span>
      </div>
      <TrendRangeBar activeSegment={activeSegment} color={color} />
      <div className={`trend-health-footer ${status}`}>
        <span style={{ fontSize: '0.85rem', marginRight: '4px' }}>
          {status === 'success' ? '✓' : '⚠️'}
        </span> 
        {footerText}
      </div>
    </div>
  );
};

const PRESET_SUPPLEMENTS = [
  { name: 'Kreatyna', icon: '⚡', match: ['kreatyn'] },
  { name: 'Ashwagandha', icon: '🌿', match: ['ashwagandh'] },
  { name: 'GABA', icon: '🧠', match: ['gaba'] },
  { name: 'Rhodiola', icon: '🌱', match: ['rhodiol', 'różeniec'] },
  { name: 'Multiwitamina 7Nutrition', icon: '🧬', match: ['multiwitam', 'multivitamin', 'witamin', '7nutrition'] }
];

const getSupplementIconsForText = (text) => {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const icons = [];
  let matchedAny = false;
  PRESET_SUPPLEMENTS.forEach(sup => {
    const isMatch = sup.match.some(m => lowerText.includes(m.toLowerCase()));
    if (isMatch) {
      icons.push(sup.icon);
      matchedAny = true;
    }
  });
  if (!matchedAny && text.trim().length > 0) {
    icons.push('💊');
  }
  return icons;
};

const getLast7Days = (endDateStr) => {
  const days = [];
// We parse locally, not as UTC (new Date("YYYY-MM-DD") is treated as UTC and in
// timezones west of UTC can give a day of -1)
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const endDate = new Date(ey, em - 1, ed);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    
    const weekday = d.toLocaleDateString('pl-PL', { weekday: 'short' });
    days.push({ date: dateStr, label: weekday, dayNum: d.getDate() });
  }
  return days;
};

export default function Dashboard({ summary, aiAdvice, sessionToken, selectedDate, onNavigate, onRefresh, onLogout, userProfile = {}, language = 'pl' }) {
  const [historyData, setHistoryData] = useState([]);
// A central session-expiry signal for the ~40 insight useEffects - instead of calling
// onLogout() directly (which would require adding it to every effect's dep array and risk
// re-render loops), the effects set a flag and one central useEffect calls onLogout() when
// the flag is true.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    if (sessionExpired) onLogout();
  }, [sessionExpired, onLogout]);

// One request instead of several dozen - see BATCHED_INSIGHT_IDS above.
// setSessionExpired comes from useState, so its reference is stable and does not restart
// the effect in useInsights.
  const {
    data: batchedInsights,
    isLoading: isLoadingBatchedInsights
  } = useInsights(sessionToken, selectedDate, BATCHED_INSIGHT_IDS, setSessionExpired);
  const [historyTrigger, setHistoryTrigger] = useState(0);
// isLoadingHistory deliberately removed (the state was set but never read in the render -
// dead code, found in the audit of round 17)
  const [isAddingWater, setIsAddingWater] = useState(false);
  const [customWaterAmount, setCustomWaterAmount] = useState('');
  const [waterMessage, setWaterMessage] = useState('');
  
  // Supplementation state
  const [supplementsText, setSupplementsText] = useState('');
  const [isSavingSupplements, setIsSavingSupplements] = useState(false);
  const [supplementsMessage, setSupplementsMessage] = useState({ type: '', text: '' });

  const handleToggleSupplement = (sup) => {
    let items = supplementsText
      ? supplementsText.split(',').map(item => item.trim()).filter(Boolean)
      : [];

    const matchIndex = items.findIndex(item => 
      sup.match.some(keyword => item.toLowerCase().includes(keyword))
    );

    if (matchIndex >= 0) {
      items.splice(matchIndex, 1);
    } else {
      items.push(sup.name);
    }

    setSupplementsText(items.join(', '));
  };

  const isSupplementActive = (sup) => {
    if (!supplementsText) return false;
    const lowerText = supplementsText.toLowerCase();
    return sup.match.some(keyword => lowerText.includes(keyword));
  };

  // Initialise the supplements text when the date or the value from the backend changes.
  // We deliberately do NOT use [summary] - summary is a new object on every re-render of the
  // parent, which would reset text the user had typed on unrelated refreshes.
  useEffect(() => {
    if (summary) {
      setSupplementsText(summary.supplements || '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.supplements, summary?.date]);

  const handleSaveSupplements = async () => {
    if (!sessionToken) return;
    setIsSavingSupplements(true);
    setSupplementsMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/supplements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          date: selectedDate,
          supplements: supplementsText
        })
      });
      if (res.ok) {
        setSupplementsMessage({ type: 'success', text: 'Zapisano suplementy!' });
        setHistoryTrigger(prev => prev + 1);
        if (onRefresh) {
          onRefresh(); // Refresh the dashboard data (and trigger background generation of new AI advice)
        }
        setTimeout(() => setSupplementsMessage({ type: '', text: '' }), 5000);
      } else {
        // F-S4: handle 401 - an expired session
        if (res.status === 401) { onLogout(); return; }
        setSupplementsMessage({ type: 'error', text: t('Błąd zapisu.') });
      }
    } catch (err) {
      console.error(err);
      setSupplementsMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    } finally {
      setIsSavingSupplements(false);
    }
  };

  // State for the wellbeing tracker (energy and mood, scale 1-5)
  const [energyLevel, setEnergyLevel] = useState(null);
  const [moodLevel, setMoodLevel] = useState(null);
  const [isSavingFeeling, setIsSavingFeeling] = useState(false);
  const [feelingMessage, setFeelingMessage] = useState({ type: '', text: '' });

  // Initialise from the backend data when the day changes
  useEffect(() => {
    if (summary) {
      setEnergyLevel(summary.energy_level ?? null);
      setMoodLevel(summary.mood ?? null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.energy_level, summary?.mood, summary?.date]);

  const handleSaveFeeling = async () => {
    if (!sessionToken) return;
    if (energyLevel === null && moodLevel === null) {
      setFeelingMessage({ type: 'error', text: t('Kliknij co najmniej jedną ocenę przed zapisaniem.') });
      return;
    }
    setIsSavingFeeling(true);
    setFeelingMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/feeling', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          date: selectedDate,
          energy_level: energyLevel,
          mood: moodLevel
        })
      });
      if (res.ok) {
        setFeelingMessage({ type: 'success', text: 'Zapisano!' });
        if (onRefresh) onRefresh();
        setTimeout(() => setFeelingMessage({ type: '', text: '' }), 4000);
      } else {
        if (res.status === 401) { onLogout(); return; }
        setFeelingMessage({ type: 'error', text: t('Błąd zapisu.') });
      }
    } catch (err) {
      console.error(err);
      setFeelingMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    } finally {
      setIsSavingFeeling(false);
    }
  };

  // Week/month nutrition comparison and the cumulative calorie balance
  const nutritionComparison = batchedInsights['nutrition-comparison'];
  const calorieBalance = batchedInsights['calorie-balance'];
  const isLoadingComparison = isLoadingBatchedInsights;

  // Insight: sleep -> next day's calories/sugar (a descriptive comparison of the averages
  // over the last 90 days, see the /api/dashboard/sleep-insight endpoint).
  const sleepInsight = batchedInsights['sleep-insight'];
  const isLoadingSleepInsight = isLoadingBatchedInsights;


  // Alert/insight: sodium -> blood pressure (see the /api/dashboard/sodium-bp-insight endpoint).
  const sodiumBpInsight = batchedInsights['sodium-bp-insight'];


  // Recovery indicator: HRV/RHR on the day after a significant workout
  // (see the /api/dashboard/recovery-insight endpoint).
  const recoveryInsight = batchedInsights['recovery-insight'];


  // Insight: supplements (free text) vs sleep/recovery on THE SAME day
  // (see the /api/dashboard/supplements-sleep-insight endpoint) - our own analysis of data
  // the app already collects (supplements + Oura), without copying
  // niczego z konkurencyjnych apek.
  const supplementsSleepInsight = batchedInsights['supplements-sleep-insight'];


  // Round 7: 8 new insights based on data the app already collects -
  // the same fetch/state pattern as above (sleepInsight, sodiumBpInsight, and so on).
  const hydrationInsight = batchedInsights['hydration-readiness-insight'];

  const sedentaryInsight = batchedInsights['sedentary-sleep-insight'];

  const fiberSleepInsight = batchedInsights['fiber-sleep-insight'];

  const bodyRecompInsight = batchedInsights['body-recomposition-insight'];

  const strainAlert = batchedInsights['early-strain-alert'];

  const stressNutritionInsight = batchedInsights['stress-nutrition-insight'];

  const mealFreqInsight = batchedInsights['meal-frequency-adherence-insight'];

  const streakDriftInsight = batchedInsights['streak-drift-insight'];

  const rhrDriftInsight = batchedInsights['rhr-drift-insight'];

  const mealTimingSleepInsight = batchedInsights['meal-timing-sleep-insight'];

  const bpTrendInsight = batchedInsights['bp-trend-insight'];

  // Real cardio zones (Karvonen) summed from the Apple Health workouts of the last 14 days
  // - unlike the static "Strefy Tętna" reference table (a formula, not a measurement),
  // these are minutes actually measured by heart rate during a workout (it requires "Include
  // Workout Metrics" enabled in Health Auto Export). See /api/dashboard/hr-zones-insight.
  const hrZonesInsight = batchedInsights['hr-zones-insight'];

  // Meal quality trend (health_rating 1-10 from analysis_json) - the last 14 days
  // vs the preceding 30 days. See /api/dashboard/meal-quality-trend-insight.
  const mealQualityTrendInsight = batchedInsights['meal-quality-trend-insight'];

  // The "weekend effect" - calories/activity/sleep on weekdays vs the weekend, over the
  // last 4 weeks. See /api/dashboard/weekend-effect-insight.
  const weekendEffectInsight = batchedInsights['weekend-effect-insight'];

  // Calorie efficiency per workout type (kcal/min) over the last 90 days.
  // See /api/dashboard/workout-efficiency-insight.
  const workoutEfficiencyInsight = batchedInsights['workout-efficiency-insight'];

  // Forecast of the date the weight goal will be reached (a 60-day regression +
  // target_weight_kg) - a permanent card on the dashboard (previously visible only in the
  // periodic e-mails). See /api/dashboard/weight-goal-forecast.
  const weightGoalForecast = batchedInsights['weight-goal-forecast'];

  // Stability of favourite (repeated) meals - the calorie drift between the older and the
  // newer half of the occurrences. See /api/dashboard/favorite-meal-drift-insight.
  const favoriteMealDriftInsight = batchedInsights['favorite-meal-drift-insight'];

  // SpO2 (blood oxygen saturation) trend - the last 7 days vs the preceding 28-day baseline.
  // See /api/dashboard/spo2-trend-insight.
  const spo2TrendInsight = batchedInsights['spo2-trend-insight'];

  // WHR (waist circumference / hip circumference) - an established cardiovascular risk
  // indicator. See /api/dashboard/whr-insight.
  const whrInsight = batchedInsights['whr-insight'];

  // Biceps symmetry (left vs right) from the body measurements.
  // See /api/dashboard/body-symmetry-insight.
  const bodySymmetryInsight = batchedInsights['body-symmetry-insight'];

  // Running/walking pace trend (min/km, approximate) - days with a single run/walk/hike
  // workout. See /api/dashboard/pace-trend-insight.
  const paceTrendInsight = batchedInsights['pace-trend-insight'];

  // Workout variety (the distribution of workout_type over the last 60 days).
  // See /api/dashboard/workout-variety-insight.
  const workoutVarietyInsight = batchedInsights['workout-variety-insight'];

  // Composite Wellness Score (0-100) - synthesises sleep/readiness/RHR/diet/hydration into
  // one headline indicator for the day. See /api/dashboard/wellness-score.
  // Energy battery (0-100): how much of the resource is left AS OF NOW. Charged by sleep and
  // readiness, discharged by load, the passing of the day and stress, lowered by accumulated
  // sleep debt. See /api/dashboard/energy-battery.
  const energyBattery = batchedInsights['energy-battery'];

  const wellnessScore = batchedInsights['wellness-score'];

  // AI that explains the causes (round 11, in the style of Oura Advisor / Whoop Coach) - it
  // detects today's largest sleep/readiness/HRV/RHR deviation and asks the AI for a short
  // explanation of the cause. See /api/dashboard/ai-explanation-insight.
  // Unlike the others, this insight is UPDATED after the batch arrives - the backend
  // generates the explanation in the background and it has to be fetched afterwards (polling
  // below). The batch provides the initial value and the overlay replaces it with a fresher
  // result. The overlay is kept together with the date it was produced for, so that switching
  // days does not show an explanation from the previous date.
  const [aiExplanationOverride, setAiExplanationOverride] = useState(null);
  const aiExplanationInsight = aiExplanationOverride && aiExplanationOverride.date === selectedDate
    ? aiExplanationOverride.data
    : batchedInsights['ai-explanation-insight'];
  // Round 12 (audit): an explicit loading state - without it the card simply rendered
  // NOTHING (neither content nor a message) between the component mounting and the API
  // response, which on a slower connection looked like a missing card rather than a loading one.
  const isLoadingAiExplanation = isLoadingBatchedInsights;

    // The backend generates the AI explanation IN THE BACKGROUND and returns `generating: true`
    // before the text is ready (see /api/dashboard/ai-explanation-insight in dashboard.js).
    // Previously the card showed the static text "the explanation will appear after a refresh"
    // and required the user to reload the page MANUALLY to see the result. Here we poll again
    // every few seconds until the backend returns `generating: false` (either done or given
    // up, a missing AI key for instance) - capped at a limited number of attempts, so we do
    // not poll forever if the background generation never finished for some reason.
  const MAX_AI_EXPLANATION_POLL_ATTEMPTS = 10;
  useEffect(() => {
    if (!aiExplanationInsight || !aiExplanationInsight.generating || !sessionToken) return;
    let attempts = 0;
    let cancelled = false;
    const intervalId = setInterval(async () => {
      attempts += 1;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/ai-explanation-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) {
          const data = await res.json();
          setAiExplanationOverride({ date: selectedDate, data });
          if (!data.generating || attempts >= MAX_AI_EXPLANATION_POLL_ATTEMPTS) {
            clearInterval(intervalId);
          }
        }
      } catch (err) {
        console.error('Failed to poll the AI explanation generation status:', err);
      }
      if (attempts >= MAX_AI_EXPLANATION_POLL_ATTEMPTS) {
        clearInterval(intervalId);
      }
    }, 4000);
    return () => { cancelled = true; clearInterval(intervalId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiExplanationInsight?.generating, sessionToken, selectedDate]); // F-S1: optional chaining instead of a boolean expression

  // Benchmark "Ty dziś vs Ty w przeszłości" (Runda 11, prywatna wersja Whoop
  // "people like you" - EXCLUSIVELY the user's own history, with no comparison to other
  // users). See /api/dashboard/self-benchmark-insight.
  const selfBenchmarkInsight = batchedInsights['self-benchmark-insight'];
  const isLoadingSelfBenchmark = isLoadingBatchedInsights;

  // Round 13, new feature 1: workout type -> the quality of that same night's sleep.
  const workoutTypeSleepInsight = batchedInsights['workout-type-sleep-insight'];
  const isLoadingWorkoutTypeSleep = isLoadingBatchedInsights;

  // Round 13, new feature 2: muscle mass vs protein intake.
  const muscleProteinInsight = batchedInsights['muscle-protein-insight'];
  const isLoadingMuscleProtein = isLoadingBatchedInsights;

  // Runda 13, nowa funkcja 3: rozjazd temperatury Oura vs Apple Watch.
  const temperatureDivergenceInsight = batchedInsights['temperature-divergence-insight'];
  const isLoadingTemperatureDivergence = isLoadingBatchedInsights;

  // Round 13, new feature 4: body circumference proportions (shoulders/waist, chest/waist).
  const bodyProportionsInsight = batchedInsights['body-proportions-insight'];
  const isLoadingBodyProportions = isLoadingBatchedInsights;

  // Round 13, new feature 5: the day's activity -> appetite on the same day.
  const activityAppetiteInsight = batchedInsights['activity-appetite-insight'];
  const isLoadingActivityAppetite = isLoadingBatchedInsights;

  // Round 13, new feature 6: diet quality as a modifier of the rate of weight change.
  const dietQualityWeightPaceInsight = batchedInsights['diet-quality-weight-pace-insight'];
  const isLoadingDietQualityWeightPace = isLoadingBatchedInsights;

  // Runda 13, nowa funkcja 7: streak -> realny efekt na wadze.
  const streakWeightEffectInsight = batchedInsights['streak-weight-effect-insight'];
  const isLoadingStreakWeightEffect = isLoadingBatchedInsights;

  // Round 13, new feature 8: sitting -> workout performance that day.
  const sedentaryPerformanceInsight = batchedInsights['sedentary-performance-insight'];
  const isLoadingSedentaryPerformance = isLoadingBatchedInsights;

  // Insight: hydration (water_ml) vs sleep quality (sleep_score) - a correlation over the
  // last 60 days. The same pattern as hydration-readiness-insight, but focused on sleep
  // rather than readiness. See /api/dashboard/water-sleep-insight.
  const waterSleepInsight = batchedInsights['water-sleep-insight'];
  const isLoadingWaterSleep = isLoadingBatchedInsights;

  // Readiness to train today (a deterministic composite score from Oura + Apple Health).
  // Needs no AI - fast, with no token cost. See /api/dashboard/training-readiness.
  const trainingReadiness = batchedInsights['training-readiness'];

  // AI training plan analysis (Gemini, cached for 7 days). ?refresh=1 forces regeneration.
  // Data: 4 weeks of workouts + the body goal + body composition + a 7-day recovery average.
  // See /api/dashboard/training-plan-insight.
  // As with the AI explanation: the initial value comes from the batch, but the "Odśwież"
  // button (refresh=1, which forces the AI to regenerate) has to be able to override it.
  // The overlay remembers the date it was produced for.
  const [trainingPlanOverride, setTrainingPlanOverride] = useState(null);
  const [isRefreshingTrainingPlan, setIsRefreshingTrainingPlan] = useState(false);
  const trainingPlanInsight = trainingPlanOverride && trainingPlanOverride.date === selectedDate
    ? trainingPlanOverride.data
    : batchedInsights['training-plan-insight'];
  const isLoadingTrainingPlan = isLoadingBatchedInsights || isRefreshingTrainingPlan;
  const fetchTrainingPlanInsight = async (refresh = false) => {
    if (!sessionToken) return;
      // Guard: do not send another request while the previous one is still in flight
      // (clicking "Odśwież" during loading).
    if (isLoadingTrainingPlan && !refresh) return;
    setIsRefreshingTrainingPlan(true);
    try {
      const dateParam = selectedDate ? `?date=${selectedDate}` : '';
      const refreshParam = refresh ? (dateParam ? '&refresh=1' : '?refresh=1') : '';
      const res = await fetch(`/api/dashboard/training-plan-insight${dateParam}${refreshParam}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.status === 401) { setSessionExpired(true); return; }
      if (res.ok) setTrainingPlanOverride({ date: selectedDate, data: await res.json() });
    } catch (err) {
      console.error('Failed to fetch the AI training plan analysis:', err);
    } finally {
      setIsRefreshingTrainingPlan(false);
    }
  };
    // Auto-fetch limited to once an hour via localStorage, so we do not hammer the endpoint
    // on every page refresh (the backend has a 7-day AI cache, but the HTTP request itself is
    // also unnecessary when the data has not changed).

  // === INSIGHTY TRENINGOWE (Runda 25): Oura + Apple Watch cross-device ===

  // Oura sleep -> Apple Watch workout performance (the following day)
  const sleepWorkoutPerfInsight = batchedInsights['sleep-workout-performance-insight'];

  // Oura readiness -> Apple Watch performance (the same day)
  const readinessWorkoutInsight = batchedInsights['readiness-workout-insight'];

  // 80/20 heart-rate zone polarisation (Apple Watch only)
  const hrPolarizationInsight = batchedInsights['hr-polarization-insight'];

  // A hard Apple Watch workout -> Oura HRV/RHR on day +1/+2
  const workoutRecoveryHrvInsight = batchedInsights['workout-recovery-hrv-insight'];

  // The gap between workouts -> performance (Apple Watch only)
  const workoutRestPerfInsight = batchedInsights['workout-rest-performance-insight'];

  // "Day tag" - date ranges marked with a context (illness/holiday/a late bedtime) that
  // selected insights above exclude when computing the user's own norm or baseline
  // (see the backend: routes/dayEvents.js + getExcludedDates in routes/dashboard.js).
  const DAY_EVENT_TYPES = [
    { value: 'illness', label: 'Choroba' },
    { value: 'vacation', label: 'Wakacje / urlop' },
    { value: 'late_sleep', label: t('Późne zaśnięcie') }
  ];
  const DAY_EVENT_TYPE_LABELS = Object.fromEntries(DAY_EVENT_TYPES.map(t => [t.value, t.label]));
  const DAY_EVENT_ICONS = {
    illness: '🤒',
    vacation: '🌴',
    late_sleep: '🌙'
  };

  const [isDayEventsOpen, setIsDayEventsOpen] = useState(false);
  const [dayEvents, setDayEvents] = useState([]);
  const [isLoadingDayEvents, setIsLoadingDayEvents] = useState(false);
  const [newEventType, setNewEventType] = useState('illness');
  const [newEventStart, setNewEventStart] = useState('');
  const [newEventEnd, setNewEventEnd] = useState('');
  const [newEventNote, setNewEventNote] = useState('');
  const [isSavingDayEvent, setIsSavingDayEvent] = useState(false);
  const [dayEventMessage, setDayEventMessage] = useState({ type: '', text: '' });

  const fetchDayEvents = async (cancelledRef) => {
    if (!sessionToken) return;
    setIsLoadingDayEvents(true);
    try {
      const res = await fetch('/api/day-events', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok && !(cancelledRef && cancelledRef.current)) {
        const data = await res.json();
        setDayEvents(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch the day events:', err);
    } finally {
      if (!(cancelledRef && cancelledRef.current)) setIsLoadingDayEvents(false);
    }
  };

  useEffect(() => {
    const cancelledRef = { current: false };
    fetchDayEvents(cancelledRef);
    return () => { cancelledRef.current = true; };
  }, [sessionToken]);

  const handleAddDayEvent = async () => {
    if (!sessionToken || !newEventType || !newEventStart || !newEventEnd) return;
    if (newEventEnd < newEventStart) {
      setDayEventMessage({ type: 'error', text: t('Data końcowa nie może być wcześniejsza niż data początkowa.') });
      return;
    }
    setIsSavingDayEvent(true);
    setDayEventMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/day-events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          type: newEventType,
          start_date: newEventStart,
          end_date: newEventEnd,
          note: newEventNote
        })
      });
      if (res.ok) {
        setNewEventStart('');
        setNewEventEnd('');
        setNewEventNote('');
        setDayEventMessage({ type: 'success', text: 'Zapisano zdarzenie.' });
        await fetchDayEvents({ current: false }); // F-S3: cancelledRef is required by the function signature
        setTimeout(() => setDayEventMessage({ type: '', text: '' }), 4000);
      } else {
        const data = await res.json().catch(() => ({}));
        setDayEventMessage({ type: 'error', text: data.error || t('Błąd zapisu zdarzenia.') });
      }
    } catch (err) {
      console.error(err);
      setDayEventMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    } finally {
      setIsSavingDayEvent(false);
    }
  };

  const handleDeleteDayEvent = async (id) => {
    if (!sessionToken) return;
    try {
      const res = await fetch(`/api/day-events/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        setDayEvents(prev => prev.filter(ev => ev.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete the day event:', err);
    }
  };

  // Whether the given date (the day currently selected on the dashboard, for instance) falls
  // within the range of an event of one of the given types - used for the context note
  // ("marked: illness") on the insight cards that exclude that type from the baseline.
  const getDayEventLabelForDate = (dateStr, types) => {
    if (!dateStr || dayEvents.length === 0) return null;
    const match = dayEvents.find(ev => types.includes(ev.type) && dateStr >= ev.start_date && dateStr <= ev.end_date);
    return match ? DAY_EVENT_TYPE_LABELS[match.type] : null;
  };

  // Collapsible "Analizy" section (UX: round 7 - 12 insight cards in one place, collapsed by
  // default so the dashboard is not flooded the moment it opens).
  const [isAnalizyOpen, setIsAnalizyOpen] = useState(false);
  // Collapsible heart-rate zone table (UX: round 7 - a static 5-zone reference table; there
  // is no need to see it immediately, an expanding link is enough).
  const [isHrZonesOpen, setIsHrZonesOpen] = useState(false);
  // Collapsible supplementation history (UX: round 7 - the 7-day bar and the
  // "Ostatnio przyjmowane" list hidden behind "Pokaż historię" by default, with only the
  // counter visible).
  const [isSupplementsHistoryOpen, setIsSupplementsHistoryOpen] = useState(false);

  // Adaptive correction of the calorie goal: comparing the declared balance (from the logged
  // meals) with the balance implied by the real weight change (see the
  // /api/dashboard/calorie-target-suggestion endpoint). caloriesTrigger forces a re-fetch
  // after clicking "Zastosuj", so the card disappears or updates without waiting for a full
  // page refresh.
  const [calorieSuggestion, setCalorieSuggestion] = useState(null);
  const [caloriesTrigger, setCaloriesTrigger] = useState(0);
  const [isApplyingCalorieSuggestion, setIsApplyingCalorieSuggestion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchCalorieSuggestion = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/calorie-target-suggestion${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setCalorieSuggestion(await res.json());
      } catch (err) {
        console.error('Failed to fetch the calorie goal correction:', err);
      }
    };
    fetchCalorieSuggestion();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, caloriesTrigger]);

  const handleApplyCalorieSuggestion = async () => {
    if (!calorieSuggestion || !calorieSuggestion.suggestedTargetCalories || isApplyingCalorieSuggestion) return;
    setIsApplyingCalorieSuggestion(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ target_calories: calorieSuggestion.suggestedTargetCalories })
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
        setCaloriesTrigger(t => t + 1);
      } else if (res.status === 401) {
        // F-S4: handle 401 - an expired session
        onLogout();
      }
    } catch (err) {
      console.error('Failed to save the new calorie goal:', err);
    } finally {
      setIsApplyingCalorieSuggestion(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const fetchHistory = async () => {
      if (!sessionToken) return;
      try {
        const res = await fetch('/api/health/history', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) {
          const data = await res.json();
          setHistoryData(data);
        }
      } catch (err) {
        console.error('Failed to fetch the history:', err);
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [sessionToken, summary.last_sync, historyTrigger]);


  const renderWeightCompositionChart = (data) => {
    let validData = data.filter(d => 
      (d.weight !== null && d.weight !== undefined) || 
      (d.fat_ratio !== null && d.fat_ratio !== undefined) ||
      (d.muscle_mass !== null && d.muscle_mass !== undefined)
    );

    if (validData.length === 0) {
                // No real weight or body composition data in the database - we show an honest
                // "no data" message rather than generating a fake chart.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px', marginTop: '10px' }}>
          <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>
            📈 Trend składu ciała
          </div>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', padding: '12px 0', textAlign: 'center' }}>
            Brak danych - zsynchronizuj wagę z Withings, aby zobaczyć trend
          </div>
        </div>
      );
    } else if (validData.length === 1) {
      const single = validData[0];
      const prevDate = new Date(single.date);
      prevDate.setDate(prevDate.getDate() - 1);
      validData = [
        { ...single, date: prevDate.toISOString().split('T')[0] },
        single
      ];
    }

    const width = 500;
    const height = 110;
    const paddingLeft = 30;
    const paddingRight = 30;
    const paddingTop = 15;
    const paddingBottom = 15;

    const getCompositionMinMax = (arr, key) => {
      const values = arr.map(d => d[key]).filter(v => v !== null && v !== undefined);
      if (values.length === 0) return { min: 0, max: 100 };
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      const padding = range === 0 ? 5 : range * 0.15;
      return { min: Math.max(0, min - padding), max: max + padding };
    };

    const weightsAndMuscles = validData.reduce((acc, d) => {
      if (d.weight !== null && d.weight !== undefined) acc.push(d.weight);
      if (d.muscle_mass !== null && d.muscle_mass !== undefined) acc.push(d.muscle_mass);
      return acc;
    }, []);
    const minLeft = weightsAndMuscles.length ? Math.max(0, Math.min(...weightsAndMuscles) - 5) : 50;
    const maxLeft = weightsAndMuscles.length ? Math.max(...weightsAndMuscles) + 5 : 100;

    const { min: minRight, max: maxRight } = getCompositionMinMax(validData, 'fat_ratio');

    const pointsWeight = [];
    const pointsMuscle = [];
    const pointsFat = [];

    validData.forEach((d, index) => {
      const x = paddingLeft + (index / (validData.length - 1 || 1)) * (width - paddingLeft - paddingRight);
      
      if (d.weight !== null && d.weight !== undefined) {
        const y = height - paddingBottom - ((d.weight - minLeft) / (maxLeft - minLeft || 1)) * (height - paddingTop - paddingBottom);
        pointsWeight.push({ x, y });
      }
      if (d.muscle_mass !== null && d.muscle_mass !== undefined) {
        const y = height - paddingBottom - ((d.muscle_mass - minLeft) / (maxLeft - minLeft || 1)) * (height - paddingTop - paddingBottom);
        pointsMuscle.push({ x, y });
      }
      if (d.fat_ratio !== null && d.fat_ratio !== undefined) {
        const y = height - paddingBottom - ((d.fat_ratio - minRight) / (maxRight - minRight || 1)) * (height - paddingTop - paddingBottom);
        pointsFat.push({ x, y });
      }
    });

    const dWeight = pointsWeight.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dMuscle = pointsMuscle.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dFat = pointsFat.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px', marginTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>
          <span>{t("📈 Trend składu ciała (30 dni)")}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: '#38bdf8', borderRadius: '50%' }}></span> Waga
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: 'var(--success-light)', borderRadius: '50%' }}></span> Mięśnie
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: '#fbbf24', borderRadius: '50%' }}></span> Tłuszcz %
            </span>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
            <line x1={paddingLeft} y1={paddingTop} x2={width - paddingRight} y2={paddingTop} stroke="rgba(255,255,255,0.02)" />
            <line x1={paddingLeft} y1={height / 2} x2={width - paddingRight} y2={height / 2} stroke="rgba(255,255,255,0.02)" />
            <line x1={paddingLeft} y1={height - paddingBottom} x2={width - paddingRight} y2={height - paddingBottom} stroke="rgba(255,255,255,0.05)" />

            <text x={paddingLeft - 4} y={paddingTop + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="end">{Math.round(maxLeft)}</text>
            <text x={paddingLeft - 4} y={height - paddingBottom + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="end">{Math.round(minLeft)}</text>

            <text x={width - paddingRight + 4} y={paddingTop + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="start">{Math.round(maxRight)}%</text>
            <text x={width - paddingRight + 4} y={height - paddingBottom + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="start">{Math.round(minRight)}%</text>

            {dWeight && <path d={dWeight} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />}
            {dMuscle && <path d={dMuscle} fill="none" stroke="var(--success-light)" strokeWidth="1.5" strokeLinecap="round" />}
            {dFat && <path d={dFat} fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="3,3" strokeLinecap="round" />}
          </svg>
        </div>
      </div>
    );
  };

  // Data comes exclusively from the database (backend) - no artificial demo values.
  // When the database has no value for a given day yet, we show 0 / no data.
  const sleepScore = summary.sleep_score ?? 0;
  const readinessScore = summary.readiness_score ?? 0;

  // FIX (audit round 4): the daily goals (steps, calories, sleep, exercise minutes) may be
  // deliberately stored as 0 (the goal is switched off - see `??` in the goal cards below and
  // the fix in dashboard.js/ActivityTracker.jsx, where `||` used to irrecoverably overwrite
  // such a 0 with a default). Dividing by goal=0 on its own would give Infinity/NaN in the
  // progress bar percentage - the helper explicitly treats a disabled goal as "0% to show"
  // instead of rendering NaN%.
  const goalProgressPct = (value, target) => target > 0 ? Math.min(Math.round((value / target) * 100), 100) : 0;

  const steps = summary.steps || 0;
  // activeCalories: 0 and "no data" are equivalent here (no workout = 0 active calories), so
  // || 0 stays - unlike rhr/hrv below.
  const activeCalories = summary.calories_burned_active || 0;
  // FIX (audit round 4): effortScore computed the effort % against a hard-coded 800 kcal,
  // while the "energy battery" below computes discharge against targetActiveCaloriesForBattery
  // (the goal from the settings, 500 kcal by default) - two cards describing the same day's
  // activity gave inconsistent, mutually incomparable percentages whenever the user's goal
  // differed from 800 kcal. Unified onto a common denominator.
  // FIX (audit round 4): `||` overwrote a deliberately stored goal=0 (active calorie goal
  // switched off, see dashboard.js/ActivityTracker.jsx) with the default 500. `??` preserves
  // a real 0 - dividing by it is safe here, because effortScore and batteryDepletion below
  // have their own separate guard against 0/0 (NaN).
  const targetActiveCaloriesForBattery = summary.target_active_calories ?? 500;
  const effortScore = activeCalories > 0 ? Math.round(Math.min((activeCalories / targetActiveCaloriesForBattery) * 100, 100)) : 0;
  const activeMinutes = summary.active_minutes || 0;

  const sleepDurationHours = summary.sleep_duration ?? 0;
  const sleepDeepHours = summary.sleep_deep ?? 0;
  const sleepRemHours = summary.sleep_rem ?? 0;
  // sleepAwakeMins is not computed from the Oura data yet (always 0) - the "Czas czuwania"
  // card is therefore hidden in the render, so we do not show a fake 0m.
  const sleepAwakeMins = 0;
  const sleepLightHours = Math.max(sleepDurationHours - sleepDeepHours - sleepRemHours - (sleepAwakeMins / 60), 0);
  // Hours/minutes breakdown for the "Czas snu" card - the same rounding pattern as in
  // formatHoursMins (utils/format.js), but returning separate numbers rather than a ready
  // string (DailyGoalCard takes val1/val2 separately). Bug fix: without carrying "min === 60"
  // over to the next hour, values close to a full hour (7.995h, say) showed as
  // "7 godz 60 min" instead of "8 godz 0 min".
  const sleepDurationDisplay = (() => {
    let hours = Math.floor(sleepDurationHours);
    let mins = Math.round((sleepDurationHours - hours) * 60);
    if (mins === 60) { hours += 1; mins = 0; }
    return { hours, mins };
  })();

  // rhr/hrv: 0 would be a physiologically impossible value, so here (unlike steps, for
  // example) we use ?? null to tell "no data" apart from a real measurement.
  const rhr = summary.rhr ?? null;
  const hrv = summary.hrv ?? null;

  const weight = summary.weight ?? 0;
  const fatRatio = summary.fat_ratio ?? 0;
  const muscleMass = summary.muscle_mass ?? 0;

  // BMI - computed exclusively from the user's real height (Settings -> Height).
  // No fake default height of 1.80m and no fake "24.5" fallback.
  // When the weight or the height is missing, the BMI is simply not shown.
  const heightCm = summary.height_cm ?? null;
  const bmiValue = (weight > 0 && heightCm)
    ? Math.round((weight / ((heightCm / 100) * (heightCm / 100))) * 10) / 10
    : null;
  const bmiCategory = bmiValue === null
    ? null
    : bmiValue < 18.5 ? 'Niedowaga'
    : bmiValue < 25 ? 'W normie'
    : bmiValue < 30 ? 'Nadwaga'
    : t('Otyłość');

  // Heart-rate zone calculation (Karvonen) based on the RHR from Oura.
  // userMaxHr: the real HRmax (220 - age) computed by the backend from the user's year of
  // birth (Settings -> Year of birth). The 190 fallback (~age 30) applies only when the user
  // has not given a year of birth.
  const userMaxHr = summary.user_max_hr || 190;
  // rhr can be null (no Oura data for that day) - for the calculation itself we use a local
  // fallback of 0, but the card below is hidden when rhr == null, so we never show zones
  // computed from a fake RHR.
  const rhrForZones = rhr ?? 0;
  const hrReserve = userMaxHr - rhrForZones;
  const hrZone1Min = Math.round(hrReserve * 0.5 + rhrForZones);
  const hrZone1Max = Math.round(hrReserve * 0.6 + rhrForZones);
  const hrZone2Min = Math.round(hrReserve * 0.6 + rhrForZones);
  const hrZone2Max = Math.round(hrReserve * 0.7 + rhrForZones);
  const hrZone3Min = Math.round(hrReserve * 0.7 + rhrForZones);
  const hrZone3Max = Math.round(hrReserve * 0.8 + rhrForZones);
  const hrZone4Min = Math.round(hrReserve * 0.8 + rhrForZones);
  const hrZone4Max = Math.round(hrReserve * 0.9 + rhrForZones);
  const hrZone5Min = Math.round(hrReserve * 0.9 + rhrForZones);
  
  // Nutrition
  // We use ?? (not ||), because a goal deliberately set to 0 (an elimination diet for one
  // macronutrient, say) should not be overwritten with a default - the same bug pattern
  // already fixed earlier for target_steps/target_active_calories/etc.
  const targetCalories = summary.target_calories ?? 2000;
  const eatenCalories = summary.calories_eaten || 0;
  const targetProtein = summary.target_protein ?? 150;
  const targetCarbs = summary.target_carbs ?? 250;
  const targetFat = summary.target_fat ?? 80;
  const eatenProtein = summary.eaten_protein || 0;
  const eatenCarbs = summary.eaten_carbs || 0;
  const eatenFat = summary.eaten_fat || 0;
  // FIX (audit round 17): previously the bar fill percentages computed
  // `eatenX / (targetX || 2000)` and so on - `||` again overwrote a deliberately stored 0
  // (a disabled or zeroed goal) with a default, even though targetX is already computed
  // correctly with `??` above. On top of that, dividing by 0 (had goal=0 reached the division
  // directly) would give Infinity/NaN. The guard follows the waterPct pattern: goal<=0 ->
  // percentage 0, no division by zero.
  const caloriesPct = targetCalories > 0 ? Math.min((eatenCalories / targetCalories) * 100, 100) : 0;
  const carbsPct = targetCarbs > 0 ? Math.min((eatenCarbs / targetCarbs) * 100, 100) : 0;
  const proteinPct = targetProtein > 0 ? Math.min((eatenProtein / targetProtein) * 100, 100) : 0;
  const fatPct = targetFat > 0 ? Math.min((eatenFat / targetFat) * 100, 100) : 0;

  // Licznik wody
  const waterMl = summary.water_ml || 0;
  // FIX (audit round 4): as above - `??` preserves a deliberately stored 0 (goal switched
  // off), and waterPct gets an explicit guard against a 0/0 division (NaN) when goal=0 and
  // nothing has been drunk yet.
  const targetWaterMl = summary.target_water_ml ?? 2500;
  const waterPct = targetWaterMl > 0 ? Math.min(Math.round((waterMl / targetWaterMl) * 100), 100) : 0;

  // The current load on the slider (effort, for instance)
  const currentLoadPos = Math.max(Math.min(effortScore, 100), 5); // at least 5% so the slider stays visible
  
  // Energy battery - a real algorithm, with no artificial offsets.
  //
  // Discharge: proportional to today's active calories relative to the user's activity goal
  // (the more effort relative to the goal, the larger the drop - analogous to "Body Battery"
  // in Garmin-style devices, but from real data).
  // No readinessScore (the device has not synced) = no battery; we do not guess.
  // FIX (audit round 4): when the active calorie goal is deliberately set to 0 (see `??`
  // above) and the user burned no active calories, the bare 0/0 division gave NaN and broke
  // the whole "energy battery" - hence an explicit guard: goal=0 means no discharge
  // (discharge only when there is a real
  // cel do przekroczenia).
  const batteryDepletion = readinessScore > 0 && targetActiveCaloriesForBattery > 0
    ? Math.round(Math.min(activeCalories / targetActiveCaloriesForBattery, 1) * 20)
    : 0;
  const batteryPct = readinessScore > 0
    ? Math.max(Math.min(readinessScore - batteryDepletion, 100), 0)
    : null;

  // Comparison with yesterday - computed from the real history (historyData) using the same
  // algorithm as today's battery. No data for yesterday = no label.
  const sortedHistoryForBattery = [...historyData].sort((a, b) => a.date.localeCompare(b.date));
  const todayHistoryIdx = selectedDate
    ? sortedHistoryForBattery.findIndex(d => d.date === selectedDate)
    : -1;
  const yesterdayHistoryRow = todayHistoryIdx > 0 ? sortedHistoryForBattery[todayHistoryIdx - 1] : null;
  let yesterdayBatteryPct = null;
  if (yesterdayHistoryRow && yesterdayHistoryRow.readiness_score > 0) {
    const yReadiness = yesterdayHistoryRow.readiness_score;
    const yActiveCalories = yesterdayHistoryRow.active_calories || 0;
    const yDepletion = Math.round(Math.min(yActiveCalories / targetActiveCaloriesForBattery, 1) * 20);
    yesterdayBatteryPct = Math.max(Math.min(yReadiness - yDepletion, 100), 0);
  }
  const batteryDelta = (batteryPct !== null && yesterdayBatteryPct !== null)
    ? batteryPct - yesterdayBatteryPct
    : null;

  // The last sync and the activity data source - the `last_sync` field had long been fetched
  // from the backend, but was never displayed to the user anywhere.
  const lastSyncDate = summary.last_sync ? new Date(summary.last_sync) : null;
  const formatRelativeSync = (date) => {
    if (!date || isNaN(date.getTime())) return null;
    const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
    if (diffMin < 1) return t('przed chwilą');
    if (diffMin < 60) return `${diffMin} min temu`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `${diffHours} godz. temu`;
    return `${Math.round(diffHours / 24)} dni temu`;
  };
  const lastSyncLabel = formatRelativeSync(lastSyncDate);
  const activitySourceLabels = { apple: '🍏 Apple Health', oura: '💍 Oura Ring', google_fit: '🟢 Google Fit' };
  const activitySourceLabel = summary.activity_source ? (activitySourceLabels[summary.activity_source] || summary.activity_source) : null;

  // Distance and the day's activity breakdown (Oura daily_activity / Google Fit / Apple
  // Health) - daily counters that reset every day, like steps (see the backend dashboard.js).
  const distanceMeters = summary.distance_meters || 0;
  const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
  const sedentaryMinutes = summary.sedentary_minutes || 0;
  const lowActivityMinutes = summary.low_activity_minutes || 0;
  const hasActivityBreakdown = distanceMeters > 0 || sedentaryMinutes > 0 || lowActivityMinutes > 0 || activeMinutes > 0;

  // The real stress level from Oura (the daily_stress endpoint) - unlike the section removed
  // earlier, which was 100% fabricated, this card appears ONLY when the backend genuinely has
  // real data (a ring with stress measurement).
  const stressHighMinutes = summary.stress_high_minutes;
  const stressRecoveryMinutes = summary.stress_recovery_minutes;
  const stressSummary = summary.stress_summary;
  const hasStressData = stressHighMinutes != null || stressRecoveryMinutes != null || stressSummary != null;
  const stressSummaryLabels = { restored: 'Zregenerowany', normal: 'Normalny', stressful: t('Stresujący') };

  // The last saved body measurement - the full CRUD and the trend chart are already in
  // ActivityTracker; this is just a shortcut to the latest value on the main Dashboard.
  const latestBodyMeasurement = summary.latest_body_measurement || null;

  // Goal streaks - computed by the backend exclusively from the history already stored in
  // the database (meals + health_metrics), with zero new integrations (point 9 of the analysis).
  const calorieStreakDays = summary.calorie_streak_days || 0;
  const sleepStreakDays = summary.sleep_streak_days || 0;

  // List of recent activities - only real workouts from the database.
  // When there are no workouts the list is empty (see the empty state in the render).
  // NOTE: dateLabel used to be hard-coded to 'dzisiaj' regardless of selectedDate - when
  // browsing the dashboard for another day (the date picker in App.jsx) the workout card
  // incorrectly said "dzisiaj" for workouts from that other day.
  const todayLocalStr = (() => {
    const d = new Date();
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
  })();
  const activities = (summary.workouts && summary.workouts.length > 0)
    ? summary.workouts.map(w => ({
        type: w.type,
        dateLabel: (!selectedDate || selectedDate === todayLocalStr) ? 'dzisiaj' : selectedDate,
        duration: `${w.duration_mins} min`,
        calories: w.calories
      }))
    : [];

  // State for the built-in chat with the Dietetyk AI assistant
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([
    { sender: 'ai', text: t('Cześć! Jestem Twoim inteligentnym asystentem w aplikacji Dietetyk AI. Przeanalizowałem Twoje dzisiejsze wyniki gotowości (Readiness), snu oraz treningów. W czym mogę Ci pomóc w kontekście diety lub obciążenia treningowego?') }
  ]);
  const [isSendingChat, setIsSendingChat] = useState(false);
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
    setChatMessages(prev => {
      if (prev.length === 1 && prev[0].sender === 'ai') {
        return [{
          sender: 'ai',
          text: t('Cześć! Jestem Twoim inteligentnym asystentem w aplikacji Dietetyk AI. Przeanalizowałem Twoje dzisiejsze wyniki gotowości (Readiness), snu oraz treningów. W czym mogę Ci pomóc w kontekście diety lub obciążenia treningowego?')
        }];
      }
      return prev;
    });
  }, [language]);

  useEffect(() => {
    if (isChatOpen) {
      document.body.style.overflow = 'hidden';
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [chatMessages, isChatOpen]);

  // `overrideText` allows sending a message without writing it into the input field - used by
  // the quick-question chips (round 8), which send ready-made text immediately on click
  // instead of first inserting it into the <input> and waiting for a separate submit.
  const handleSendChat = async (e, overrideText) => {
    if (e && e.preventDefault) e.preventDefault();
    const userMsg = (overrideText !== undefined ? overrideText : chatInput).trim();
    if (!userMsg || isSendingChat) return;

    setChatInput('');
    // We build the new history explicitly (rather than through a closure over `chatMessages`) -
    // setChatMessages below is asynchronous, so the `chatMessages` variable inside this call
    // would still point at the state from BEFORE the current user message was added (a stale
    // closure). Without this fix the backend (routes/chat.js) received a history missing the
    // message that had just been sent - the AI answered without the context of the last question.
    const updatedHistory = [...chatMessages, { sender: 'user', text: userMsg }];
    setChatMessages(updatedHistory);
    setIsSendingChat(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ message: userMsg, date: selectedDate, history: updatedHistory })
      });
      
      if (res.ok) {
        const data = await res.json();
        setChatMessages(prev => [...prev, { sender: 'ai', text: data.response }]);
      } else {
        setChatMessages(prev => [...prev, { sender: 'ai', text: t('Przepraszam, wystąpił problem z połączeniem. Upewnij się, że masz skonfigurowany Gemini API Key w Ustawieniach.') }]);
      }
    } catch (err) {
      setChatMessages(prev => [...prev, { sender: 'ai', text: t('Błąd sieciowy. Nie można połączyć się z asystentem Dietetyk AI.') }]);
    } finally {
      setIsSendingChat(false);
    }
  };

  // Adding water drunk (the quick-add buttons + a custom amount)
  const handleAddWater = async (amountMl) => {
    const amount = Number(amountMl);
    if (!amount || isNaN(amount) || amount <= 0 || isAddingWater) return;
    setIsAddingWater(true);
    setWaterMessage('');
    try {
      const res = await fetch('/api/water/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ date: selectedDate, amount_ml: amount })
      });
      if (res.ok) {
        setCustomWaterAmount('');
        if (onRefresh) onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setWaterMessage(data.error || t('Nie udało się zapisać wody.'));
      }
    } catch (err) {
      setWaterMessage(t('Błąd sieciowy. Nie udało się zapisać wody.'));
    } finally {
      setIsAddingWater(false);
    }
  };

  const handleResetWater = async () => {
    if (isAddingWater) return;
    // F-N1: Potwierdzenie przed resetem licznika wody
    if (!window.confirm(t('Zresetować licznik wody do 0?'))) return;
    setIsAddingWater(true);
    setWaterMessage('');
    try {
      const res = await fetch('/api/water/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ date: selectedDate })
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setWaterMessage(data.error || t('Nie udało się zresetować licznika wody.'));
      }
    } catch (err) {
      setWaterMessage(t('Błąd sieciowy. Nie udało się zresetować licznika wody.'));
    } finally {
      setIsAddingWater(false);
    }
  };

  // formatHoursMins moved to utils/format.js (imported at the top of this file) -
  // the same logic was also duplicated in Trends.jsx and potentially ActivityTracker.jsx.

  // Rendering the AI advice as Markdown (bold, bullet lists).
  // dashboard.js asks Gemini for a Markdown answer - without this conversion React would
  // display "**text**" literally, with the asterisks on screen.
  // We escape the HTML first (the text is LLM-generated and could have copied something from
  // the user), then convert only the known Markdown markers into HTML.
  const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Recognises headings (## Analiza / ### Cos), bullet lists ("- "/"* ") AND numbered ones
  // ("1. ") - the previous version handled only bullet lists and paragraphs, so the new,
  // structured AI answer (the "## Analiza" / "## Rekomendacje" headings from the prompt in
  // dashboard.js) rendered as plain text with visible "##" on screen. We close every
  // list/heading when the line type changes, so an open <ul>/<ol> is never left behind.
  const renderAdviceMarkdown = (text) => {
    if (!text) return '';
    const lines = escapeHtml(text).split('\n');
    let html = '';
    let listType = null; // 'ul' | 'ol' | null
    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };
    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      const headingMatch = line.match(/^(#{2,4})\s+(.*)/);
      const bulletMatch = line.match(/^[*-]\s+(.*)/);
      const orderedMatch = line.match(/^\d+[.)]\s+(.*)/);
      if (headingMatch) {
        closeList();
        const level = headingMatch[1].length >= 4 ? 'h6' : headingMatch[1].length === 3 ? 'h5' : 'h4';
        html += `<${level} class="dietetyk-ai-advice-heading">${headingMatch[2]}</${level}>`;
      } else if (bulletMatch) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${bulletMatch[1]}</li>`;
      } else if (orderedMatch) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += `<li>${orderedMatch[1]}</li>`;
      } else {
        closeList();
        html += line === '' ? '<br/>' : `<p>${line}</p>`;
      }
    });
    closeList();
    return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  };

  const getReadinessColor = () => {
    const score = summary.readiness_score || (wellnessScore?.hasEnoughData ? wellnessScore.wellnessScore : null);
    if (!score) return null;
    if (score >= 85) return '0 0 20px rgba(34, 197, 94, 0.15)';
    if (score >= 70) return '0 0 20px rgba(234, 179, 8, 0.15)';
    return '0 0 20px rgba(239, 68, 68, 0.15)';
  };

  const getReadinessBorder = () => {
    const score = summary.readiness_score || (wellnessScore?.hasEnoughData ? wellnessScore.wellnessScore : null);
    if (!score) return '1px solid rgba(255, 255, 255, 0.04)';
    if (score >= 85) return '1px solid rgba(34, 197, 94, 0.2)';
    if (score >= 70) return '1px solid rgba(234, 179, 8, 0.2)';
    return '1px solid rgba(239, 68, 68, 0.2)';
  };

  return (
    <div className="premium-dashboard-container">
      
      {/* AI RECOVERY HEADER */}
      <div className="dietetyk-ai-banner" style={{ boxShadow: getReadinessColor(), border: getReadinessBorder() }}>
        <div className="premium-title-row">
          <span className="dietetyk-greeting">
            {userProfile?.first_name
              ? (readinessScore >= 80
                  ? `Gotowy na pełne obciążenie, ${userProfile.first_name}!`
                  : `Gotowy na lżejszą pracę, ${userProfile.first_name}!`)
              : (readinessScore >= 80
                  ? t("Dzisiaj wyglądasz na gotowego na pełne obciążenie")
                  : t("Dzisiaj wyglądasz na gotowego do lżejszej pracy"))
            }
          </span>
        </div>
        {aiAdvice && aiAdvice.length > 30 ? (
          <div
            className="dietetyk-ai-advice-text"
            dangerouslySetInnerHTML={{ __html: renderAdviceMarkdown(aiAdvice) }}
          />
        ) : (
          <p className="dietetyk-ai-advice-text">
            {/* F-W1: guard for a null HRV - it printed 'null ms' instead of a value */}
            {`Twoja regeneracja trzyma stabilny poziom (${readinessScore}%). HRV wynosi ${hrv != null ? hrv + ' ms' : '(brak danych)'} i mieści się w normie, więc organizm nie protestuje przeciwko aktywności. Dobrym wyborem będzie lekki tlenowy wysiłek kardio lub sesja mobility.`}
          </p>
        )}
        <button className="btn-dietetyk-ask" onClick={() => setIsChatOpen(true)}>
          ✨ Zapytaj agenta
        </button>
      </div>

      {/* SYNC STATUS - data that had long been collected (last_sync, activity_source)
          but was never surfaced to the user before. */}
      <div data-testid="status-sync-bar" style={{ gridColumn: 'span 2', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', padding: '0 4px', marginTop: '-6px', marginBottom: '4px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
        <span>
          {lastSyncLabel ? `🔄 Zsynchronizowano: ${lastSyncLabel}` : '🔄 Brak jeszcze synchronizacji'}
        </span>
        {activitySourceLabel && (
          <span>· Źródło aktywności: {activitySourceLabel}</span>
        )}
      </div>

      {/* DASHBOARD COLUMNS, TO KEEP THE MASONRY LAYOUT FREE OF EMPTY BLACK AREAS */}
      <div className="dashboard-column">
        {/* THE THREE RINGS: SLEEP, RECOVERY, EFFORT */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚡ Regeneracja i Stan</span>
            <span className="premium-title-info">ⓘ</span>
          </div>
          
          <div className="ring-row">
            {/* Sen */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={84} strokeWidth={7} percentage={sleepScore} color="#38bdf8" />
                <div style={{ position: 'absolute', fontSize: '1.05rem', fontWeight: '800', color: '#fff' }}>
                  {sleepScore}%
                </div>
              </div>
              <span className="ring-item-label">🌙 Sen</span>
            </div>

            {/* Regeneracja */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={96} strokeWidth={8} percentage={readinessScore} color="#ffffff" />
                <div style={{ position: 'absolute', fontSize: '1.25rem', fontWeight: '800', color: '#fff' }}>
                  {readinessScore}%
                </div>
              </div>
              <span className="ring-item-label" style={{ fontWeight: '700', color: '#fff' }}>⚡ Regeneracja</span>
            </div>

            {/* Effort */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={84} strokeWidth={7} percentage={effortScore} color={effortScore > 0 ? "var(--danger)" : "rgba(255,255,255,0.08)"} />
                <div style={{ position: 'absolute', fontSize: '1.05rem', fontWeight: '800', color: '#fff' }}>
                  {effortScore}%
                </div>
              </div>
              <span className="ring-item-label">{t("🔥 Wysiłek")}</span>
            </div>
          </div>
        </div>

        {/* CELE DZIENNE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          <div className="premium-title-row" style={{ padding: '0 4px' }}>
            <span className="premium-title" style={{ fontSize: '1.2rem' }}>Cele dzienne</span>
            <span
              onClick={() => onNavigate && onNavigate('activity')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate && onNavigate('activity'); } }}
              role="button"
              tabIndex={0}
              style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
            >
              Ustaw cele
            </span>
          </div>
          {(calorieStreakDays > 0 || sleepStreakDays > 0) && (
            <div style={{ display: 'flex', gap: '8px', padding: '0 4px', flexWrap: 'wrap' }}>
              {calorieStreakDays > 0 && (
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '4px 10px', borderRadius: '999px' }}>
                  🔥 {calorieStreakDays} {calorieStreakDays === 1 ? t('dzień') : 'dni'} z rzędu w celu kalorycznym
                </span>
              )}
              {sleepStreakDays > 0 && (
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '4px 10px', borderRadius: '999px' }}>
                  😴 {sleepStreakDays} {sleepStreakDays === 1 ? t('dzień') : 'dni'} z rzędu z celem snu
                </span>
              )}
            </div>
          )}
          <div className="premium-grid-2">
            <DailyGoalCard
              title={t("Kroki")}
              val1={steps.toLocaleString('pl-PL')}
              unit1="kroki"
              percentage={goalProgressPct(steps, summary?.target_steps ?? 10000)}
              barType={goalProgressPct(steps, summary?.target_steps ?? 10000) < 30 ? "red" : "gradient"}
            />
            <DailyGoalCard
              title="Aktywne kalorie"
              val1={String(activeCalories)}
              unit1="kcal"
              percentage={goalProgressPct(activeCalories, summary?.target_active_calories ?? 500)}
              barType="gradient"
            />
            <DailyGoalCard
              title="Czas snu"
              val1={String(sleepDurationDisplay.hours)}
              unit1="godz"
              val2={String(sleepDurationDisplay.mins)}
              unit2="min"
              percentage={goalProgressPct(sleepDurationHours, summary?.target_sleep_duration ?? 7.2)}
              barType="gradient"
            />
            <DailyGoalCard
              title={t("Minuty ćwiczeń")}
              val1={String(activeMinutes)}
              unit1="min"
              percentage={goalProgressPct(activeMinutes, summary?.target_active_minutes ?? 30)}
              barType={activeMinutes > 0 ? "gradient" : "grey"}
            />
            <DailyGoalCard
              title="Woda"
              val1={waterMl.toLocaleString('pl-PL')}
              unit1="ml"
              percentage={waterPct}
              barType={waterPct < 30 ? "red" : "gradient"}
            />
          </div>
        </div>

        {/* READINESS TO TRAIN TODAY - below the daily goals, as a direct answer to the
            question "what should I do about activity today?". */}
        {summary?.has_oura && trainingReadiness && trainingReadiness.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🏋️ Gotowość do treningu")}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '10px' }}>
              <span style={{ fontSize: '2.2rem' }}>{trainingReadiness.emoji}</span>
              <div>
                <div style={{ fontSize: '1.1rem', fontWeight: '700', color: trainingReadiness.status === 'TRAIN_HARD' ? 'var(--success-light)' : trainingReadiness.status === 'TRAIN_LIGHT' ? '#fbbf24' : 'var(--danger-light)' }}>
                  {trainingReadiness.label}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                  Score: {trainingReadiness.compositeScore}/100
                </div>
              </div>
            </div>
            <p style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.75)', margin: '0 0 10px' }}>
              {trainingReadiness.advice}
            </p>
            {trainingReadiness.signals && trainingReadiness.signals.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {trainingReadiness.signals.map((sig, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.55)' }}>
                    <span>{sig.status === 'ok' ? '✅' : sig.status === 'warn' ? '⚠️' : '🔴'}</span>
                    <span>{sig.label}</span>
                  </div>
                ))}
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Na podstawie Oury ({trainingReadiness.weekWorkoutDays ?? '–'} treningów w tym tygodniu, {trainingReadiness.recentWorkoutDays ?? '–'} ostatnie 3 dni).
            </p>
          </div>
        )}
        {summary?.has_oura && trainingReadiness && !trainingReadiness.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🏋️ Gotowość do treningu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px', marginBottom: 0 }}>
              Potrzeba co najmniej 14 dni danych z Oury (gotowość lub HRV) aby ocenić gotowość do treningu.
            </p>
          </div>
        )}

        {/* WEEK/MONTH COMPARISON AND THE CUMULATIVE CALORIE BALANCE */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">{t("📊 Porównanie i bilans")}</span>
          </div>
          {isLoadingComparison ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '90%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '70%' }} />
            </div>
          ) : (
            <>
              {nutritionComparison && (nutritionComparison.week.current.avg || nutritionComparison.month.current.avg) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                  {[
                    { label: t('Tydzień'), data: nutritionComparison.week },
                    { label: t('Miesiąc'), data: nutritionComparison.month }
                  ].map(({ label, data }) => (
                    data.current.avg && (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                          {label} · śr. {data.current.avg.calories} kcal/dzień
                        </span>
                        <span style={{
                          fontWeight: '700',
                          color: data.calories_change_pct == null ? 'rgba(255,255,255,0.4)' : data.calories_change_pct > 0 ? 'var(--danger-light)' : data.calories_change_pct < 0 ? 'var(--success-light)' : '#fff'
                        }}>
                          {data.calories_change_pct == null ? t('brak danych do porównania') : `${data.calories_change_pct > 0 ? '+' : ''}${data.calories_change_pct}% vs poprzedni okres`}
                        </span>
                      </div>
                    )
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0' }}>
                  Brak danych - dodaj więcej posiłków, aby zobaczyć porównanie
                </div>
              )}

              {calorieBalance && (calorieBalance.week.days_with_data > 0 || calorieBalance.month.days_with_data > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px' }}>
                  {[
                    { label: '7 dni', data: calorieBalance.week },
                    { label: '30 dni', data: calorieBalance.month }
                  ].map(({ label, data }) => (
                    data.days_with_data > 0 && (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                          Bilans {label} vs cel ({data.days_with_data} {data.days_with_data === 1 ? t('dzień') : 'dni'} z danymi)
                        </span>
                        <span style={{ fontWeight: '700', color: data.balance_vs_target > 0 ? 'var(--danger-light)' : data.balance_vs_target < 0 ? 'var(--success-light)' : '#fff' }}>
                          {data.balance_vs_target > 0 ? '+' : ''}{Math.round(data.balance_vs_target)} kcal
                        </span>
                      </div>
                    )
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ENERGY BATTERY (0-100) - one number for "how much fuel do I have today", charged
            by sleep and discharged by load and the passing of the day. Deliberately ABOVE the
            Wellness Score: the Wellness Score rates how good the day was (behaviour), while
            the battery says how much of the resource is left AS OF NOW - and that is the first
            thing anyone reaches for in the morning. See /api/dashboard/energy-battery. */}
        {energyBattery && energyBattery.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔋 Bateria energii</span>
              {!energyBattery.isLive && (
                <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)' }}>
                  stan na koniec dnia
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginTop: '6px' }}>
              <span style={{ fontSize: '2.4rem', fontWeight: '800', lineHeight: 1, color: batteryColor(energyBattery.battery) }}>
                {energyBattery.battery}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>
                /100 - {energyBattery.label}
              </span>
            </div>

            {/* Charge bar. A progressbar role plus ARIA values, so a screen reader announces
                the number rather than just a coloured rectangle. */}
            <div
              role="progressbar"
              aria-valuenow={energyBattery.battery}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Poziom baterii energii"
              style={{
                marginTop: '12px', height: '14px', borderRadius: '7px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                overflow: 'hidden'
              }}
            >
              <div style={{
                width: `${energyBattery.battery}%`, height: '100%',
                background: batteryColor(energyBattery.battery),
                transition: 'width 0.4s ease'
              }} />
            </div>

            <p style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.8)', marginTop: '12px', marginBottom: '10px' }}>
              {energyBattery.recommendation}
            </p>

            {/* The breakdown: what charged it, what used it. Without this the number is
                unverifiable for the user, which undermines trust in the whole card. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)' }}>
              <span>noc +{energyBattery.components.nightCharge}</span>
              {energyBattery.components.activityDrain > 0 && (
                <span>aktywność −{energyBattery.components.activityDrain}</span>
              )}
              {energyBattery.components.timeDrain > 0 && (
                <span>upływ dnia −{energyBattery.components.timeDrain}</span>
              )}
              {energyBattery.components.debtPenalty > 0 && (
                <span>dług snu −{energyBattery.components.debtPenalty}</span>
              )}
              {energyBattery.components.stressDrain > 0 && (
                <span>stres −{energyBattery.components.stressDrain}</span>
              )}
              {energyBattery.components.stressRecovery > 0 && (
                <span>regeneracja +{energyBattery.components.stressRecovery}</span>
              )}
            </div>

            {energyBattery.sleepDebt.hours > 0 && (
              <p style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', marginTop: '10px', marginBottom: 0 }}>
                Dług snu: <strong style={{ color: 'rgba(255,255,255,0.7)' }}>{energyBattery.sleepDebt.hours} h</strong> z
                ostatnich {energyBattery.sleepDebt.windowDays} dni (cel {energyBattery.sleepDebt.targetSleepHours} h/noc,
                dane z {energyBattery.sleepDebt.nights} nocy).
              </p>
            )}

            {energyBattery.strain.metric && (
              <p style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', marginTop: '6px', marginBottom: 0 }}>
                Obciążenie dziś: {Math.round(energyBattery.strain.ratioToBaseline * 100)}% typowego dnia
                (mediana z 30 dni: {energyBattery.strain.baselineMedian}).
              </p>
            )}

            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Model opisowy na Twoich danych, nie pomiar kliniczny.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 10): WELLNESS SCORE (0-100) - Runda 12 (audyt): wyniesiony
            POZA zwijaną sekcję "Analizy" poniżej. To najbardziej syntetyczny, "na pierwszy
            rzut oka" wskaźnik dnia (jak Oura Readiness/Whoop Recovery) - chowanie go za
            dodatkowym kliknięciem "Pokaż" w 12-kartowej liście było niespójne z jego rolą
            głównego podsumowania, a nie jednej z wielu szczegółowych analiz. */}
        {wellnessScore && wellnessScore.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">✨ Wellness Score</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Syntetyczny wskaźnik dnia z {wellnessScore.componentsUsed}/{wellnessScore.componentsTotal} dostępnych sygnałów (sen, gotowość, RHR, dieta, nawodnienie).
            </p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
              <span style={{ fontSize: '2rem', fontWeight: '800', color: wellnessScore.wellnessScore >= 80 ? 'var(--success-light)' : wellnessScore.wellnessScore >= 60 ? '#fff' : wellnessScore.wellnessScore >= 40 ? '#fbbf24' : 'var(--danger-light)' }}>
                {wellnessScore.wellnessScore}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>/100 - {wellnessScore.label}</span>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Ważona synteza Twoich danych, nie kliniczny pomiar zdrowia.
            </p>
          </div>
        )}

        {/* AI TRAINING PLAN ANALYSIS (Gemini, cached for 7 days). It assesses whether your
            plan is optimal for the body goal. t("Odśwież") -> ?refresh=1 -> a new analysis. */}
        {(trainingPlanInsight || isLoadingTrainingPlan) && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🤖 Analiza planu treningowego AI</span>
              <button
                onClick={() => fetchTrainingPlanInsight(true)}
                disabled={isLoadingTrainingPlan}
                style={{ fontSize: '0.72rem', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', cursor: isLoadingTrainingPlan ? 'not-allowed' : 'pointer', opacity: isLoadingTrainingPlan ? 0.5 : 1 }}
                aria-label={t("Odśwież analizę planu treningowego")}
              >
                {isLoadingTrainingPlan ? t('Generuję…') : t('Odśwież')}
              </button>
            </div>
            {isLoadingTrainingPlan && !trainingPlanInsight && (
              <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginTop: '8px', marginBottom: 0 }}>
                AI analizuje Twój plan treningowy…
              </p>
            )}
            {trainingPlanInsight && !trainingPlanInsight.hasEnoughData && (
              <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginTop: '8px', marginBottom: 0 }}>
                Potrzeba co najmniej 7 treningów z ostatnich 4 tygodni, aby AI mogło ocenić plan.
              </p>
            )}
            {trainingPlanInsight && trainingPlanInsight.hasEnoughData && (
              <>
                {trainingPlanInsight.cached && trainingPlanInsight.generatedAt && (
                  <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '4px', marginBottom: '8px' }}>
                    Analiza z {new Date(trainingPlanInsight.generatedAt).toLocaleDateString('pl-PL')} · cache 7 dni
                  </p>
                )}
                {trainingPlanInsight.overallRating != null && (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '1.6rem', fontWeight: '800', color: trainingPlanInsight.overallRating >= 8 ? 'var(--success-light)' : trainingPlanInsight.overallRating >= 5 ? '#fbbf24' : 'var(--danger-light)' }}>
                      {trainingPlanInsight.overallRating}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>/10</span>
                  </div>
                )}
                {trainingPlanInsight.assessment && (
                  <p style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.8)', margin: '0 0 10px', lineHeight: '1.5' }}>
                    {trainingPlanInsight.assessment}
                  </p>
                )}
                {trainingPlanInsight.missing && trainingPlanInsight.missing.length > 0 && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '5px' }}>Braki w danych:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                      {trainingPlanInsight.missing.map((m, i) => (
                        <span key={i} style={{ fontSize: '0.7rem', background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '5px', padding: '2px 7px' }}>
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {trainingPlanInsight.suggestions && trainingPlanInsight.suggestions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Sugestie AI:</div>
                    {trainingPlanInsight.suggestions.map((sug, i) => (
                      <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '8px 10px' }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: '600', color: '#fff', marginBottom: '3px' }}>
                          {sug.title}
                        </div>
                        <div style={{ fontSize: '0.74rem', color: 'rgba(255,255,255,0.6)', lineHeight: '1.45' }}>
                          {sug.description}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* "DAY TAG" - date ranges marked with a context (illness/holiday/a late bedtime),
            excluded from the norm calculation in selected analyses above. */}
        <div
          className="premium-card"
          role="button"
          tabIndex={0}
          aria-expanded={isDayEventsOpen}
          onClick={() => setIsDayEventsOpen(o => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsDayEventsOpen(o => !o); } }}
          style={{ cursor: 'pointer' }}
        >
          <div className="premium-title-row" style={{ marginBottom: 0 }}>
            <span className="premium-title">🏷️ Tag dnia</span>
            <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
              {isDayEventsOpen ? t('Zwiń ▲') : t('Pokaż ▼')}
            </span>
          </div>
        </div>

        {isDayEventsOpen && (
          <div className="premium-card">
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '12px' }}>
              Oznacz dni choroby, wakacji albo późnego zaśnięcia - takie dni zostaną
              wykluczone z liczenia Twojej normy w wybranych analizach (regeneracja,
              sen, trend wagi, jakość posiłków, efekt weekendu i inne).
            </p>

            <div className="day-event-inputs">
              <select
                value={newEventType}
                onChange={(e) => setNewEventType(e.target.value)}
                className="day-event-select"
                style={{ flex: '1 1 140px' }}
                aria-label="Typ zdarzenia"
              >
                {DAY_EVENT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={newEventStart}
                onChange={(e) => setNewEventStart(e.target.value)}
                className="day-event-date"
                style={{ flex: '1 1 130px' }}
                aria-label="Data od"
              />
              <input
                type="date"
                value={newEventEnd}
                onChange={(e) => setNewEventEnd(e.target.value)}
                className="day-event-date"
                style={{ flex: '1 1 130px' }}
                aria-label="Data do"
              />
            </div>
            <input
              type="text"
              value={newEventNote}
              onChange={(e) => setNewEventNote(e.target.value)}
              placeholder="Notatka (opcjonalnie)"
              maxLength={500}
              className="day-event-note-input"
              style={{ marginBottom: '12px' }}
              aria-label="Notatka"
            />
            <button
              className="btn-primary"
              onClick={handleAddDayEvent}
              disabled={isSavingDayEvent || !newEventStart || !newEventEnd}
            >
              {isSavingDayEvent ? t('Zapisywanie...') : 'Dodaj'}
            </button>
            {dayEventMessage.text && (
              <p style={{ fontSize: '0.78rem', marginTop: '8px', color: dayEventMessage.type === 'error' ? 'var(--danger-light)' : 'var(--success-light)' }}>
                {dayEventMessage.text}
              </p>
            )}

            <div className="day-event-list">
              {isLoadingDayEvents && <div className="shimmer-placeholder" style={{ height: '36px', width: '100%', marginBottom: '10px' }} />}
              {!isLoadingDayEvents && dayEvents.length === 0 && (
                <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: '10px 0' }}>Brak oznaczonych dni.</p>
              )}
              {!isLoadingDayEvents && dayEvents.map(ev => (
                <div key={ev.id} className="day-event-item">
                  <div className="day-event-info">
                    <span className={`day-event-badge ${ev.type}`}>
                      <span>{DAY_EVENT_ICONS[ev.type] || '🏷️'}</span>
                      <span>{DAY_EVENT_TYPE_LABELS[ev.type] || ev.type}</span>
                    </span>
                    <span className="day-event-dates">
                      {ev.start_date}{ev.start_date !== ev.end_date ? ` – ${ev.end_date}` : ''}
                    </span>
                    {ev.note && (
                      <span className="day-event-note">
                        ({ev.note})
                      </span>
                    )}
                  </div>
                  <button
                    className="day-event-delete-btn"
                    onClick={() => handleDeleteDayEvent(ev.id)}
                    aria-label={`Usuń zdarzenie ${DAY_EVENT_TYPE_LABELS[ev.type] || ev.type} ${ev.start_date}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COLLAPSIBLE "ANALIZY" SECTION - 12 cards of descriptive comparisons (sleep,
            sodium, recovery, supplements + 8 new ones from round 7), collapsed by default so
            the dashboard is not flooded the moment it opens (UX round 7, point 1). */}
        <div
          className="premium-card"
          role="button"
          tabIndex={0}
          aria-expanded={isAnalizyOpen}
          onClick={() => setIsAnalizyOpen(o => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsAnalizyOpen(o => !o); } }}
          style={{ cursor: 'pointer' }}
        >
          <div className="premium-title-row" style={{ marginBottom: 0 }}>
            <span className="premium-title">📊 Analizy</span>
            <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
              {isAnalizyOpen ? t('Zwiń ▲') : t('Pokaż ▼')}
            </span>
          </div>
        </div>

        {isAnalizyOpen && (
          <>
        {/* INSIGHT: SLEEP -> NEXT DAY'S NUTRITION */}
        {summary?.has_oura && !isLoadingSleepInsight && sleepInsight && sleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("😴 Sen → następny dzień")}</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['late_sleep']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['late_sleep'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Po nocach krócej niż {sleepInsight.sleepThreshold}h (cel snu) vs po nocach z wystarczającym snem - ostatnie 90 dni
              ({sleepInsight.shortSleepNights} vs {sleepInsight.goodSleepNights} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Kalorie: {sleepInsight.avgCaloriesAfterShortSleep} kcal vs {sleepInsight.avgCaloriesAfterGoodSleep} kcal
                </span>
                <span style={{ fontWeight: '700', color: sleepInsight.caloriesDiff > 0 ? 'var(--danger-light)' : sleepInsight.caloriesDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {sleepInsight.caloriesDiff > 0 ? '+' : ''}{sleepInsight.caloriesDiff} kcal
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Cukier: {sleepInsight.avgSugarAfterShortSleep}g vs {sleepInsight.avgSugarAfterGoodSleep}g
                </span>
                <span style={{ fontWeight: '700', color: sleepInsight.sugarDiff > 0 ? 'var(--danger-light)' : sleepInsight.sugarDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {sleepInsight.sugarDiff > 0 ? '+' : ''}{sleepInsight.sugarDiff} g
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              To porównanie dwóch średnich z Twoich danych, nie dowód naukowy - im więcej dni z danymi, tym bardziej wiarygodne.
            </p>
          </div>
        )}
        {summary?.has_oura && !isLoadingSleepInsight && sleepInsight && !sleepInsight.hasEnoughData && sleepInsight.reason === 'not_enough_nights' && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("😴 Sen → następny dzień")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o śnie i posiłkach (min. {sleepInsight.minNightsRequired} w każdej grupie - krótki/wystarczający sen).
              Obecnie: {sleepInsight.shortSleepNights} vs {sleepInsight.goodSleepNights}.
            </p>
          </div>
        )}

        {/* ALERT/INSIGHT: SODIUM -> BLOOD PRESSURE - the card appears only when there is
            genuinely something to say: today's sodium is high OR we have enough history for a
            personal comparison. Otherwise the card would be empty noise on most days. */}
        {sodiumBpInsight && (sodiumBpInsight.today?.isHigh || sodiumBpInsight.insight?.hasEnoughData) && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🧂 Sód → ciśnienie")}</span>
            </div>
            {sodiumBpInsight.today?.isHigh && (
              <p style={{ fontSize: '0.78rem', color: 'var(--danger-light)', marginTop: '2px', marginBottom: sodiumBpInsight.insight?.hasEnoughData ? '10px' : 0, fontWeight: 600 }}>
                ⚠️ Dziś spożycie sodu: {sodiumBpInsight.today.sodium} mg - powyżej zalecanego dziennego limitu ({sodiumBpInsight.sodiumThresholdMg} mg, wytyczne WHO/AHA).
              </p>
            )}
            {sodiumBpInsight.insight?.hasEnoughData && (
              <>
                <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginBottom: '10px' }}>
                  Dni z wysokim sodem vs dni z sodem w normie - ciśnienie następnego dnia, ostatnie 90 dni
                  ({sodiumBpInsight.insight.highSodiumDays} vs {sodiumBpInsight.insight.normalSodiumDays} dni z danymi).
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      Skurczowe: {sodiumBpInsight.insight.avgSystolicAfterHighSodium} vs {sodiumBpInsight.insight.avgSystolicAfterNormalSodium} mmHg
                    </span>
                    <span style={{ fontWeight: '700', color: sodiumBpInsight.insight.systolicDiff > 0 ? 'var(--danger-light)' : sodiumBpInsight.insight.systolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                      {sodiumBpInsight.insight.systolicDiff > 0 ? '+' : ''}{sodiumBpInsight.insight.systolicDiff} mmHg
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      Rozkurczowe: {sodiumBpInsight.insight.avgDiastolicAfterHighSodium} vs {sodiumBpInsight.insight.avgDiastolicAfterNormalSodium} mmHg
                    </span>
                    <span style={{ fontWeight: '700', color: sodiumBpInsight.insight.diastolicDiff > 0 ? 'var(--danger-light)' : sodiumBpInsight.insight.diastolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                      {sodiumBpInsight.insight.diastolicDiff > 0 ? '+' : ''}{sodiumBpInsight.insight.diastolicDiff} mmHg
                    </span>
                  </div>
                </div>
                <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
                  Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
                </p>
              </>
            )}
          </div>
        )}

        {/* RECOVERY INDICATOR: HRV/RHR AFTER A WORKOUT */}
        {summary?.has_oura && recoveryInsight && recoveryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔄 Regeneracja po treningu</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['illness', 'late_sleep']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['illness', 'late_sleep'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              {/* The "significant" workout threshold (20 min) is set on the backend
                  (SIGNIFICANT_WORKOUT_MIN_MINUTES in dashboard.js) - this is descriptive only. */}
              Dzień po znaczącym treningu (min. 20 min) vs zwykłe dni - ostatnie 90 dni
              ({recoveryInsight.postWorkoutDays} vs {recoveryInsight.otherDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  HRV: {recoveryInsight.avgHrvPostWorkout} vs {recoveryInsight.avgHrvOtherDays} ms
                </span>
                <span style={{ fontWeight: '700', color: recoveryInsight.hrvDiff < 0 ? 'var(--danger-light)' : recoveryInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                  {recoveryInsight.hrvDiff > 0 ? '+' : ''}{recoveryInsight.hrvDiff} ms
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  RHR: {recoveryInsight.avgRhrPostWorkout} vs {recoveryInsight.avgRhrOtherDays} bpm
                </span>
                <span style={{ fontWeight: '700', color: recoveryInsight.rhrDiff > 0 ? 'var(--danger-light)' : recoveryInsight.rhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {recoveryInsight.rhrDiff > 0 ? '+' : ''}{recoveryInsight.rhrDiff} bpm
                </span>
              </div>
            </div>
            {recoveryInsight.latest && (
              <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', marginBottom: 0 }}>
                Ostatni trening ({recoveryInsight.latest.workoutDate}): regeneracja {recoveryInsight.latest.recoveryDate} -
                HRV {recoveryInsight.latest.hrv} ms, RHR {recoveryInsight.latest.rhr} bpm.
              </p>
            )}
            {recoveryInsight.intensitySplit && recoveryInsight.intensitySplit.hasEnoughData && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                  Treningi wysokointensywne (więcej stref Z4-Z5) vs spokojniejsze
                  ({recoveryInsight.intensitySplit.highIntensityDays} vs {recoveryInsight.intensitySplit.lowIntensityDays} dni):
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      HRV: {recoveryInsight.intensitySplit.avgHrvHighIntensity} vs {recoveryInsight.intensitySplit.avgHrvLowIntensity} ms
                    </span>
                    <span style={{ fontWeight: '700', color: recoveryInsight.intensitySplit.hrvDiff < 0 ? 'var(--danger-light)' : recoveryInsight.intensitySplit.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                      {recoveryInsight.intensitySplit.hrvDiff > 0 ? '+' : ''}{recoveryInsight.intensitySplit.hrvDiff} ms
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      RHR: {recoveryInsight.intensitySplit.avgRhrHighIntensity} vs {recoveryInsight.intensitySplit.avgRhrLowIntensity} bpm
                    </span>
                    <span style={{ fontWeight: '700', color: recoveryInsight.intensitySplit.rhrDiff > 0 ? 'var(--danger-light)' : recoveryInsight.intensitySplit.rhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                      {recoveryInsight.intensitySplit.rhrDiff > 0 ? '+' : ''}{recoveryInsight.intensitySplit.rhrDiff} bpm
                    </span>
                  </div>
                </div>
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie diagnoza medyczna.
            </p>
          </div>
        )}

        {/* INSIGHT: SIEDZENIE -> SEN TEJ SAMEJ NOCY */}
        {summary?.has_oura && sedentaryInsight && sedentaryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🪑 Siedzenie → sen</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z czasem siedzącym ≥ Twojej mediany ({sedentaryInsight.medianSedentaryMinutes} min) vs poniżej mediany - ostatnie 90 dni
              ({sedentaryInsight.moreSittingDays} vs {sedentaryInsight.lessSittingDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sedentaryInsight.sleepScoreDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Wynik snu: {sedentaryInsight.avgSleepScoreMoreSitting} vs {sedentaryInsight.avgSleepScoreLessSitting}
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepScoreDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepScoreDiff > 0 ? '+' : ''}{sedentaryInsight.sleepScoreDiff}
                  </span>
                </div>
              )}
              {sedentaryInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {sedentaryInsight.avgSleepDeepMoreSitting} vs {sedentaryInsight.avgSleepDeepLessSitting} min
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepDeepDiff > 0 ? '+' : ''}{sedentaryInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
              {sedentaryInsight.sleepRemDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen REM: {sedentaryInsight.avgSleepRemMoreSitting} vs {sedentaryInsight.avgSleepRemLessSitting} min
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepRemDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepRemDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepRemDiff > 0 ? '+' : ''}{sedentaryInsight.sleepRemDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: FIBRE -> DEEP/REM SLEEP THE SAME NIGHT */}
        {summary?.has_oura && fiberSleepInsight && fiberSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🌾 Błonnik → sen")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni ze spożyciem błonnika ≥ Twojej mediany ({fiberSleepInsight.medianFiberGrams} g) vs poniżej mediany, ten sam dzień - ostatnie 90 dni
              ({fiberSleepInsight.moreFiberDays} vs {fiberSleepInsight.lessFiberDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {fiberSleepInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {fiberSleepInsight.avgSleepDeepMoreFiber} vs {fiberSleepInsight.avgSleepDeepLessFiber} min
                  </span>
                  <span style={{ fontWeight: '700', color: fiberSleepInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : fiberSleepInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {fiberSleepInsight.sleepDeepDiff > 0 ? '+' : ''}{fiberSleepInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
              {fiberSleepInsight.sleepRemDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen REM: {fiberSleepInsight.avgSleepRemMoreFiber} vs {fiberSleepInsight.avgSleepRemLessFiber} min
                  </span>
                  <span style={{ fontWeight: '700', color: fiberSleepInsight.sleepRemDiff < 0 ? 'var(--danger-light)' : fiberSleepInsight.sleepRemDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {fiberSleepInsight.sleepRemDiff > 0 ? '+' : ''}{fiberSleepInsight.sleepRemDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* BODY RECOMPOSITION DETECTOR - only when the waist and weight trends diverge */}
        {bodyRecompInsight && bodyRecompInsight.hasEnoughData && bodyRecompInsight.divergentTrend && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📐 Rekompozycja ciała")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Trend obwodu pasa i trend wagi idą w różnych kierunkach - możliwy sygnał zmiany składu ciała (np. przyrost mięśni przy redukcji tkanki tłuszczowej), nie tylko samej wagi.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Pas (trend/tydzień)")}</span>
                <span style={{ fontWeight: '700', color: bodyRecompInsight.waistSlopeCmPerWeek < 0 ? 'var(--success-light)' : bodyRecompInsight.waistSlopeCmPerWeek > 0 ? 'var(--danger-light)' : '#fff' }}>
                  {bodyRecompInsight.waistSlopeCmPerWeek > 0 ? '+' : ''}{bodyRecompInsight.waistSlopeCmPerWeek} cm
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Waga (trend/tydzień)")}</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>
                  {bodyRecompInsight.weightSlopeKgPerWeek > 0 ? '+' : ''}{bodyRecompInsight.weightSlopeKgPerWeek} kg
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Regresja liniowa z Twoich pomiarów, nie pomiar składu ciała (np. DEXA) - traktuj jako wskazówkę, nie fakt.
            </p>
          </div>
        )}

        {/* EARLY OVERLOAD / POSSIBLE INFECTION ALERT - only when the alert is active */}
        {strainAlert && strainAlert.hasEnoughData && strainAlert.alert && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("⚠️ Sygnały przeciążenia")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--danger-light)', marginTop: '2px', marginBottom: '10px', fontWeight: 600 }}>
              Dziś częstość oddechów, odchylenie temperatury i gotowość naraz odbiegają od Twojej średniej z ostatnich {strainAlert.baselineDays} dni - możliwy sygnał przetrenowania lub początku infekcji.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Częstość oddechów")}</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.respiratoryRate} vs śr. {strainAlert.baseline.avgRespiratoryRate}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Odchylenie temperatury</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.temperatureDeviation}°C vs śr. {strainAlert.baseline.avgTemperatureDeviation}°C</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Gotowość")}</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.readinessScore} vs śr. {strainAlert.baseline.avgReadinessScore}</span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Sygnał statystyczny na bazie Twojej własnej historii, NIE diagnoza medyczna - przy złym samopoczuciu skonsultuj się z lekarzem.
            </p>
          </div>
        )}

        {/* INSIGHT: STRESS -> SODIUM/SUGAR THE SAME DAY */}
        {summary?.has_oura && stressNutritionInsight && stressNutritionInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("😰 Stres → odżywianie")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z minutami wysokiego stresu ≥ Twojej mediany ({stressNutritionInsight.medianStressMinutes} min) vs poniżej mediany, ten sam dzień - ostatnie 90 dni
              ({stressNutritionInsight.highStressDays} vs {stressNutritionInsight.lowStressDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {stressNutritionInsight.sodiumDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sód: {stressNutritionInsight.avgSodiumHighStress} vs {stressNutritionInsight.avgSodiumLowStress} mg
                  </span>
                  <span style={{ fontWeight: '700', color: stressNutritionInsight.sodiumDiff > 0 ? 'var(--danger-light)' : stressNutritionInsight.sodiumDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {stressNutritionInsight.sodiumDiff > 0 ? '+' : ''}{stressNutritionInsight.sodiumDiff} mg
                  </span>
                </div>
              )}
              {stressNutritionInsight.sugarDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Cukier: {stressNutritionInsight.avgSugarHighStress} vs {stressNutritionInsight.avgSugarLowStress} g
                  </span>
                  <span style={{ fontWeight: '700', color: stressNutritionInsight.sugarDiff > 0 ? 'var(--danger-light)' : stressNutritionInsight.sugarDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {stressNutritionInsight.sugarDiff > 0 ? '+' : ''}{stressNutritionInsight.sugarDiff} g
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: MEALS PER DAY -> HITTING THE CALORIE GOAL */}
        {mealFreqInsight && mealFreqInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🍽️ Częstość posiłków → cel")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni, w których trafiłeś w cel kaloryczny (±15%) vs dni, w których nie - ostatnie 90 dni
              ({mealFreqInsight.onTargetDays} vs {mealFreqInsight.offTargetDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                Śr. liczba posiłków: {mealFreqInsight.avgMealCountOnTarget} vs {mealFreqInsight.avgMealCountOffTarget}
              </span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {mealFreqInsight.mealCountDiff > 0 ? '+' : ''}{mealFreqInsight.mealCountDiff}
              </span>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: PASA TRZYMANIA CELU -> REGENERACJA PO PRZERWANIU */}
        {summary?.has_oura && streakDriftInsight && streakDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥 Passa celu → regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni w trakcie passy trzymania celu kalorycznego (min. {streakDriftInsight.streakMinLength} dni z rzędu) vs dzień bezpośrednio po jej przerwaniu
              ({streakDriftInsight.streakDays} vs {streakDriftInsight.breakDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {streakDriftInsight.hrvDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    HRV: {streakDriftInsight.avgHrvDuringStreak} vs {streakDriftInsight.avgHrvAfterBreak} ms
                  </span>
                  <span style={{ fontWeight: '700', color: streakDriftInsight.hrvDiff < 0 ? 'var(--danger-light)' : streakDriftInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {streakDriftInsight.hrvDiff > 0 ? '+' : ''}{streakDriftInsight.hrvDiff} ms
                  </span>
                </div>
              )}
              {streakDriftInsight.readinessDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Gotowość: {streakDriftInsight.avgReadinessDuringStreak} vs {streakDriftInsight.avgReadinessAfterBreak}
                  </span>
                  <span style={{ fontWeight: '700', color: streakDriftInsight.readinessDiff < 0 ? 'var(--danger-light)' : streakDriftInsight.readinessDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {streakDriftInsight.readinessDiff > 0 ? '+' : ''}{streakDriftInsight.readinessDiff}
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (round 8): RESTING HEART RATE TREND */}
        {summary?.has_oura && rhrDriftInsight && rhrDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("❤️ Trend tętna spoczynkowego")}</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['illness']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['illness'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie RHR z ostatnich {rhrDriftInsight.recentDays} dni vs Twoja własna baseline z poprzedzających {rhrDriftInsight.baselineDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  RHR: {rhrDriftInsight.avgRecentRhr} vs {rhrDriftInsight.avgBaselineRhr} bpm
                </span>
                <span style={{ fontWeight: '700', color: rhrDriftInsight.rhrDiff > 0 ? 'var(--danger-light)' : rhrDriftInsight.rhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {rhrDriftInsight.rhrDiff > 0 ? '+' : ''}{rhrDriftInsight.rhrDiff} bpm
                </span>
              </div>
            </div>
            {rhrDriftInsight.isElevated && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Tętno spoczynkowe ostatnio podniesione względem Twojej baseline - może to być sygnał przemęczenia, stresu albo zaczynającej się infekcji.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (round 8): TIME OF THE LAST MEAL -> SLEEP */}
        {summary?.has_oura && mealTimingSleepInsight && mealTimingSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🍽️ Godzina posiłku → sen")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Twoja mediana godziny ostatniego posiłku to {mealTimingSleepInsight.medianLastMealHour}. Porównanie snu w dniach z późniejszym ({mealTimingSleepInsight.laterEatingDays} dni) vs wcześniejszym ({mealTimingSleepInsight.earlierEatingDays} dni) ostatnim posiłkiem.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {mealTimingSleepInsight.sleepScoreDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Wynik snu: {mealTimingSleepInsight.avgSleepScoreLaterEating} vs {mealTimingSleepInsight.avgSleepScoreEarlierEating}
                  </span>
                  <span style={{ fontWeight: '700', color: mealTimingSleepInsight.sleepScoreDiff < 0 ? 'var(--danger-light)' : mealTimingSleepInsight.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {mealTimingSleepInsight.sleepScoreDiff > 0 ? '+' : ''}{mealTimingSleepInsight.sleepScoreDiff}
                  </span>
                </div>
              )}
              {mealTimingSleepInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {mealTimingSleepInsight.avgSleepDeepLaterEating} vs {mealTimingSleepInsight.avgSleepDeepEarlierEating} min
                  </span>
                  <span style={{ fontWeight: '700', color: mealTimingSleepInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : mealTimingSleepInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {mealTimingSleepInsight.sleepDeepDiff > 0 ? '+' : ''}{mealTimingSleepInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (round 9): STANDALONE BLOOD PRESSURE TREND */}
        {bpTrendInsight && bpTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🩺 Trend ciśnienia krwi")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie ciśnienie z ostatnich {bpTrendInsight.recentDays} dni vs Twoja własna baseline z poprzedzających {bpTrendInsight.baselineDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Skurczowe: {bpTrendInsight.avgRecentSystolic} vs {bpTrendInsight.avgBaselineSystolic} mmHg
                </span>
                <span style={{ fontWeight: '700', color: bpTrendInsight.systolicDiff > 0 ? 'var(--danger-light)' : bpTrendInsight.systolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {bpTrendInsight.systolicDiff > 0 ? '+' : ''}{bpTrendInsight.systolicDiff}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Rozkurczowe: {bpTrendInsight.avgRecentDiastolic} vs {bpTrendInsight.avgBaselineDiastolic} mmHg
                </span>
                <span style={{ fontWeight: '700', color: bpTrendInsight.diastolicDiff > 0 ? 'var(--danger-light)' : bpTrendInsight.diastolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {bpTrendInsight.diastolicDiff > 0 ? '+' : ''}{bpTrendInsight.diastolicDiff}
                </span>
              </div>
            </div>
            {bpTrendInsight.recentCategory && bpTrendInsight.recentCategory !== 'Prawidłowe' && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Kategoria ostatnich odczytów: {bpTrendInsight.recentCategory} (wg uproszczonych progów AHA).
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie diagnoza medyczna. Skonsultuj się z lekarzem przy niepokojących odczytach.
            </p>
          </div>
        )}

        {/* SUPLEMENTY + NAWODNIENIE — 2 kolumny obok siebie (auto-fit: jedna kolumna
            jeśli tylko jeden insight ma dane, dwie jeśli oba są dostępne) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>

        {/* SUPLEMENTY VS SEN/REGENERACJA */}
        {summary?.has_oura && supplementsSleepInsight && supplementsSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💊 Suplementy vs sen i regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z danym suplementem vs bez niego, ten sam dzień - ostatnie {supplementsSleepInsight.lookbackDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {supplementsSleepInsight.findings.map((f) => (
                <div key={f.supplement} style={{ paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff', marginBottom: '4px', overflowWrap: 'break-word' }}>
                    {f.supplement} <span style={{ fontWeight: '400', color: 'rgba(255,255,255,0.4)' }}>({f.daysWith} vs {f.daysWithout} dni)</span>
                  </div>
                  {f.sleepScoreDiff != null && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                        Sen: {f.avgSleepScoreWith} vs {f.avgSleepScoreWithout}
                      </span>
                      <span style={{ fontWeight: '700', color: f.sleepScoreDiff < 0 ? 'var(--danger-light)' : f.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                        {f.sleepScoreDiff > 0 ? '+' : ''}{f.sleepScoreDiff}
                      </span>
                    </div>
                  )}
                  {f.readinessScoreDiff != null && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                        Gotowość: {f.avgReadinessScoreWith} vs {f.avgReadinessScoreWithout}
                      </span>
                      <span style={{ fontWeight: '700', color: f.readinessScoreDiff < 0 ? 'var(--danger-light)' : f.readinessScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                        {f.readinessScoreDiff > 0 ? '+' : ''}{f.readinessScoreDiff}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód skuteczności suplementu.
            </p>
          </div>
        )}

        {/* INSIGHT: HYDRATION -> READINESS/HRV/RHR */}
        {summary?.has_oura && hydrationInsight && hydrationInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💧 Nawodnienie → regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z nawodnieniem ≥ Twojego celu ({hydrationInsight.targetWaterMl} ml) vs dni poniżej celu - ostatnie 90 dni
              ({hydrationInsight.hydratedDays} vs {hydrationInsight.underHydratedDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {hydrationInsight.readinessDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Gotowość: {hydrationInsight.avgReadinessHydrated} vs {hydrationInsight.avgReadinessUnderHydrated}
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.readinessDiff < 0 ? 'var(--danger-light)' : hydrationInsight.readinessDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.readinessDiff > 0 ? '+' : ''}{hydrationInsight.readinessDiff}
                  </span>
                </div>
              )}
              {hydrationInsight.hrvDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    HRV: {hydrationInsight.avgHrvHydrated} vs {hydrationInsight.avgHrvUnderHydrated} ms
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.hrvDiff < 0 ? 'var(--danger-light)' : hydrationInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.hrvDiff > 0 ? '+' : ''}{hydrationInsight.hrvDiff} ms
                  </span>
                </div>
              )}
              {hydrationInsight.nextDayRhrDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    RHR (następny dzień): {hydrationInsight.avgNextDayRhrHydrated} vs {hydrationInsight.avgNextDayRhrUnderHydrated} bpm
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.nextDayRhrDiff > 0 ? 'var(--danger-light)' : hydrationInsight.nextDayRhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.nextDayRhrDiff > 0 ? '+' : ''}{hydrationInsight.nextDayRhrDiff} bpm
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        </div>{/* koniec gridu Suplementy+Nawodnienie */}

        {/* CARD: THE DAY'S WELLBEING (energy + mood, scale 1-5).
            The buttons are rendered inline (with no local component inside the IIFE) so that
            React does not create a new function reference on every render and does not
            perform a pointless unmount/remount of the buttons. */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚡ Samopoczucie dnia</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '4px' }}>
            {/* Wiersz: Energia */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Energia</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[['😴',t('Bardzo niska')],['😕',t('Niska')],['😐',t('Średnia')],['😊',t('Wysoka')],['⚡',t('Bardzo wysoka')]].map(([emoji, label], i) => {
                  const val = i + 1;
                  const isActive = energyLevel === val;
                  return (
                    <button key={val} onClick={() => setEnergyLevel(isActive ? null : val)} title={label}
                      aria-label={`Energia: ${label}`} aria-pressed={isActive}
                      style={{ flex: 1, padding: '8px 4px', borderRadius: '8px', cursor: 'pointer', fontSize: '1.3rem', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                        border: isActive ? '1.5px solid var(--color-secondary)' : '1.5px solid rgba(255,255,255,0.08)',
                        background: isActive ? 'rgba(108,200,120,0.15)' : 'rgba(255,255,255,0.04)' }}>
                      {emoji}
                      <span style={{ fontSize: '0.6rem', color: isActive ? 'var(--color-secondary)' : 'rgba(255,255,255,0.35)' }}>{val}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Row: mood */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t("Nastrój")}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[['😞',t('Bardzo zły')],['😔',t('Zły')],['😐',t('Neutralny')],['🙂',t('Dobry')],['😄',t('Świetny')]].map(([emoji, label], i) => {
                  const val = i + 1;
                  const isActive = moodLevel === val;
                  return (
                    <button key={val} onClick={() => setMoodLevel(isActive ? null : val)} title={label}
                      aria-label={`Nastrój: ${label}`} aria-pressed={isActive}
                      style={{ flex: 1, padding: '8px 4px', borderRadius: '8px', cursor: 'pointer', fontSize: '1.3rem', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                        border: isActive ? '1.5px solid var(--color-secondary)' : '1.5px solid rgba(255,255,255,0.08)',
                        background: isActive ? 'rgba(108,200,120,0.15)' : 'rgba(255,255,255,0.04)' }}>
                      {emoji}
                      <span style={{ fontSize: '0.6rem', color: isActive ? 'var(--color-secondary)' : 'rgba(255,255,255,0.35)' }}>{val}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '2px' }}>
              <span style={{ fontSize: '0.75rem', color: feelingMessage.type === 'success' ? 'var(--color-secondary)' : feelingMessage.type === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.3)' }}>
                {feelingMessage.text || t('Dane pomogą AI w analizie Twojego samopoczucia')}
              </span>
              <button className="btn-primary" disabled={isSavingFeeling} onClick={handleSaveFeeling}
                style={{ padding: '6px 18px', fontSize: '0.8rem' }}>
                {isSavingFeeling ? t('Zapisywanie...') : 'Zapisz'}
              </button>
            </div>
          </div>
        </div>

        {/* INSIGHT: REAL CARDIO ZONES FROM WORKOUTS (measured by heart rate, not a formula) */}
        {hrZonesInsight && hrZonesInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🔥 Realne strefy kardio z treningów")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Suma minut w strefach tętna zmierzonych podczas {hrZonesInsight.workoutsWithZoneData} treningów z ostatnich {hrZonesInsight.windowDays} dni (zegarek, nie szacowanie).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[
                { key: 'zone1', label: 'Strefa 1', color: '#60a5fa' },
                { key: 'zone2', label: 'Strefa 2', color: '#34d399' },
                { key: 'zone3', label: 'Strefa 3', color: '#fbbf24' },
                { key: 'zone4', label: 'Strefa 4', color: '#f87171' },
                { key: 'zone5', label: 'Strefa 5', color: '#ef4444' }
              ].map(z => {
                const mins = hrZonesInsight.zoneMinutes[z.key] || 0;
                const pct = hrZonesInsight.totalMinutes > 0 ? Math.round((mins / hrZonesInsight.totalMinutes) * 100) : 0;
                return (
                  <div key={z.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: '58px' }}>{z.label}</span>
                    <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: z.color, borderRadius: '4px' }} />
                    </div>
                    <span style={{ fontWeight: '700', color: '#fff', minWidth: '54px', textAlign: 'right' }}>{mins} min</span>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Personalizowaną rekomendację, w jakiej strefie trenować względem Twojego celu sylwetki, znajdziesz w porównaniu z poradą AI powyżej.
            </p>
          </div>
        )}

        {/* INSIGHT: MEAL QUALITY TREND (health_rating) */}
        {mealQualityTrendInsight && mealQualityTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🥗 Trend jakości posiłków")}</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['vacation']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['vacation'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnia ocena zdrowotności posiłków (AI, skala 1-10) - ostatnie 14 dni vs poprzedzające 30 dni
              ({mealQualityTrendInsight.recentRatedMeals} vs {mealQualityTrendInsight.baselineRatedMeals} ocenionych posiłków).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {mealQualityTrendInsight.avgRecentRating} vs {mealQualityTrendInsight.avgBaselineRating} / 10
              </span>
              <span style={{ fontWeight: '700', color: mealQualityTrendInsight.ratingDiff > 0 ? 'var(--success-light)' : mealQualityTrendInsight.ratingDiff < 0 ? 'var(--danger-light)' : '#fff' }}>
                {mealQualityTrendInsight.ratingDiff > 0 ? '+' : ''}{mealQualityTrendInsight.ratingDiff}
              </span>
            </div>
          </div>
        )}

        {/* INSIGHT: EFEKT WEEKENDU */}
        {weekendEffectInsight && weekendEffectInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📅 Efekt weekendu</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['vacation']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['vacation'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni robocze vs weekend - ostatnie 4 tygodnie ({weekendEffectInsight.weekdayDaysLogged} vs {weekendEffectInsight.weekendDaysLogged} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Kalorie: {weekendEffectInsight.avgWeekdayCalories} vs {weekendEffectInsight.avgWeekendCalories} kcal
                </span>
                <span style={{ fontWeight: '700', color: weekendEffectInsight.caloriesDiff > 0 ? 'var(--danger-light)' : weekendEffectInsight.caloriesDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {weekendEffectInsight.caloriesDiff > 0 ? '+' : ''}{weekendEffectInsight.caloriesDiff} kcal
                </span>
              </div>
              {weekendEffectInsight.avgWeekdaySteps != null && weekendEffectInsight.avgWeekendSteps != null && (() => {
                const stepsDiff = weekendEffectInsight.avgWeekendSteps - weekendEffectInsight.avgWeekdaySteps;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>Kroki: {weekendEffectInsight.avgWeekdaySteps} vs {weekendEffectInsight.avgWeekendSteps}</span>
                    <span style={{ fontWeight: '700', color: stepsDiff > 0 ? 'var(--success-light)' : stepsDiff < 0 ? 'var(--danger-light)' : '#fff' }}>
                      {stepsDiff > 0 ? '+' : ''}{stepsDiff}
                    </span>
                  </div>
                );
              })()}
              {weekendEffectInsight.avgWeekdayActiveCalories != null && weekendEffectInsight.avgWeekendActiveCalories != null && (() => {
                const activeCalDiff = weekendEffectInsight.avgWeekendActiveCalories - weekendEffectInsight.avgWeekdayActiveCalories;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>Kalorie aktywne: {weekendEffectInsight.avgWeekdayActiveCalories} vs {weekendEffectInsight.avgWeekendActiveCalories} kcal</span>
                    <span style={{ fontWeight: '700', color: activeCalDiff > 0 ? 'var(--success-light)' : activeCalDiff < 0 ? 'var(--danger-light)' : '#fff' }}>
                      {activeCalDiff > 0 ? '+' : ''}{activeCalDiff} kcal
                    </span>
                  </div>
                );
              })()}
              {weekendEffectInsight.avgWeekdaySleepScore != null && weekendEffectInsight.avgWeekendSleepScore != null && (() => {
                const sleepDiff = weekendEffectInsight.avgWeekendSleepScore - weekendEffectInsight.avgWeekdaySleepScore;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>Wynik snu: {weekendEffectInsight.avgWeekdaySleepScore} vs {weekendEffectInsight.avgWeekendSleepScore}</span>
                    <span style={{ fontWeight: '700', color: sleepDiff > 0 ? 'var(--success-light)' : sleepDiff < 0 ? 'var(--danger-light)' : '#fff' }}>
                      {sleepDiff > 0 ? '+' : ''}{sleepDiff}
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* INSIGHT: CALORIE EFFICIENCY PER WORKOUT TYPE */}
        {workoutEfficiencyInsight && workoutEfficiencyInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("⚡ Efektywność kalorii per trening")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie spalanie kcal/min wg typu treningu - ostatnie {workoutEfficiencyInsight.windowDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {workoutEfficiencyInsight.types.map(t => (
                <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t.type} ({t.count}x, śr. {t.avgDurationMin} min)</span>
                  <span style={{ fontWeight: '700', color: '#fff' }}>{t.avgKcalPerMin} kcal/min</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* INSIGHT: STABILITY OF FAVOURITE MEALS (DRIFT) */}
        {favoriteMealDriftInsight && favoriteMealDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🔁 Stabilność ulubionych posiłków")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Posiłki zapisywane pod tym samym opisem - porównanie starszych i nowszych wystąpień (ostatnie 180 dni,
              {' '}{favoriteMealDriftInsight.mealsAnalyzed} powtarzających się posiłków).
            </p>
            {favoriteMealDriftInsight.findings.length === 0 ? (
              <p style={{ fontSize: '0.78rem', color: 'var(--success-light)', marginBottom: 0 }}>
                Brak istotnego dryfu kalorycznego - Twoje ulubione posiłki są stabilne.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {favoriteMealDriftInsight.findings.map((f, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', gap: '8px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.rawText} ({f.olderAvgCalories} → {f.newerAvgCalories} kcal)
                    </span>
                    <span style={{ fontWeight: '700', color: f.diffPercent > 0 ? 'var(--danger-light)' : 'var(--success-light)', flexShrink: 0 }}>
                      {f.diffPercent > 0 ? '+' : ''}{f.diffPercent}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* INSIGHT (round 11): AI THAT EXPLAINS THE CAUSES (Oura Advisor / Whoop Coach style) */}
        {/* Round 12 (audit): an explicit loading state - instead of a card that simply did not
            exist until the API responded (which looked like a missing insight, not loading). */}
        {summary?.has_oura && isLoadingAiExplanation && !aiExplanationInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔎 Dlaczego dzisiaj tak jest?</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '85%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '100%' }} />
            </div>
          </div>
        )}
        {summary?.has_oura && aiExplanationInsight && aiExplanationInsight.hasEnoughData && aiExplanationInsight.hasFinding && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔎 Dlaczego dzisiaj tak jest?</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              {aiExplanationInsight.label} odchyla się dziś o {Math.abs(aiExplanationInsight.zScore)} odch. std. od Twojego 28-dniowego wzorca.
            </p>
            {aiExplanationInsight.explanation ? (
              <p style={{ fontSize: '0.85rem', color: '#fff', marginTop: 0, marginBottom: 0, lineHeight: '1.5' }}>
                {aiExplanationInsight.explanation}
              </p>
            ) : aiExplanationInsight.generating ? (
              <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', marginTop: 0, marginBottom: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="ai-explanation-spinner" aria-hidden="true" />
                AI analizuje przyczynę...
              </p>
            ) : (
              <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', marginTop: 0, marginBottom: 0 }}>
                Nie udało się wygenerować wyjaśnienia (sprawdź klucz AI w Ustawieniach).
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Wyjaśnienie generowane przez AI na bazie Twoich danych - nie diagnoza medyczna.
            </p>
          </div>
        )}
        {/* Empty state: the data is sufficient, but the AI found no significant deviation
            today (a z-score below the threshold) - without this the card simply did not
            appear, which the user could read as an error or missing data rather than
            "everything is normal". */}
        {summary?.has_oura && !isLoadingAiExplanation && aiExplanationInsight && aiExplanationInsight.hasEnoughData && !aiExplanationInsight.hasFinding && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔎 Dlaczego dzisiaj tak jest?</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Dziś żadna z Twoich metryk nie odchyla się wyraźnie od 28-dniowego wzorca - wszystko w normie.
            </p>
          </div>
        )}

        {/* INSIGHT (round 11): BENCHMARK "YOU TODAY VS YOU IN THE PAST" (no comparison with other users) */}
        {isLoadingSelfBenchmark && !selfBenchmarkInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📊 Ty dziś vs Ty w przeszłości")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {summary?.has_oura && selfBenchmarkInsight && selfBenchmarkInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📊 Ty dziś vs Ty w przeszłości")}</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['illness']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['illness'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Na bazie Twoich ostatnich {selfBenchmarkInsight.lookbackDays} dni - wyłącznie Twoja historia, bez porównań z innymi użytkownikami. Percentyl 100 = Twój najlepszy dzień, niezależnie od metryki.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: selfBenchmarkInsight.worst ? '8px' : 0 }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {selfBenchmarkInsight.best.label}
                {selfBenchmarkInsight.best.higherIsBetter === false && (
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>{t("(niżej = lepiej)")}</span>
                )}
                {selfBenchmarkInsight.best.todayValue != null && (
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}> · {selfBenchmarkInsight.best.todayValue}{selfBenchmarkInsight.best.unit ? ` ${selfBenchmarkInsight.best.unit}` : ''}</span>
                )}
              </span>
              <span style={{ fontWeight: '700', color: 'var(--success-light)' }}>
                lepszy niż {selfBenchmarkInsight.best.percentile}% Twoich dni
              </span>
            </div>
            {selfBenchmarkInsight.worst && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {selfBenchmarkInsight.worst.label}
                  {selfBenchmarkInsight.worst.higherIsBetter === false && (
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}>{t("(niżej = lepiej)")}</span>
                  )}
                  {selfBenchmarkInsight.worst.todayValue != null && (
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}> · {selfBenchmarkInsight.worst.todayValue}{selfBenchmarkInsight.worst.unit ? ` ${selfBenchmarkInsight.worst.unit}` : ''}</span>
                  )}
                </span>
                <span style={{ fontWeight: '700', color: selfBenchmarkInsight.worst.percentile < 30 ? 'var(--danger-light)' : '#fff' }}>
                  lepszy niż {selfBenchmarkInsight.worst.percentile}% Twoich dni
                </span>
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Percentyl względem Twoich własnych dni z ostatnich {selfBenchmarkInsight.lookbackDays} dni.
            </p>
          </div>
        )}
        {!isLoadingSelfBenchmark && selfBenchmarkInsight && !selfBenchmarkInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📊 Ty dziś vs Ty w przeszłości")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {selfBenchmarkInsight.reason === 'no_data_for_date'
                ? t('Brak danych zdrowia/posiłków dla tego dnia.')
                : `Za mało dni z historią do porównania (min. ${selfBenchmarkInsight.minDaysRequired || 14}).`}
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 10): TREND SpO2 */}
        {summary?.has_oura && spo2TrendInsight && spo2TrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🫁 Trend SpO2</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['illness']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['illness'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie SpO2 z ostatnich {spo2TrendInsight.recentDays} dni vs Twoja własna baseline z poprzedzających {spo2TrendInsight.baselineDays} dni.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                SpO2: {spo2TrendInsight.avgRecentSpo2}% vs {spo2TrendInsight.avgBaselineSpo2}%
              </span>
              <span style={{ fontWeight: '700', color: spo2TrendInsight.spo2Diff < 0 ? 'var(--danger-light)' : 'var(--success-light)' }}>
                {spo2TrendInsight.spo2Diff > 0 ? '+' : ''}{spo2TrendInsight.spo2Diff} pp
              </span>
            </div>
            {spo2TrendInsight.isLow && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ SpO2 ostatnio niższe niż Twoja baseline - może to być sygnał problemów z oddychaniem w czasie snu, infekcji albo przebywania na wysokości.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie diagnoza medyczna.
            </p>
          </div>
        )}

        {/* INSIGHT (round 10): WHR */}
        {whrInsight && whrInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📏 Wskaźnik WHR (pas/biodra)")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Z {whrInsight.measurements} pomiarów obwodów z ostatniego roku (najnowszy: {whrInsight.latestDate}).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Aktualny WHR</span>
              <span style={{ fontWeight: '700', color: whrInsight.isAboveMaleThreshold ? 'var(--danger-light)' : '#fff' }}>
                {whrInsight.latestWhr}
              </span>
            </div>
            {(whrInsight.isAboveFemaleThreshold || whrInsight.isAboveMaleThreshold) && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Wartość powyżej progu WHO ({whrInsight.whoThresholdFemale} dla kobiet / {whrInsight.whoThresholdMale} dla mężczyzn) - podwyższone ryzyko sercowo-naczyniowe.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Trend: {whrInsight.whrTrend === 'down' ? 'spadkowy' : whrInsight.whrTrend === 'up' ? 'wzrostowy' : 'stabilny'}. Nie zastępuje konsultacji lekarskiej.
            </p>
          </div>
        )}

        {/* INSIGHT (round 10): BICEPS SYMMETRY */}
        {bodySymmetryInsight && bodySymmetryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💪 Symetria bicepsów")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Z {bodySymmetryInsight.measurements} pomiarów (lewy vs prawy biceps), najnowszy: {bodySymmetryInsight.latestDate}.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Średnia różnica (L - P)")}</span>
              <span style={{ fontWeight: '700', color: bodySymmetryInsight.isAsymmetric ? 'var(--danger-light)' : 'var(--success-light)' }}>
                {bodySymmetryInsight.avgDiffCm > 0 ? '+' : ''}{bodySymmetryInsight.avgDiffCm} cm
              </span>
            </div>
            {bodySymmetryInsight.isAsymmetric && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Dominująca strona: {bodySymmetryInsight.dominantSide === 'left' ? 'lewa' : 'prawa'} (różnica ≥ {bodySymmetryInsight.asymmetryThresholdCm} cm) - rozważ korekcyjne ćwiczenia jednostronne.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Niewielka asymetria jest normalna - liczy się trwałość i kierunek trendu.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 10): TREND TEMPA BIEGU/MARSZU */}
        {paceTrendInsight && paceTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🏃 Trend tempa biegu/marszu</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Przybliżone tempo (dystans dnia / czas treningu) z ostatnich {paceTrendInsight.recentDays} dni vs poprzedzających {paceTrendInsight.baselineDays} dni z jednym treningiem run/walk/hike.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                Tempo: {paceTrendInsight.avgRecentPaceMinPerKm} vs {paceTrendInsight.avgBaselinePaceMinPerKm} min/km
              </span>
              <span style={{ fontWeight: '700', color: paceTrendInsight.isImproving ? 'var(--success-light)' : paceTrendInsight.isSlower ? 'var(--danger-light)' : '#fff' }}>
                {paceTrendInsight.paceDiffMinPerKm > 0 ? '+' : ''}{paceTrendInsight.paceDiffMinPerKm} min/km
              </span>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Przybliżenie z dziennego dystansu - apka nie zapisuje dystansu per trening.
            </p>
          </div>
        )}

        {/* INSIGHT (round 10): WORKOUT VARIETY */}
        {workoutVarietyInsight && workoutVarietyInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🎲 Różnorodność treningów")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Rozkład typów treningów z ostatnich 60 dni ({workoutVarietyInsight.totalWorkouts} treningów, {workoutVarietyInsight.distinctTypes} dyscyplin).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {workoutVarietyInsight.breakdown.slice(0, 5).map((b, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.type}</span>
                  <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{ width: `${b.pct}%`, height: '100%', background: '#60a5fa', borderRadius: '4px' }} />
                  </div>
                  <span style={{ fontWeight: '700', color: '#fff', minWidth: '40px', textAlign: 'right' }}>{b.pct}%</span>
                </div>
              ))}
            </div>
            {workoutVarietyInsight.isImbalanced && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ {workoutVarietyInsight.dominantType} to {workoutVarietyInsight.dominantPct}% wszystkich treningów - rozważ większą różnorodność, by uniknąć przetrenowania jednej grupy mięśniowej/dyscypliny.
              </p>
            )}
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 1): TYP TRENINGU VS SEN TEJ SAMEJ NOCY */}
        {isLoadingWorkoutTypeSleep && !workoutTypeSleepInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🏋️😴 Typ treningu vs sen tej nocy</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {summary?.has_oura && workoutTypeSleepInsight && workoutTypeSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🏋️😴 Typ treningu vs sen tej nocy</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Śr. jakość snu po dniu treningowym danego typu vs dni bez treningu (śr. {workoutTypeSleepInsight.avgRestDaySleepScore}, {workoutTypeSleepInsight.restDays} dni) z ostatnich {workoutTypeSleepInsight.lookbackDays} dni.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: workoutTypeSleepInsight.worst ? '8px' : 0 }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {workoutTypeSleepInsight.best.type} · {workoutTypeSleepInsight.best.avgSleepScore} pkt ({workoutTypeSleepInsight.best.nights} nocy)
              </span>
              <span style={{ fontWeight: '700', color: workoutTypeSleepInsight.best.diffVsRestDays >= 0 ? 'var(--success-light)' : 'var(--danger-light)' }}>
                {workoutTypeSleepInsight.best.diffVsRestDays > 0 ? '+' : ''}{workoutTypeSleepInsight.best.diffVsRestDays}
              </span>
            </div>
            {workoutTypeSleepInsight.worst && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {workoutTypeSleepInsight.worst.type} · {workoutTypeSleepInsight.worst.avgSleepScore} pkt ({workoutTypeSleepInsight.worst.nights} nocy)
                </span>
                <span style={{ fontWeight: '700', color: workoutTypeSleepInsight.worst.diffVsRestDays < 0 ? 'var(--danger-light)' : '#fff' }}>
                  {workoutTypeSleepInsight.worst.diffVsRestDays > 0 ? '+' : ''}{workoutTypeSleepInsight.worst.diffVsRestDays}
                </span>
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Różnica pkt snu vs Twoja przeciętna noc bez treningu tego okresu.
            </p>
          </div>
        )}
        {!isLoadingWorkoutTypeSleep && workoutTypeSleepInsight && !workoutTypeSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🏋️😴 Typ treningu vs sen tej nocy</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {workoutTypeSleepInsight.reason === 'not_enough_rest_days'
                ? `Za mało dni bez treningu z danymi o śnie do porównania (min. ${workoutTypeSleepInsight.minRestDaysRequired}).`
                : `Za mało treningów danego typu z danymi o śnie (min. ${workoutTypeSleepInsight.minWorkoutsPerTypeRequired} na typ).`}
            </p>
          </div>
        )}

        {/* INSIGHT (round 13, new feature 2): MUSCLE MASS VS PROTEIN */}
        {isLoadingMuscleProtein && !muscleProteinInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💪🥩 Masa mięśniowa vs białko")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {muscleProteinInsight && muscleProteinInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💪🥩 Masa mięśniowa vs białko")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Trend masy mięśniowej z ostatnich {muscleProteinInsight.muscleSpanDays} dni ({muscleProteinInsight.muscleMeasurements} pomiarów) i Twoje śr. spożycie białka ({muscleProteinInsight.proteinLoggedDays} dni z logiem).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Trend masy mięśniowej")}</span>
              <span style={{ fontWeight: '700', color: muscleProteinInsight.muscleTrend === 'up' ? 'var(--success-light)' : muscleProteinInsight.muscleTrend === 'down' ? 'var(--danger-light)' : '#fff' }}>
                {muscleProteinInsight.muscleSlopeKgPerWeek > 0 ? '+' : ''}{muscleProteinInsight.muscleSlopeKgPerWeek} kg/tydz.
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                Białko: {muscleProteinInsight.avgProteinGramsPerDay} g/dzień
                {muscleProteinInsight.proteinPerKgBodyweight !== null && ` (${muscleProteinInsight.proteinPerKgBodyweight} g/kg)`}
              </span>
              {muscleProteinInsight.proteinAdequate !== null && (
                <span style={{ fontWeight: '700', color: muscleProteinInsight.proteinAdequate ? 'var(--success-light)' : 'var(--danger-light)' }}>
                  {muscleProteinInsight.proteinAdequate ? t('wystarczające') : `poniżej ${muscleProteinInsight.adequateProteinThresholdGPerKg} g/kg`}
                </span>
              )}
            </div>
          </div>
        )}
        {!isLoadingMuscleProtein && muscleProteinInsight && !muscleProteinInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💪🥩 Masa mięśniowa vs białko")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {muscleProteinInsight.reason === 'not_enough_data'
                ? t('Za mało pomiarów masy mięśniowej lub dni z zalogowanym białkiem.')
                : muscleProteinInsight.reason === 'span_too_short'
                ? t('Pomiary masy mięśniowej obejmują za krótki okres.')
                : t('Brak wyraźnego trendu masy mięśniowej w tym okresie.')}
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 3): ROZJAZD TEMPERATURY OURA VS APPLE WATCH */}
        {isLoadingTemperatureDivergence && !temperatureDivergenceInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🌡️ Rozjazd temperatury Oura/Apple Watch</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {summary?.has_oura && temperatureDivergenceInsight && temperatureDivergenceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🌡️ Rozjazd temperatury Oura/Apple Watch</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Zgodność kierunku wychylenia temperatury (Oura vs Apple Watch) w {temperatureDivergenceInsight.decisiveDays} dniach z jednoznacznym odczytem z obu źródeł.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                Zgodne: {temperatureDivergenceInsight.agreeDays} · Rozjazd: {temperatureDivergenceInsight.divergeDays}
              </span>
              <span style={{ fontWeight: '700', color: temperatureDivergenceInsight.agreementRatePercent >= 70 ? 'var(--success-light)' : 'var(--danger-light)' }}>
                {temperatureDivergenceInsight.agreementRatePercent}% zgodności
              </span>
            </div>
            {temperatureDivergenceInsight.recentDivergentDates.length > 0 && (
              <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
                Ostatnie dni z rozjazdem: {temperatureDivergenceInsight.recentDivergentDates.join(', ')}.
              </p>
            )}
          </div>
        )}
        {!isLoadingTemperatureDivergence && temperatureDivergenceInsight && !temperatureDivergenceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🌡️ Rozjazd temperatury Oura/Apple Watch</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {temperatureDivergenceInsight.reason === 'no_wrist_temperature_data'
                ? 'Brak danych z czujnika temperatury Apple Watch (Series 8+/Ultra).'
                : temperatureDivergenceInsight.reason === 'not_enough_decisive_days'
                ? t('Odczyty z obu źródeł są zbyt blisko własnej średniej (szum pomiaru), by ocenić zgodność kierunku wychylenia.')
                : t('Za mało dni z odczytami temperatury z obu źródeł jednocześnie.')}
            </p>
          </div>
        )}

        {/* INSIGHT (round 13, new feature 4): BODY CIRCUMFERENCE PROPORTIONS */}
        {isLoadingBodyProportions && !bodyProportionsInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📐 Proporcje obwodów ciała")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {bodyProportionsInsight && bodyProportionsInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📐 Proporcje obwodów ciała")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Zmiana proporcji obwodów między pierwszym i ostatnim pomiarem z ostatniego roku. Punkt odniesienia z fizjologii sportu (Adonis Index): ~{bodyProportionsInsight.referenceGoldenRatio}.
            </p>
            {bodyProportionsInsight.shoulderToWaist && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: bodyProportionsInsight.chestToWaist ? '8px' : 0 }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Barki/talia: {bodyProportionsInsight.shoulderToWaist.firstRatio} → {bodyProportionsInsight.shoulderToWaist.lastRatio}
                </span>
                <span style={{ fontWeight: '700', color: bodyProportionsInsight.shoulderToWaist.ratioDiff >= 0 ? 'var(--success-light)' : 'var(--danger-light)' }}>
                  {bodyProportionsInsight.shoulderToWaist.ratioDiff > 0 ? '+' : ''}{bodyProportionsInsight.shoulderToWaist.ratioDiff}
                </span>
              </div>
            )}
            {bodyProportionsInsight.chestToWaist && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Klatka/talia: {bodyProportionsInsight.chestToWaist.firstRatio} → {bodyProportionsInsight.chestToWaist.lastRatio}
                </span>
                <span style={{ fontWeight: '700', color: bodyProportionsInsight.chestToWaist.ratioDiff >= 0 ? 'var(--success-light)' : 'var(--danger-light)' }}>
                  {bodyProportionsInsight.chestToWaist.ratioDiff > 0 ? '+' : ''}{bodyProportionsInsight.chestToWaist.ratioDiff}
                </span>
              </div>
            )}
          </div>
        )}
        {!isLoadingBodyProportions && bodyProportionsInsight && !bodyProportionsInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📐 Proporcje obwodów ciała")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało pomiarów obwodów (barki/klatka i talia), by ocenić zmianę proporcji w czasie.
            </p>
          </div>
        )}

        {/* INSIGHT (round 13, new feature 5): THE DAY'S ACTIVITY VS APPETITE */}
        {isLoadingActivityAppetite && !activityAppetiteInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🔥🍽️ Aktywność dnia vs apetyt")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {activityAppetiteInsight && activityAppetiteInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🔥🍽️ Aktywność dnia vs apetyt")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Śr. kalorie z posiłków w dniach bardziej aktywnych ({activityAppetiteInsight.moreActiveDays} dni, ≥{activityAppetiteInsight.medianActiveCalories} kcal aktywności) vs mniej aktywnych ({activityAppetiteInsight.lessActiveDays} dni).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {activityAppetiteInsight.avgCaloriesMoreActiveDays} vs {activityAppetiteInsight.avgCaloriesLessActiveDays} kcal
              </span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {activityAppetiteInsight.caloriesDiff > 0 ? '+' : ''}{activityAppetiteInsight.caloriesDiff} kcal
              </span>
            </div>
          </div>
        )}
        {!isLoadingActivityAppetite && activityAppetiteInsight && !activityAppetiteInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🔥🍽️ Aktywność dnia vs apetyt")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o aktywności i posiłkach do porównania.
            </p>
          </div>
        )}

        {/* INSIGHT (round 13, new feature 6): DIET QUALITY AND THE RATE OF WEIGHT CHANGE */}
        {isLoadingDietQualityWeightPace && !dietQualityWeightPaceInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🥗⚖️ Jakość diety i tempo zmiany wagi")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {dietQualityWeightPaceInsight && dietQualityWeightPaceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🥗⚖️ Jakość diety i tempo zmiany wagi")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Śr. ocena jakości {dietQualityWeightPaceInsight.ratedMeals} posiłków i tempo zmiany wagi z ostatnich {dietQualityWeightPaceInsight.weightSpanDays} dni ({dietQualityWeightPaceInsight.weightMeasurements} pomiarów) - dwa niezależne fakty z tego okresu.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Śr. ocena posiłków")}</span>
              <span style={{ fontWeight: '700', color: dietQualityWeightPaceInsight.dietQuality === 'high' ? 'var(--success-light)' : dietQualityWeightPaceInsight.dietQuality === 'low' ? 'var(--danger-light)' : '#fff' }}>
                {dietQualityWeightPaceInsight.avgMealRating}/10
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Tempo zmiany wagi</span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {dietQualityWeightPaceInsight.weightSlopeKgPerWeek > 0 ? '+' : ''}{dietQualityWeightPaceInsight.weightSlopeKgPerWeek} kg/tydz.
              </span>
            </div>
          </div>
        )}
        {!isLoadingDietQualityWeightPace && dietQualityWeightPaceInsight && !dietQualityWeightPaceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🥗⚖️ Jakość diety i tempo zmiany wagi")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {dietQualityWeightPaceInsight.reason === 'not_enough_data'
                ? t('Za mało ocenionych posiłków lub pomiarów wagi.')
                : dietQualityWeightPaceInsight.reason === 'span_too_short'
                ? t('Pomiary wagi obejmują za krótki okres.')
                : t('Brak wyraźnego trendu wagi w tym okresie.')}
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 7): PASSA KALORYCZNA VS REALNY EFEKT NA WADZE */}
        {isLoadingStreakWeightEffect && !streakWeightEffectInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥⚖️ Passa kaloryczna vs efekt na wadze</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {streakWeightEffectInsight && streakWeightEffectInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥⚖️ Passa kaloryczna vs efekt na wadze</span>
            </div>
            {getDayEventLabelForDate(selectedDate, ['vacation']) && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['vacation'])} - może to wpływać na statystykę z tego okresu
              </p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Tempo zmiany wagi w dniach z aktywną passą trzymania celu kalorycznego ({streakWeightEffectInsight.streakMinLength}+ dni w paśmie) vs dni bez passy.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>W trakcie passy ({streakWeightEffectInsight.streakWeightPoints} pomiarów)</span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {streakWeightEffectInsight.weightSlopeKgPerWeekDuringStreak > 0 ? '+' : ''}{streakWeightEffectInsight.weightSlopeKgPerWeekDuringStreak} kg/tydz.
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bez passy ({streakWeightEffectInsight.noStreakWeightPoints} pomiarów)</span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {streakWeightEffectInsight.weightSlopeKgPerWeekWithoutStreak > 0 ? '+' : ''}{streakWeightEffectInsight.weightSlopeKgPerWeekWithoutStreak} kg/tydz.
              </span>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Różnica tempa: {streakWeightEffectInsight.slopeDiffKgPerWeek > 0 ? '+' : ''}{streakWeightEffectInsight.slopeDiffKgPerWeek} kg/tydz.
            </p>
          </div>
        )}
        {!isLoadingStreakWeightEffect && streakWeightEffectInsight && !streakWeightEffectInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥⚖️ Passa kaloryczna vs efekt na wadze</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {streakWeightEffectInsight.reason === 'not_enough_data_per_group'
                ? t('Za mało pomiarów wagi w grupie z passą lub bez passy do porównania.')
                : t('Brak wyraźnego trendu wagi w jednej z grup.')}
            </p>
          </div>
        )}

        {/* INSIGHT (round 13, new feature 8): SITTING VS WORKOUT PERFORMANCE */}
        {isLoadingSedentaryPerformance && !sedentaryPerformanceInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🪑🏋️ Siedzenie vs wydajność treningu")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {sedentaryPerformanceInsight && sedentaryPerformanceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🪑🏋️ Siedzenie vs wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Wydajność treningu (kcal/min) w dniach z większą ilością siedzenia (≥{sedentaryPerformanceInsight.medianSedentaryMinutes} min, {sedentaryPerformanceInsight.moreSittingWorkoutDays} dni treningowych) vs mniejszą ({sedentaryPerformanceInsight.lessSittingWorkoutDays} dni).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {sedentaryPerformanceInsight.avgKcalPerMinMoreSitting} vs {sedentaryPerformanceInsight.avgKcalPerMinLessSitting} kcal/min
              </span>
              <span style={{ fontWeight: '700', color: sedentaryPerformanceInsight.performanceDiffKcalPerMin < 0 ? 'var(--danger-light)' : 'var(--success-light)' }}>
                {sedentaryPerformanceInsight.performanceDiffKcalPerMin > 0 ? '+' : ''}{sedentaryPerformanceInsight.performanceDiffKcalPerMin} kcal/min
              </span>
            </div>
          </div>
        )}
        {!isLoadingSedentaryPerformance && sedentaryPerformanceInsight && !sedentaryPerformanceInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🪑🏋️ Siedzenie vs wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni treningowych z danymi o siedzeniu do porównania.
            </p>
          </div>
        )}

        {/* INSIGHT: HYDRATION AND SLEEP QUALITY */}
        {summary?.has_oura && isLoadingWaterSleep && !waterSleepInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💧😴 Woda a jakość snu")}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '80%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          </div>
        )}
        {summary?.has_oura && waterSleepInsight && waterSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💧😴 Woda a jakość snu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '8px' }}>
              Dni z hydratacją ≥{waterSleepInsight.medianWaterMl} ml ({waterSleepInsight.wellHydratedDays} dni) vs &lt;{waterSleepInsight.medianWaterMl} ml ({waterSleepInsight.lessHydratedDays} dni). Ostatnie {waterSleepInsight.totalDays} dni.
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(56,189,248,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Dobrze nawodnione ({waterSleepInsight.avgWaterWell} ml)</div>
                <div style={{ fontSize: '1.1rem', fontWeight: '700', color: '#38bdf8' }}>{waterSleepInsight.avgSleepScoreWellHydrated ?? '–'}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>sleep score</div>
                {waterSleepInsight.avgSleepDeepWellHydrated != null && (
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>sen głęboki: {waterSleepInsight.avgSleepDeepWellHydrated} min</div>
                )}
              </div>
              <div style={{ background: 'rgba(248,113,113,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Słabiej nawodnione ({waterSleepInsight.avgWaterLess} ml)</div>
                <div style={{ fontSize: '1.1rem', fontWeight: '700', color: '#f87171' }}>{waterSleepInsight.avgSleepScoreLessHydrated ?? '–'}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>sleep score</div>
                {waterSleepInsight.avgSleepDeepLessHydrated != null && (
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>sen głęboki: {waterSleepInsight.avgSleepDeepLessHydrated} min</div>
                )}
              </div>
            </div>
            {waterSleepInsight.sleepScoreDiff != null && (
              <div style={{ marginTop: '8px', fontSize: '0.82rem' }}>
                Różnica: <span style={{ fontWeight: '700', color: waterSleepInsight.sleepScoreDiff > 0 ? 'var(--success-light)' : 'var(--danger-light)' }}>
                  {waterSleepInsight.sleepScoreDiff > 0 ? '+' : ''}{waterSleepInsight.sleepScoreDiff} pkt
                </span>
                {waterSleepInsight.sleepScoreDiff > 2
                  ? t(' — lepsze nawodnienie wyraźnie poprawia sen.')
                  : waterSleepInsight.sleepScoreDiff < -2
                    ? t(' — brak wyraźnego efektu nawodnienia na sen.')
                    : ' — efekt nawodnienia na sen jest nieznaczny.'}
              </div>
            )}
          </div>
        )}
        {summary?.has_oura && !isLoadingWaterSleep && waterSleepInsight && !waterSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("💧😴 Woda a jakość snu")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o hydratacji i śnie (min. 14 dni).
            </p>
          </div>
        )}

        {/* INSIGHT (round 25): OURA SLEEP -> AW WORKOUT PERFORMANCE (the following day) */}
        {summary?.has_oura && sleepWorkoutPerfInsight && sleepWorkoutPerfInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("😴🏃 Sen → wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Wydajność (kcal/min) po nocach z dobrym snem (score ≥{sleepWorkoutPerfInsight.goodSleepThreshold}) vs słabym (≤{sleepWorkoutPerfInsight.poorSleepThreshold}).
              Ostatnie {sleepWorkoutPerfInsight.lookbackDays} dni ({sleepWorkoutPerfInsight.goodSleepDays} vs {sleepWorkoutPerfInsight.poorSleepDays} treningów).
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t("Po dobrym śnie")}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--success-light)' }}>{sleepWorkoutPerfInsight.avgKcalPerMinAfterGoodSleep}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
              <div style={{ background: 'rgba(248,113,113,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t("Po słabym śnie")}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--danger-light)' }}>{sleepWorkoutPerfInsight.avgKcalPerMinAfterPoorSleep}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
            </div>
            {sleepWorkoutPerfInsight.diff != null && (
              <div style={{ marginTop: '8px', fontSize: '0.82rem' }}>
                Różnica: <span style={{ fontWeight: '700', color: sleepWorkoutPerfInsight.diff > 0 ? 'var(--success-light)' : sleepWorkoutPerfInsight.diff < 0 ? 'var(--danger-light)' : '#fff' }}>
                  {sleepWorkoutPerfInsight.diff > 0 ? '+' : ''}{sleepWorkoutPerfInsight.diff} kcal/min
                </span>
                {Math.abs(sleepWorkoutPerfInsight.diff) >= 1
                  ? (sleepWorkoutPerfInsight.diff > 0
                      ? t(' — po lepszym śnie ćwiczysz wydajniej.')
                      : t(' — jakość snu nie widoczna na wydajności w Twoich danych.'))
                  : t(' — brak wyraźnej różnicy w Twoich danych.')}
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Oura (sen) + Apple Watch (trening). Porównanie dwóch średnich, nie dowód naukowy.
            </p>
          </div>
        )}
        {summary?.has_oura && sleepWorkoutPerfInsight && !sleepWorkoutPerfInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("😴🏃 Sen → wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało danych (potrzeba min. {sleepWorkoutPerfInsight.minRequired ?? 5} treningów po dobrym i złym śnie). Masz: {sleepWorkoutPerfInsight.goodSleepDays ?? 0} vs {sleepWorkoutPerfInsight.poorSleepDays ?? 0}.
            </p>
          </div>
        )}

        {/* INSIGHT (round 25): OURA READINESS -> APPLE WATCH PERFORMANCE */}
        {summary?.has_oura && readinessWorkoutInsight && readinessWorkoutInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🎯 Gotowość → wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Wydajność (kcal/min) przy wysokiej gotowości Oura (≥{readinessWorkoutInsight.highReadinessThreshold} pkt) vs niskiej (≤{readinessWorkoutInsight.lowReadinessThreshold} pkt).
              Ostatnie {readinessWorkoutInsight.lookbackDays} dni ({readinessWorkoutInsight.highReadinessDays} vs {readinessWorkoutInsight.lowReadinessDays} treningów).
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t("Wysoka gotowość")}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--success-light)' }}>{readinessWorkoutInsight.avgKcalPerMinHighReadiness}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
              <div style={{ background: 'rgba(248,113,113,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t("Niska gotowość")}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--danger-light)' }}>{readinessWorkoutInsight.avgKcalPerMinLowReadiness}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
            </div>
            {readinessWorkoutInsight.diff != null && (
              <div style={{ marginTop: '8px', fontSize: '0.82rem' }}>
                Różnica: <span style={{ fontWeight: '700', color: readinessWorkoutInsight.diff > 0 ? 'var(--success-light)' : readinessWorkoutInsight.diff < 0 ? 'var(--danger-light)' : '#fff' }}>
                  {readinessWorkoutInsight.diff > 0 ? '+' : ''}{readinessWorkoutInsight.diff} kcal/min
                </span>
                {Math.abs(readinessWorkoutInsight.diff) >= 1
                  ? (readinessWorkoutInsight.diff > 0
                      ? t(' — wyższy readiness przekłada się na lepszy trening.')
                      : t(' — score gotowości nie widoczny na wydajności w Twoich danych.'))
                  : t(' — brak wyraźnej korelacji.')}
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Oura readiness + Apple Watch. Porównanie dwóch średnich, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (round 25): 80/20 HEART-RATE ZONE POLARISATION (Apple Watch only) */}
        {hrPolarizationInsight && hrPolarizationInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("📊 Polaryzacja stref tętna")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Rozkład wysiłku w strefach z ostatnich {hrPolarizationInsight.lookbackDays} dni ({hrPolarizationInsight.workoutsAnalyzed} treningów, {hrPolarizationInsight.totalZoneMinutes} min ze strefami).
              Teoria 80/20: ≥80% łatwy (Z1-2), ≤15% środkowy (Z3), ≥15% intensywny (Z4-5).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[
                { label: 'Z1 Regeneracja', pct: hrPolarizationInsight.zone1Pct, color: '#38bdf8' },
                { label: 'Z2 Aerobowa', pct: hrPolarizationInsight.zone2Pct, color: '#4ade80' },
                { label: 'Z3 Tempo / "szara strefa"', pct: hrPolarizationInsight.zone3Pct, color: '#fbbf24' },
                { label: t('Z4 Próg anaerobowy'), pct: hrPolarizationInsight.zone4Pct, color: '#fb923c' },
                { label: t('Z5 Maks. wysiłek'), pct: hrPolarizationInsight.zone5Pct, color: '#f87171' },
              ].map(({ label, pct, color }) => (
                <div key={label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '3px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>{label}</span>
                    <span style={{ fontWeight: '700', color }}>{pct}%</span>
                  </div>
                  <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '3px', transition: 'width 0.4s' }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: '10px', fontSize: '0.82rem' }}>
              <span style={{ fontWeight: '700', color: hrPolarizationInsight.isWellPolarized ? 'var(--success-light)' : hrPolarizationInsight.tooMuchGrayZone ? 'var(--danger-light)' : '#fbbf24' }}>
                {hrPolarizationInsight.isWellPolarized
                  ? '✅ Dobra polaryzacja'
                  : hrPolarizationInsight.tooMuchGrayZone
                    ? t('⚠️ Za dużo "szarej strefy" (Z3)')
                    : '⚠️ Nieoptymalna polaryzacja'}
              </span>
              {hrPolarizationInsight.tooMuchGrayZone && (
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>{t("— spróbuj więcej wolnego cardio lub krótkich interwałów Z4-5 zamiast ciągłego Z3.")}</span>
              )}
            </div>
          </div>
        )}

        {/* INSIGHT (round 25): A HARD AW WORKOUT -> OURA HRV/RHR +1/+2 DAYS */}
        {summary?.has_oura && workoutRecoveryHrvInsight && workoutRecoveryHrvInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💪📉 Trening → regeneracja HRV/RHR</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              HRV/RHR dzień po ciężkim treningu (≥{workoutRecoveryHrvInsight.heavyWorkoutMinMinutes} min) vs baseline z ostatnich {workoutRecoveryHrvInsight.lookbackDays} dni ({workoutRecoveryHrvInsight.heavyWorkoutDays} treningów).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {workoutRecoveryHrvInsight.avgHrvDay1 != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("HRV dzień +1 vs baseline")}</span>
                  <span style={{ fontWeight: '700', color: (workoutRecoveryHrvInsight.hrvDiff1 ?? 0) < -3 ? 'var(--danger-light)' : (workoutRecoveryHrvInsight.hrvDiff1 ?? 0) > 3 ? 'var(--success-light)' : '#fff' }}>
                    {workoutRecoveryHrvInsight.avgHrvDay1} ms
                    {workoutRecoveryHrvInsight.hrvDiff1 != null && (
                      <span style={{ fontSize: '0.72rem', marginLeft: '4px' }}>({workoutRecoveryHrvInsight.hrvDiff1 > 0 ? '+' : ''}{workoutRecoveryHrvInsight.hrvDiff1} vs {workoutRecoveryHrvInsight.avgHrvBaseline})</span>
                    )}
                  </span>
                </div>
              )}
              {workoutRecoveryHrvInsight.avgHrvDay2 != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("HRV dzień +2")}</span>
                  <span style={{ fontWeight: '700', color: (workoutRecoveryHrvInsight.hrvDiff2 ?? 0) < -3 ? 'var(--danger-light)' : (workoutRecoveryHrvInsight.hrvDiff2 ?? 0) > 3 ? 'var(--success-light)' : '#fff' }}>
                    {workoutRecoveryHrvInsight.avgHrvDay2} ms
                    {workoutRecoveryHrvInsight.hrvDiff2 != null && (
                      <span style={{ fontSize: '0.72rem', marginLeft: '4px' }}>({workoutRecoveryHrvInsight.hrvDiff2 > 0 ? '+' : ''}{workoutRecoveryHrvInsight.hrvDiff2})</span>
                    )}
                  </span>
                </div>
              )}
              {workoutRecoveryHrvInsight.avgRhrDay1 != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("RHR dzień +1 vs baseline")}</span>
                  <span style={{ fontWeight: '700', color: (workoutRecoveryHrvInsight.rhrDiff1 ?? 0) > 3 ? 'var(--danger-light)' : (workoutRecoveryHrvInsight.rhrDiff1 ?? 0) < -3 ? 'var(--success-light)' : '#fff' }}>
                    {workoutRecoveryHrvInsight.avgRhrDay1} bpm
                    {workoutRecoveryHrvInsight.rhrDiff1 != null && (
                      <span style={{ fontSize: '0.72rem', marginLeft: '4px' }}>({workoutRecoveryHrvInsight.rhrDiff1 > 0 ? '+' : ''}{workoutRecoveryHrvInsight.rhrDiff1} vs {workoutRecoveryHrvInsight.avgRhrBaseline})</span>
                    )}
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Oura (HRV/RHR) + Apple Watch (treningi). Wzrost RHR lub spadek HRV = normalna odpowiedź regeneracyjna.
            </p>
          </div>
        )}

        {/* INSIGHT (round 25): THE GAP BETWEEN WORKOUTS -> PERFORMANCE (Apple Watch only) */}
        {workoutRestPerfInsight && workoutRestPerfInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">{t("🗓️ Przerwa → wydajność treningu")}</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Wydajność (kcal/min) po 0–1 dniach przerwy vs po 2+ dniach odpoczynku.
              Ostatnie {workoutRestPerfInsight.lookbackDays} dni ({workoutRestPerfInsight.fewRestDays} vs {workoutRestPerfInsight.moreRestDays} treningów).
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(251,191,36,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Po 0–1 dniach przerwy</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: '#fbbf24' }}>{workoutRestPerfInsight.avgKcalPerMinFewRest}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
              <div style={{ background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Po 2+ dniach przerwy</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--success-light)' }}>{workoutRestPerfInsight.avgKcalPerMinMoreRest}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
            </div>
            {workoutRestPerfInsight.diff != null && (
              <div style={{ marginTop: '8px', fontSize: '0.82rem' }}>
                Różnica: <span style={{ fontWeight: '700', color: workoutRestPerfInsight.diff > 0 ? 'var(--success-light)' : workoutRestPerfInsight.diff < 0 ? 'var(--danger-light)' : '#fff' }}>
                  {workoutRestPerfInsight.diff > 0 ? '+' : ''}{workoutRestPerfInsight.diff} kcal/min
                </span>
                {Math.abs(workoutRestPerfInsight.diff) >= 1
                  ? (workoutRestPerfInsight.diff > 0
                      ? t(' — dłuższy odpoczynek wyraźnie poprawia wydajność.')
                      : t(' — krótsze przerwy dają lepszą wydajność w Twoich danych.'))
                  : t(' — przerwa nie ma wyraźnego wpływu na wydajność.')}
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Apple Watch. Porównanie dwóch średnich, nie dowód naukowy.
            </p>
          </div>
        )}

          </>
        )}

        {/* PROGNOZA DATY CELU WAGI */}
        {weightGoalForecast && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📈 Prognoza celu wagi</span>
            </div>
            {weightGoalForecast.hasEnoughData ? (
              <>
                {getDayEventLabelForDate(selectedDate, ['vacation']) && (
                  <p style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '2px', marginBottom: '8px' }}>
                    🏷️ Uwaga: wybrany dzień ({selectedDate}) jest oznaczony jako: {getDayEventLabelForDate(selectedDate, ['vacation'])} - może to wpływać na statystykę z tego okresu
                  </p>
                )}
                {weightGoalForecast.status === 'reached' ? (
                  <p style={{ fontSize: '0.85rem', color: 'var(--success-light)', marginBottom: 0 }}>
                    Cel wagi ({weightGoalForecast.targetWeightKg} kg) już osiągnięty - aktualna waga {weightGoalForecast.currentWeight} kg.
                  </p>
                ) : weightGoalForecast.status === 'wrong_direction' ? (
                  <p style={{ fontSize: '0.85rem', color: 'var(--danger-light)', marginBottom: 0 }}>
                    Waga zmienia się w przeciwnym kierunku niż wymaga cel ({weightGoalForecast.targetWeightKg} kg) -
                    tempo: {weightGoalForecast.weeklyWeightChange > 0 ? '+' : ''}{weightGoalForecast.weeklyWeightChange} kg/tydz.
                  </p>
                ) : weightGoalForecast.status === 'stalled' ? (
                  <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginBottom: 0 }}>
                    Waga jest stabilna (brak wyraźnego trendu) - pozostało {Math.abs(weightGoalForecast.remainingKg)} kg do celu {weightGoalForecast.targetWeightKg} kg.
                  </p>
                ) : (
                  <>
                    <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
                      Tempo z ostatnich {weightGoalForecast.spanDays} dni: {weightGoalForecast.weeklyWeightChange > 0 ? '+' : ''}{weightGoalForecast.weeklyWeightChange} kg/tydz.
                      Pozostało {Math.abs(weightGoalForecast.remainingKg)} kg do celu {weightGoalForecast.targetWeightKg} kg.
                    </p>
                    {weightGoalForecast.projectedDate && (
                      <p style={{ fontSize: '0.85rem', fontWeight: '700', color: '#fff', marginBottom: 0 }}>
                        Prognozowana data osiągnięcia celu: {weightGoalForecast.projectedDate}
                      </p>
                    )}
                  </>
                )}
                <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
                  Prognoza z regresji liniowej Twojej wagi z ostatnich {weightGoalForecast.spanDays} dni, nie gwarancja.
                </p>
              </>
            ) : (
              <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
                {weightGoalForecast.reason === 'no_target_weight_set' ? (
                  t('Ustaw swój cel wagi w Ustawieniach, aby aktywować prognozę.')
                ) : (
                  `Za mało pomiarów wagi w ostatnich 60 dniach (zalogowano: ${weightGoalForecast.weightMeasurements || 0} z wymaganych 4 przez co najmniej 14 dni).`
                )}
              </p>
            )}
          </div>
        )}

        {/* ADAPTACYJNA KOREKTA CELU KALORYCZNEGO */}
        {calorieSuggestion && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🎯 Analiza i korekta kalorii</span>
            </div>
            {calorieSuggestion.hasEnoughData ? (
              calorieSuggestion.suggestionNeeded ? (
                <>
                  <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
                    Twój zalogowany bilans i bilans wynikający z realnej zmiany wagi (ostatnie ~3 tygodnie) rozjeżdżają się.
                    To zwykle oznacza niedoszacowane porcje albo nieuwzględnione podjadanie, nie błędnie ustawiony cel.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("Bilans z logów")}</span>
                      <span style={{ fontWeight: '700', color: '#fff' }}>{calorieSuggestion.loggedDailyBalance > 0 ? '+' : ''}{calorieSuggestion.loggedDailyBalance} kcal/dzień</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bilans z realnej wagi</span>
                      <span style={{ fontWeight: '700', color: '#fff' }}>{calorieSuggestion.actualDailyBalance > 0 ? '+' : ''}{calorieSuggestion.actualDailyBalance} kcal/dzień</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginTop: '4px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Obecny cel</span>
                      <span style={{ color: '#fff' }}>{calorieSuggestion.currentTargetCalories} kcal</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Sugerowany cel</span>
                      <span style={{ fontWeight: '700', color: 'var(--success-light)' }}>{calorieSuggestion.suggestedTargetCalories} kcal</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleApplyCalorieSuggestion}
                    disabled={isApplyingCalorieSuggestion}
                    style={{ marginTop: '12px', width: '100%', padding: '8px 14px', fontSize: '0.85rem' }}
                  >
                    {isApplyingCalorieSuggestion ? t('Zapisywanie...') : `Zastosuj cel ${calorieSuggestion.suggestedTargetCalories} kcal`}
                  </button>
                  <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
                    Sugestia oparta na Twoich danych z ostatnich tygodni, nie porada medyczna. Zawsze możesz ustawić cel ręcznie w Aktywności.
                  </p>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <p style={{ fontSize: '0.85rem', color: 'var(--success-light)', fontWeight: '700', marginBottom: '6px' }}>
                    🥗 Bilans pod kontrolą!
                  </p>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)', marginBottom: 0 }}>
                    Twój zalogowany bilans kaloryczny pokrywa się z realnymi zmianami wagi. Jesz dokładnie tyle, ile powinieneś, aby realizować swój cel!
                  </p>
                </div>
              )
            ) : (
              <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
                Zaloguj min. 7 dni z kaloriami i wprowadź min. 4 pomiary wagi w ostatnich 21 dniach, aby odblokować analizę kaloryczną.
              </p>
            )}
          </div>
        )}

        {/* LICZNIK WODY - szybkie dodawanie */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">💧 Nawodnienie</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
              {waterMl.toLocaleString('pl-PL')} / {targetWaterMl.toLocaleString('pl-PL')} ml
            </span>
          </div>

          <div className="daily-goal-progress-container" style={{ margin: '8px 0 14px' }}>
            <div className="daily-goal-progress-track">
              <div
                className={`daily-goal-progress-fill ${waterPct < 30 ? 'red' : 'gradient'}`}
                style={{ width: `${waterPct}%` }}
              ></div>
            </div>
            <div className="daily-goal-pct">{waterPct}%</div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater}
              onClick={() => handleAddWater(250)}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              +250 ml
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater}
              onClick={() => handleAddWater(500)}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              +500 ml
            </button>
            <input
              type="number"
              min="1"
              placeholder={t("Własna (ml)")}
              value={customWaterAmount}
              onChange={(e) => setCustomWaterAmount(e.target.value)}
              style={{
                flex: '1 1 100px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: '#fff',
                padding: '0 10px',
                fontSize: '0.85rem'
              }}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater || !customWaterAmount}
              onClick={() => handleAddWater(Number(customWaterAmount))}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              Dodaj
            </button>
            <button
              type="button"
              disabled={isAddingWater}
              onClick={handleResetWater}
              style={{
                flex: '1 1 80px',
                padding: '10px 8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                fontSize: '0.85rem'
              }}
            >
              Reset
            </button>
          </div>

          {waterMessage && (
            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--danger)' }}>
              {waterMessage}
            </div>
          )}
        </div>

        {/* SUPLEMENTY */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">💊 Suplementy</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Quick 7Nutrition supplement picker */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '4px' }}>
              {PRESET_SUPPLEMENTS.map((sup, idx) => {
                const active = isSupplementActive(sup);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleToggleSupplement(sup)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '5px 10px',
                      borderRadius: '20px',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      border: '1px solid',
                      borderColor: active ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                      background: active 
                        ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.2) 0%, rgba(56, 189, 248, 0.05) 100%)' 
                        : 'rgba(255, 255, 255, 0.03)',
                      color: active ? '#38bdf8' : 'rgba(255, 255, 255, 0.6)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: active ? '0 0 8px rgba(56, 189, 248, 0.15)' : 'none'
                    }}
                  >
                    <span>{sup.icon}</span>
                    <span>{sup.name}</span>
                  </button>
                );
              })}
            </div>

            <textarea
              placeholder={t("Wpisz przyjmowane suplementy (np. Kreatyna, Omega-3, Wit. D3, Białko)...")}
              value={supplementsText}
              onChange={(e) => setSupplementsText(e.target.value)}
              rows={3}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                color: '#fff',
                padding: '10px',
                fontSize: '0.85rem',
                resize: 'none',
                fontFamily: 'inherit'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: supplementsMessage.type === 'success' ? 'var(--color-secondary)' : supplementsMessage.type === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.3)' }}>
                {supplementsMessage.text || t('Zapisz, aby AI wzięło je pod uwagę')}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={isSavingSupplements}
                onClick={handleSaveSupplements}
                style={{ padding: '8px 16px', fontSize: '0.8rem' }}
              >
                {isSavingSupplements ? t('Zapisywanie...') : 'Zapisz'}
              </button>
            </div>

            {/* Historia suplementacji (ostatnie 7 dni) */}
            {(() => {
              const last7Days = getLast7Days(selectedDate);
              const complianceDays = last7Days.filter(day => {
                const entry = historyData.find(h => h.date === day.date);
                return entry?.supplements && entry.supplements.trim().length > 0;
              }).length;

              return (
                <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isSupplementsHistoryOpen}
                    onClick={() => setIsSupplementsHistoryOpen(o => !o)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsSupplementsHistoryOpen(o => !o); } }}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', cursor: 'pointer' }}
                  >
                    <span style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.6)', fontWeight: '600' }}>
                      Historia suplementacji {isSupplementsHistoryOpen ? '▲' : '▼'}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-secondary)', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 8px', borderRadius: '10px', fontWeight: '700' }}>
                      Aktywność: {complianceDays}/7 dni
                    </span>
                  </div>
                  {isSupplementsHistoryOpen && (
                  <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                    {last7Days.map((day, idx) => {
                      const histEntry = historyData.find(h => h.date === day.date);
                      const supsText = histEntry?.supplements || '';
                      const icons = getSupplementIconsForText(supsText);
                      const isToday = day.date === selectedDate;
                      const hasSups = icons.length > 0;

                      return (
                        <div 
                          key={idx} 
                          style={{ 
                            flex: 1, 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center',
                            padding: '6px 4px',
                            background: isToday ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                            border: isToday ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid rgba(255, 255, 255, 0.04)',
                            borderRadius: '10px',
                            minWidth: 0,
                            cursor: 'pointer'
                          }}
                          title={supsText ? `${day.date}: ${supsText}` : `${day.date}: brak suplementów`}
                        >
                          <span style={{ fontSize: '0.65rem', color: isToday ? '#38bdf8' : 'rgba(255,255,255,0.4)', textTransform: 'capitalize' }}>
                            {day.label}
                          </span>
                          <span style={{ fontSize: '0.8rem', fontWeight: '700', color: isToday ? '#fff' : 'rgba(255,255,255,0.7)', margin: '2px 0' }}>
                            {day.dayNum}
                          </span>
                          <div style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center', 
                            gap: '2px', 
                            minHeight: '28px', 
                            justifyContent: 'center',
                            marginTop: '2px'
                          }}>
                            {hasSups ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', justifyContent: 'center' }}>
                                {icons.slice(0, 3).map((ico, i) => (
                                  <span key={i} style={{ fontSize: '0.8rem' }} title={supsText}>{ico}</span>
                                ))}
                                {icons.length > 3 && (
                                  <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.5)', fontWeight: 'bold' }}>+{icons.length - 3}</span>
                                )}
                              </div>
                            ) : (
                              <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.1)' }}>-</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Details of the recent days */}
                  {(() => {
                    const loggedDays = historyData
                      .filter(h => h.supplements && h.supplements.trim().length > 0)
                      .sort((a, b) => b.date.localeCompare(a.date)) // newest first
                      .slice(0, 3); // show last 3 entries

                    if (loggedDays.length === 0) return null;

                    return (
                      <div style={{ 
                        marginTop: '12px', 
                        display: 'flex', 
                        flexDirection: 'column', 
                        gap: '6px', 
                        background: 'rgba(255, 255, 255, 0.01)', 
                        padding: '8px 10px', 
                        borderRadius: '8px', 
                        border: '1px solid rgba(255, 255, 255, 0.03)' 
                      }}>
                        <div style={{ 
                          fontSize: '0.68rem', 
                          color: 'rgba(255, 255, 255, 0.35)', 
                          fontWeight: '700', 
                          textTransform: 'uppercase', 
                          letterSpacing: '0.05em',
                          marginBottom: '2px'
                        }}>
                          Ostatnio przyjmowane
                        </div>
                        {loggedDays.map((entry, idx) => {
                    // Timezone-safe date conversion
                          const parts = entry.date.split('-');
                          const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
                          const formattedDate = dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
                          
                          let dayLabel = formattedDate;
                          const todayStr = selectedDate;
                          
                          // Wczoraj
                          const dateParts = selectedDate.split('-');
                          const yesterdayObj = new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]));
                          yesterdayObj.setDate(yesterdayObj.getDate() - 1);
                          const yyyy = yesterdayObj.getFullYear();
                          const mm = String(yesterdayObj.getMonth() + 1).padStart(2, '0');
                          const dd = String(yesterdayObj.getDate()).padStart(2, '0');
                          const yesterdayStr = `${yyyy}-${mm}-${dd}`;
                          
                          if (entry.date === todayStr) {
                            dayLabel = 'Dzisiaj';
                          } else if (entry.date === yesterdayStr) {
                            dayLabel = 'Wczoraj';
                          }

                          return (
                            <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: '0.75rem', gap: '12px' }}>
                              <span style={{ fontWeight: '700', color: 'rgba(255, 255, 255, 0.5)', flexShrink: 0 }}>{dayLabel}</span>
                              <span style={{ color: '#fff', textAlign: 'right', wordBreak: 'break-word', fontWeight: '500' }}>{entry.supplements}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

      </div>

      <div className="dashboard-column">
        {/* NUTRITION */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">{t("Odżywianie")}</span>
            <span className="premium-title-info">▶</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              <div style={{ position: 'relative', width: 92, height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {/* Calories circular gauge */}
                <RenderProgressCircle size={92} strokeWidth={8} percentage={caloriesPct} color="var(--color-secondary)" />
                <div style={{ position: 'absolute', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                    {eatenCalories}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '2px' }}>
                    cals
                  </div>
                </div>
              </div>
              {/* Net calorie balance (eaten - burned) - data from summary.net_calories,
                  computed in dashboard.js. Colour: red = a surplus of >200 kcal (bulking),
                  green = a deficit of < -200 kcal (cutting), yellow = balance (+/-200 kcal). */}
              {summary.net_calories != null && (
                <div style={{ fontSize: '0.7rem', textAlign: 'center', lineHeight: 1.3 }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>netto </span>
                  <strong style={{
                    color: summary.net_calories > 200 ? '#f87171'
                      : summary.net_calories < -200 ? '#34d399'
                      : '#fbbf24'
                  }}>
                    {summary.net_calories > 0 ? '+' : ''}{Math.round(summary.net_calories)} kcal
                  </strong>
                </div>
              )}
            </div>

            {/* Macronutrients Progress Bars */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Węglowodany")}</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenCarbs)}g / {targetCarbs}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#06b6d4', width: `${carbsPct}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Białko")}</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenProtein)}g / {targetProtein}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#7c3aed', width: `${proteinPct}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Tłuszcz")}</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenFat)}g / {targetFat}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#fbbf24', width: `${fatPct}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* WEIGHT AND BODY COMPOSITION */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">{t("⚖️ Waga i Skład Ciała")}</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              {summary.weight !== null && summary.weight !== undefined ? 'Zsynchronizowano' : 'Brak danych'}
            </span>
          </div>
          
          {(() => {
            const fatMass = (weight > 0 && fatRatio > 0) ? Math.round((weight * fatRatio / 100) * 10) / 10 : 0;
            const fatPercentage = fatRatio || 0;
            const musclePercentage = (weight > 0 && muscleMass > 0) ? Math.round((muscleMass / weight) * 100 * 10) / 10 : 0;
            const otherMass = (weight > 0) ? Math.max(0, Math.round((weight - muscleMass - fatMass) * 10) / 10) : 0;
            const otherPercentage = (weight > 0) ? Math.max(0, Math.round((otherMass / weight) * 100 * 10) / 10) : 0;
            // FIX (audit round 4): fatRatio===0 means "no body fat measurement" (the ?? 0
            // fallback above), NOT "a real 0% body fat" - the same way fatPercentage above
            // interprets it. Previously, with no data, leanBodyMassPct came out as 100, so a
            // new user with no synced scale saw a completely filled, "perfect" body
            // composition ring despite having no Withings data at all.
            const leanBodyMassPct = (weight > 0 && fatRatio > 0) ? 100 - fatRatio : 0;

            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
                {/* Main weight ring */}
                <div style={{ position: 'relative', width: 92, height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <RenderProgressCircle size={92} strokeWidth={8} percentage={leanBodyMassPct} color="#38bdf8" />
                  <div style={{ position: 'absolute', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                      {weight > 0 ? weight : '--'}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '2px' }}>
                      kg
                    </div>
                  </div>
                </div>

                {/* Body Composition breakdown */}
                <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Mięśnie")}</span>
                      <span style={{ fontWeight: '700' }}>{muscleMass > 0 ? `${muscleMass} kg` : '--'} ({musclePercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: 'var(--success-light)', width: `${musclePercentage}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Tłuszcz")}</span>
                      <span style={{ fontWeight: '700' }}>{fatMass > 0 ? `${fatMass} kg` : '--'} ({fatPercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#fbbf24', width: `${fatPercentage}%` }}></div>
                    </div>
                  </div>
                  {otherMass > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                        <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>{t("Inne (woda, kości)")}</span>
                        <span style={{ fontWeight: '700' }}>{otherMass} kg ({otherPercentage}%)</span>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: '#64748b', width: `${otherPercentage}%` }}></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
              <span>{t("Wskaźnik BMI")}</span>
              {bmiValue !== null ? (
                <span style={{ color: 'var(--success-light)', fontWeight: '600' }}>
                  {bmiValue} ({bmiCategory})
                </span>
              ) : (
                <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: '500' }}>
                  Brak danych (ustaw wzrost w Ustawieniach)
                </span>
              )}
            </div>
            {/* Blood pressure removed from this spot (UX round 7, point 2) - it duplicated the
                separate, full t("🩺 Ciśnienie tętnicze") card below the heart-rate zones, which the
                user had explicitly asked to be placed there. Here we keep only the BMI and the
                measurements, so the same number is not shown twice. */}
            {latestBodyMeasurement && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>
                <span>Ostatni pomiar obwodów ({latestBodyMeasurement.date})</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: '600', textAlign: 'right' }}>
                  {[
                    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
                    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
                    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
                    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
                    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
                  ].filter(Boolean).join(' · ') || t('Brak wypełnionych pól')}
                </span>
              </div>
            )}
          </div>
          {renderWeightCompositionChart(historyData)}
        </div>

        {/* SEN DETAILS */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Sen</span>
            <span className="premium-title-info">▶</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
            {/* Main sleep ring */}
            <div style={{ position: 'relative', width: 104, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <RenderProgressCircle size={104} strokeWidth={8} percentage={sleepScore} color="#3b82f6" />
              <div style={{ position: 'absolute', textAlign: 'center' }}>
                <div style={{ fontSize: '1.2rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                  {formatHoursMins(sleepDurationHours)}
                </div>
                <div style={{ fontSize: '0.6rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '4px' }}>
                  Typowy zakres
                </div>
              </div>
            </div>

            {/* Sleep Stages */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <SleepStageBar 
                label={t("Sen głęboki")} 
                durationText={formatHoursMins(sleepDeepHours)} 
                percentage={Math.min((sleepDeepHours / 2.5) * 100, 100)} 
                typicalStart={35} 
                typicalEnd={65} 
                colorClass="deep" 
              />
              <SleepStageBar 
                label="REM" 
                durationText={formatHoursMins(sleepRemHours)} 
                percentage={Math.min((sleepRemHours / 3.0) * 100, 100)} 
                typicalStart={40} 
                typicalEnd={75} 
                colorClass="rem" 
              />
              <SleepStageBar 
                label="Sen lekki" 
                durationText={formatHoursMins(sleepLightHours)} 
                percentage={Math.min((sleepLightHours / 5.5) * 100, 100)} 
                typicalStart={50} 
                typicalEnd={85} 
                colorClass="light" 
              />
              {/* "Czas czuwania" hidden while sleepAwakeMins is hard-coded to 0 (the backend
                  does not compute this value from Oura yet) - showing a fake "0 m" would
                  suggest a real measurement we do not have. */}
              {sleepAwakeMins > 0 && (
                <SleepStageBar
                  label="Czas czuwania"
                  durationText={`${sleepAwakeMins} m`}
                  percentage={Math.min((sleepAwakeMins / 90) * 100, 100)}
                  typicalStart={10}
                  typicalEnd={45}
                  colorClass="awake"
                />
              )}
            </div>
          </div>
        </div>

        {/* THE DAY'S ENERGY AND ACTIVITY - merged from the former "Dystans i aktywność dnia"
            card (UX: round 7 - two adjacent, thematically related cards combined into one to
            shorten the dashboard). Data from Oura (equivalent_walking_distance, sedentary/
            low_activity_time), Google Fit (distance.delta) or Apple Health
            (walking_running_distance). */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">{t("Energia i aktywność dnia")}</span>
            <span className="premium-title-info">ⓘ</span>
          </div>

          {/* Battery segments - a real algorithm (readinessScore - discharge from activity) */}
          <div className="energy-battery-row">
            <span style={{ fontSize: '1rem' }}>🔋</span>
            <div className="energy-battery-container">
              {Array.from({ length: 28 }).map((_, idx) => {
                const filledSegmentsCount = batteryPct !== null ? Math.round((batteryPct / 100) * 28) : 0;
                const isFilled = idx < filledSegmentsCount;
                return (
                  <div
                    key={idx}
                    className={`energy-battery-segment ${isFilled ? 'filled' : ''}`}
                  ></div>
                );
              })}
            </div>
            {batteryPct !== null ? (
              <>
                <span className="energy-battery-pct">{batteryPct}%</span>
                {batteryDelta !== null ? (
                  <span style={{ fontSize: '0.75rem', color: batteryDelta >= 0 ? 'var(--color-secondary)' : 'var(--danger-light)', fontWeight: '700' }}>
                    {batteryDelta >= 0 ? '+' : ''}{batteryDelta}% vs wczoraj
                  </span>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>Brak danych z wczoraj</span>
                )}
              </>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>{t("Brak danych (czekam na synchronizację)")}</span>
            )}
          </div>
          {/* The real stress level (Oura /v2/usercollection/daily_stress) - this section used
              to be removed from here, because it was 100% hard-coded with no real data source
              behind it. It comes back only when the backend genuinely has data for it (an Oura
              ring with stress measurement) - otherwise it is simply invisible, with no fake
              values. */}
          {hasStressData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>😮‍💨 Poziom stresu (Oura)</span>
                {stressSummary && (
                  <span style={{ fontSize: '0.75rem', fontWeight: '700', color: stressSummary === 'stressful' ? 'var(--danger-light)' : stressSummary === 'restored' ? 'var(--success-light)' : '#fbbf24' }}>
                    {stressSummaryLabels[stressSummary] || stressSummary}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--danger-light)' }}>
                    {stressHighMinutes != null ? `${stressHighMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Stres dzisiaj</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--success-light)' }}>
                    {stressRecoveryMinutes != null ? `${stressRecoveryMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Regeneracja dzisiaj</span>
                </div>
              </div>
            </div>
          )}

          {/* THE DAY'S DISTANCE AND ACTIVITY - merged in here from the former separate card
              (UX round 7). Data from Oura (equivalent_walking_distance, sedentary/
              low_activity_time), Google Fit (distance.delta) or Apple Health (walking_running_distance). */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#fff' }}>
                {distanceKm > 0 ? distanceKm : '-'} <span style={{ fontSize: '0.9rem', fontWeight: '500', color: 'rgba(255,255,255,0.4)' }}>km</span>
              </span>
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>Dystans dzisiaj</span>
            </div>
          </div>
          {hasActivityBreakdown ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🔥 Aktywne minuty</span>
                <span style={{ fontWeight: '700' }}>{activeMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t("🚶 Niska intensywność")}</span>
                <span style={{ fontWeight: '700' }}>{lowActivityMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🪑 Bezruch</span>
                <span style={{ fontWeight: '700' }}>{sedentaryMinutes} min</span>
              </div>
              {(activeMinutes > 0 || lowActivityMinutes > 0 || sedentaryMinutes > 0) && (
                <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: '4px', background: 'rgba(255,255,255,0.05)' }}>
                  {activeMinutes > 0 && <div style={{ background: 'var(--danger)', flex: activeMinutes }}></div>}
                  {lowActivityMinutes > 0 && <div style={{ background: '#fbbf24', flex: lowActivityMinutes }}></div>}
                  {sedentaryMinutes > 0 && <div style={{ background: 'rgba(255,255,255,0.15)', flex: sedentaryMinutes }}></div>}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0' }}>
              Brak danych - czekam na synchronizację
            </div>
          )}
        </div>

        {/* TRENDY ZDROWOTNE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
          <div className="premium-title-row" style={{ padding: '0 4px' }}>
            <span className="premium-title" style={{ fontSize: '1.2rem' }}>Trendy zdrowotne ⓘ</span>
            <span
              onClick={() => onNavigate && onNavigate('trends')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate && onNavigate('trends'); } }}
              role="button"
              tabIndex={0}
              style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
            >
              Wykresy
            </span>
          </div>
          <div className="premium-grid-2" style={{ gap: '12px' }}>
            {/* hrv/rhr can be null (no Oura measurement for that day) - the cards then show
                '--' and a neutral state rather than a fake "0 ms"/"0 bpm" and wrong comparisons
                (null >= 48 or null < 61 would give illogical results). */}
            <TrendCard
              title={t("Zmienność rytmu zatokowego")}
              valueText={hrv != null ? String(hrv) : '--'}
              unitText="ms"
              activeSegment={hrv != null && hrv >= 48 ? "right" : "middle"}
              color="blue"
              footerText={hrv == null ? "Brak danych" : hrv >= 48 ? "Wysoki > 48" : "Niski < 48"}
              status="success"
            />
            <TrendCard
              title={t("Spoczynkowe tętno")}
              valueText={rhr != null ? String(rhr) : '--'}
              unitText="bpm"
              activeSegment={rhr != null && rhr < 61 ? "left" : "middle"}
              color="blue"
              footerText={rhr == null ? "Brak danych" : rhr < 61 ? "Niski < 61" : "Wysoki > 61"}
              status="success"
            />
            {/* The "Słuch" card stays removed at the user's request - Oura has no microphone,
                and Apple Watch/AirPods are not supported yet. The 4 cards below appear only
                when the backend genuinely has a real value for them (Oura Gen 3+ for SpO2, an
                Apple Watch Series 8+/Ultra with the "Wrist Temperature" metric enabled in
                Health Auto Export for the wrist temperature, Oura /daily_readiness for the body
                temperature deviation) - otherwise the card is simply invisible, with no fake
                zeroes. */}
            {summary.respiratory_rate != null && (
              <TrendCard
                title={t("Częstość oddechów")}
                valueText={String(summary.respiratory_rate)}
                unitText="odd/min"
                activeSegment={summary.respiratory_rate < 12 ? "left" : summary.respiratory_rate > 20 ? "right" : "middle"}
                color="blue"
                footerText={summary.respiratory_rate >= 12 && summary.respiratory_rate <= 20 ? "Norma 12-20" : t("Poza normą 12-20")}
                status={summary.respiratory_rate >= 12 && summary.respiratory_rate <= 20 ? "success" : "warning"}
              />
            )}
            {summary.spo2_percentage != null && (
              <TrendCard
                title="Poziom tlenu we krwi"
                valueText={String(summary.spo2_percentage)}
                unitText="%"
                activeSegment={summary.spo2_percentage >= 98 ? "right" : summary.spo2_percentage >= 95 ? "middle" : "left"}
                color="blue"
                footerText={summary.spo2_percentage >= 95 ? t("Prawidłowy ≥ 95%") : "Niski < 95%"}
                status={summary.spo2_percentage >= 95 ? "success" : "warning"}
              />
            )}
            {summary.wrist_temperature != null && (
              <TrendCard
                title="Temperatura nadgarstka"
                valueText={String(summary.wrist_temperature)}
                unitText="°C"
                activeSegment="middle"
                color="blue"
                footerText="Pomiar nocny (Apple Watch)"
                status="success"
              />
            )}
            {summary.temperature_deviation != null && (() => {
                  // A shared +/-0.5°C threshold (Oura) - see utils/health.js, so the same
                  // boundary is not duplicated across several components.
              const tempStatus = getTemperatureStatus(summary.temperature_deviation);
              return (
                <TrendCard
                  title="Odchylenie temperatury"
                  valueText={`${summary.temperature_deviation > 0 ? '+' : ''}${summary.temperature_deviation.toFixed(2)}`}
                  unitText="°C"
                  activeSegment={summary.temperature_deviation > 0.5 ? "right" : summary.temperature_deviation < -0.5 ? "left" : "middle"}
                  color="blue"
                  footerText={tempStatus.label}
                  status={tempStatus.inRange ? "success" : "warning"}
                />
              );
            })()}
          </div>
        </div>

        {/* TRENING (TRAINING) */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Trening ⓘ</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', margin: '4px 0' }}>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.7)' }}>
              Obciążenie cardio
            </div>
            {/* Rainbow/gradient load slider */}
            <div className="cardio-load-gradient-bar">
              <div 
                className="cardio-load-handle" 
                style={{ left: `${currentLoadPos}%` }}
              ></div>
            </div>
          </div>

          <div style={{ marginTop: '12px' }}>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.5)', fontWeight: '600', marginBottom: '8px' }}>
              Ostatnia aktywność
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activities.length > 0 ? activities.map((act, idx) => (
                <div key={idx} className="premium-workout-card">
                  <div className="premium-workout-left">
                    <div className="premium-workout-icon-box">
                      {getWorkoutIcon(act.type)}
                    </div>
                    <div>
                      <div className="premium-workout-name">{act.type}</div>
                      <div className="premium-workout-duration">{act.duration}</div>
                    </div>
                  </div>
                  <div className="premium-workout-right">
                    <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', display: 'block' }}>{act.dateLabel}</span>
                    <span className="premium-workout-calories">{act.calories} kcal</span>
                  </div>
                </div>
              )) : (
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.35)', textAlign: 'center', padding: '8px 0' }}>
                  Brak zarejestrowanych aktywności
                </div>
              )}
            </div>
          </div>
        </div>

        {/* HEART-RATE ZONES - only when we have a real RHR; without it every range would be
            computed from a fake RHR=0 (see rhrForZones above).
            A static reference table - collapsed by default (UX round 7), because it does not
            change from day to day and does not need to be visible immediately. */}
        {rhr != null && (
        <div className="premium-card">
          <div
            className="premium-title-row"
            role="button"
            tabIndex={0}
            aria-expanded={isHrZonesOpen}
            onClick={() => setIsHrZonesOpen(o => !o)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsHrZonesOpen(o => !o); } }}
            style={{ cursor: 'pointer' }}
          >
            <span className="premium-title">{t("💓 Strefy Tętna (Karvonen)")}</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              Na bazie RHR ({rhr} bpm) · {isHrZonesOpen ? t('Zwiń ▲') : t('Pokaż ▼')}
            </span>
          </div>
          {isHrZonesOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #60a5fa' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 1 (Regeneracja)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#60a5fa' }}>{hrZone1Min}-{hrZone1Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>{t("Aktywna regeneracja, bardzo lekki wysiłek")}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #34d399' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>{t("Strefa 2 (Spalanie Tłuszczu)")}</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--success-light)' }}>{hrZone2Min}-{hrZone2Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>{t("Baza tlenowa, optymalne spalanie tłuszczu")}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #fbbf24' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 3 (Cardio / Tempo)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fbbf24' }}>{hrZone3Min}-{hrZone3Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>{t("Poprawa wydolności sercowo-naczyniowej")}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #f87171' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>{t("Strefa 4 (Próg / Threshold)")}</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger-light)' }}>{hrZone4Min}-{hrZone4Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>{t("Budowanie wytrzymałości beztlenowej")}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #ef4444' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>{t("Strefa 5 (Maks. Wysiłek)")}</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger)' }}>{hrZone5Min}-{userMaxHr} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>{t("Trening beztlenowy, interwały, maksymalna wydolność")}</span>
            </div>
          </div>
          )}
        </div>
        )}

        {/* BLOOD PRESSURE - moved below the heart-rate zones in the right-hand column at the user's request */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">{t("🩺 Ciśnienie tętnicze")}</span>
            <span className="premium-title-info">ⓘ</span>
          </div>

          {summary.blood_pressure_systolic !== null && summary.blood_pressure_systolic !== undefined ? (
            (() => {
              const sys = summary.blood_pressure_systolic;
              const dia = summary.blood_pressure_diastolic;
              let color = 'var(--success-light)';
              let label = 'Optymalne';
              if (sys >= 140 || dia >= 90) { color = 'var(--danger-light)'; label = 'Wysokie'; }
              else if (sys >= 130 || dia >= 80) { color = '#fbbf24'; label = t('Podwyższone'); }
              else if (sys >= 120) { color = '#fbbf24'; label = t('Prawidłowe wysokie'); }
              return (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', margin: '8px 0' }}>
                  <span style={{ fontSize: '2rem', fontWeight: '800', color: '#fff' }}>
                    {sys}/{dia}
                  </span>
                  <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)' }}>mmHg</span>
                  <span style={{ fontSize: '0.8rem', fontWeight: '700', color, marginLeft: 'auto' }}>
                    {label}
                  </span>
                </div>
              );
            })()
          ) : (
            <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', margin: '8px 0' }}>
              Brak danych (zsynchronizuj Withings, by zobaczyć pomiar ciśnienia)
            </p>
          )}
        </div>
      </div>


      {/* CZAT Z DIETETYKIEM AI (Boczna szuflada / overlay) */}
      {isChatOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: '20px',
          zIndex: 9999,
          animation: 'fadeIn 0.2s ease-out'
        }} onClick={() => setIsChatOpen(false)}>
          <div style={{
            width: '100%',
            maxWidth: '460px',
            maxHeight: 'calc(100vh - 40px)',
            height: 'min(720px, calc(100vh - 40px))',
            background: 'rgba(13, 14, 14, 0.96)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '24px',
            boxShadow: '0 20px 50px rgba(0,0,0,0.8), 0 0 30px rgba(124, 58, 237, 0.15)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header czatu */}
            <div style={{
              padding: '20px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>✨</span> Dietetyk AI
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
                  Rozmowa z asystentem Dietetyk AI
                </span>
              </div>
              <button
                onClick={() => setIsChatOpen(false)}
                aria-label="Zamknij czat"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: 'none',
                  color: '#fff',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  fontSize: '1rem'
                }}
              >
                ✕
              </button>
            </div>

            {/* Message history */}
            <div style={{
              flexGrow: 1,
              padding: '20px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}>
              {chatMessages.map((msg, idx) => (
                <div 
                  key={idx} 
                  style={{
                    alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    padding: '12px 16px',
                    borderRadius: msg.sender === 'user' ? '18px 18px 2px 18px' : '18px 18px 18px 2px',
                    background: msg.sender === 'user' ? '#7c3aed' : 'rgba(255,255,255,0.03)',
                    border: msg.sender === 'user' ? 'none' : '1px solid rgba(255,255,255,0.05)',
                    color: '#fff',
                    fontSize: '0.9rem',
                    lineHeight: '1.45',
                    whiteSpace: 'pre-line'
                  }}
                >
                  {msg.text}
                </div>
              ))}
              {isSendingChat && (
                <div style={{
                  alignSelf: 'flex-start',
                  padding: '12px 16px',
                  borderRadius: '18px 18px 18px 2px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.85rem',
                  color: 'rgba(255,255,255,0.4)'
                }}>
                  <div className="loading-pulse"></div>
                  <span>{t("Dietetyk AI myśli...")}</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick-question chips (round 8) - shown only at the start of a conversation
                (just the AI welcome message), so they do not clutter the view once the user
                has begun talking. Clicking one sends the question immediately, without
                copying it into the input field. */}
            {chatMessages.length === 1 && !isSendingChat && (
              <div style={{
                padding: '0 20px 14px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px'
              }}>
                {[
                  t('Jak wygląda mój sen w tym tygodniu?'),
                  t('Czy jestem blisko celu kalorycznego?'),
                  t('Jak moja regeneracja po ostatnim treningu?'),
                  t('Coś niepokojącego w moich danych?')
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSendChat(null, suggestion)}
                    style={{
                      background: 'rgba(124,58,237,0.12)',
                      border: '1px solid rgba(124,58,237,0.3)',
                      color: '#c4b5fd',
                      borderRadius: '999px',
                      padding: '6px 14px',
                      fontSize: '0.76rem',
                      cursor: 'pointer'
                    }}
                  >
                    {t(suggestion)}
                  </button>
                ))}
              </div>
            )}

            {/* Message input */}
            <form 
              onSubmit={handleSendChat}
              style={{
                padding: '20px',
                borderTop: '1px solid rgba(255,255,255,0.05)',
                display: 'flex',
                gap: '10px'
              }}
            >
              <input
                type="text"
                placeholder={t("Zapytaj agenta np. o swój dzisiejszy sen...")}
                className="input-field"
                style={{ flexGrow: 1, borderRadius: '12px', fontSize: '0.9rem' }}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={isSendingChat}
                required
              />
              <button
                type="submit"
                className="btn-primary"
                style={{ width: '45px', height: '42px', padding: 0, borderRadius: '12px' }}
                disabled={isSendingChat}
                aria-label={t("Wyślij wiadomość")}
              >
                ➔
              </button>
            </form>

          </div>
        </div>
      )}

      {/* Style animacji szuflady czatu */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

    </div>
  );
}
