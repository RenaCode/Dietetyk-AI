import React, { useState, useEffect, useRef } from 'react';
import { getTemperatureStatus } from '../utils/health';
import { formatHoursMins } from '../utils/format';
import { t } from '../utils/i18n';

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
  // type może nie przyjść z backendu (trening bez przypisanej kategorii) -
  // bez fallbacku do '' aplikacja wywaliłaby się na .toLowerCase() na undefined.
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
  // Parsujemy lokalnie, nie jako UTC (new Date("YYYY-MM-DD") traktuje jako UTC
  // i w strefach zachodnich może dać dzień -1)
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

export default function Dashboard({ summary, aiAdvice, sessionToken, selectedDate, onNavigate, onRefresh, onLogout, userProfile = {} }) {
  const [historyData, setHistoryData] = useState([]);
  // Centralny sygnał wygaśnięcia sesji dla ~40 insight useEffectów — zamiast
  // wywoływać onLogout() bezpośrednio (co wymagałoby dodania go do dep-array każdego
  // effectu i groziło pętlami re-render), effekty ustawiają flagę, a jeden centralny
  // useEffect wywołuje onLogout() gdy flaga jest true.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    if (sessionExpired) onLogout();
  }, [sessionExpired, onLogout]);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  // isLoadingHistory celowo usunięte (stan był ustawiany ale nigdy nie odczytywany
  // w renderze - martwy kod, wykryty w audycie rundy 17)
  const [isAddingWater, setIsAddingWater] = useState(false);
  const [customWaterAmount, setCustomWaterAmount] = useState('');
  const [waterMessage, setWaterMessage] = useState('');
  
  // Stany dla suplementacji
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

  // Inicjalizacja tekstu suplementów przy zmianie daty lub wartości z backendu
  // Celowo NIE używamy [summary] — summary to nowy obiekt na każdy re-render parenta,
  // co resetowałoby tekst wpisany przez użytkownika przy niezwiązanych odświeżeniach.
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
          onRefresh(); // Odśwież dane dashboardu (i wyzwalaj generowanie nowej porady AI w tle)
        }
        setTimeout(() => setSupplementsMessage({ type: '', text: '' }), 5000);
      } else {
        // F-S4: Obsługa 401 — wygasła sesja
        if (res.status === 401) { onLogout(); return; }
        setSupplementsMessage({ type: 'error', text: 'Błąd zapisu.' });
      }
    } catch (err) {
      console.error(err);
      setSupplementsMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSavingSupplements(false);
    }
  };

  // Stany dla trackera samopoczucia (energia i nastrój, skala 1–5)
  const [energyLevel, setEnergyLevel] = useState(null);
  const [moodLevel, setMoodLevel] = useState(null);
  const [isSavingFeeling, setIsSavingFeeling] = useState(false);
  const [feelingMessage, setFeelingMessage] = useState({ type: '', text: '' });

  // Inicjalizacja z danych z backendu przy zmianie dnia
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
      setFeelingMessage({ type: 'error', text: 'Kliknij co najmniej jedną ocenę przed zapisaniem.' });
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
        setFeelingMessage({ type: 'error', text: 'Błąd zapisu.' });
      }
    } catch (err) {
      console.error(err);
      setFeelingMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSavingFeeling(false);
    }
  };

  // Porównanie odżywiania tydzień/miesiąc i bilans kaloryczny narastająco
  const [nutritionComparison, setNutritionComparison] = useState(null);
  const [calorieBalance, setCalorieBalance] = useState(null);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);

  // Insight: sen -> kalorie/cukier następnego dnia (porównanie opisowe średnich
  // z ostatnich 90 dni, patrz endpoint /api/dashboard/sleep-insight).
  const [sleepInsight, setSleepInsight] = useState(null);
  const [isLoadingSleepInsight, setIsLoadingSleepInsight] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchSleepInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingSleepInsight(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu sen-odżywianie:', err);
      } finally {
        if (!cancelled) setIsLoadingSleepInsight(false);
      }
    };
    fetchSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Alert/insight: sód -> ciśnienie (patrz endpoint /api/dashboard/sodium-bp-insight).
  const [sodiumBpInsight, setSodiumBpInsight] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchSodiumBpInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sodium-bp-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSodiumBpInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu sód-ciśnienie:', err);
      }
    };
    fetchSodiumBpInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Wskaźnik regeneracji: HRV/RHR następnego dnia po znaczącym treningu
  // (patrz endpoint /api/dashboard/recovery-insight).
  const [recoveryInsight, setRecoveryInsight] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchRecoveryInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/recovery-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setRecoveryInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania wskaźnika regeneracji:', err);
      }
    };
    fetchRecoveryInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Insight: suplementy (wolny tekst) vs sen/regeneracja TEGO SAMEGO dnia
  // (patrz endpoint /api/dashboard/supplements-sleep-insight) - własna analiza
  // danych już zbieranych przez aplikację (suplementy + Oura), bez kopiowania
  // niczego z konkurencyjnych apek.
  const [supplementsSleepInsight, setSupplementsSleepInsight] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchSupplementsSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/supplements-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSupplementsSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu suplementy-sen:', err);
      }
    };
    fetchSupplementsSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 7: 8 nowych insightów na bazie danych już zbieranych przez aplikację -
  // ten sam wzorzec fetch/state co powyżej (sleepInsight, sodiumBpInsight, itd.).
  const [hydrationInsight, setHydrationInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchHydrationInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/hydration-readiness-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setHydrationInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu nawodnienie-regeneracja:', err);
      }
    };
    fetchHydrationInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [sedentaryInsight, setSedentaryInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchSedentaryInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sedentary-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSedentaryInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu siedzenie-sen:', err);
      }
    };
    fetchSedentaryInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [fiberSleepInsight, setFiberSleepInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchFiberSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/fiber-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setFiberSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu błonnik-sen:', err);
      }
    };
    fetchFiberSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [bodyRecompInsight, setBodyRecompInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchBodyRecompInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/body-recomposition-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setBodyRecompInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu rekompozycji ciała:', err);
      }
    };
    fetchBodyRecompInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [strainAlert, setStrainAlert] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchStrainAlert = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/early-strain-alert${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setStrainAlert(await res.json());
      } catch (err) {
        console.error('Błąd pobierania alertu przeciążenia:', err);
      }
    };
    fetchStrainAlert();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [stressNutritionInsight, setStressNutritionInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchStressNutritionInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/stress-nutrition-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setStressNutritionInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu stres-odżywianie:', err);
      }
    };
    fetchStressNutritionInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [mealFreqInsight, setMealFreqInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchMealFreqInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/meal-frequency-adherence-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setMealFreqInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu częstość posiłków:', err);
      }
    };
    fetchMealFreqInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [streakDriftInsight, setStreakDriftInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchStreakDriftInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/streak-drift-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setStreakDriftInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu passa-regeneracja:', err);
      }
    };
    fetchStreakDriftInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [rhrDriftInsight, setRhrDriftInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchRhrDriftInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/rhr-drift-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setRhrDriftInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu trendu tętna spoczynkowego:', err);
      }
    };
    fetchRhrDriftInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [mealTimingSleepInsight, setMealTimingSleepInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchMealTimingSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/meal-timing-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setMealTimingSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu godzina posiłku-sen:', err);
      }
    };
    fetchMealTimingSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const [bpTrendInsight, setBpTrendInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchBpTrendInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/bp-trend-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setBpTrendInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu trendu ciśnienia krwi:', err);
      }
    };
    fetchBpTrendInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Realne strefy kardio (Karvonen) zsumowane z treningów Apple Health z ostatnich 14 dni
  // - w przeciwieństwie do statycznej tabeli referencyjnej "Strefy Tętna" (wzór, nie pomiar),
  // to są minuty faktycznie zmierzone tętnem podczas treningu (wymaga włączonego "Include
  // Workout Metrics" w Health Auto Export). Patrz /api/dashboard/hr-zones-insight.
  const [hrZonesInsight, setHrZonesInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchHrZonesInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/hr-zones-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setHrZonesInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu stref kardio:', err);
      }
    };
    fetchHrZonesInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Trend jakości posiłków (health_rating 1-10 z analysis_json) - ostatnie 14 dni
  // vs poprzedzające 30 dni. Patrz /api/dashboard/meal-quality-trend-insight.
  const [mealQualityTrendInsight, setMealQualityTrendInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchMealQualityTrendInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/meal-quality-trend-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setMealQualityTrendInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania trendu jakości posiłków:', err);
      }
    };
    fetchMealQualityTrendInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // "Efekt weekendu" - kalorie/aktywność/sen w dni robocze vs weekend, ostatnie
  // 4 tygodnie. Patrz /api/dashboard/weekend-effect-insight.
  const [weekendEffectInsight, setWeekendEffectInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWeekendEffectInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/weekend-effect-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWeekendEffectInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania efektu weekendu:', err);
      }
    };
    fetchWeekendEffectInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Efektywność kalorii per typ treningu (kcal/min) z ostatnich 90 dni.
  // Patrz /api/dashboard/workout-efficiency-insight.
  const [workoutEfficiencyInsight, setWorkoutEfficiencyInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWorkoutEfficiencyInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/workout-efficiency-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWorkoutEfficiencyInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania efektywności treningów:', err);
      }
    };
    fetchWorkoutEfficiencyInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Prognoza daty osiągnięcia celu wagi (regresja 60 dni + target_weight_kg) - stała
  // karta na dashboardzie (wcześniej widoczna tylko w okresowych mailach).
  // Patrz /api/dashboard/weight-goal-forecast.
  const [weightGoalForecast, setWeightGoalForecast] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWeightGoalForecast = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/weight-goal-forecast${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWeightGoalForecast(await res.json());
      } catch (err) {
        console.error('Błąd pobierania prognozy celu wagi:', err);
      }
    };
    fetchWeightGoalForecast();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Stabilność ulubionych (powtarzających się) posiłków - dryf kalorii między
  // starszą a nowszą połową wystąpień. Patrz /api/dashboard/favorite-meal-drift-insight.
  const [favoriteMealDriftInsight, setFavoriteMealDriftInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchFavoriteMealDriftInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/favorite-meal-drift-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setFavoriteMealDriftInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania dryfu ulubionych posiłków:', err);
      }
    };
    fetchFavoriteMealDriftInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Trend SpO2 (saturacja krwi) - ostatnie 7 dni vs poprzedzający baseline 28 dni.
  // Patrz /api/dashboard/spo2-trend-insight.
  const [spo2TrendInsight, setSpo2TrendInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchSpo2TrendInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/spo2-trend-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSpo2TrendInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania trendu SpO2:', err);
      }
    };
    fetchSpo2TrendInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Wskaźnik WHR (obwód pasa / obwód bioder) - uznany wskaźnik ryzyka
  // sercowo-naczyniowego. Patrz /api/dashboard/whr-insight.
  const [whrInsight, setWhrInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWhrInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/whr-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWhrInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu WHR:', err);
      }
    };
    fetchWhrInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Symetria bicepsów (lewy vs prawy) z pomiarów obwodów ciała.
  // Patrz /api/dashboard/body-symmetry-insight.
  const [bodySymmetryInsight, setBodySymmetryInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchBodySymmetryInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/body-symmetry-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setBodySymmetryInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu symetrii bicepsów:', err);
      }
    };
    fetchBodySymmetryInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Trend tempa biegu/marszu (min/km, przybliżony) - dni z jednym treningiem
  // run/walk/hike. Patrz /api/dashboard/pace-trend-insight.
  const [paceTrendInsight, setPaceTrendInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchPaceTrendInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/pace-trend-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setPaceTrendInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania trendu tempa:', err);
      }
    };
    fetchPaceTrendInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Różnorodność treningów (rozkład workout_type, ostatnie 60 dni).
  // Patrz /api/dashboard/workout-variety-insight.
  const [workoutVarietyInsight, setWorkoutVarietyInsight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWorkoutVarietyInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/workout-variety-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWorkoutVarietyInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania różnorodności treningów:', err);
      }
    };
    fetchWorkoutVarietyInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Composite Wellness Score (0-100) - syntetyzuje sen/gotowość/RHR/dietę/nawodnienie
  // w jeden nagłówkowy wskaźnik dnia. Patrz /api/dashboard/wellness-score.
  const [wellnessScore, setWellnessScore] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWellnessScore = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/wellness-score${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWellnessScore(await res.json());
      } catch (err) {
        console.error('Błąd pobierania Wellness Score:', err);
      }
    };
    fetchWellnessScore();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // AI tłumaczące przyczyny (Runda 11, styl Oura Advisor/Whoop Coach) - wykrywa
  // największe dzisiejsze odchylenie sen/gotowość/HRV/RHR i prosi AI o krótkie
  // wyjaśnienie przyczyny. Patrz /api/dashboard/ai-explanation-insight.
  const [aiExplanationInsight, setAiExplanationInsight] = useState(null);
  // Runda 12 (audyt): jawny stan ładowania - bez tego karta po prostu nie renderowała
  // się NIC (ani treści, ani komunikatu) między mountem komponentu a odpowiedzią API,
  // co na wolniejszym połączeniu wyglądało jak zniknięcie/brak karty, a nie jej ładowanie.
  const [isLoadingAiExplanation, setIsLoadingAiExplanation] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchAiExplanationInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingAiExplanation(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/ai-explanation-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setAiExplanationInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania wyjaśnienia AI:', err);
      } finally {
        if (!cancelled) setIsLoadingAiExplanation(false);
      }
    };
    fetchAiExplanationInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Backend generuje wyjaśnienie AI W TLE i zwraca `generating: true` zanim tekst jest
  // gotowy (patrz /api/dashboard/ai-explanation-insight w dashboard.js). Wcześniej karta
  // pokazywała statyczny tekst "wyjaśnienie pojawi się po odświeżeniu" i wymagała od
  // użytkownika RĘCZNEGO przeładowania strony, żeby zobaczyć wynik. Tu odpytujemy
  // ponownie co kilka sekund, dopóki backend nie zwróci `generating: false` (gotowe albo
  // poddane, np. brak klucza AI) - maks. ograniczona liczba prób, żeby nie odpytywać
  // w nieskończoność, gdyby generowanie w tle z jakiegoś powodu nigdy się nie zakończyło.
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
          setAiExplanationInsight(data);
          if (!data.generating || attempts >= MAX_AI_EXPLANATION_POLL_ATTEMPTS) {
            clearInterval(intervalId);
          }
        }
      } catch (err) {
        console.error('Błąd odpytywania o status generowania wyjaśnienia AI:', err);
      }
      if (attempts >= MAX_AI_EXPLANATION_POLL_ATTEMPTS) {
        clearInterval(intervalId);
      }
    }, 4000);
    return () => { cancelled = true; clearInterval(intervalId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiExplanationInsight?.generating, sessionToken, selectedDate]); // F-S1: optional chaining zamiast wyrażenia boolowskiego

  // Benchmark "Ty dziś vs Ty w przeszłości" (Runda 11, prywatna wersja Whoop
  // "people like you" - WYŁĄCZNIE własna historia, bez porównań z innymi
  // użytkownikami). Patrz /api/dashboard/self-benchmark-insight.
  const [selfBenchmarkInsight, setSelfBenchmarkInsight] = useState(null);
  const [isLoadingSelfBenchmark, setIsLoadingSelfBenchmark] = useState(false);
  useEffect(() => {
    // POPRAWKA (runda 17): brakująca flaga cancelled - jedyny insight bez niej,
    // w otoczeniu kilkunastu analogicznych efektów, które tę flagę mają.
    let cancelled = false;
    const fetchSelfBenchmarkInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingSelfBenchmark(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/self-benchmark-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSelfBenchmarkInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania benchmarku "Ty dziś vs Ty w przeszłości":', err);
      } finally {
        if (!cancelled) setIsLoadingSelfBenchmark(false);
      }
    };
    fetchSelfBenchmarkInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 1: typ treningu -> jakość snu tej samej nocy.
  const [workoutTypeSleepInsight, setWorkoutTypeSleepInsight] = useState(null);
  const [isLoadingWorkoutTypeSleep, setIsLoadingWorkoutTypeSleep] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchWorkoutTypeSleepInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingWorkoutTypeSleep(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/workout-type-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWorkoutTypeSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu typ treningu-sen:', err);
      } finally {
        if (!cancelled) setIsLoadingWorkoutTypeSleep(false);
      }
    };
    fetchWorkoutTypeSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 2: masa mięśniowa vs spożycie białka.
  const [muscleProteinInsight, setMuscleProteinInsight] = useState(null);
  const [isLoadingMuscleProtein, setIsLoadingMuscleProtein] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchMuscleProteinInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingMuscleProtein(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/muscle-protein-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setMuscleProteinInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu masa mięśniowa-białko:', err);
      } finally {
        if (!cancelled) setIsLoadingMuscleProtein(false);
      }
    };
    fetchMuscleProteinInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 3: rozjazd temperatury Oura vs Apple Watch.
  const [temperatureDivergenceInsight, setTemperatureDivergenceInsight] = useState(null);
  const [isLoadingTemperatureDivergence, setIsLoadingTemperatureDivergence] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchTemperatureDivergenceInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingTemperatureDivergence(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/temperature-divergence-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setTemperatureDivergenceInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu rozjazdu temperatur:', err);
      } finally {
        if (!cancelled) setIsLoadingTemperatureDivergence(false);
      }
    };
    fetchTemperatureDivergenceInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 4: proporcje obwodów ciała (barki/talia, klatka/talia).
  const [bodyProportionsInsight, setBodyProportionsInsight] = useState(null);
  const [isLoadingBodyProportions, setIsLoadingBodyProportions] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchBodyProportionsInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingBodyProportions(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/body-proportions-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setBodyProportionsInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu proporcji obwodów ciała:', err);
      } finally {
        if (!cancelled) setIsLoadingBodyProportions(false);
      }
    };
    fetchBodyProportionsInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 5: aktywność dnia -> apetyt tego samego dnia.
  const [activityAppetiteInsight, setActivityAppetiteInsight] = useState(null);
  const [isLoadingActivityAppetite, setIsLoadingActivityAppetite] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchActivityAppetiteInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingActivityAppetite(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/activity-appetite-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setActivityAppetiteInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu aktywność-apetyt:', err);
      } finally {
        if (!cancelled) setIsLoadingActivityAppetite(false);
      }
    };
    fetchActivityAppetiteInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 6: jakość diety jako modyfikator tempa zmiany wagi.
  const [dietQualityWeightPaceInsight, setDietQualityWeightPaceInsight] = useState(null);
  const [isLoadingDietQualityWeightPace, setIsLoadingDietQualityWeightPace] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchDietQualityWeightPaceInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingDietQualityWeightPace(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/diet-quality-weight-pace-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setDietQualityWeightPaceInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu jakość diety-tempo wagi:', err);
      } finally {
        if (!cancelled) setIsLoadingDietQualityWeightPace(false);
      }
    };
    fetchDietQualityWeightPaceInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 7: streak -> realny efekt na wadze.
  const [streakWeightEffectInsight, setStreakWeightEffectInsight] = useState(null);
  const [isLoadingStreakWeightEffect, setIsLoadingStreakWeightEffect] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchStreakWeightEffectInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingStreakWeightEffect(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/streak-weight-effect-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setStreakWeightEffectInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu passa-efekt na wadze:', err);
      } finally {
        if (!cancelled) setIsLoadingStreakWeightEffect(false);
      }
    };
    fetchStreakWeightEffectInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Runda 13, nowa funkcja 8: siedzenie -> wydajność treningu tego dnia.
  const [sedentaryPerformanceInsight, setSedentaryPerformanceInsight] = useState(null);
  const [isLoadingSedentaryPerformance, setIsLoadingSedentaryPerformance] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchSedentaryPerformanceInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingSedentaryPerformance(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sedentary-performance-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setSedentaryPerformanceInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu siedzenie-wydajność treningu:', err);
      } finally {
        if (!cancelled) setIsLoadingSedentaryPerformance(false);
      }
    };
    fetchSedentaryPerformanceInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Insight: Hydratacja (water_ml) a jakość snu (sleep_score) — korelacja z ostatnich
  // 60 dni. Analogiczny wzorzec do hydration-readiness-insight, ale fokus na sen,
  // nie gotowość. Patrz /api/dashboard/water-sleep-insight.
  const [waterSleepInsight, setWaterSleepInsight] = useState(null);
  const [isLoadingWaterSleep, setIsLoadingWaterSleep] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchWaterSleepInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingWaterSleep(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/water-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setWaterSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu hydratacja-sen:', err);
      } finally {
        if (!cancelled) setIsLoadingWaterSleep(false);
      }
    };
    fetchWaterSleepInsight();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Gotowość do treningu dziś (deterministyczny composite score z Oury + Apple Health).
  // Nie wymaga AI — szybkie, bez kosztu tokenów. Patrz /api/dashboard/training-readiness.
  const [trainingReadiness, setTrainingReadiness] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchTrainingReadiness = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/training-readiness${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) setTrainingReadiness(await res.json());
      } catch (err) {
        console.error('Błąd pobierania gotowości do treningu:', err);
      }
    };
    fetchTrainingReadiness();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Analiza planu treningowego AI (Gemini, cache 7 dni). ?refresh=1 wymusza regenerację.
  // Dane: 4 tygodnie treningów + cel sylwetki + skład ciała + 7d avg regeneracji.
  // Patrz /api/dashboard/training-plan-insight.
  const [trainingPlanInsight, setTrainingPlanInsight] = useState(null);
  const [isLoadingTrainingPlan, setIsLoadingTrainingPlan] = useState(false);
  const fetchTrainingPlanInsight = async (refresh = false) => {
    if (!sessionToken) return;
    // Guard: nie wysyłaj kolejnego żądania gdy poprzednie jeszcze trwa
    // (kliknięcie "Odśwież" w trakcie ładowania). Bez tego setIsLoadingTrainingPlan(true)
    // jest wywoływane ponownie i finallyBlock może zresetować stan zbyt wcześnie.
    if (isLoadingTrainingPlan && !refresh) return;
    setIsLoadingTrainingPlan(true);
    try {
      const dateParam = selectedDate ? `?date=${selectedDate}` : '';
      const refreshParam = refresh ? (dateParam ? '&refresh=1' : '?refresh=1') : '';
      const res = await fetch(`/api/dashboard/training-plan-insight${dateParam}${refreshParam}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.status === 401) { setSessionExpired(true); return; }
      if (res.ok) setTrainingPlanInsight(await res.json());
    } catch (err) {
      console.error('Błąd pobierania analizy planu treningowego AI:', err);
    } finally {
      setIsLoadingTrainingPlan(false);
    }
  };
  // Auto-fetch ograniczony do 1×/godzinę przez localStorage, żeby nie bić
  // w endpoint przy każdym odświeżeniu strony (backend ma 7-dniowy cache AI,
  // ale samo zapytanie HTTP też jest zbędne gdy danych nie ma zmienionych).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sessionToken) return;
      // Sprawdź timestamp ostatniego auto-fetch w localStorage
      const CACHE_KEY = 'training_plan_last_auto_fetch';
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const lastFetch = Number(localStorage.getItem(CACHE_KEY) || 0);
      if (Date.now() - lastFetch < ONE_HOUR_MS) return; // pomijamy - za wcześnie
      setIsLoadingTrainingPlan(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/training-plan-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!cancelled && res.status === 401) { setSessionExpired(true); return; }
        if (res.ok && !cancelled) {
          setTrainingPlanInsight(await res.json());
          localStorage.setItem(CACHE_KEY, String(Date.now()));
        }
      } catch (err) {
        console.error('Błąd pobierania analizy planu treningowego AI:', err);
      } finally {
        if (!cancelled) setIsLoadingTrainingPlan(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // === INSIGHTY TRENINGOWE (Runda 25): Oura + Apple Watch cross-device ===

  // Sen Oura → wydajność treningu Apple Watch (dzień następny)
  const [sleepWorkoutPerfInsight, setSleepWorkoutPerfInsight] = useState(null);
  const [isLoadingSleepWorkoutPerf, setIsLoadingSleepWorkoutPerf] = useState(false);
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const dateParam = selectedDate ? `?date=${selectedDate}` : '';
    setIsLoadingSleepWorkoutPerf(true);
    fetch(`/api/dashboard/sleep-workout-performance-insight${dateParam}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    }).then(r => {
      if (!cancelled && r.status === 401) { setSessionExpired(true); return; }
      if (r.ok && !cancelled) return r.json().then(setSleepWorkoutPerfInsight);
    }).catch(err => console.error('Błąd insightu sen-trening:', err))
      .finally(() => { if (!cancelled) setIsLoadingSleepWorkoutPerf(false); });
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Gotowość Oura → wydajność Apple Watch (ten sam dzień)
  const [readinessWorkoutInsight, setReadinessWorkoutInsight] = useState(null);
  const [isLoadingReadinessWorkout, setIsLoadingReadinessWorkout] = useState(false);
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const dateParam = selectedDate ? `?date=${selectedDate}` : '';
    setIsLoadingReadinessWorkout(true);
    fetch(`/api/dashboard/readiness-workout-insight${dateParam}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    }).then(r => {
      if (!cancelled && r.status === 401) { setSessionExpired(true); return; }
      if (r.ok && !cancelled) return r.json().then(setReadinessWorkoutInsight);
    }).catch(err => console.error('Błąd insightu gotowość-trening:', err))
      .finally(() => { if (!cancelled) setIsLoadingReadinessWorkout(false); });
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Polaryzacja stref tętna 80/20 (Apple Watch only)
  const [hrPolarizationInsight, setHrPolarizationInsight] = useState(null);
  const [isLoadingHrPolarization, setIsLoadingHrPolarization] = useState(false);
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const dateParam = selectedDate ? `?date=${selectedDate}` : '';
    setIsLoadingHrPolarization(true);
    fetch(`/api/dashboard/hr-polarization-insight${dateParam}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    }).then(r => {
      if (!cancelled && r.status === 401) { setSessionExpired(true); return; }
      if (r.ok && !cancelled) return r.json().then(setHrPolarizationInsight);
    }).catch(err => console.error('Błąd insightu polaryzacja stref:', err))
      .finally(() => { if (!cancelled) setIsLoadingHrPolarization(false); });
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Ciężki trening Apple Watch → HRV/RHR Oura dzień +1/+2
  const [workoutRecoveryHrvInsight, setWorkoutRecoveryHrvInsight] = useState(null);
  const [isLoadingWorkoutRecoveryHrv, setIsLoadingWorkoutRecoveryHrv] = useState(false);
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const dateParam = selectedDate ? `?date=${selectedDate}` : '';
    setIsLoadingWorkoutRecoveryHrv(true);
    fetch(`/api/dashboard/workout-recovery-hrv-insight${dateParam}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    }).then(r => {
      if (!cancelled && r.status === 401) { setSessionExpired(true); return; }
      if (r.ok && !cancelled) return r.json().then(setWorkoutRecoveryHrvInsight);
    }).catch(err => console.error('Błąd insightu regeneracja HRV:', err))
      .finally(() => { if (!cancelled) setIsLoadingWorkoutRecoveryHrv(false); });
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // Przerwa między treningami → wydajność (Apple Watch only)
  const [workoutRestPerfInsight, setWorkoutRestPerfInsight] = useState(null);
  const [isLoadingWorkoutRestPerf, setIsLoadingWorkoutRestPerf] = useState(false);
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    const dateParam = selectedDate ? `?date=${selectedDate}` : '';
    setIsLoadingWorkoutRestPerf(true);
    fetch(`/api/dashboard/workout-rest-performance-insight${dateParam}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    }).then(r => {
      if (!cancelled && r.status === 401) { setSessionExpired(true); return; }
      if (r.ok && !cancelled) return r.json().then(setWorkoutRestPerfInsight);
    }).catch(err => console.error('Błąd insightu przerwa-wydajność:', err))
      .finally(() => { if (!cancelled) setIsLoadingWorkoutRestPerf(false); });
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  // "Tag dnia" - zakresy dat oznaczone kontekstem (choroba/wakacje/późne zaśnięcie),
  // które wybrane insighty powyżej wykluczają z liczenia własnej normy/baseline
  // (patrz backend: routes/dayEvents.js + getExcludedDates w routes/dashboard.js).
  const DAY_EVENT_TYPES = [
    { value: 'illness', label: 'Choroba' },
    { value: 'vacation', label: 'Wakacje / urlop' },
    { value: 'late_sleep', label: 'Późne zaśnięcie' }
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
      console.error('Błąd pobierania zdarzeń dnia:', err);
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
      setDayEventMessage({ type: 'error', text: 'Data końcowa nie może być wcześniejsza niż data początkowa.' });
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
        await fetchDayEvents({ current: false }); // F-S3: cancelledRef wymagany przez sygnaturę funkcji
        setTimeout(() => setDayEventMessage({ type: '', text: '' }), 4000);
      } else {
        const data = await res.json().catch(() => ({}));
        setDayEventMessage({ type: 'error', text: data.error || 'Błąd zapisu zdarzenia.' });
      }
    } catch (err) {
      console.error(err);
      setDayEventMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
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
      console.error('Błąd usuwania zdarzenia dnia:', err);
    }
  };

  // Czy podana data (np. aktualnie wybrany dzień na dashboardzie) wpada w zakres
  // któregoś zdarzenia o jednym z podanych typów - użyte do dopisku kontekstu
  // ("oznaczony: choroba") w kartach insightów, które ten typ wyklucza z baseline.
  const getDayEventLabelForDate = (dateStr, types) => {
    if (!dateStr || dayEvents.length === 0) return null;
    const match = dayEvents.find(ev => types.includes(ev.type) && dateStr >= ev.start_date && dateStr <= ev.end_date);
    return match ? DAY_EVENT_TYPE_LABELS[match.type] : null;
  };

  // Zwijalna sekcja "Analizy" (UX: rundy 7 - 12 kart insightów w jednym miejscu,
  // domyślnie zwinięta, żeby nie zalewać dashboardu od razu po wejściu).
  const [isAnalizyOpen, setIsAnalizyOpen] = useState(false);
  // Zwijalna tabela stref tętna (UX: rundy 7 - statyczna tabela referencyjna 5
  // strefy, nie trzeba jej widzieć od razu, wystarczy link rozwijający).
  const [isHrZonesOpen, setIsHrZonesOpen] = useState(false);
  // Zwijalna historia suplementacji (UX: runda 7 - pasek 7 dni + lista "Ostatnio
  // przyjmowane" domyślnie schowane za "Pokaż historię", widoczny tylko licznik).
  const [isSupplementsHistoryOpen, setIsSupplementsHistoryOpen] = useState(false);

  // Adaptacyjna korekta celu kalorycznego: porównanie deklarowanego bilansu
  // (z zalogowanych posiłków) z bilansem wynikającym z realnej zmiany wagi
  // (patrz endpoint /api/dashboard/calorie-target-suggestion). caloriesTrigger
  // wymusza ponowne pobranie po kliknięciu "Zastosuj", żeby karta zniknęła/
  // zaktualizowała się bez czekania na pełne odświeżenie strony.
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
        console.error('Błąd pobierania korekty celu kalorycznego:', err);
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
        // F-S4: Obsługa 401 — wygasła sesja
        onLogout();
      }
    } catch (err) {
      console.error('Błąd zapisu nowego celu kalorycznego:', err);
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
        console.error('Błąd pobierania historii:', err);
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [sessionToken, summary.last_sync, historyTrigger]);

  useEffect(() => {
    let cancelled = false;
    const fetchComparisonAndBalance = async () => {
      if (!sessionToken) return;
      setIsLoadingComparison(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const [comparisonRes, balanceRes] = await Promise.all([
          fetch(`/api/dashboard/nutrition-comparison${dateParam}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          }),
          fetch(`/api/dashboard/calorie-balance${dateParam}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          })
        ]);
        if (!cancelled) {
          if (comparisonRes.ok) setNutritionComparison(await comparisonRes.json());
          if (balanceRes.ok) setCalorieBalance(await balanceRes.json());
        }
      } catch (err) {
        console.error('Błąd pobierania porównania/bilansu kalorycznego:', err);
      } finally {
        if (!cancelled) setIsLoadingComparison(false);
      }
    };
    fetchComparisonAndBalance();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate]);

  const renderWeightCompositionChart = (data) => {
    let validData = data.filter(d => 
      (d.weight !== null && d.weight !== undefined) || 
      (d.fat_ratio !== null && d.fat_ratio !== undefined) ||
      (d.muscle_mass !== null && d.muscle_mass !== undefined)
    );

    if (validData.length === 0) {
      // Brak rzeczywistych danych wagi/składu ciała w bazie - pokazujemy
      // szczery komunikat o braku danych, bez generowania fałszywego wykresu.
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
          <span>📈 Trend składu ciała (30 dni)</span>
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

  // Dane wyłącznie z bazy (backend) - bez sztucznych wartości demo.
  // Gdy w bazie nie ma jeszcze wartości za dany dzień, pokazujemy 0 / brak danych.
  const sleepScore = summary.sleep_score ?? 0;
  const readinessScore = summary.readiness_score ?? 0;

  // POPRAWKA (runda 4 audytu): cele dzienne (kroki, kalorie, sen, minuty ćwiczeń) mogą
  // być świadomie zapisane jako 0 (cel wyłączony - patrz `??` w kartach celów niżej oraz
  // poprawka w dashboard.js/ActivityTracker.jsx, gdzie `||` wcześniej bezpowrotnie
  // nadpisywało takie 0 domyślną wartością). Samo dzielenie przez cel=0 dawałoby
  // Infinity/NaN w procencie paska postępu - helper jawnie traktuje wyłączony cel jako
  // "0% do pokazania" zamiast renderować NaN%.
  const goalProgressPct = (value, target) => target > 0 ? Math.min(Math.round((value / target) * 100), 100) : 0;

  const steps = summary.steps || 0;
  // activeCalories: 0 i "brak danych" są tu równoważne (brak treningu = 0 kalorii
  // aktywnych), więc || 0 zostaje - w odróżnieniu od rhr/hrv poniżej.
  const activeCalories = summary.calories_burned_active || 0;
  // POPRAWKA (runda 4 audytu): effortScore liczył % wysiłku względem sztywnych 800
  // kcal, a "Bateria energii" niżej liczy rozładowanie względem
  // targetActiveCaloriesForBattery (cel z ustawień, domyślnie 500 kcal) - dwie karty
  // opisujące tę samą aktywność dnia dawały niespójne, nieporównywalne ze sobą %,
  // gdy cel użytkownika różnił się od 800 kcal. Ujednolicone na wspólny mianownik.
  // POPRAWKA (runda 4 audytu): `||` nadpisywał świadomie zapisany cel=0 (wyłączony cel
  // aktywnych kalorii, patrz dashboard.js/ActivityTracker.jsx) domyślnym 500. `??`
  // zachowuje realne 0 - dzielenie przez nie jest bezpieczne tutaj, bo effortScore i
  // batteryDepletion niżej mają osobne zabezpieczenie przed 0/0 (NaN).
  const targetActiveCaloriesForBattery = summary.target_active_calories ?? 500;
  const effortScore = activeCalories > 0 ? Math.round(Math.min((activeCalories / targetActiveCaloriesForBattery) * 100, 100)) : 0;
  const activeMinutes = summary.active_minutes || 0;

  const sleepDurationHours = summary.sleep_duration ?? 0;
  const sleepDeepHours = summary.sleep_deep ?? 0;
  const sleepRemHours = summary.sleep_rem ?? 0;
  // sleepAwakeMins nie jest jeszcze wyliczane z danych Oura (zawsze 0) - karta
  // "Czas czuwania" jest dlatego ukrywana w renderze, żeby nie pokazywać fałszywego 0m.
  const sleepAwakeMins = 0;
  const sleepLightHours = Math.max(sleepDurationHours - sleepDeepHours - sleepRemHours - (sleepAwakeMins / 60), 0);

  // rhr/hrv: 0 byłoby fizjologicznie nierealną wartością, więc tu (w odróżnieniu od
  // np. steps) używamy ?? null, żeby odróżnić "brak danych" od realnego pomiaru.
  const rhr = summary.rhr ?? null;
  const hrv = summary.hrv ?? null;

  const weight = summary.weight ?? 0;
  const fatRatio = summary.fat_ratio ?? 0;
  const muscleMass = summary.muscle_mass ?? 0;

  // BMI - liczone wyłącznie z realnego wzrostu użytkownika (Ustawienia -> Wzrost).
  // Brak fałszywego domyślnego wzrostu 1.80m i brak fałszywego fallbacku "24.5".
  // Gdy nie ma wagi lub wzrostu, BMI po prostu nie jest pokazywane.
  const heightCm = summary.height_cm ?? null;
  const bmiValue = (weight > 0 && heightCm)
    ? Math.round((weight / ((heightCm / 100) * (heightCm / 100))) * 10) / 10
    : null;
  const bmiCategory = bmiValue === null
    ? null
    : bmiValue < 18.5 ? 'Niedowaga'
    : bmiValue < 25 ? 'W normie'
    : bmiValue < 30 ? 'Nadwaga'
    : 'Otyłość';

  // Kalkulacja stref tętna (Karvonen) na bazie RHR z Oura.
  // userMaxHr: realne HRmax (220 - wiek) liczone przez backend z roku urodzenia
  // użytkownika (Ustawienia -> Rok urodzenia). Fallback 190 (~wiek 30 lat) tylko
  // gdy użytkownik nie podał roku urodzenia.
  const userMaxHr = summary.user_max_hr || 190;
  // rhr może być null (brak danych z Oura za ten dzień) - do samych obliczeń
  // używamy lokalnego fallbacku 0, ale karta poniżej jest ukrywana, gdy rhr == null,
  // żeby nie pokazywać stref wyliczonych z fałszywego RHR.
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
  
  // Odżywianie
  // Użyto ?? (nie ||), bo cel ustawiony świadomie na 0 (np. dieta eliminacyjna jednego
  // makroskładnika) nie powinien być nadpisywany domyślną wartością - ten sam wzorzec
  // błędu naprawiony już wcześniej dla target_steps/target_active_calories/itd.
  const targetCalories = summary.target_calories ?? 2000;
  const eatenCalories = summary.calories_eaten || 0;
  const targetProtein = summary.target_protein ?? 150;
  const targetCarbs = summary.target_carbs ?? 250;
  const targetFat = summary.target_fat ?? 80;
  const eatenProtein = summary.eaten_protein || 0;
  const eatenCarbs = summary.eaten_carbs || 0;
  const eatenFat = summary.eaten_fat || 0;
  // POPRAWKA (runda 17 audytu): wcześniej procenty wypełnienia pasków liczyły
  // `eatenX / (targetX || 2000)` itd. - `||` ponownie nadpisywał świadomie
  // zapisane 0 (cel wyłączony/wyzerowany) domyślną wartością, mimo że targetX
  // już jest poprawnie wyliczone przez `??` powyżej. Dodatkowo dzielenie przez 0
  // (gdyby cel=0 trafił bezpośrednio do dzielenia) dawałoby Infinity/NaN. Wzorzec
  // zabezpieczenia jak przy waterPct: cel<=0 -> procent 0, brak dzielenia przez 0.
  const caloriesPct = targetCalories > 0 ? Math.min((eatenCalories / targetCalories) * 100, 100) : 0;
  const carbsPct = targetCarbs > 0 ? Math.min((eatenCarbs / targetCarbs) * 100, 100) : 0;
  const proteinPct = targetProtein > 0 ? Math.min((eatenProtein / targetProtein) * 100, 100) : 0;
  const fatPct = targetFat > 0 ? Math.min((eatenFat / targetFat) * 100, 100) : 0;

  // Licznik wody
  const waterMl = summary.water_ml || 0;
  // POPRAWKA (runda 4 audytu): jak wyżej - `??` zachowuje świadomie zapisane 0 (cel
  // wyłączony), a waterPct dostaje jawne zabezpieczenie przed dzieleniem 0/0 (NaN),
  // gdy cel=0 i nic jeszcze nie wypito.
  const targetWaterMl = summary.target_water_ml ?? 2500;
  const waterPct = targetWaterMl > 0 ? Math.min(Math.round((waterMl / targetWaterMl) * 100), 100) : 0;

  // Aktualne obciążenie na suwaku (np. wysiłek)
  const currentLoadPos = Math.max(Math.min(effortScore, 100), 5); // min 5% dla widoczności suwaka
  
  // Bateria energii - realny algorytm, bez sztucznych przesunięć.
  // Punkt startowy: readinessScore (realny wynik regeneracji z Oura/Apple Health).
  // Rozładowanie: proporcjonalne do dzisiejszych aktywnych kalorii względem celu
  // aktywności użytkownika (im więcej wysiłku względem celu, tym większy spadek -
  // analogicznie do "Body Battery" w urządzeniach typu Garmin, ale z realnych danych).
  // Brak readinessScore (brak synchronizacji urządzenia) = brak baterii, nie zgadujemy.
  // POPRAWKA (runda 4 audytu): gdy cel aktywnych kalorii jest świadomie ustawiony na 0
  // (patrz `??` powyżej), a użytkownik nie spalił żadnych aktywnych kalorii, samo
  // dzielenie 0/0 dawało NaN i psuło całą "baterię energii" - dodane jawne
  // zabezpieczenie: cel=0 oznacza brak rozładowania (rozładowanie tylko gdy jest realny
  // cel do przekroczenia).
  const batteryDepletion = readinessScore > 0 && targetActiveCaloriesForBattery > 0
    ? Math.round(Math.min(activeCalories / targetActiveCaloriesForBattery, 1) * 20)
    : 0;
  const batteryPct = readinessScore > 0
    ? Math.max(Math.min(readinessScore - batteryDepletion, 100), 0)
    : null;

  // Porównanie z wczorajszym dniem - liczone z realnej historii (historyData),
  // tym samym algorytmem co dzisiejsza bateria. Brak danych za wczoraj = brak etykiety.
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

  // Ostatnia synchronizacja i źródło danych aktywności - pole `last_sync` było już
  // od dawna pobierane z backendu, ale nigdzie nie wyświetlane użytkownikowi.
  const lastSyncDate = summary.last_sync ? new Date(summary.last_sync) : null;
  const formatRelativeSync = (date) => {
    if (!date || isNaN(date.getTime())) return null;
    const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
    if (diffMin < 1) return 'przed chwilą';
    if (diffMin < 60) return `${diffMin} min temu`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `${diffHours} godz. temu`;
    return `${Math.round(diffHours / 24)} dni temu`;
  };
  const lastSyncLabel = formatRelativeSync(lastSyncDate);
  const activitySourceLabels = { apple: '🍏 Apple Health', oura: '💍 Oura Ring', google_fit: '🟢 Google Fit' };
  const activitySourceLabel = summary.activity_source ? (activitySourceLabels[summary.activity_source] || summary.activity_source) : null;

  // Dystans i rozbicie aktywności dnia (Oura daily_activity / Google Fit / Apple Health) -
  // liczniki dzienne, zerujące się każdego dnia tak jak kroki (patrz backend dashboard.js).
  const distanceMeters = summary.distance_meters || 0;
  const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
  const sedentaryMinutes = summary.sedentary_minutes || 0;
  const lowActivityMinutes = summary.low_activity_minutes || 0;
  const hasActivityBreakdown = distanceMeters > 0 || sedentaryMinutes > 0 || lowActivityMinutes > 0 || activeMinutes > 0;

  // Realny poziom stresu z Oury (endpoint daily_stress) - w przeciwieństwie do wcześniej
  // usuniętej, w 100% fałszywej sekcji, ta karta pojawia się TYLKO gdy backend faktycznie
  // ma realne dane (pierścionek z funkcją pomiaru stresu).
  const stressHighMinutes = summary.stress_high_minutes;
  const stressRecoveryMinutes = summary.stress_recovery_minutes;
  const stressSummary = summary.stress_summary;
  const hasStressData = stressHighMinutes != null || stressRecoveryMinutes != null || stressSummary != null;
  const stressSummaryLabels = { restored: 'Zregenerowany', normal: 'Normalny', stressful: 'Stresujący' };

  // Ostatni zapisany pomiar obwodów ciała - pełny CRUD i wykres trendu jest już w
  // ActivityTracker, tu tylko skrót najnowszej wartości na głównym Dashboardzie.
  const latestBodyMeasurement = summary.latest_body_measurement || null;

  // Streaki celów - liczone przez backend wyłącznie na bazie historii już zapisanej
  // w bazie (meals + health_metrics), zero nowych integracji (punkt 9 z analizy).
  const calorieStreakDays = summary.calorie_streak_days || 0;
  const sleepStreakDays = summary.sleep_streak_days || 0;

  // Lista ostatnich aktywności - tylko rzeczywiste treningi z bazy.
  // Gdy brak treningów, lista jest pusta (patrz pusty stan w renderze).
  // UWAGA: poprzednio dateLabel był zahardkodowany na 'dzisiaj' niezależnie od
  // selectedDate - przy przeglądaniu dashboardu za inny dzień (date picker w App.jsx)
  // karta treningu błędnie pokazywała "dzisiaj" dla treningów z tamtego dnia.
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

  // Stany dla wbudowanego czatu z asystentem Dietetyk AI
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

  // `overrideText` pozwala wysłać wiadomość bez przepisywania jej do pola input -
  // używane przez chipy szybkich pytań (Runda 8), które wysyłają gotowy tekst od razu
  // po kliknięciu, zamiast najpierw wstawiać go do <input> i czekać na osobny submit.
  const handleSendChat = async (e, overrideText) => {
    if (e && e.preventDefault) e.preventDefault();
    const userMsg = (overrideText !== undefined ? overrideText : chatInput).trim();
    if (!userMsg || isSendingChat) return;

    setChatInput('');
    // Budujemy nową historię jawnie (a nie przez closure na `chatMessages`) - setChatMessages
    // poniżej jest asynchroniczny, więc zmienna `chatMessages` w tym wywołaniu funkcji
    // wciąż wskazywałaby na stan SPRZED dodania aktualnej wiadomości użytkownika (stale
    // closure). Bez tej poprawki backend (routes/chat.js) dostawał historię, w której
    // brakowało właśnie wysłanej wiadomości - AI odpowiadał bez kontekstu ostatniego pytania.
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
        setChatMessages(prev => [...prev, { sender: 'ai', text: 'Przepraszam, wystąpił problem z połączeniem. Upewnij się, że masz skonfigurowany Gemini API Key w Ustawieniach.' }]);
      }
    } catch (err) {
      setChatMessages(prev => [...prev, { sender: 'ai', text: 'Błąd sieciowy. Nie można połączyć się z asystentem Dietetyk AI.' }]);
    } finally {
      setIsSendingChat(false);
    }
  };

  // Dodanie wypitej wody (przyciski szybkiego dodawania + własna ilość)
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
        setWaterMessage(data.error || 'Nie udało się zapisać wody.');
      }
    } catch (err) {
      setWaterMessage('Błąd sieciowy. Nie udało się zapisać wody.');
    } finally {
      setIsAddingWater(false);
    }
  };

  const handleResetWater = async () => {
    if (isAddingWater) return;
    // F-N1: Potwierdzenie przed resetem licznika wody
    if (!window.confirm('Zresetować licznik wody do 0?')) return;
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
        setWaterMessage(data.error || 'Nie udało się zresetować licznika wody.');
      }
    } catch (err) {
      setWaterMessage('Błąd sieciowy. Nie udało się zresetować licznika wody.');
    } finally {
      setIsAddingWater(false);
    }
  };

  // formatHoursMins przeniesione do utils/format.js (import na górze pliku) -
  // ta sama logika była duplikowana też w Trends.jsx i potencjalnie ActivityTracker.jsx.

  // Renderowanie porady AI jako Markdown (pogrubienia, listy punktowane).
  // dashboard.js prosi Gemini o odpowiedź w Markdown - bez tej konwersji
  // React wyświetliłby "**tekst**" dosłownie, z gwiazdkami na ekranie.
  // Najpierw escapujemy HTML (tekst generuje LLM, mógł przepisać coś od
  // użytkownika), potem zamieniamy tylko znane znaczniki Markdown na HTML.
  const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Rozpoznaje nagłówki (## Analiza / ### Coś), listy punktowane ("- "/"* ") ORAZ
  // numerowane ("1. ") - poprzednia wersja obsługiwała tylko listy punktowane i
  // akapity, więc nowa, ustrukturyzowana odpowiedź AI (nagłówki "## Analiza" /
  // "## Rekomendacje" z promptu w dashboard.js) renderowała się jako zwykły tekst
  // z widocznymi "##" na ekranie. Domykamy każdą listę/nagłówek przy zmianie typu
  // linii, żeby nigdy nie zostawić otwartego <ul>/<ol>.
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
      
      {/* NAGŁÓWEK REGENERACJI AI */}
      <div className="dietetyk-ai-banner" style={{ boxShadow: getReadinessColor(), border: getReadinessBorder() }}>
        <div className="premium-title-row">
          <span className="dietetyk-greeting">
            {userProfile?.first_name
              ? (readinessScore >= 80
                  ? `Gotowy na pełne obciążenie, ${userProfile.first_name}!`
                  : `Gotowy na lżejszą pracę, ${userProfile.first_name}!`)
              : (readinessScore >= 80
                  ? "Dzisiaj wyglądasz na gotowego na pełne obciążenie"
                  : "Dzisiaj wyglądasz na gotowego do lżejszej pracy")
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
            {/* F-W1: Guard dla null HRV — wypisanie 'null ms' zamiast wartości */}
            {`Twoja regeneracja trzyma stabilny poziom (${readinessScore}%). HRV wynosi ${hrv != null ? hrv + ' ms' : '(brak danych)'} i mieści się w normie, więc organizm nie protestuje przeciwko aktywności. Dobrym wyborem będzie lekki tlenowy wysiłek kardio lub sesja mobility.`}
          </p>
        )}
        <button className="btn-dietetyk-ask" onClick={() => setIsChatOpen(true)}>
          ✨ Zapytaj agenta
        </button>
      </div>

      {/* STATUS SYNCHRONIZACJI - dane już dawno zbierane (last_sync, activity_source),
          ale wcześniej nigdzie nie ujawnione użytkownikowi. */}
      <div data-testid="status-sync-bar" style={{ gridColumn: 'span 2', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', padding: '0 4px', marginTop: '-6px', marginBottom: '4px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
        <span>
          {lastSyncLabel ? `🔄 Zsynchronizowano: ${lastSyncLabel}` : '🔄 Brak jeszcze synchronizacji'}
        </span>
        {activitySourceLabel && (
          <span>· Źródło aktywności: {activitySourceLabel}</span>
        )}
      </div>

      {/* KOLUMNY DASHBOARDU DLA ZAPEWNIENIA MASONRY / BRAKU CZARNYCH PRZESTRZENI */}
      <div className="dashboard-column">
        {/* POTRÓJNE RINGI: SEN, REGENERACJA, WYSIŁEK */}
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

            {/* Wysiłek */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={84} strokeWidth={7} percentage={effortScore} color={effortScore > 0 ? "var(--danger)" : "rgba(255,255,255,0.08)"} />
                <div style={{ position: 'absolute', fontSize: '1.05rem', fontWeight: '800', color: '#fff' }}>
                  {effortScore}%
                </div>
              </div>
              <span className="ring-item-label">🔥 Wysiłek</span>
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
                  🔥 {calorieStreakDays} {calorieStreakDays === 1 ? 'dzień' : 'dni'} z rzędu w celu kalorycznym
                </span>
              )}
              {sleepStreakDays > 0 && (
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '4px 10px', borderRadius: '999px' }}>
                  😴 {sleepStreakDays} {sleepStreakDays === 1 ? 'dzień' : 'dni'} z rzędu z celem snu
                </span>
              )}
            </div>
          )}
          <div className="premium-grid-2">
            <DailyGoalCard
              title="Kroki"
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
              val1={String(Math.floor(sleepDurationHours))}
              unit1="godz"
              val2={String(Math.round((sleepDurationHours - Math.floor(sleepDurationHours)) * 60))}
              unit2="min"
              percentage={goalProgressPct(sleepDurationHours, summary?.target_sleep_duration ?? 7.2)}
              barType="gradient"
            />
            <DailyGoalCard
              title="Minuty ćwiczeń"
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

        {/* GOTOWOŚĆ DO TRENINGU DZIŚ — pod celami dziennymi, jako bezpośrednia
            odpowiedź na pytanie "co robić dziś z aktywnością?". */}
        {summary?.has_oura && trainingReadiness && trainingReadiness.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🏋️ Gotowość do treningu</span>
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
              <span className="premium-title">🏋️ Gotowość do treningu</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px', marginBottom: 0 }}>
              Potrzeba co najmniej 14 dni danych z Oury (gotowość lub HRV) aby ocenić gotowość do treningu.
            </p>
          </div>
        )}

        {/* PORÓWNANIE TYDZIEŃ/MIESIĄC I BILANS KALORYCZNY NARASTAJĄCO */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">📊 Porównanie i bilans</span>
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
                    { label: 'Tydzień', data: nutritionComparison.week },
                    { label: 'Miesiąc', data: nutritionComparison.month }
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
                          {data.calories_change_pct == null ? 'brak danych do porównania' : `${data.calories_change_pct > 0 ? '+' : ''}${data.calories_change_pct}% vs poprzedni okres`}
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
                          Bilans {label} vs cel ({data.days_with_data} {data.days_with_data === 1 ? 'dzień' : 'dni'} z danymi)
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

        {/* ANALIZA PLANU TRENINGOWEGO AI (Gemini, cache 7 dni). Ocenia, czy Twój plan
            jest optymalny pod cel sylwetki. "Odśwież" → ?refresh=1 → nowa analiza. */}
        {(trainingPlanInsight || isLoadingTrainingPlan) && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🤖 Analiza planu treningowego AI</span>
              <button
                onClick={() => fetchTrainingPlanInsight(true)}
                disabled={isLoadingTrainingPlan}
                style={{ fontSize: '0.72rem', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', cursor: isLoadingTrainingPlan ? 'not-allowed' : 'pointer', opacity: isLoadingTrainingPlan ? 0.5 : 1 }}
                aria-label="Odśwież analizę planu treningowego"
              >
                {isLoadingTrainingPlan ? 'Generuję…' : 'Odśwież'}
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

        {/* "TAG DNIA" - zakresy dat oznaczone kontekstem (choroba/wakacje/późne
            zaśnięcie), wykluczane z liczenia normy w wybranych analizach powyżej. */}
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
              {isDayEventsOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
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
              {isSavingDayEvent ? 'Zapisywanie...' : 'Dodaj'}
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

        {/* ZWIJALNA SEKCJA "ANALIZY" - 12 kart opisowych porównań (sen, sód,
            regeneracja, suplementy + 8 nowych z rundy 7), domyślnie zwinięta,
            żeby nie zalewać dashboardu od razu po wejściu (UX runda 7, punkt 1). */}
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
              {isAnalizyOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
            </span>
          </div>
        </div>

        {isAnalizyOpen && (
          <>
        {/* INSIGHT: SEN -> ODŻYWIANIE NASTĘPNEGO DNIA */}
        {summary?.has_oura && !isLoadingSleepInsight && sleepInsight && sleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😴 Sen → następny dzień</span>
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
              <span className="premium-title">😴 Sen → następny dzień</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o śnie i posiłkach (min. {sleepInsight.minNightsRequired} w każdej grupie - krótki/wystarczający sen).
              Obecnie: {sleepInsight.shortSleepNights} vs {sleepInsight.goodSleepNights}.
            </p>
          </div>
        )}

        {/* ALERT/INSIGHT: SÓD -> CIŚNIENIE - karta pojawia się tylko, gdy jest coś
            realnie do powiedzenia: dzisiejszy sód jest wysoki LUB mamy wystarczającą
            historię do personalnego porównania. Inaczej karta byłaby pustym szumem
            na większości dni. */}
        {sodiumBpInsight && (sodiumBpInsight.today?.isHigh || sodiumBpInsight.insight?.hasEnoughData) && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🧂 Sód → ciśnienie</span>
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

        {/* WSKAŹNIK REGENERACJI: HRV/RHR PO TRENINGU */}
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
              {/* Próg "znaczącego" treningu (20 min) jest ustalony w backendzie
                  (SIGNIFICANT_WORKOUT_MIN_MINUTES w dashboard.js) - tu tylko opisowo. */}
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

        {/* INSIGHT: BŁONNIK -> SEN GŁĘBOKI/REM TEJ SAMEJ NOCY */}
        {summary?.has_oura && fiberSleepInsight && fiberSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🌾 Błonnik → sen</span>
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

        {/* DETEKTOR REKOMPOZYCJI CIAŁA - tylko, gdy trendy pasa i wagi się rozjeżdżają */}
        {bodyRecompInsight && bodyRecompInsight.hasEnoughData && bodyRecompInsight.divergentTrend && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📐 Rekompozycja ciała</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Trend obwodu pasa i trend wagi idą w różnych kierunkach - możliwy sygnał zmiany składu ciała (np. przyrost mięśni przy redukcji tkanki tłuszczowej), nie tylko samej wagi.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Pas (trend/tydzień)</span>
                <span style={{ fontWeight: '700', color: bodyRecompInsight.waistSlopeCmPerWeek < 0 ? 'var(--success-light)' : bodyRecompInsight.waistSlopeCmPerWeek > 0 ? 'var(--danger-light)' : '#fff' }}>
                  {bodyRecompInsight.waistSlopeCmPerWeek > 0 ? '+' : ''}{bodyRecompInsight.waistSlopeCmPerWeek} cm
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Waga (trend/tydzień)</span>
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

        {/* WCZESNY ALERT PRZECIĄŻENIA/MOŻLIWEJ INFEKCJI - tylko gdy alert aktywny */}
        {strainAlert && strainAlert.hasEnoughData && strainAlert.alert && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">⚠️ Sygnały przeciążenia</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--danger-light)', marginTop: '2px', marginBottom: '10px', fontWeight: 600 }}>
              Dziś częstość oddechów, odchylenie temperatury i gotowość naraz odbiegają od Twojej średniej z ostatnich {strainAlert.baselineDays} dni - możliwy sygnał przetrenowania lub początku infekcji.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Częstość oddechów</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.respiratoryRate} vs śr. {strainAlert.baseline.avgRespiratoryRate}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Odchylenie temperatury</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.temperatureDeviation}°C vs śr. {strainAlert.baseline.avgTemperatureDeviation}°C</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Gotowość</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.readinessScore} vs śr. {strainAlert.baseline.avgReadinessScore}</span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Sygnał statystyczny na bazie Twojej własnej historii, NIE diagnoza medyczna - przy złym samopoczuciu skonsultuj się z lekarzem.
            </p>
          </div>
        )}

        {/* INSIGHT: STRES -> SÓD/CUKIER TEGO SAMEGO DNIA */}
        {summary?.has_oura && stressNutritionInsight && stressNutritionInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😰 Stres → odżywianie</span>
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

        {/* INSIGHT: LICZBA POSIŁKÓW DZIENNIE -> TRAFIENIE W CEL KALORYCZNY */}
        {mealFreqInsight && mealFreqInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🍽️ Częstość posiłków → cel</span>
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

        {/* INSIGHT (Runda 8): TREND SPOCZYNKOWEGO TĘTNA */}
        {summary?.has_oura && rhrDriftInsight && rhrDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">❤️ Trend tętna spoczynkowego</span>
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

        {/* INSIGHT (Runda 8): GODZINA OSTATNIEGO POSIŁKU -> SEN */}
        {summary?.has_oura && mealTimingSleepInsight && mealTimingSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🍽️ Godzina posiłku → sen</span>
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

        {/* INSIGHT (Runda 9): SAMODZIELNY TREND CIŚNIENIA KRWI */}
        {bpTrendInsight && bpTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🩺 Trend ciśnienia krwi</span>
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

        {/* INSIGHT: NAWODNIENIE -> GOTOWOŚĆ/HRV/RHR */}
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

        {/* KARTA: SAMOPOCZUCIE DNIA (energia + nastrój, skala 1–5).
            Przyciski są renderowane inline (bez lokalnego komponentu wewnątrz IIFE),
            żeby React nie tworzył nowej referencji funkcji przy każdym renderze
            i nie wykonywał zbędnego unmount/remount przycisków. */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚡ Samopoczucie dnia</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '4px' }}>
            {/* Wiersz: Energia */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Energia</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[['😴','Bardzo niska'],['😕','Niska'],['😐','Średnia'],['😊','Wysoka'],['⚡','Bardzo wysoka']].map(([emoji, label], i) => {
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
            {/* Wiersz: Nastrój */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Nastrój</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[['😞','Bardzo zły'],['😔','Zły'],['😐','Neutralny'],['🙂','Dobry'],['😄','Świetny']].map(([emoji, label], i) => {
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
                {feelingMessage.text || 'Dane pomogą AI w analizie Twojego samopoczucia'}
              </span>
              <button className="btn-primary" disabled={isSavingFeeling} onClick={handleSaveFeeling}
                style={{ padding: '6px 18px', fontSize: '0.8rem' }}>
                {isSavingFeeling ? 'Zapisywanie...' : 'Zapisz'}
              </button>
            </div>
          </div>
        </div>

        {/* INSIGHT: REALNE STREFY KARDIO Z TRENINGÓW (zmierzone tętnem, nie wzór) */}
        {hrZonesInsight && hrZonesInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥 Realne strefy kardio z treningów</span>
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

        {/* INSIGHT: TREND JAKOŚCI POSIŁKÓW (health_rating) */}
        {mealQualityTrendInsight && mealQualityTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🥗 Trend jakości posiłków</span>
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

        {/* INSIGHT: EFEKTYWNOŚĆ KALORII PER TYP TRENINGU */}
        {workoutEfficiencyInsight && workoutEfficiencyInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">⚡ Efektywność kalorii per trening</span>
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

        {/* INSIGHT: STABILNOŚĆ ULUBIONYCH POSIŁKÓW (DRYF) */}
        {favoriteMealDriftInsight && favoriteMealDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔁 Stabilność ulubionych posiłków</span>
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

        {/* INSIGHT (Runda 11): AI TŁUMACZĄCE PRZYCZYNY (styl Oura Advisor/Whoop Coach) */}
        {/* Runda 12 (audyt): jawny stan ładowania - zamiast karty, która po prostu nie
            istniała do czasu odpowiedzi API (wyglądało to jak brak insightu, nie ładowanie). */}
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
        {/* Pusty stan: dane są wystarczające, ale AI nie znalazło dziś żadnego znaczącego
            odchylenia (z-score poniżej progu) - bez tego karta po prostu nie pojawiała się,
            co użytkownik mógł odczytać jako błąd/brak danych, a nie "wszystko w normie". */}
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

        {/* INSIGHT (Runda 11): BENCHMARK "TY DZIŚ VS TY W PRZESZŁOŚCI" (bez porównań z innymi użytkownikami) */}
        {isLoadingSelfBenchmark && !selfBenchmarkInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📊 Ty dziś vs Ty w przeszłości</span>
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
              <span className="premium-title">📊 Ty dziś vs Ty w przeszłości</span>
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
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}> (niżej = lepiej)</span>
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
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}> (niżej = lepiej)</span>
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
              <span className="premium-title">📊 Ty dziś vs Ty w przeszłości</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {selfBenchmarkInsight.reason === 'no_data_for_date'
                ? 'Brak danych zdrowia/posiłków dla tego dnia.'
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

        {/* INSIGHT (Runda 10): WSKAŹNIK WHR */}
        {whrInsight && whrInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📏 Wskaźnik WHR (pas/biodra)</span>
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

        {/* INSIGHT (Runda 10): SYMETRIA BICEPSÓW */}
        {bodySymmetryInsight && bodySymmetryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💪 Symetria bicepsów</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Z {bodySymmetryInsight.measurements} pomiarów (lewy vs prawy biceps), najnowszy: {bodySymmetryInsight.latestDate}.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Średnia różnica (L - P)</span>
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

        {/* INSIGHT (Runda 10): RÓŻNORODNOŚĆ TRENINGÓW */}
        {workoutVarietyInsight && workoutVarietyInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🎲 Różnorodność treningów</span>
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

        {/* INSIGHT (Runda 13, nowa funkcja 2): MASA MIĘŚNIOWA VS BIAŁKO */}
        {isLoadingMuscleProtein && !muscleProteinInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💪🥩 Masa mięśniowa vs białko</span>
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
              <span className="premium-title">💪🥩 Masa mięśniowa vs białko</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Trend masy mięśniowej z ostatnich {muscleProteinInsight.muscleSpanDays} dni ({muscleProteinInsight.muscleMeasurements} pomiarów) i Twoje śr. spożycie białka ({muscleProteinInsight.proteinLoggedDays} dni z logiem).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Trend masy mięśniowej</span>
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
                  {muscleProteinInsight.proteinAdequate ? 'wystarczające' : `poniżej ${muscleProteinInsight.adequateProteinThresholdGPerKg} g/kg`}
                </span>
              )}
            </div>
          </div>
        )}
        {!isLoadingMuscleProtein && muscleProteinInsight && !muscleProteinInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💪🥩 Masa mięśniowa vs białko</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {muscleProteinInsight.reason === 'not_enough_data'
                ? 'Za mało pomiarów masy mięśniowej lub dni z zalogowanym białkiem.'
                : muscleProteinInsight.reason === 'span_too_short'
                ? 'Pomiary masy mięśniowej obejmują za krótki okres.'
                : 'Brak wyraźnego trendu masy mięśniowej w tym okresie.'}
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
                ? 'Odczyty z obu źródeł są zbyt blisko własnej średniej (szum pomiaru), by ocenić zgodność kierunku wychylenia.'
                : 'Za mało dni z odczytami temperatury z obu źródeł jednocześnie.'}
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 4): PROPORCJE OBWODÓW CIAŁA */}
        {isLoadingBodyProportions && !bodyProportionsInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📐 Proporcje obwodów ciała</span>
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
              <span className="premium-title">📐 Proporcje obwodów ciała</span>
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
              <span className="premium-title">📐 Proporcje obwodów ciała</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało pomiarów obwodów (barki/klatka i talia), by ocenić zmianę proporcji w czasie.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 5): AKTYWNOŚĆ DNIA VS APETYT */}
        {isLoadingActivityAppetite && !activityAppetiteInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥🍽️ Aktywność dnia vs apetyt</span>
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
              <span className="premium-title">🔥🍽️ Aktywność dnia vs apetyt</span>
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
              <span className="premium-title">🔥🍽️ Aktywność dnia vs apetyt</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o aktywności i posiłkach do porównania.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 6): JAKOŚĆ DIETY I TEMPO ZMIANY WAGI */}
        {isLoadingDietQualityWeightPace && !dietQualityWeightPaceInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🥗⚖️ Jakość diety i tempo zmiany wagi</span>
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
              <span className="premium-title">🥗⚖️ Jakość diety i tempo zmiany wagi</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Śr. ocena jakości {dietQualityWeightPaceInsight.ratedMeals} posiłków i tempo zmiany wagi z ostatnich {dietQualityWeightPaceInsight.weightSpanDays} dni ({dietQualityWeightPaceInsight.weightMeasurements} pomiarów) - dwa niezależne fakty z tego okresu.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginBottom: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>Śr. ocena posiłków</span>
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
              <span className="premium-title">🥗⚖️ Jakość diety i tempo zmiany wagi</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              {dietQualityWeightPaceInsight.reason === 'not_enough_data'
                ? 'Za mało ocenionych posiłków lub pomiarów wagi.'
                : dietQualityWeightPaceInsight.reason === 'span_too_short'
                ? 'Pomiary wagi obejmują za krótki okres.'
                : 'Brak wyraźnego trendu wagi w tym okresie.'}
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
                ? 'Za mało pomiarów wagi w grupie z passą lub bez passy do porównania.'
                : 'Brak wyraźnego trendu wagi w jednej z grup.'}
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 13, nowa funkcja 8): SIEDZENIE VS WYDAJNOŚĆ TRENINGU */}
        {isLoadingSedentaryPerformance && !sedentaryPerformanceInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🪑🏋️ Siedzenie vs wydajność treningu</span>
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
              <span className="premium-title">🪑🏋️ Siedzenie vs wydajność treningu</span>
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
              <span className="premium-title">🪑🏋️ Siedzenie vs wydajność treningu</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni treningowych z danymi o siedzeniu do porównania.
            </p>
          </div>
        )}

        {/* INSIGHT: HYDRATACJA A JAKOŚĆ SNU */}
        {summary?.has_oura && isLoadingWaterSleep && !waterSleepInsight && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💧😴 Woda a jakość snu</span>
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
              <span className="premium-title">💧😴 Woda a jakość snu</span>
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
                  ? ' — lepsze nawodnienie wyraźnie poprawia sen.'
                  : waterSleepInsight.sleepScoreDiff < -2
                    ? ' — brak wyraźnego efektu nawodnienia na sen.'
                    : ' — efekt nawodnienia na sen jest nieznaczny.'}
              </div>
            )}
          </div>
        )}
        {summary?.has_oura && !isLoadingWaterSleep && waterSleepInsight && !waterSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💧😴 Woda a jakość snu</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o hydratacji i śnie (min. 14 dni).
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 25): SEN OURA → WYDAJNOŚĆ TRENINGU AW (dzień następny) */}
        {summary?.has_oura && sleepWorkoutPerfInsight && sleepWorkoutPerfInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😴🏃 Sen → wydajność treningu</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Wydajność (kcal/min) po nocach z dobrym snem (score ≥{sleepWorkoutPerfInsight.goodSleepThreshold}) vs słabym (≤{sleepWorkoutPerfInsight.poorSleepThreshold}).
              Ostatnie {sleepWorkoutPerfInsight.lookbackDays} dni ({sleepWorkoutPerfInsight.goodSleepDays} vs {sleepWorkoutPerfInsight.poorSleepDays} treningów).
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Po dobrym śnie</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--success-light)' }}>{sleepWorkoutPerfInsight.avgKcalPerMinAfterGoodSleep}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
              <div style={{ background: 'rgba(248,113,113,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Po słabym śnie</div>
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
                      ? ' — po lepszym śnie ćwiczysz wydajniej.'
                      : ' — jakość snu nie widoczna na wydajności w Twoich danych.')
                  : ' — brak wyraźnej różnicy w Twoich danych.'}
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
              <span className="premium-title">😴🏃 Sen → wydajność treningu</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało danych (potrzeba min. {sleepWorkoutPerfInsight.minRequired ?? 5} treningów po dobrym i złym śnie). Masz: {sleepWorkoutPerfInsight.goodSleepDays ?? 0} vs {sleepWorkoutPerfInsight.poorSleepDays ?? 0}.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 25): GOTOWOŚĆ OURA → WYDAJNOŚĆ APPLE WATCH */}
        {summary?.has_oura && readinessWorkoutInsight && readinessWorkoutInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🎯 Gotowość → wydajność treningu</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)', marginBottom: '10px' }}>
              Wydajność (kcal/min) przy wysokiej gotowości Oura (≥{readinessWorkoutInsight.highReadinessThreshold} pkt) vs niskiej (≤{readinessWorkoutInsight.lowReadinessThreshold} pkt).
              Ostatnie {readinessWorkoutInsight.lookbackDays} dni ({readinessWorkoutInsight.highReadinessDays} vs {readinessWorkoutInsight.lowReadinessDays} treningów).
            </p>
            <div className="premium-grid-2" style={{ gap: '8px' }}>
              <div style={{ background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Wysoka gotowość</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--success-light)' }}>{readinessWorkoutInsight.avgKcalPerMinHighReadiness}</div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>kcal/min</div>
              </div>
              <div style={{ background: 'rgba(248,113,113,0.08)', borderRadius: '8px', padding: '8px 10px' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>Niska gotowość</div>
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
                      ? ' — wyższy readiness przekłada się na lepszy trening.'
                      : ' — score gotowości nie widoczny na wydajności w Twoich danych.')
                  : ' — brak wyraźnej korelacji.'}
              </div>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Oura readiness + Apple Watch. Porównanie dwóch średnich, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 25): POLARYZACJA STREF TĘTNA 80/20 (Apple Watch only) */}
        {hrPolarizationInsight && hrPolarizationInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📊 Polaryzacja stref tętna</span>
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
                { label: 'Z4 Próg anaerobowy', pct: hrPolarizationInsight.zone4Pct, color: '#fb923c' },
                { label: 'Z5 Maks. wysiłek', pct: hrPolarizationInsight.zone5Pct, color: '#f87171' },
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
                    ? '⚠️ Za dużo "szarej strefy" (Z3)'
                    : '⚠️ Nieoptymalna polaryzacja'}
              </span>
              {hrPolarizationInsight.tooMuchGrayZone && (
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}> — spróbuj więcej wolnego cardio lub krótkich interwałów Z4-5 zamiast ciągłego Z3.</span>
              )}
            </div>
          </div>
        )}

        {/* INSIGHT (Runda 25): CIĘŻKI TRENING AW → HRV/RHR OURA +1/+2 DNI */}
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
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>HRV dzień +1 vs baseline</span>
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
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>HRV dzień +2</span>
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
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>RHR dzień +1 vs baseline</span>
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

        {/* INSIGHT (Runda 25): PRZERWA MIĘDZY TRENINGAMI → WYDAJNOŚĆ (Apple Watch only) */}
        {workoutRestPerfInsight && workoutRestPerfInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🗓️ Przerwa → wydajność treningu</span>
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
                      ? ' — dłuższy odpoczynek wyraźnie poprawia wydajność.'
                      : ' — krótsze przerwy dają lepszą wydajność w Twoich danych.')
                  : ' — przerwa nie ma wyraźnego wpływu na wydajność.'}
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
                  'Ustaw swój cel wagi w Ustawieniach, aby aktywować prognozę.'
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
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bilans z logów</span>
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
                    {isApplyingCalorieSuggestion ? 'Zapisywanie...' : `Zastosuj cel ${calorieSuggestion.suggestedTargetCalories} kcal`}
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
              placeholder="Własna (ml)"
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
            {/* Szybki wybór suplementów 7Nutrition */}
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
              placeholder="Wpisz przyjmowane suplementy (np. Kreatyna, Omega-3, Wit. D3, Białko)..."
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
                {supplementsMessage.text || 'Zapisz, aby AI wzięło je pod uwagę'}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={isSavingSupplements}
                onClick={handleSaveSupplements}
                style={{ padding: '8px 16px', fontSize: '0.8rem' }}
              >
                {isSavingSupplements ? 'Zapisywanie...' : 'Zapisz'}
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

                  {/* Szczegóły ostatnich dni */}
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
                          // Bezpieczna konwersja daty bez przesunięć strefy czasowej
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
        {/* ODŻYWIANIE (NUTRITION) */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Odżywianie</span>
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
              {/* Bilans netto kalorii (zjedzone - spalone) — dane z summary.net_calories
                  wyliczone w dashboard.js. Kolor: czerwony = nadwyżka >200 kcal (masa),
                  zielony = deficyt < -200 kcal (redukcja), żółty = równowaga (±200 kcal). */}
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
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Węglowodany</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenCarbs)}g / {targetCarbs}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#06b6d4', width: `${carbsPct}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Białko</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenProtein)}g / {targetProtein}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#7c3aed', width: `${proteinPct}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Tłuszcz</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenFat)}g / {targetFat}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#fbbf24', width: `${fatPct}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* WAGA I SKŁAD CIAŁA */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚖️ Waga i Skład Ciała</span>
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
            // POPRAWKA (runda 4 audytu): fatRatio===0 oznacza "brak pomiaru tkanki
            // tłuszczowej" (fallback ?? 0 wyżej), a NIE "realne 0% tłuszczu" - tak
            // samo jak interpretuje to fatPercentage powyżej. Wcześniej przy braku
            // danych leanBodyMassPct wynosił 100, więc nowy użytkownik bez
            // zsynchronizowanej wagi widział w pełni wypełniony, "idealny" pierścień
            // składu ciała mimo braku jakichkolwiek danych z Withings.
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
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Mięśnie</span>
                      <span style={{ fontWeight: '700' }}>{muscleMass > 0 ? `${muscleMass} kg` : '--'} ({musclePercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: 'var(--success-light)', width: `${musclePercentage}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Tłuszcz</span>
                      <span style={{ fontWeight: '700' }}>{fatMass > 0 ? `${fatMass} kg` : '--'} ({fatPercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#fbbf24', width: `${fatPercentage}%` }}></div>
                    </div>
                  </div>
                  {otherMass > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                        <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Inne (woda, kości)</span>
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
              <span>Wskaźnik BMI</span>
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
            {/* Ciśnienie tętnicze usunięte z tego miejsca (UX runda 7, punkt 2) - duplikowało
                osobną, pełną kartę "🩺 Ciśnienie tętnicze" pod strefami tętna, którą użytkownik
                wcześniej wyraźnie poprosił o umieszczenie w tamtym miejscu. Tu zostawiamy
                tylko BMI i pomiar obwodów, żeby nie pokazywać tej samej liczby dwa razy. */}
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
                  ].filter(Boolean).join(' · ') || 'Brak wypełnionych pól'}
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
                label="Sen głęboki" 
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
              {/* "Czas czuwania" ukryty, gdy sleepAwakeMins jest hardcoded na 0
                  (backend jeszcze nie liczy tej wartości z Oura) - pokazywanie
                  fałszywego "0 m" sugerowałoby realny pomiar, którego nie mamy. */}
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

        {/* ENERGIA I AKTYWNOŚĆ DNIA - połączone z dawnej karty "Dystans i aktywność dnia"
            (UX: runda 7 - dwie sąsiadujące, tematycznie pokrewne karty w jedną, żeby
            skrócić dashboard). Dane z Oury (equivalent_walking_distance, sedentary/
            low_activity_time), Google Fit (distance.delta) albo Apple Health
            (walking_running_distance). */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Energia i aktywność dnia</span>
            <span className="premium-title-info">ⓘ</span>
          </div>

          {/* Battery segments - realny algorytm (readinessScore - rozładowanie aktywnością) */}
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
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>Brak danych (czekam na synchronizację)</span>
            )}
          </div>
          {/* Realny poziom stresu (Oura /v2/usercollection/daily_stress) - wcześniej ta
              sekcja była tu usunięta, bo była w 100% zaszywana na sztywno bez żadnego
              realnego źródła danych. Wraca tylko wtedy, gdy backend faktycznie ma dla
              niej dane (pierścionek Oura z funkcją pomiaru stresu) - inaczej jest po
              prostu niewidoczna, bez fałszywych wartości. */}
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

          {/* DYSTANS I AKTYWNOŚĆ DNIA - połączone tu z dawnej osobnej karty (UX runda 7).
              Dane z Oury (equivalent_walking_distance, sedentary/low_activity_time),
              Google Fit (distance.delta) albo Apple Health (walking_running_distance). */}
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
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🚶 Niska intensywność</span>
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
            {/* hrv/rhr mogą być null (brak pomiaru z Oura za ten dzień) - karty pokazują
                '--' i neutralny stan zamiast fałszywego "0 ms"/"0 bpm" i błędnych
                porównań (null >= 48 czy null < 61 dałyby nielogiczne wyniki). */}
            <TrendCard
              title="Zmienność rytmu zatokowego"
              valueText={hrv != null ? String(hrv) : '--'}
              unitText="ms"
              activeSegment={hrv != null && hrv >= 48 ? "right" : "middle"}
              color="blue"
              footerText={hrv == null ? "Brak danych" : hrv >= 48 ? "Wysoki > 48" : "Niski < 48"}
              status="success"
            />
            <TrendCard
              title="Spoczynkowe tętno"
              valueText={rhr != null ? String(rhr) : '--'}
              unitText="bpm"
              activeSegment={rhr != null && rhr < 61 ? "left" : "middle"}
              color="blue"
              footerText={rhr == null ? "Brak danych" : rhr < 61 ? "Niski < 61" : "Wysoki > 61"}
              status="success"
            />
            {/* Karta "Słuch" pozostaje usunięta na życzenie użytkownika - Oura nie ma
                mikrofonu, a Apple Watch/AirPods nie są jeszcze obsługiwane. Poniższe
                4 karty pokazują się tylko, gdy backend faktycznie ma dla nich realną
                wartość (Gen 3+ Oura dla SpO2, Apple Watch Series 8+/Ultra z włączoną
                metryką "Wrist Temperature" w Health Auto Export dla temperatury
                nadgarstka, Oura /daily_readiness dla odchylenia temperatury ciała) -
                w przeciwnym razie karta jest po prostu niewidoczna, bez fałszywych zer. */}
            {summary.respiratory_rate != null && (
              <TrendCard
                title="Częstość oddechów"
                valueText={String(summary.respiratory_rate)}
                unitText="odd/min"
                activeSegment={summary.respiratory_rate < 12 ? "left" : summary.respiratory_rate > 20 ? "right" : "middle"}
                color="blue"
                footerText={summary.respiratory_rate >= 12 && summary.respiratory_rate <= 20 ? "Norma 12-20" : "Poza normą 12-20"}
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
                footerText={summary.spo2_percentage >= 95 ? "Prawidłowy ≥ 95%" : "Niski < 95%"}
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
              // Wspólny próg ±0.5°C (Oura) - patrz utils/health.js, żeby nie
              // duplikować tej samej granicy w kilku komponentach.
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

        {/* STREFY TĘTNA (HR ZONES) - tylko gdy mamy realny RHR, bez tego wszystkie
            zakresy byłyby liczone z fałszywym RHR=0 (patrz rhrForZones powyżej).
            Statyczna tabela referencyjna - zwinięta domyślnie (UX runda 7), bo nie
            zmienia się z dnia na dzień i nie trzeba jej widzieć od razu. */}
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
            <span className="premium-title">💓 Strefy Tętna (Karvonen)</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              Na bazie RHR ({rhr} bpm) · {isHrZonesOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
            </span>
          </div>
          {isHrZonesOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #60a5fa' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 1 (Regeneracja)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#60a5fa' }}>{hrZone1Min}-{hrZone1Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Aktywna regeneracja, bardzo lekki wysiłek</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #34d399' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 2 (Spalanie Tłuszczu)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--success-light)' }}>{hrZone2Min}-{hrZone2Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Baza tlenowa, optymalne spalanie tłuszczu</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #fbbf24' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 3 (Cardio / Tempo)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fbbf24' }}>{hrZone3Min}-{hrZone3Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Poprawa wydolności sercowo-naczyniowej</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #f87171' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 4 (Próg / Threshold)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger-light)' }}>{hrZone4Min}-{hrZone4Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Budowanie wytrzymałości beztlenowej</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #ef4444' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 5 (Maks. Wysiłek)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger)' }}>{hrZone5Min}-{userMaxHr} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Trening beztlenowy, interwały, maksymalna wydolność</span>
            </div>
          </div>
          )}
        </div>
        )}

        {/* CIŚNIENIE TĘTNICZE - przeniesione pod strefy tętna w prawej kolumnie na życzenie użytkownika */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">🩺 Ciśnienie tętnicze</span>
            <span className="premium-title-info">ⓘ</span>
          </div>

          {summary.blood_pressure_systolic !== null && summary.blood_pressure_systolic !== undefined ? (
            (() => {
              const sys = summary.blood_pressure_systolic;
              const dia = summary.blood_pressure_diastolic;
              let color = 'var(--success-light)';
              let label = 'Optymalne';
              if (sys >= 140 || dia >= 90) { color = 'var(--danger-light)'; label = 'Wysokie'; }
              else if (sys >= 130 || dia >= 80) { color = '#fbbf24'; label = 'Podwyższone'; }
              else if (sys >= 120) { color = '#fbbf24'; label = 'Prawidłowe wysokie'; }
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

            {/* Historia wiadomości */}
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

            {/* Chipy szybkich pytań (Runda 8) - pokazujemy tylko na starcie konwersacji
                (sama wiadomość powitalna AI), żeby nie zaśmiecać widoku po tym, jak
                użytkownik już zaczął rozmowę. Kliknięcie wysyła pytanie od razu,
                bez kopiowania go do pola input. */}
            {chatMessages.length === 1 && !isSendingChat && (
              <div style={{
                padding: '0 20px 14px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px'
              }}>
                {[
                  'Jak wygląda mój sen w tym tygodniu?',
                  'Czy jestem blisko celu kalorycznego?',
                  'Jak moja regeneracja po ostatnim treningu?',
                  'Coś niepokojącego w moich danych?'
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

            {/* Input wiadomości */}
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
                aria-label="Wyślij wiadomość"
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
