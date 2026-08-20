import React, { useState, useEffect } from 'react';
import { formatHoursMins } from '../utils/format';
import { t } from '../utils/i18n';

export default function Trends({ selectedDate, sessionToken, onLogout }) {
  const [historyData, setHistoryData] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  // Wspólny stan dla podpowiedzi (tooltip) po najechaniu/kliknięciu na słupek lub punkt
  // wykresu. Identyfikowany przez klucz metryki (chartKey) + indeks dnia, żeby tylko
  // właściwy wykres i właściwy słupek/punkt pokazywał swoją podpowiedź.
  const [hoverInfo, setHoverInfo] = useState(null);
  // Podział wykresów na dwie grupy (UX: runda 7 - 8 wykresów w jednej płaskiej
  // siatce było za dużo na raz). "Aktywność i ciało" startuje zwinięta, sen i
  // regeneracja (główny temat aplikacji) widoczne od razu.
  const [isActivityGroupOpen, setIsActivityGroupOpen] = useState(false);

  useEffect(() => {
    // Runda 12 (audyt): efekt zależy od `selectedDate` (zmiana dnia w nawigacji wyżej
    // też przeładowuje historię), ale fetch zawsze pobiera te same "ostatnie 90 dni" -
    // bez flagi `cancelled` szybka zmiana daty (np. kilka kliknięć "poprzedni dzień")
    // mogła odłożyć starszą, wolniejszą odpowiedź NAD nowszą, jeśli ta pierwsza
    // dociągnęła się jako ostatnia - dane na wykresach na chwilę "skakały" do tyłu.
    let cancelled = false;
    const fetchHistory = async () => {
      if (!sessionToken) return;
      setIsLoading(true);
      try {
        const res = await fetch('/api/health/history', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setHistoryData(data);
        } else if (res.status === 401) {
          // Wygasła sesja - bez tego Trends po prostu po cichu przestawał się odświeżać
          // (interwał co godzinę nadal działał, ale fetch zawsze zwracał 401), podczas gdy
          // resztę aplikacji (App.jsx) konsekwentnie wylogowuje i pokazuje komunikat
          // "Sesja wygasła" w tej sytuacji.
          if (onLogout) onLogout();
        }
      } catch (err) {
        if (!cancelled) console.error('Błąd pobierania historii zdrowotnej:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchHistory();

    // Odśwież dane co godzinę, zgodnie z godzinową synchronizacją po stronie backendu,
    // żeby otwarte wykresy też pokazywały najnowsze dane z bazy bez przeładowania strony.
    const intervalId = setInterval(fetchHistory, 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [sessionToken, selectedDate]);

  // Bezpieczna konwersja daty bez przesunięć strefy czasowej - new Date(selectedDate)
  // parsuje "YYYY-MM-DD" jako UTC, więc w strefach na zachód od UTC d.setDate()
  // mogło dać dzień przesunięty o -1 po toISOString().slice(0,10). new Date(Y, M-1, D)
  // tworzy datę w lokalnej strefie, więc takiego przesunięcia nie ma (patrz Dashboard.jsx).
  const selectedDateParts = selectedDate.split('-');
  const selectedDateObj = new Date(
    Number(selectedDateParts[0]),
    Number(selectedDateParts[1]) - 1,
    Number(selectedDateParts[2])
  );

  // toISOString() konwertuje do UTC, co samo w sobie mogłoby ponownie przesunąć
  // dzień o -1 w strefach na zachód od UTC - kompensujemy offset przed konwersją,
  // analogicznie do getLocalDateString() w App.jsx.
  const toDateStr = (date) => {
    const tzOffset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - tzOffset).toISOString().slice(0, 10);
  };

  const [timeframe, setTimeframe] = useState('7d');

  const periodDaysCount = timeframe === '90d' ? 90 : (timeframe === '30d' ? 30 : 7);

  // Generowanie dni dla aktualnego okresu (ostatnie N dni kończące się na selectedDate)
  const currentWeekDays = [];
  for (let i = periodDaysCount - 1; i >= 0; i--) {
    const d = new Date(selectedDateObj);
    d.setDate(d.getDate() - i);
    currentWeekDays.push(toDateStr(d));
  }

  // Generowanie dni dla poprzedniego okresu (N dni przed aktualnym okresem)
  const prevWeekDays = [];
  for (let i = (periodDaysCount * 2) - 1; i >= periodDaysCount; i--) {
    const d = new Date(selectedDateObj);
    d.setDate(d.getDate() - i);
    prevWeekDays.push(toDateStr(d));
  }

  // Bezpieczne parsowanie "YYYY-MM-DD" w lokalnej strefie czasowej (patrz komentarz przy
  // selectedDateObj wyżej) - new Date(dateStr) parsuje string daty jako UTC północ, a getDay/
  // getDate/getMonth czytają w strefie LOKALNEJ, więc w strefach na zachód od UTC dawałoby to
  // dzień tygodnia/datę przesunięte o -1 (np. niedziela pokazana jako sobota na wykresach).
  const parseLocalDate = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const getDayLabel = (dateStr) => {
    const d = parseLocalDate(dateStr);
    if (timeframe !== '7d') {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}`;
    }
    const day = d.getDay(); // 0: niedziela, 1: poniedziałek...
    const labels = ['n', 'p', 'w', 'ś', 'c', 'p', 's'];
    return labels[day];
  };

  // Pełna etykieta dnia używana w podpowiedzi (tooltip), np. "śr 17.06"
  const getFullDayLabel = (dateStr) => {
    const d = parseLocalDate(dateStr);
    const names = ['niedz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'].map(t);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${names[d.getDay()]} ${dd}.${mm}`;
  };

  const getMetricColor = (key) => {
    switch (key) {
      case 'sleep_score': return '#a78bfa';
      case 'readiness_score': return '#10b981';
      case 'rhr': return '#ef4444';
      case 'hrv': return '#f43f5e';
      case 'weight': return '#3b82f6';
      case 'sleep_duration': return '#8b5cf6';
      case 'steps': return '#10b981';
      case 'total_calories_burned': return '#f59e0b';
      case 'sleep_stages': return '#c084fc';
      case 'blood_pressure': return '#38bdf8';
      default: return '#ffffff';
    }
  };

  // Wspólny komponent podpowiedzi (tooltip) renderowany jako nakładka HTML (div).
  // anchorX/anchorY to punkt w układzie współrzędnych SVG (viewBox), do którego
  // "przyklejony" jest dymek (np. góra słupka/punktu).
  const renderTooltip = (chartKey, idx, anchorX, anchorY, valueLabel, dateStr, svgWidth, customContent = null, svgHeight = 90) => {
    if (!hoverInfo || hoverInfo.chartKey !== chartKey || hoverInfo.idx !== idx) return null;
    const dateLabel = getFullDayLabel(dateStr);
    const tooltipLeft = `${(anchorX / svgWidth) * 100}%`;
    const tooltipTop = `${(anchorY / svgHeight) * 100}%`;
    const color = getMetricColor(chartKey);
    return (
      <div
        style={{
          position: 'absolute',
          left: tooltipLeft,
          top: tooltipTop,
          transform: 'translate(-50%, -100%) translateY(-10px)',
          pointerEvents: 'none',
          background: 'rgba(20, 21, 23, 0.98)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--border-glass)',
          borderLeft: `4px solid ${color}`,
          borderRadius: '12px',
          padding: '10px 16px',
          boxShadow: '0 12px 32px rgba(0,0,0,0.7)',
          zIndex: 100,
          minWidth: '120px',
          textAlign: 'left',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          transition: 'all 0.1s ease-out',
        }}
      >
        <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
          {dateLabel}
        </span>
        {customContent ? (
          customContent
        ) : (
          <span style={{ fontSize: '1.05rem', color: '#fff', fontWeight: '800', whiteSpace: 'nowrap' }}>
            {valueLabel}
          </span>
        )}
      </div>
    );
  };

  const getMetricData = (days, key) => {
    return days.map(day => {
      const row = historyData.find(r => r.date === day);
      return row ? row[key] : null;
    });
  };

  // Obliczenie statystyk dla danej metryki.
  // noFallbackToday: dla liczników dziennych (kroki, kalorie, sen), które mają zerować się
  // każdego dnia, NIE podstawiamy wartości z poprzednich dni, gdy dzisiejszy wpis jeszcze
  // nie istnieje w bazie (czyli zanim nadejdzie pierwsza dzisiejsza synchronizacja) - inaczej
  // wykres pokazywałby wczorajsze kroki/kalorie jako dzisiejsze.
  const calculateStats = (key, noFallbackToday = false) => {
    const currValues = getMetricData(currentWeekDays, key).filter(v => v !== null && v !== undefined);
    const prevValues = getMetricData(prevWeekDays, key).filter(v => v !== null && v !== undefined);

    const currValueRaw = historyData.find(r => r.date === selectedDate)?.[key];
    const currValue = currValueRaw !== undefined && currValueRaw !== null
      ? currValueRaw
      : (noFallbackToday ? 0 : (currValues.length > 0 ? currValues[currValues.length - 1] : null));

    const currAvg = currValues.length > 0 ? currValues.reduce((a, b) => a + b, 0) / currValues.length : 0;
    const prevAvg = prevValues.length > 0 ? prevValues.reduce((a, b) => a + b, 0) / prevValues.length : 0;

    // Gdy poprzedni tydzień nie ma żadnych danych (prevAvg === 0), dzielenie przez
    // prevAvg dawałoby NaN/Infinity, więc wcześniej kod po prostu zostawiał pctChange=0 -
    // co w renderComparisonPill wygląda identycznie jak "brak zmiany", mimo że w
    // rzeczywistości użytkownik mógł właśnie zacząć aktywność po tygodniu przerwy
    // (np. 0 -> 8000 kroków/dzień). Rozróżniamy te dwa przypadki przez isNewActivity.
    let pctChange = 0;
    let isNewActivity = false;
    let isNoData = false; // F-N3: brak danych w obu tygodniach → nie pokazuj "0%"
    if (prevAvg > 0) {
      pctChange = Math.round(((currAvg - prevAvg) / prevAvg) * 100);
    } else if (currAvg > 0) {
      isNewActivity = true;
    } else {
      isNoData = true;
    }

    return {
      current: currValue,
      avg: currAvg,
      pctChange,
      isNewActivity,
      isNoData
    };
  };

  // Logika formatowania "Xh Ym" przeniesiona do utils/format.js (formatHoursMins),
  // żeby nie duplikować jej w Dashboard.jsx/Trends.jsx/ActivityTracker.jsx.
  // formatDuration zachowuje swoje dotychczasowe zachowanie dla 0/null/undefined
  // ("0h 0m" - inaczej niż formatHoursMins, które zwraca '--'), żeby nie zmieniać
  // wyglądu istniejących wykresów w tym pliku.
  const formatDuration = (hoursDecimal) => {
    if (hoursDecimal === null || hoursDecimal === undefined || hoursDecimal === 0) return '0h 0m';
    return formatHoursMins(hoursDecimal);
  };

  // Renderowanie wykresu słupkowego (Kroki, Kalorie, Czas Snu)
  const renderBarChart = (title, key, unit, ticks, formatFn = (v) => v) => {
    const stats = calculateStats(key, true);
    const currentWeekVals = getMetricData(currentWeekDays, key);

    // Max do skalowania wysokości słupków. Filtr musi odrzucać też `undefined` (nie tylko
    // `null`) - dzień bez wpisu danej metryki w bazie zwracał undefined, co psowało
    // Math.max(...) do NaN i całe skalowanie wykresu (analogicznie do renderLineChart niżej).
    const maxVal = Math.max(...currentWeekVals.filter(v => v !== null && v !== undefined), ...ticks, 1);

    const svgWidth = 240;
    const svgHeight = 90;
    const barWidth = currentWeekDays.length === 7 ? 14 : (currentWeekDays.length === 30 ? 3.5 : 1);
    const gap = currentWeekDays.length === 7 ? 16 : (currentWeekDays.length === 30 ? 3.3 : 1.15);
    const leftMargin = 15;
    const topMargin = 10;

    return (
      <div className="premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)', fontWeight: '600' }}>{title}</span>
          {stats.current !== null && renderComparisonPill(stats.pctChange, stats.isNewActivity, stats.isNoData)}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '4px' }}>
          <div>
            <span style={{ fontSize: '1.8rem', fontWeight: '800', color: '#fff' }}>
              {stats.current !== null ? formatFn(stats.current) : '--'}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginLeft: '4px' }}>{unit}</span>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {stats.current !== null ? `Śr. ${formatFn(stats.avg)} ${unit}` : 'Brak danych'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px', position: 'relative', width: '100%' }}>
          {/* Wykres SVG */}
          <svg width="100%" height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ overflow: 'visible' }}>
            {/* Tło siatki - poziome linie pomocnicze */}
            {ticks.map((t, idx) => {
              const y = svgHeight - topMargin - ((t / maxVal) * (svgHeight - topMargin - 15));
              return (
                <g key={idx}>
                  <line x1="0" y1={y} x2={svgWidth - 30} y2={y} stroke="rgba(255,255,255,0.04)" strokeDasharray="3,3" />
                  <text x={svgWidth - 25} y={y + 3} fill="rgba(255,255,255,0.25)" fontSize="7px" textAnchor="start">
                    {t >= 1000 ? `${(t / 1000).toFixed(0)}K` : t}
                  </text>
                </g>
              );
            })}

            {/* Słupki */}
            {currentWeekDays.map((day, idx) => {
              const val = currentWeekVals[idx] || 0;
              const h = (val / maxVal) * (svgHeight - topMargin - 15);
              const x = leftMargin + idx * (barWidth + gap);
              const y = svgHeight - topMargin - h;
              const isActive = hoverInfo && hoverInfo.chartKey === key && hoverInfo.idx === idx;

              const toggleHover = () => {
                setHoverInfo(prev => (prev && prev.chartKey === key && prev.idx === idx)
                  ? null
                  : { chartKey: key, idx });
              };

              return (
                <g
                  key={idx}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverInfo({ chartKey: key, idx })}
                  onMouseLeave={() => setHoverInfo(prev => (prev && prev.chartKey === key && prev.idx === idx) ? null : prev)}
                  onClick={toggleHover}
                >
                  {/* Niewidoczne, szersze pole "trafienia" - ułatwia kliknięcie/hover na wąski słupek */}
                  <rect x={x - gap / 2} y={0} width={barWidth + gap} height={svgHeight} fill="transparent" />
                  {/* Słupek z zaokrąglonymi rogami na górze */}
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(h, 2)}
                    rx="2"
                    ry="2"
                    fill={val > 0 ? (isActive ? '#a3e6ff' : '#ffffff') : 'rgba(255,255,255,0.08)'}
                  />
                  {/* Etykieta dnia tygodnia */}
                  {(() => {
                    const shouldShowLabel = 
                      currentWeekDays.length <= 7 
                      || (currentWeekDays.length === 30 && idx % 5 === 0) 
                      || (currentWeekDays.length === 90 && idx % 15 === 0);
                    return shouldShowLabel ? (
                      <text
                        x={x + barWidth / 2}
                        y={svgHeight - 1}
                        fill={day === selectedDate ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                        fontSize="9px"
                        fontWeight={day === selectedDate ? 'bold' : 'normal'}
                        textAnchor="middle"
                      >
                        {getDayLabel(day)}
                      </text>
                    ) : null;
                  })()}
                </g>
              );
            })}

          </svg>

          {/* Podpowiedź (tooltip) dla aktywnego słupka */}
          {hoverInfo && hoverInfo.chartKey === key && (() => {
            const idx = hoverInfo.idx;
            const day = currentWeekDays[idx];
            const val = currentWeekVals[idx] || 0;
            const h = (val / maxVal) * (svgHeight - topMargin - 15);
            const x = leftMargin + idx * (barWidth + gap) + barWidth / 2;
            const y = svgHeight - topMargin - h;
            return renderTooltip(key, idx, x, y, `${formatFn(val)} ${unit}`, day, svgWidth, null, svgHeight);
          })()}
        </div>
      </div>
    );
  };

  // Renderowanie wykresu liniowego/obszarowego (Wynik Snu, Regeneracja, HRV, RHR, Waga)
  const renderLineChart = (title, key, unit, ticks, isWeight = false, formatFn = (v) => v) => {
    const stats = calculateStats(key);
    const currentWeekVals = getMetricData(currentWeekDays, key);

    // Filter nulls for drawing line, use fallback if all null
    const validVals = currentWeekVals.filter(v => v !== null && v !== undefined);
    const hasData = validVals.length > 0;

    // Zakresy y-skalowania - liczone z validVals (już odfiltrowanych z null/undefined,
    // patrz wyżej), a nie z || 9999 / || 0, które myliłyby brak danych z realnym zerem
    // (analogicznie do getMinMax w ActivityTracker.jsx).
    const minVal = Math.min(...(validVals.length ? validVals : [0]), ...ticks, 1);
    const maxVal = Math.max(...(validVals.length ? validVals : [0]), ...ticks, 1);
    const range = maxVal - minVal || 1;

    const svgWidth = 240;
    const svgHeight = 90;
    const leftMargin = 15;
    const rightMargin = 30;
    const topMargin = 10;
    const chartWidth = svgWidth - leftMargin - rightMargin;
    const chartHeight = svgHeight - topMargin - 15;

    // Budowanie punktów dla linii
    const points = currentWeekDays.map((day, idx) => {
      const val = currentWeekVals[idx];
      if (val === null || val === undefined) return null;
      const x = leftMargin + (idx / (currentWeekDays.length - 1 || 1)) * chartWidth;
      const y = svgHeight - topMargin - ((val - minVal) / range) * chartHeight;
      return { x, y, val, day };
    });

    const activePoints = points.filter(p => p !== null);

    // Budowanie ścieżki SVG dla linii
    let linePath = '';
    let areaPath = '';
    if (activePoints.length > 0) {
      linePath = `M ${activePoints[0].x} ${activePoints[0].y} ` + activePoints.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
      areaPath = `${linePath} L ${activePoints[activePoints.length - 1].x} ${svgHeight - topMargin} L ${activePoints[0].x} ${svgHeight - topMargin} Z`;
    }

    // Średnia wartość rzutowana na oś Y
    const avgY = svgHeight - topMargin - ((stats.avg - minVal) / range) * chartHeight;

    // Znajdowanie ostatniego punktu do postawienia kropki
    const lastPoint = activePoints[activePoints.length - 1];

    return (
      <div className="premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)', fontWeight: '600' }}>{title}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isWeight && stats.current !== null && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Śr. {formatFn(stats.avg)} {unit}</span>}
            {stats.current !== null && renderComparisonPill(stats.pctChange, stats.isNewActivity, stats.isNoData)}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '4px' }}>
          <div>
            <span style={{ fontSize: '1.8rem', fontWeight: '800', color: '#fff' }}>
              {stats.current !== null ? formatFn(stats.current) : '--'}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginLeft: '4px' }}>{unit}</span>
            {!isWeight && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                {stats.current !== null ? `Śr. ${formatFn(stats.avg)} ${unit}` : 'Brak danych'}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px', position: 'relative', width: '100%' }}>
          <svg width="100%" height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ overflow: 'visible' }}>
            <defs>
              <linearGradient id={`gradient-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.12" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0.00" />
              </linearGradient>
            </defs>

            {/* Poziome linie pomocnicze */}
            {ticks.map((t, idx) => {
              const y = svgHeight - topMargin - ((t - minVal) / range) * chartHeight;
              return (
                <g key={idx}>
                  <line x1="0" y1={y} x2={svgWidth - 30} y2={y} stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                  <text x={svgWidth - 25} y={y + 3} fill="rgba(255,255,255,0.25)" fontSize="7px" textAnchor="start">
                    {formatFn(t)}
                  </text>
                </g>
              );
            })}

            {/* Pozioma linia średniej tygodniowej (dashed) */}
            {hasData && (
              <line
                x1={leftMargin}
                y1={avgY}
                x2={svgWidth - rightMargin}
                y2={avgY}
                stroke="rgba(255,255,255,0.2)"
                strokeDasharray="3,3"
                strokeWidth="1"
              />
            )}

            {/* Obszar pod wykresem z gradientem */}
            {hasData && areaPath && (
              <path d={areaPath} fill={`url(#gradient-${key})`} />
            )}

            {/* Linia wykresu */}
            {hasData && linePath && (
              <path d={linePath} stroke="#ffffff" strokeWidth="2" fill="none" strokeLinecap="round" />
            )}

            {/* Kropka na ostatnim wpisie */}
            {hasData && lastPoint && (
              <circle
                cx={lastPoint.x}
                cy={lastPoint.y}
                r="3.5"
                fill="#ffffff"
                stroke="#121314"
                strokeWidth="1.5"
              />
            )}

            {/* Interaktywne punkty - hover/klik pokazuje podpowiedź z dokładną wartością i dniem */}
            {points.map((p, idx) => {
              if (!p) return null;
              const isActive = hoverInfo && hoverInfo.chartKey === key && hoverInfo.idx === idx;
              const toggleHover = () => {
                setHoverInfo(prev => (prev && prev.chartKey === key && prev.idx === idx)
                  ? null
                  : { chartKey: key, idx });
              };
              return (
                <g
                  key={idx}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverInfo({ chartKey: key, idx })}
                  onMouseLeave={() => setHoverInfo(prev => (prev && prev.chartKey === key && prev.idx === idx) ? null : prev)}
                  onClick={toggleHover}
                  onTouchStart={(e) => { e.stopPropagation(); toggleHover(); }}
                >
                  {/* Niewidoczne, większe pole "trafienia" wokół punktu */}
                  <circle cx={p.x} cy={p.y} r="9" fill="transparent" />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isActive ? '4.5' : '2.5'}
                    fill={isActive ? '#a3e6ff' : '#ffffff'}
                    stroke="#121314"
                    strokeWidth="1.5"
                  />
                </g>
              );
            })}

            {/* Dni tygodnia */}
            {currentWeekDays.map((day, idx) => {
              const shouldShowLabel = 
                currentWeekDays.length <= 7 
                || (currentWeekDays.length === 30 && idx % 5 === 0) 
                || (currentWeekDays.length === 90 && idx % 15 === 0);
              if (!shouldShowLabel) return null;
              const x = leftMargin + (idx / (currentWeekDays.length - 1 || 1)) * chartWidth;
              return (
                <text
                  key={idx}
                  x={x}
                  y={svgHeight - 1}
                  fill={day === selectedDate ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                  fontSize="9px"
                  fontWeight={day === selectedDate ? 'bold' : 'normal'}
                  textAnchor="middle"
                >
                  {getDayLabel(day)}
                </text>
              );
            })}

          </svg>

          {/* Podpowiedź (tooltip) dla aktywnego punktu */}
          {hoverInfo && hoverInfo.chartKey === key && points[hoverInfo.idx] && (() => {
            const p = points[hoverInfo.idx];
            return renderTooltip(key, hoverInfo.idx, p.x, p.y, `${formatFn(p.val)} ${unit}`, p.day, svgWidth, null, svgHeight);
          })()}
        </div>
      </div>
    );
  };

  // Wykres ciśnienia tętniczego (Withings) - dwie linie (skurczowe/rozkurczowe) na
  // wspólnej osi mmHg, na bazie renderLineChart, ale bez pojedynczego "key" bo
  // potrzebujemy dwóch serii naraz.
  const renderBloodPressureChart = () => {
    const chartKey = 'blood_pressure';
    const sysVals = getMetricData(currentWeekDays, 'blood_pressure_systolic');
    const diaVals = getMetricData(currentWeekDays, 'blood_pressure_diastolic');
    const validSys = sysVals.filter(v => v !== null && v !== undefined);
    const validDia = diaVals.filter(v => v !== null && v !== undefined);
    const hasData = validSys.length > 0 || validDia.length > 0;

    const ticks = [60, 90, 120, 150];
    const allVals = [...validSys, ...validDia];
    const minVal = Math.min(...(allVals.length ? allVals : [0]), ...ticks, 1);
    const maxVal = Math.max(...(allVals.length ? allVals : [0]), ...ticks, 1);
    const range = maxVal - minVal || 1;

    const svgWidth = 240;
    const svgHeight = 90;
    const leftMargin = 15;
    const rightMargin = 30;
    const topMargin = 10;
    const chartWidth = svgWidth - leftMargin - rightMargin;
    const chartHeight = svgHeight - topMargin - 15;

    const buildPoints = (vals) => currentWeekDays.map((day, idx) => {
      const val = vals[idx];
      if (val === null || val === undefined) return null;
      const x = leftMargin + (idx / (currentWeekDays.length - 1 || 1)) * chartWidth;
      const y = svgHeight - topMargin - ((val - minVal) / range) * chartHeight;
      return { x, y, val, day };
    }).filter(p => p !== null);

    const buildPath = (pts) => pts.length ? `M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') : '';

    const sysPoints = buildPoints(sysVals);
    const diaPoints = buildPoints(diaVals);
    const sysPath = buildPath(sysPoints);
    const diaPath = buildPath(diaPoints);

    const todayRow = historyData.find(r => r.date === selectedDate);
    const currentSys = (todayRow && todayRow.blood_pressure_systolic !== null && todayRow.blood_pressure_systolic !== undefined)
      ? todayRow.blood_pressure_systolic
      : (validSys.length ? validSys[validSys.length - 1] : null);
    const currentDia = (todayRow && todayRow.blood_pressure_diastolic !== null && todayRow.blood_pressure_diastolic !== undefined)
      ? todayRow.blood_pressure_diastolic
      : (validDia.length ? validDia[validDia.length - 1] : null);

    return (
      <div className="premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)', fontWeight: '600' }}>{t("Ciśnienie tętnicze")}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.7rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffffff', display: 'inline-block' }}></span>
              Skurczowe
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8', display: 'inline-block' }}></span>
              Rozkurczowe
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '4px' }}>
          <div>
            <span style={{ fontSize: '1.8rem', fontWeight: '800', color: '#fff' }}>
              {currentSys !== null && currentSys !== undefined ? Math.round(currentSys) : '--'}/{currentDia !== null && currentDia !== undefined ? Math.round(currentDia) : '--'}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginLeft: '4px' }}>mmHg</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' }}>
          <svg width="100%" height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ overflow: 'visible' }}>
            {ticks.map((t, idx) => {
              const y = svgHeight - topMargin - ((t - minVal) / range) * chartHeight;
              return (
                <g key={idx}>
                  <line x1="0" y1={y} x2={svgWidth - 30} y2={y} stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                  <text x={svgWidth - 25} y={y + 3} fill="rgba(255,255,255,0.25)" fontSize="7px" textAnchor="start">{t}</text>
                </g>
              );
            })}

            {hasData && sysPath && <path d={sysPath} stroke="#ffffff" strokeWidth="2" fill="none" strokeLinecap="round" />}
            {hasData && diaPath && <path d={diaPath} stroke="#38bdf8" strokeWidth="2" fill="none" strokeLinecap="round" />}

            {/* Interaktywne punkty - hover/klik pokazuje podpowiedź z dokładną wartością i dniem */}
            {sysPoints.map((p, idx) => {
              const isActive = hoverInfo && hoverInfo.chartKey === chartKey && hoverInfo.idx === idx;
              const diaP = diaPoints.find(dp => dp.day === p.day);
              const toggleHover = () => {
                setHoverInfo(prev => (prev && prev.chartKey === chartKey && prev.idx === idx)
                  ? null
                  : { chartKey, idx });
              };
              return (
                <g
                  key={idx}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverInfo({ chartKey, idx })}
                  onMouseLeave={() => setHoverInfo(prev => (prev && prev.chartKey === chartKey && prev.idx === idx) ? null : prev)}
                  onClick={toggleHover}
                  onTouchStart={(e) => { e.stopPropagation(); toggleHover(); }}
                >
                  {/* Niewidoczne, szersze pole interakcji */}
                  <line x1={p.x} y1={topMargin} x2={p.x} y2={svgHeight - 15} stroke="transparent" strokeWidth="12" />
                  
                  {/* Skurczowe kropka */}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isActive ? '4.5' : '2.5'}
                    fill={isActive ? '#a3e6ff' : '#ffffff'}
                    stroke="#121314"
                    strokeWidth="1.5"
                  />
                  
                  {/* Rozkurczowe kropka */}
                  {diaP && (
                    <circle
                      cx={diaP.x}
                      cy={diaP.y}
                      r={isActive ? '4.5' : '2.5'}
                      fill={isActive ? '#a3e6ff' : '#38bdf8'}
                      stroke="#121314"
                      strokeWidth="1.5"
                    />
                  )}
                </g>
              );
            })}

            {currentWeekDays.map((day, idx) => {
              const shouldShowLabel = 
                currentWeekDays.length <= 7 
                || (currentWeekDays.length === 30 && idx % 5 === 0) 
                || (currentWeekDays.length === 90 && idx % 15 === 0);
              if (!shouldShowLabel) return null;
              const x = leftMargin + (idx / (currentWeekDays.length - 1 || 1)) * chartWidth;
              return (
                <text
                  key={idx}
                  x={x}
                  y={svgHeight - 1}
                  fill={day === selectedDate ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                  fontSize="9px"
                  fontWeight={day === selectedDate ? 'bold' : 'normal'}
                  textAnchor="middle"
                >
                  {getDayLabel(day)}
                </text>
              );
            })}
          </svg>
        </div>
        {!hasData && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            Brak danych - zsynchronizuj ciśnieniomierz Withings
          </div>
        )}

        {/* Podpowiedź (tooltip) dla ciśnienia tętniczego */}
        {hoverInfo && hoverInfo.chartKey === chartKey && sysPoints[hoverInfo.idx] && (() => {
          const p = sysPoints[hoverInfo.idx];
          const diaP = diaPoints.find(dp => dp.day === p.day);
          return renderTooltip(
            chartKey,
            hoverInfo.idx,
            p.x,
            Math.min(p.y, diaP ? diaP.y : p.y),
            null,
            p.day,
            svgWidth,
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '0.8rem', color: '#fff', marginTop: '2px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ffffff' }} />
                Skurczowe: <strong>{Math.round(p.val)} mmHg</strong>
              </span>
              {diaP && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#38bdf8' }} />
                  Rozkurczowe: <strong>{Math.round(diaP.val)} mmHg</strong>
                </span>
              )}
            </div>,
            svgHeight
          );
        })()}
      </div>
    );
  };

  // Wykres (Runda 8) historii faz snu - słupek skumulowany (głęboki/REM/lekki) na dzień,
  // z ostatnich 7 dni. Dane sleep_deep/sleep_rem/sleep_duration są już dostępne w
  // historyData (patrz /api/health/history), tylko nigdzie wcześniej nie były pokazane
  // razem jako historia - tylko jako wartość "dziś" na Dashboardzie (SleepStageBar).
  // sleep_deep/sleep_rem są w bazie w GODZINACH (services/sync.js), więc liczymy
  // wszystko w godzinach i formatujemy przez formatDuration na końcu.
  const renderSleepStagesChart = () => {
    const chartKey = 'sleep_stages';
    const durVals = getMetricData(currentWeekDays, 'sleep_duration');
    const deepVals = getMetricData(currentWeekDays, 'sleep_deep');
    const remVals = getMetricData(currentWeekDays, 'sleep_rem');

    const dayBreakdowns = currentWeekDays.map((day, idx) => {
      const duration = durVals[idx];
      if (duration === null || duration === undefined || duration <= 0) return null;
      const deep = deepVals[idx] || 0;
      const rem = remVals[idx] || 0;
      const light = Math.max(duration - deep - rem, 0);
      return { day, duration, deep, rem, light };
    });

    const hasData = dayBreakdowns.some(d => d !== null);
    const maxVal = Math.max(...dayBreakdowns.filter(d => d !== null).map(d => d.duration), 8, 1);

    const svgWidth = 240;
    const svgHeight = 90;
    const barWidth = currentWeekDays.length === 7 ? 14 : (currentWeekDays.length === 30 ? 3.5 : 1);
    const gap = currentWeekDays.length === 7 ? 16 : (currentWeekDays.length === 30 ? 3.3 : 1.15);
    const leftMargin = 15;
    const topMargin = 10;
    const plotHeight = svgHeight - topMargin - 15;

    const colors = { deep: '#7c3aed', rem: '#38bdf8', light: 'rgba(255,255,255,0.18)' };

    return (
      <div className="premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)', fontWeight: '600' }}>Fazy snu ({timeframe === '90d' ? '90 dni' : (timeframe === '30d' ? '30 dni' : '7 dni')})</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.68rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.deep, display: 'inline-block' }}></span>
              {t("Głęboki")}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.rem, display: 'inline-block' }}></span>
              REM
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.light, display: 'inline-block' }}></span>
              Lekki
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px', position: 'relative', width: '100%' }}>
          <svg width="100%" height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ overflow: 'visible' }}>
            {[0, 4, 8].map((t, idx) => {
              const y = svgHeight - topMargin - ((t / maxVal) * plotHeight);
              return (
                <g key={idx}>
                  <line x1="0" y1={y} x2={svgWidth - 30} y2={y} stroke="rgba(255,255,255,0.04)" strokeDasharray="3,3" />
                  <text x={svgWidth - 25} y={y + 3} fill="rgba(255,255,255,0.25)" fontSize="7px" textAnchor="start">{t}h</text>
                </g>
              );
            })}

            {currentWeekDays.map((day, idx) => {
              const b = dayBreakdowns[idx];
              const x = leftMargin + idx * (barWidth + gap);
              const isActive = hoverInfo && hoverInfo.chartKey === chartKey && hoverInfo.idx === idx;
              const toggleHover = () => {
                setHoverInfo(prev => (prev && prev.chartKey === chartKey && prev.idx === idx)
                  ? null
                  : { chartKey, idx });
              };

              const shouldShowLabel = 
                currentWeekDays.length <= 7 
                || (currentWeekDays.length === 30 && idx % 5 === 0) 
                || (currentWeekDays.length === 90 && idx % 15 === 0);

              if (!b) {
                return (
                  <g key={idx} style={{ cursor: 'pointer' }} onMouseEnter={() => setHoverInfo({ chartKey, idx })} onMouseLeave={() => setHoverInfo(prev => (prev && prev.chartKey === chartKey && prev.idx === idx) ? null : prev)} onClick={toggleHover}>
                    <rect x={x - gap / 2} y={0} width={barWidth + gap} height={svgHeight} fill="transparent" />
                    <rect x={x} y={svgHeight - topMargin - 2} width={barWidth} height={2} rx="1" fill="rgba(255,255,255,0.08)" />
                    {shouldShowLabel && (
                      <text x={x + barWidth / 2} y={svgHeight - 1} fill={day === selectedDate ? '#ffffff' : 'rgba(255,255,255,0.35)'} fontSize="9px" fontWeight={day === selectedDate ? 'bold' : 'normal'} textAnchor="middle">
                        {getDayLabel(day)}
                      </text>
                    )}
                  </g>
                );
              }

              const deepH = (b.deep / maxVal) * plotHeight;
              const remH = (b.rem / maxVal) * plotHeight;
              const lightH = (b.light / maxVal) * plotHeight;
              const yBottom = svgHeight - topMargin;
              const yDeepTop = yBottom - deepH;
              const yRemTop = yDeepTop - remH;
              const yLightTop = yRemTop - lightH;

              return (
                <g
                  key={idx}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverInfo({ chartKey, idx })}
                  onMouseLeave={() => setHoverInfo(prev => (prev && prev.chartKey === chartKey && prev.idx === idx) ? null : prev)}
                  onClick={toggleHover}
                >
                  <rect x={x - gap / 2} y={0} width={barWidth + gap} height={svgHeight} fill="transparent" />
                  <rect x={x} y={yLightTop} width={barWidth} height={Math.max(lightH, 0)} fill={isActive ? 'rgba(255,255,255,0.3)' : colors.light} />
                  <rect x={x} y={yRemTop} width={barWidth} height={Math.max(remH, 0)} fill={colors.rem} opacity={isActive ? 1 : 0.85} />
                  <rect x={x} y={yDeepTop} width={barWidth} height={Math.max(deepH, 0)} rx="2" ry="2" fill={colors.deep} opacity={isActive ? 1 : 0.85} />
                  {shouldShowLabel && (
                    <text
                      x={x + barWidth / 2}
                      y={svgHeight - 1}
                      fill={day === selectedDate ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                      fontSize="9px"
                      fontWeight={day === selectedDate ? 'bold' : 'normal'}
                      textAnchor="middle"
                    >
                      {getDayLabel(day)}
                    </text>
                  )}
                </g>
              );
            })}

          </svg>

          {/* Podpowiedź (tooltip) - rozbicie godzin głęboki/REM/lekki dla aktywnego dnia */}
          {hoverInfo && hoverInfo.chartKey === chartKey && dayBreakdowns[hoverInfo.idx] && (() => {
            const idx = hoverInfo.idx;
            const b = dayBreakdowns[idx];
            const x = leftMargin + idx * (barWidth + gap) + barWidth / 2;
            const y = 10;
            return renderTooltip(
              chartKey,
              idx,
              x,
              y,
              null,
              b.day,
              svgWidth,
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start', fontSize: '0.78rem', color: '#fff', marginTop: '2px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.deep }} />
                  Głęboki: <strong>{formatDuration(b.deep)}</strong>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.rem }} />
                  REM: <strong>{formatDuration(b.rem)}</strong>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.light }} />
                  Lekki: <strong>{formatDuration(b.light)}</strong>
                </span>
              </div>,
              svgHeight
            );
          })()}
        </div>
        {!hasData && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            Brak danych o fazach snu w tym tygodniu
          </div>
        )}
      </div>
    );
  };

  const renderComparisonPill = (pctChange, isNewActivity = false, isNoData = false) => {
    // F-N3: Brak danych w obu tygodniach — nie pokazuj mylącego "0%"
    if (isNoData) {
      return (
        <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.3)', fontWeight: '600', display: 'inline-flex', alignItems: 'center' }}>
          — brak danych
        </span>
      );
    }
    if (isNewActivity) {
      return (
        <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: '12px', background: 'rgba(96, 165, 250, 0.12)', color: '#60a5fa', fontWeight: '600', display: 'inline-flex', alignItems: 'center' }}>
          ✦ nowa aktywność (brak danych z poprzedniego tygodnia)
        </span>
      );
    }

    if (pctChange === 0) {
      return (
        <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', fontWeight: '600', display: 'inline-flex', alignItems: 'center' }}>
          0% vs poprzedni tydzień
        </span>
      );
    }

    const isPositive = pctChange > 0;
    const color = isPositive ? '#34d399' : '#f87171';
    const bg = isPositive ? 'rgba(52, 211, 153, 0.12)' : 'rgba(239, 68, 68, 0.12)';
    const arrow = isPositive ? '↑' : '↓';

    return (
      <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: '12px', background: bg, color: color, fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
        {arrow} {Math.abs(pctChange)}% vs poprzedni tydzień
      </span>
    );
  };

  if (isLoading && historyData.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div className="premium-title-row" style={{ padding: '0 4px' }}>
          <div className="shimmer-placeholder" style={{ height: '24px', width: '150px' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          <div className="premium-card" style={{ height: '280px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '40%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          </div>
          <div className="premium-card" style={{ height: '280px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '30%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '180px', width: '100%' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      <div className="premium-title-row" style={{ padding: '0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#fff' }}>Twoje wykresy</h2>
        <div style={{ display: 'flex', gap: '4px', background: 'rgba(255, 255, 255, 0.03)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
          {[
            { key: '7d', label: '7 dni' },
            { key: '30d', label: '30 dni' },
            { key: '90d', label: '90 dni' }
          ].map((item) => (
            <button
              key={item.key}
              onClick={() => setTimeframe(item.key)}
              style={{
                background: timeframe === item.key ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                border: 'none',
                borderRadius: '6px',
                color: timeframe === item.key ? '#fff' : 'var(--text-dim)',
                padding: '6px 12px',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <span className="premium-title" style={{ fontSize: '1.05rem', padding: '0 4px' }}>Sen i regeneracja</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {renderBarChart("Czas snu", "sleep_duration", "h", [0, 4, 8], (v) => formatDuration(v))}
          {renderSleepStagesChart()}
          {renderLineChart("Wynik snu", "sleep_score", "%", [0, 50, 100], false, (v) => Math.round(v))}
          {renderLineChart("Wskaźnik regeneracji", "readiness_score", "%", [0, 50, 100], false, (v) => Math.round(v))}
          {renderLineChart("Spoczynkowe tętno", "rhr", "bpm", [40, 60, 80], false, (v) => Math.round(v))}
          {renderLineChart("Zmienność rytmu serca (HRV)", "hrv", "ms", [20, 50, 80], false, (v) => Math.round(v))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div
          className="premium-title-row"
          role="button"
          tabIndex={0}
          aria-expanded={isActivityGroupOpen}
          onClick={() => setIsActivityGroupOpen(o => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsActivityGroupOpen(o => !o); } }}
          style={{ padding: '0 4px', cursor: 'pointer' }}
        >
          <span className="premium-title" style={{ fontSize: '1.05rem' }}>{t("Aktywność i ciało")}</span>
          <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
            {isActivityGroupOpen ? t('Zwiń ▲') : t('Pokaż ▼')}
          </span>
        </div>
        {isActivityGroupOpen && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {renderBarChart("Kroki", "steps", "steps", [0, 10000, 20000], (v) => Math.round(v).toLocaleString('pl-PL'))}
          {renderBarChart("Całkowita liczba kalorii", "total_calories_burned", "cals", [0, 3500, 7000], (v) => Math.round(v).toLocaleString('pl-PL'))}
          {renderLineChart("Masa ciała", "weight", "kg", [80, 95, 110], true, (v) => (Math.round(v * 10) / 10).toLocaleString('pl-PL'))}
          {renderBloodPressureChart()}
        </div>
        )}
      </div>

    </div>
  );
}
