import React, { useState, useEffect, useRef } from 'react';
import { t } from '../utils/i18n';

export default function ActivityTracker({ summary = {}, userProfile, sessionToken, onGoalsUpdate, onLogout }) {
  const [historyData, setHistoryData] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Stany pomiarów obwodów ciała
  const [measurementsData, setMeasurementsData] = useState([]);

  // Cele aktywności
  const [goals, setGoals] = useState({
    target_steps: 10000,
    target_active_calories: 500,
    target_sleep_duration: 7.2,
    target_active_minutes: 30,
    // 0 = brak ustawionego celu wagowego (pole opcjonalne, w przeciwieństwie do
    // pozostałych celów aktywności, które zawsze mają sensowną wartość domyślną).
    target_weight_kg: 0
  });
  const [isSavingGoals, setIsSavingGoals] = useState(false);
  const [goalsMessage, setGoalsMessage] = useState({ type: '', text: '' });
  // POPRAWKA (runda 17 audytu): efekt synchronizujący `goals` ze `summary` nadpisywał
  // formularz przy KAŻDEJ zmianie `summary` - również przy tle auto-refreshu - co mogło
  // nadpisać to, co użytkownik właśnie wpisuje w pola celów. Flaga "dirty" pozwala
  // efektowi synchronizować formularz tylko, gdy użytkownik nie ma niezapisanych zmian.
  const [goalsDirty, setGoalsDirty] = useState(false);
  const [isGoalsOpen, setIsGoalsOpen] = useState(false);

  useEffect(() => {
    if (summary && !goalsDirty) {
      // POPRAWKA (runda 4 audytu): `||` nadpisywał świadomo zapisane 0 (cel wyłączony)
      // domyślną wartością przy każdym odświeżeniu `summary` (np. po zapisaniu celów -
      // onGoalsUpdate odpytuje dashboard na nowo), więc pole formularza "skakało" z
      // powrotem na domyślną wartość mimo poprawnie zapisanego 0 w backendzie (patrz
      // poprawiony /api/dashboard w dashboard.js). `??` odróżnia realne 0 od
      // null/undefined (brak danych z backendu).
      setGoals({
        target_steps: summary.target_steps ?? 10000,
        target_active_calories: summary.target_active_calories ?? 500,
        target_sleep_duration: summary.target_sleep_duration ?? 7.2,
        target_active_minutes: summary.target_active_minutes ?? 30,
        target_weight_kg: summary.target_weight_kg ?? 0
      });
    }
  }, [summary, goalsDirty]);

  const handleSaveGoals = async (e) => {
    e.preventDefault();
    setIsSavingGoals(true);
    setGoalsMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(goals)
      });
      if (res.ok) {
        setGoalsMessage({ type: 'success', text: t('Cele zostały zaktualizowane!') });
        setGoalsDirty(false);
        if (onGoalsUpdate) {
          onGoalsUpdate();
        }
        setTimeout(() => setGoalsMessage({ type: '', text: '' }), 5000);
      } else {
        // F-S6: Obsługa 401 — wygasła sesja
        if (res.status === 401) { if (onLogout) onLogout(); return; }
        setGoalsMessage({ type: 'error', text: t('Błąd zapisu celów.') });
      }
    } catch (err) {
      setGoalsMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    } finally {
      setIsSavingGoals(false);
    }
  };
  const [isLoadingMeasurements, setIsLoadingMeasurements] = useState(false);
  const [selectedMeasure, setSelectedMeasure] = useState('waist');
  const [isSavingMeasurement, setIsSavingMeasurement] = useState(false);
  const [measurementMessage, setMeasurementMessage] = useState({ type: '', text: '' });
  const [formMeasurement, setFormMeasurement] = useState({
    date: new Date().toISOString().split('T')[0],
    chest: '',
    waist: '',
    hips: '',
    biceps: '',
    thigh: '',
    biceps_left: '',
    biceps_right: '',
    shoulders: '',
    waist_above: '',
    waist_below: ''
  });

  useEffect(() => {
    // POPRAWKA (runda 17 audytu): brak flagi `cancelled` - spóźniona odpowiedź z
    // nieaktualnego już żądania (np. po szybkiej zmianie sessionToken/last_sync)
    // mogła nadpisać nowsze dane historii zdrowotnej. Wzorzec jak w Dashboard.jsx.
    let cancelled = false;
    const fetchHistory = async () => {
      if (!sessionToken) return;
      setIsLoadingHistory(true);
      try {
        const res = await fetch('/api/health/history', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setHistoryData(data);
        }
      } catch (err) {
        console.error('Błąd pobierania historii zdrowotnej:', err);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [sessionToken, summary.last_sync]);

  // POPRAWKA (runda 17 audytu): `fetchMeasurements` jest wywoływana zarówno z efektu
  // startowego, jak i po zapisie/usunięciu pomiaru - ref przechowuje "numer" aktualnego
  // żądania z efektu, żeby spóźniona odpowiedź z poprzedniego efektu (np. po szybkiej
  // zmianie sessionToken) nie nadpisała nowszego stanu. Wywołania spoza efektu (zapis/
  // usunięcie) nie ustawiają tej flagi, więc działają jak dotychczas.
  const measurementsRequestRef = useRef(0);

  useEffect(() => {
    measurementsRequestRef.current += 1;
    const requestId = measurementsRequestRef.current;
    fetchMeasurements(requestId);
  }, [sessionToken]);

  const fetchMeasurements = async (requestId) => {
    if (!sessionToken) return;
    setIsLoadingMeasurements(true);
    try {
      const res = await fetch('/api/body-measurements', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (requestId === undefined || requestId === measurementsRequestRef.current) {
          setMeasurementsData(data);
        }
      }
    } catch (err) {
      console.error('Błąd pobierania obwodów ciała:', err);
    } finally {
      if (requestId === undefined || requestId === measurementsRequestRef.current) {
        setIsLoadingMeasurements(false);
      }
    }
  };

  const handleFormMeasurementChange = (e) => {
    const { name, value } = e.target;
    setFormMeasurement(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSaveMeasurement = async (e) => {
    e.preventDefault();
    setIsSavingMeasurement(true);
    setMeasurementMessage({ type: '', text: '' });
    try {
      // F-S5: Filtrowanie pustych stringów — nie wysyłamy '' do backendu (trafiłoby jako NULL lub błąd walidacji)
      const measurementPayload = Object.fromEntries(
        Object.entries(formMeasurement).map(([k, v]) => [k, v === '' ? null : v])
      );
      const res = await fetch('/api/body-measurements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(measurementPayload)
      });
      if (res.ok) {
        setMeasurementMessage({ type: 'success', text: t('Zapisano pomiary pomyślnie!') });
        setFormMeasurement({
          date: new Date().toISOString().split('T')[0],
          chest: '',
          waist: '',
          hips: '',
          biceps: '',
          thigh: '',
          biceps_left: '',
          biceps_right: '',
          shoulders: '',
          waist_above: '',
          waist_below: ''
        });
        fetchMeasurements();
        setTimeout(() => setMeasurementMessage({ type: '', text: '' }), 5000);
      } else {
        const errData = await res.json();
        setMeasurementMessage({ type: 'error', text: errData.error || t('Błąd zapisu pomiarów.') });
      }
    } catch (err) {
      setMeasurementMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    } finally {
      setIsSavingMeasurement(false);
    }
  };

  const handleDeleteMeasurement = async (id) => {
    if (!window.confirm(t('Czy na pewno chcesz usunąć ten pomiar?'))) return;
    try {
      const res = await fetch(`/api/body-measurements/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        setMeasurementMessage({ type: '', text: '' });
        fetchMeasurements();
      } else {
        setMeasurementMessage({ type: 'error', text: t('Nie udało się usunąć pomiaru.') });
      }
    } catch (err) {
      console.error('Błąd usuwania pomiaru:', err);
      setMeasurementMessage({ type: 'error', text: t('Błąd połączenia z serwerem.') });
    }
  };

  const getMeasureLabel = (key) => {
    switch(key) {
      case 'waist': return 'Talia / Pas (cm)';
      case 'waist_above': return t('Pas +2cm (cm)');
      case 'waist_below': return t('Pas -2cm (cm)');
      case 'chest': return t('Klatka piersiowa (cm)');
      case 'shoulders': return t('Barki (cm)');
      case 'hips': return t('Biodra (cm)');
      case 'biceps': return t('Biceps (cm)');
      case 'biceps_left': return t('Biceps lewy (cm)');
      case 'biceps_right': return t('Biceps prawy (cm)');
      case 'thigh': return t('Udo (cm)');
      default: return t('Obwód (cm)');
    }
  };

  const formatSyncTime = (isoString) => {
    if (!isoString) return 'Nigdy';
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + date.toLocaleDateString() + ')';
    } catch (e) {
      return isoString;
    }
  };

  const getMinMax = (data, key) => {
    const values = data.map(d => d[key]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) return { min: 0, max: 100 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const padding = range === 0 ? 5 : range * 0.15;
    return { min: Math.max(0, min - padding), max: max + padding };
  };

  const renderLineChart = (data, key, color, labelY) => {
    const validData = data.filter(d => d[key] !== null && d[key] !== undefined);
    if (validData.length === 0) {
      return (
        <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Brak danych historycznych dla: {labelY}
        </div>
      );
    }

    const width = 500;
    const height = 180;
    const padding = 35;

    const { min, max } = getMinMax(validData, key);

    const points = validData.map((d, index) => {
      const x = padding + (index / (validData.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key] - min) / (max - min || 1)) * (height - 2 * padding);
      return { x, y, val: d[key], date: d.date };
    });

    const dPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ position: 'relative' }}>
        <svg width="100%" height="180" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={(height) / 2} x2={width - padding} y2={(height) / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

          {/* Labels Y */}
          <text x={padding - 8} y={padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{max.toFixed(1)}</text>
          <text x={padding - 8} y={height - padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{min.toFixed(1)}</text>

          {/* Line Path */}
          <path d={dPath} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

          {/* Vertex dots */}
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill={color} stroke="#0f111a" strokeWidth="2" />
              {validData.length <= 15 && (
                <text x={p.x} y={p.y - 8} fill="#fff" fontSize="8" textAnchor="middle" fontWeight="600">{p.val.toFixed(1)}</text>
              )}
            </g>
          ))}

          {/* Dates labels on X axis */}
          {points.filter((_, i) => i === 0 || i === points.length - 1 || (points.length > 5 && i === Math.floor(points.length / 2))).map((p, i) => (
            <text key={i} x={p.x} y={height - 10} fill="var(--text-dim)" fontSize="9" textAnchor="middle">
              {p.date.slice(5)}
            </text>
          ))}
        </svg>
      </div>
    );
  };

  const renderDualAxisChart = (data, key1, key2, color1, color2, label1, label2, unit1 = 'kg', unit2 = '%') => {
    const validData = data.filter(d => (d[key1] !== null && d[key1] !== undefined) || (d[key2] !== null && d[key2] !== undefined));
    if (validData.length === 0) {
      return (
        <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Brak danych historycznych do wyrenderowania wykresu.
        </div>
      );
    }

    const width = 500;
    const height = 180;
    const padding = 35;

    const data1 = validData.filter(d => d[key1] !== null && d[key1] !== undefined);
    const data2 = validData.filter(d => d[key2] !== null && d[key2] !== undefined);

    const { min: min1, max: max1 } = getMinMax(data1, key1);
    const { min: min2, max: max2 } = getMinMax(data2, key2);

    const points1 = data1.map((d) => {
      const overallIndex = validData.findIndex(item => item.date === d.date);
      const x = padding + (overallIndex / (validData.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key1] - min1) / (max1 - min1 || 1)) * (height - 2 * padding);
      return { x, y, val: d[key1], date: d.date };
    });

    const points2 = data2.map((d) => {
      const overallIndex = validData.findIndex(item => item.date === d.date);
      const x = padding + (overallIndex / (validData.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key2] - min2) / (max2 - min2 || 1)) * (height - 2 * padding);
      return { x, y, val: d[key2], date: d.date };
    });

    const dPath1 = points1.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dPath2 = points2.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', fontSize: '0.8rem', marginBottom: '8px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '12px', height: '3px', background: color1, borderRadius: '2px', display: 'inline-block' }}></span>
            <span style={{ color: 'var(--text-muted)' }}>{label1} ({unit1})</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '12px', height: '3px', background: color2, borderRadius: '2px', display: 'inline-block' }}></span>
            <span style={{ color: 'var(--text-muted)' }}>{label2} ({unit2})</span>
          </span>
        </div>
        <svg width="100%" height="180" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={(height) / 2} x2={width - padding} y2={(height) / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

          {/* Left Y labels */}
          {data1.length > 0 && (
            <>
              <text x={padding - 8} y={padding + 4} fill={color1} fontSize="9" textAnchor="end" fontWeight="bold">{max1.toFixed(1)}</text>
              <text x={padding - 8} y={height - padding + 4} fill={color1} fontSize="9" textAnchor="end" fontWeight="bold">{min1.toFixed(1)}</text>
            </>
          )}

          {/* Right Y labels */}
          {data2.length > 0 && (
            <>
              <text x={width - padding + 8} y={padding + 4} fill={color2} fontSize="9" textAnchor="start" fontWeight="bold">{max2.toFixed(1)}{unit2 === '%' ? '%' : ''}</text>
              <text x={width - padding + 8} y={height - padding + 4} fill={color2} fontSize="9" textAnchor="start" fontWeight="bold">{min2.toFixed(1)}{unit2 === '%' ? '%' : ''}</text>
            </>
          )}

          {/* Line 1 */}
          {points1.length > 0 && (
            <path d={dPath1} fill="none" stroke={color1} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {/* Line 2 */}
          {points2.length > 0 && (
            <path d={dPath2} fill="none" stroke={color2} strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" strokeLinejoin="round" />
          )}

          {/* Points 1 */}
          {points1.map((p, i) => (
            <circle key={`p1-${i}`} cx={p.x} cy={p.y} r="4" fill={color1} stroke="#0f111a" strokeWidth="2" />
          ))}

          {/* Points 2 */}
          {points2.map((p, i) => (
            <circle key={`p2-${i}`} cx={p.x} cy={p.y} r="3.5" fill={color2} stroke="#0f111a" strokeWidth="1.5" />
          ))}

          {/* X axis dates */}
          {validData.filter((_, i) => i === 0 || i === validData.length - 1 || (validData.length > 5 && i === Math.floor(validData.length / 2))).map((p, i) => {
            const x = padding + (validData.indexOf(p) / (validData.length - 1 || 1)) * (width - 2 * padding);
            return (
              <text key={`x-${i}`} x={x} y={height - 10} fill="var(--text-dim)" fontSize="9" textAnchor="middle">
                {p.date.slice(5)}
              </text>
            );
          })}
        </svg>
      </div>
    );
  };

  // Wykres wielu serii na jednej, wspólnej osi Y (np. fazy snu w godzinach) -
  // analogiczny do renderLineChart/renderDualAxisChart powyżej, ale dla N serii
  // współdzielących skalę, więc nie ma sensu osobna skala per seria.
  const renderMultiLineChart = (data, series) => {
    const validData = data.filter(d => series.some(s => d[s.key] !== null && d[s.key] !== undefined));
    if (validData.length === 0) {
      return (
        <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Brak danych historycznych do wyrenderowania wykresu.
        </div>
      );
    }

    const width = 500;
    const height = 180;
    const padding = 35;

    const allValues = [];
    series.forEach(s => {
      validData.forEach(d => {
        if (d[s.key] !== null && d[s.key] !== undefined) allValues.push(d[s.key]);
      });
    });
    const sharedMin = allValues.length ? Math.max(0, Math.min(...allValues) - 0.3) : 0;
    const sharedMax = allValues.length ? Math.max(...allValues) + 0.3 : 1;

    const seriesPoints = series.map(s => {
      const seriesData = validData.filter(d => d[s.key] !== null && d[s.key] !== undefined);
      const points = seriesData.map((d) => {
        const overallIndex = validData.findIndex(item => item.date === d.date);
        const x = padding + (validData.length > 1 ? (overallIndex / (validData.length - 1)) * (width - 2 * padding) : (width - 2 * padding) / 2);
        const y = height - padding - ((d[s.key] - sharedMin) / (sharedMax - sharedMin || 1)) * (height - 2 * padding);
        return { x, y, val: d[s.key] };
      });
      const dPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      return { ...s, points, dPath };
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', fontSize: '0.78rem', marginBottom: '8px', flexWrap: 'wrap' }}>
          {series.map(s => (
            <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '3px', background: s.color, borderRadius: '2px', display: 'inline-block' }}></span>
              <span style={{ color: 'var(--text-muted)' }}>{s.label}</span>
            </span>
          ))}
        </div>
        <svg width="100%" height="180" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={(height) / 2} x2={width - padding} y2={(height) / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

          <text x={padding - 8} y={padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{sharedMax.toFixed(1)}h</text>
          <text x={padding - 8} y={height - padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{sharedMin.toFixed(1)}h</text>

          {seriesPoints.map(s => (
            <path key={`path-${s.key}`} d={s.dPath} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {seriesPoints.map(s => s.points.map((p, i) => (
            <circle key={`${s.key}-${i}`} cx={p.x} cy={p.y} r="3" fill={s.color} stroke="#0f111a" strokeWidth="1.5" />
          )))}

          {validData.filter((_, i) => i === 0 || i === validData.length - 1 || (validData.length > 5 && i === Math.floor(validData.length / 2))).map((p, i) => {
            const x = padding + (validData.indexOf(p) / (validData.length - 1 || 1)) * (width - 2 * padding);
            return (
              <text key={`x-${i}`} x={x} y={height - 10} fill="var(--text-dim)" fontSize="9" textAnchor="middle">
                {p.date.slice(5)}
              </text>
            );
          })}
        </svg>
      </div>
    );
  };

  // Prognoza trendu wagi na podstawie regresji liniowej z danych historycznych.
  // targetWeight (opcjonalny, kg) - jeśli podany (>0), funkcja dodatkowo liczy,
  // za ile dni/kiedy linia trendu przetnie wagę docelową ("prognoza do celu"),
  // a nie tylko wagę za sztywne `daysAhead` dni.
  const computeWeightForecast = (data, daysAhead, targetWeight) => {
    const validData = data
      .filter(d => d.weight !== null && d.weight !== undefined && d.date)
      .map(d => ({ date: d.date, weight: d.weight }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (validData.length < 5) return null;

    // Dzień 0 = data pierwszego pomiaru, oś X w dniach
    const baseTime = new Date(validData[0].date).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const points = validData.map(d => ({
      x: (new Date(d.date).getTime() - baseTime) / msPerDay,
      y: d.weight
    }));

    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    const lastX = points[points.length - 1].x;
    const forecastX = lastX + daysAhead;
    const forecastWeight = slope * forecastX + intercept;
    const currentWeight = validData[validData.length - 1].weight;
    const deltaPerWeek = slope * 7;

    // "Prognoza do celu" - data, kiedy linia trendu przetnie wagę docelową.
    // Liczymy tylko jeśli cel jest realnie ustawiony (>0) i trend nie jest
    // płaski (slope !== 0, inaczej linia nigdy nie dotknie celu).
    let goalWeight = null;
    let goalEtaDays = null;
    let goalDate = null;
    let goalMovingAway = false;
    let goalTooFar = false;

    if (targetWeight && targetWeight > 0 && slope !== 0) {
      goalWeight = targetWeight;
      const goalX = (targetWeight - intercept) / slope;
      const daysFromNow = goalX - lastX;

      if (daysFromNow <= 0) {
        // Cel byłby "w przeszłości" względem ostatniego pomiaru - trend
        // oddala się od celu (np. cel to spadek wagi, a waga rośnie).
        goalMovingAway = true;
      } else if (daysFromNow > 3650) {
        // Trend zbyt płaski/odległy, żeby sensownie podać konkretną datę
        // (>10 lat ekstrapolacji z kilkutygodniowych danych byłoby mylące).
        goalTooFar = true;
      } else {
        goalEtaDays = Math.round(daysFromNow);
        const goalTime = baseTime + (lastX + daysFromNow) * msPerDay;
        goalDate = new Date(goalTime).toISOString().split('T')[0];
      }
    }

    return {
      forecastWeight: Math.round(forecastWeight * 10) / 10,
      currentWeight,
      deltaPerWeek: Math.round(deltaPerWeek * 100) / 100,
      daysAhead,
      goalWeight,
      goalEtaDays,
      goalDate,
      goalMovingAway,
      goalTooFar
    };
  };

  const weightForecast = computeWeightForecast(historyData, 30, goals.target_weight_kg);

  // Fazy snu w czasie - "lekki sen" nie jest zapisywany jako osobna kolumna,
  // wyliczamy go z realnych danych (całkowity czas snu minus głęboki i REM)
  // zamiast fabrykować wartość - jeśli któregoś ze składników brakuje, light
  // pozostaje null i po prostu nie rysujemy go dla tego dnia.
  const sleepPhaseData = historyData.map(d => {
    const hasAllPhases = d.sleep_duration != null && d.sleep_deep != null && d.sleep_rem != null;
    const light = hasAllPhases ? Math.max(0, d.sleep_duration - d.sleep_deep - d.sleep_rem) : null;
    return { ...d, sleep_light: light };
  });
  const hasSleepPhaseData = sleepPhaseData.some(d => d.sleep_deep != null || d.sleep_rem != null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 1. Kafelki wskaźników z sensorów (Gotowość, Sen, Skład Ciała) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', alignItems: 'start' }}>
        
        {/* Kolumna 1: Oura & Dzisiejsza Aktywność */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Oura Ring: Sen i Gotowość */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>💍</span> Oura Ring Status
              </h3>
              <span style={{ fontSize: '0.8rem', padding: '2px 8px', borderRadius: '12px', background: userProfile?.has_oura ? 'rgba(52, 211, 153, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: userProfile?.has_oura ? 'var(--success-light)' : 'var(--danger-light)' }}>
                {userProfile?.has_oura ? t('Połączono') : t('Rozłączono')}
              </span>
            </div>

            {!userProfile?.has_oura ? (
              <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
                Brak połączenia z kontem Oura Ring. Skonfiguruj integrację w zakładce Ustawienia.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block' }}>{t("Gotowość (Readiness)")}</span>
                    <strong style={{ fontSize: '1.4rem', color: '#c084fc' }}>
                      {summary.readiness_score != null ? `${summary.readiness_score}/100` : '--'}
                    </strong>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block' }}>Wynik Snu (Sleep)</span>
                    <strong style={{ fontSize: '1.4rem', color: '#38bdf8' }}>
                      {summary.sleep_score != null ? `${summary.sleep_score}/100` : '--'}
                    </strong>
                  </div>
                </div>

                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Długość snu:")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.sleep_duration != null ? `${Number(summary.sleep_duration).toFixed(1)}h` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Faza głęboka / REM:")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.sleep_deep != null ? `${Number(summary.sleep_deep).toFixed(1)}h` : '--'} / {summary.sleep_rem != null ? `${Number(summary.sleep_rem).toFixed(1)}h` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("HRV (Zmienność tętna):")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.hrv != null ? `${Number(summary.hrv).toFixed(0)} ms` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Tętno spoczynkowe (RHR):")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.rhr != null ? `${Number(summary.rhr).toFixed(0)} bpm` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Odchylenie temperatury:</span>
                    {/* Runda 12 (audyt): poprzednio `temperature_deviation > 0` przy null
                        zwracało false, więc brak danych był kolorowany tak samo jak realne
                        "0 lub mniej" (zielony) - teraz brak danych dostaje neutralny, wyciszony
                        kolor, niezależny od interpretacji "dobre/złe". */}
                    <span style={{ color: summary.temperature_deviation == null ? 'var(--text-dim)' : (summary.temperature_deviation > 0 ? 'var(--danger-light)' : 'var(--success-light)'), fontWeight: 600 }}>
                      {summary.temperature_deviation != null ? `${summary.temperature_deviation > 0 ? '+' : ''}${Number(summary.temperature_deviation).toFixed(2)} °C` : '--'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Ogólna Aktywność: Kroki i Kalorie */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>👣</span> Dzisiejsza Aktywność
              </h3>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Importowane</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '1.2rem' }}>👣</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t("Kroki")}</div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Wykonane dzisiaj</span>
                  </div>
                </div>
                <strong style={{ fontSize: '1.1rem', color: '#fff' }}>
                  {summary.steps != null ? summary.steps.toLocaleString('pl-PL') : '0'}
                </strong>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '1.2rem' }}>🔥</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Aktywne Kalorie</div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Spalone w ruchu</span>
                  </div>
                </div>
                <strong style={{ fontSize: '1.1rem', color: 'var(--color-secondary)' }}>
                  {summary.calories_burned_active != null ? `${summary.calories_burned_active} kcal` : '0 kcal'}
                </strong>
              </div>

              <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px', fontSize: '0.8rem', color: 'var(--text-dim)', textAlign: 'right' }}>
                Ost. sync: {formatSyncTime(summary.last_sync)}
              </div>
            </div>
          </div>
        </div>

        {/* Kolumna 2: Withings & Cele Aktywności */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Withings: Skład Ciała i Waga */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>⚖️</span> Withings Status
              </h3>
              <span style={{ fontSize: '0.8rem', padding: '2px 8px', borderRadius: '12px', background: userProfile?.has_withings ? 'rgba(52, 211, 153, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: userProfile?.has_withings ? 'var(--success-light)' : 'var(--danger-light)' }}>
                {userProfile?.has_withings ? t('Połączono') : t('Rozłączono')}
              </span>
            </div>

            {!userProfile?.has_withings ? (
              <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
                Brak połączenia z kontem Withings. Skonfiguruj integrację w zakładce Ustawienia.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)', textAlign: 'center' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', display: 'block' }}>{t("Aktualna Waga Ciała")}</span>
                    <strong style={{ fontSize: '1.8rem', color: '#fbbf24' }}>
                      {summary.weight != null ? `${Number(summary.weight).toFixed(1)} kg` : '--'}
                    </strong>
                  </div>
                </div>

                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Procent tkanki tłuszczowej (Fat %):")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.fat_ratio != null ? `${Number(summary.fat_ratio).toFixed(1)}%` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Szacowana masa tłuszczu:")}</span>
                    <span style={{ color: '#fff', fontWeight: 600 }}>
                      {summary.weight != null && summary.fat_ratio != null ? `${((Number(summary.weight) * Number(summary.fat_ratio)) / 100).toFixed(1)} kg` : '--'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t("Masa mięśniowa (Muscle mass):")}</span>
                    <span style={{ color: 'var(--success-light)', fontWeight: 600 }}>
                      {summary.muscle_mass != null ? `${Number(summary.muscle_mass).toFixed(1)} kg` : '--'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Cele Aktywności */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div
              className="glass-card"
              role="button"
              tabIndex={0}
              aria-expanded={isGoalsOpen}
              onClick={() => setIsGoalsOpen(o => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsGoalsOpen(o => !o); } }}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🎯</span> Cele Aktywności
                </h3>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                  {isGoalsOpen ? t('Zwiń ▲') : t('Pokaż ▼')}
                </span>
              </div>
            </div>

            {isGoalsOpen && (
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Ustawienia celów
                  </h3>
                </div>

                <form onSubmit={handleSaveGoals} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Kroki (kroki)</label>
                    <input
                      type="number"
                      className="input-field"
                      style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                      value={goals.target_steps}
                      onChange={(e) => { setGoalsDirty(true); setGoals({...goals, target_steps: Number(e.target.value)}); }}
                      min="0"
                      required
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Aktywne kalorie (kcal)</label>
                    <input
                      type="number"
                      className="input-field"
                      style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                      value={goals.target_active_calories}
                      onChange={(e) => { setGoalsDirty(true); setGoals({...goals, target_active_calories: Number(e.target.value)}); }}
                      min="0"
                      required
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{t("Czas snu (godziny)")}</label>
                    <input
                      type="number"
                      step="0.1"
                      className="input-field"
                      style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                      value={goals.target_sleep_duration}
                      onChange={(e) => { setGoalsDirty(true); setGoals({...goals, target_sleep_duration: Number(e.target.value)}); }}
                      min="0"
                      required
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{t("Minuty ćwiczeń (min)")}</label>
                    <input
                      type="number"
                      className="input-field"
                      style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                      value={goals.target_active_minutes}
                      onChange={(e) => { setGoalsDirty(true); setGoals({...goals, target_active_minutes: Number(e.target.value)}); }}
                      min="0"
                      required
                    />
                  </div>
                  <button type="submit" className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.85rem', marginTop: '6px', height: '34px' }} disabled={isSavingGoals}>
                    {isSavingGoals ? t('Zapisywanie...') : t('Zapisz cele')}
                  </button>
                  {goalsMessage.text && (
                    <div style={{ fontSize: '0.8rem', color: goalsMessage.type === 'success' ? 'var(--success-light)' : 'var(--danger-light)', textAlign: 'center', marginTop: '4px' }}>
                      {goalsMessage.text}
                    </div>
                  )}
                </form>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 2. Wykresy trendów z 30 dni (Spalanie Tłuszczu i Masa Mięśniowa) */}
      <div className="activity-charts-grid">
        
        {/* Wykres 1: Spalanie Tłuszczu (Waga i Fat %) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>{t("📉 Wykres 1: Spalanie Tłuszczu")}</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Zależność wagi ciała w kg (linia ciągła) do procentu tkanki tłuszczowej (linia przerywana).
          </p>
          {isLoadingHistory ? (
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          ) : (
            renderDualAxisChart(historyData, 'weight', 'fat_ratio', '#38bdf8', '#fbbf24', t('Waga ciała'), t('Tkanka tłuszczowa'))
          )}
          {!isLoadingHistory && weightForecast && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                📐 Prognoza (regresja liniowa) na {weightForecast.daysAhead} dni:
              </span>
              <span style={{ fontSize: '0.85rem', fontWeight: '700', color: weightForecast.deltaPerWeek < 0 ? 'var(--success-light)' : weightForecast.deltaPerWeek > 0 ? 'var(--danger-light)' : '#fff' }}>
                ~{weightForecast.forecastWeight} kg
                <span style={{ fontSize: '0.7rem', fontWeight: '500', color: 'var(--text-dim)', marginLeft: '6px' }}>
                  ({weightForecast.deltaPerWeek > 0 ? '+' : ''}{weightForecast.deltaPerWeek} kg/tydz.)
                </span>
              </span>
            </div>
          )}
          {/* Prognoza "do celu" - osobna linia, bo to inna informacja niż prognoza
              na sztywne 30 dni powyżej: tu liczymy datę przecięcia linii trendu
              z wagą docelową ustawioną w formularzu "Cele Aktywności". */}
          {!isLoadingHistory && weightForecast && weightForecast.goalWeight && (
            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '0.75rem', textAlign: 'center' }}>
              {weightForecast.goalDate && (
                <span style={{ color: 'var(--text-dim)' }}>
                  🎯 Przy obecnym tempie cel <strong style={{ color: '#fff' }}>{weightForecast.goalWeight} kg</strong> osiągniesz około{' '}
                  <strong style={{ color: 'var(--success-light)' }}>{weightForecast.goalDate}</strong>
                  {' '}(~{weightForecast.goalEtaDays} dni).
                </span>
              )}
              {weightForecast.goalMovingAway && (
                <span style={{ color: 'var(--danger-light)' }}>
                  ⚠️ Obecny trend wagi oddala się od celu {weightForecast.goalWeight} kg, nie zbliża.
                </span>
              )}
              {weightForecast.goalTooFar && (
                <span style={{ color: 'var(--text-dim)' }}>
                  Trend jest zbyt płaski, aby oszacować realistyczną datę osiągnięcia celu {weightForecast.goalWeight} kg.
                </span>
              )}
            </div>
          )}
          {!isLoadingHistory && !weightForecast && historyData.length > 0 && (
            <p style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', textAlign: 'center' }}>
              Za mało danych do prognozy trendu wagi (min. 5 pomiarów).
            </p>
          )}
        </div>

        {/* Wykres 2: Przyrost Mięśni (Masa mięśniowa w kg) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>{t("📈 Wykres 2: Rozwój Masy Mięśniowej")}</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Trend beztłuszczowej masy mięśniowej w kg z ostatnich 30 dni.
          </p>
          {isLoadingHistory ? (
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          ) : (
            renderLineChart(historyData, 'muscle_mass', 'var(--success-light)', t('Masa mięśniowa (kg)'))
          )}
        </div>

        {/* Wykres 3: Fazy Snu (Głęboki / REM / Lekki) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>😴 Wykres 3: Fazy Snu</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Trend długości faz snu w godzinach (Oura) z ostatnich 30 dni.
          </p>
          {isLoadingHistory ? (
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          ) : hasSleepPhaseData ? (
            renderMultiLineChart(sleepPhaseData, [
              { key: 'sleep_deep', color: '#7c3aed', label: t('Głęboki') },
              { key: 'sleep_rem', color: '#38bdf8', label: 'REM' },
              { key: 'sleep_light', color: '#fbbf24', label: 'Lekki' }
            ])
          ) : (
            <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              Brak danych o fazach snu - wymaga synchronizacji z Oura.
            </div>
          )}
        </div>

        {/* Wykres 4: Aktywność (Aktywne kalorie i aktywne minuty) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>{t("🔥 Wykres 4: Aktywność")}</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Zależność spalonych aktywnych kalorii (linia ciągła) do aktywnych minut (linia przerywana) z ostatnich 30 dni.
          </p>
          {isLoadingHistory ? (
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          ) : (
            renderDualAxisChart(historyData, 'active_calories', 'active_minutes', '#fb923c', '#a78bfa', 'Aktywne kalorie', t('Aktywne minuty'), 'kcal', 'min')
          )}
        </div>

      </div>

      {/* 3. Pomiary Obwodów Ciała */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px', marginTop: '10px' }}>
        
        {/* Formularz wprowadzania pomiarów i Wykres trendu obwodów */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="card-title">{t("📐 Pomiary Obwodów Ciała")}</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            Wprowadzaj regularnie pomiary obwodów swojego ciała, aby monitorować rozwój sylwetki.
          </p>

          <form onSubmit={handleSaveMeasurement} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(255,255,255,0.01)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Data</label>
                <input
                  type="date"
                  name="date"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.date}
                  onChange={handleFormMeasurementChange}
                  required
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Talia / Pas (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="waist"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.waist}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 85"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Pas +2cm (powyżej pępka)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="waist_above"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.waist_above}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 83"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Pas -2cm (poniżej pępka)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="waist_below"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.waist_below}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 87"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Klatka (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="chest"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.chest}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 100"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Barki (cm)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="shoulders"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.shoulders}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 120"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Biodra (cm)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="hips"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.hips}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 95"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Biceps (ogólny)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="biceps"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.biceps}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 37"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Biceps lewy (cm)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="biceps_left"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.biceps_left}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 36.5"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Biceps prawy (cm)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="biceps_right"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.biceps_right}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 36.5"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '12px', alignItems: 'flex-end' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>{t("Udo (cm)")}</label>
                <input
                  type="number"
                  step="0.1"
                  name="thigh"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.thigh}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 55"
                />
              </div>
              <button type="submit" className="btn-primary" style={{ padding: '8px 12px', fontSize: '0.85rem', height: '38px' }} disabled={isSavingMeasurement}>
                {isSavingMeasurement ? t('Zapisywanie...') : 'Zapisz pomiar'}
              </button>
            </div>
            {measurementMessage.text && (
              <div style={{ fontSize: '0.8rem', color: measurementMessage.type === 'success' ? 'var(--success-light)' : 'var(--danger-light)', marginTop: '4px' }}>
                {measurementMessage.text}
              </div>
            )}
          </form>

          {/* Wykres trendu obwodów */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <strong style={{ fontSize: '0.9rem', color: '#fff' }}>{t("📉 Wykres Trendów Obwodów")}</strong>
              <select
                className="input-field"
                aria-label={t("Wybierz obwód do wykresu trendu")}
                style={{ width: 'auto', padding: '4px 10px', fontSize: '0.8rem', height: '30px', background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', borderRadius: '6px', color: '#fff' }}
                value={selectedMeasure}
                onChange={(e) => setSelectedMeasure(e.target.value)}
              >
                <option value="waist">Talia / Pas</option>
                <option value="waist_above">Pas +2cm</option>
                <option value="waist_below">Pas -2cm</option>
                <option value="chest">Klatka piersiowa</option>
                <option value="shoulders">Barki</option>
                <option value="hips">Biodra</option>
                <option value="biceps">Biceps</option>
                <option value="biceps_left">Biceps lewy</option>
                <option value="biceps_right">Biceps prawy</option>
                <option value="thigh">Udo</option>
              </select>
            </div>
            {isLoadingMeasurements ? (
              <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
            ) : (
              renderLineChart(measurementsData, selectedMeasure, '#c084fc', getMeasureLabel(selectedMeasure))
            )}
          </div>
        </div>

        {/* Historia pomiarów obwodów */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="card-title">{t("📜 Historia Pomiarów Obwodów")}</h3>
          {isLoadingMeasurements ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0' }}>
              <div className="shimmer-placeholder" style={{ height: '14px', width: '100%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '90%' }} />
              <div className="shimmer-placeholder" style={{ height: '14px', width: '95%' }} />
            </div>
          ) : measurementsData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
              Brak wprowadzonych pomiarów ciała. Zaloguj swój pierwszy pomiar obok!
            </div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-dim)' }}>
                    <th style={{ padding: '8px 4px' }}>Data</th>
                    <th style={{ padding: '8px 4px' }}>Pas (+2 / -2)</th>
                    <th style={{ padding: '8px 4px' }}>Klatka</th>
                    <th style={{ padding: '8px 4px' }}>Barki</th>
                    <th style={{ padding: '8px 4px' }}>Biodra</th>
                    <th style={{ padding: '8px 4px' }}>Bic (L / P)</th>
                    <th style={{ padding: '8px 4px' }}>Udo</th>
                    <th style={{ padding: '8px 4px', textAlign: 'center' }}>Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {[...measurementsData].reverse().map((m) => (
                    <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}>
                      <td style={{ padding: '8px 4px', fontWeight: 600, color: '#fff' }}>{m.date}</td>
                      <td style={{ padding: '8px 4px' }}>
                        {m.waist !== null && m.waist !== undefined ? `${m.waist}` : '--'}
                        {(m.waist_above !== null || m.waist_below !== null) && ` (${m.waist_above !== null && m.waist_above !== undefined ? m.waist_above : '--'} / ${m.waist_below !== null && m.waist_below !== undefined ? m.waist_below : '--'})`} cm
                      </td>
                      <td style={{ padding: '8px 4px' }}>{m.chest != null ? `${m.chest} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.shoulders != null ? `${m.shoulders} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.hips != null ? `${m.hips} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>
                        {m.biceps !== null && m.biceps !== undefined ? `${m.biceps}` : '--'}
                        {(m.biceps_left !== null || m.biceps_right !== null) && ` (${m.biceps_left !== null && m.biceps_left !== undefined ? m.biceps_left : '--'} / ${m.biceps_right !== null && m.biceps_right !== undefined ? m.biceps_right : '--'})`} cm
                      </td>
                      <td style={{ padding: '8px 4px' }}>{m.thigh != null ? `${m.thigh} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--danger-light)',
                            cursor: 'pointer',
                            padding: '4px',
                            fontSize: '1rem'
                          }}
                          onClick={() => handleDeleteMeasurement(m.id)}
                          title={t("Usuń pomiar")}
                          aria-label={`Usuń pomiar z dnia ${m.date}`}
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
