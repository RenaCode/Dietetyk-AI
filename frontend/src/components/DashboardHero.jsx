import React from 'react';
import { t } from '../utils/i18n';
import { getWarsawDateString } from '../utils/dates';

// The top of the dashboard: the day's calories as one large ring and the three
// macronutrients. Everything here is read from the /api/dashboard summary that
// App.jsx already holds - this file adds no request of its own.
//
// Goals are shown ONLY when the user actually has one. The nutrition card this replaces
// read `summary.target_protein ?? 150` (and 2000 kcal / 250 g / 80 g), so a user without a
// stored goal saw "104g / 150g" and a 69% bar measured against a number nobody set. A goal
// deliberately stored as 0 (a switched-off goal) counts as "no goal" too: there is nothing
// to be a percentage of, and dividing by it gave Infinity/NaN in an earlier version.
const hasGoal = (value) => Number.isFinite(value) && value > 0;

const localeFor = (language) => (language === 'en' ? 'en-US' : 'pl-PL');

const formatNumber = (value, language) => Math.round(value).toLocaleString(localeFor(language));

// Positions of the decorative particles around the ring, as fractions of the ring box.
// Computed once from a fixed seed so the layout is identical on every render and in
// screenshots; they carry no data.
const PARTICLES = Array.from({ length: 18 }, (_, i) => {
  const angle = (i / 18) * Math.PI * 2 + (i % 3) * 0.17;
  const distance = 0.53 + ((i * 37) % 11) / 100;
  return {
    x: 50 + Math.cos(angle) * distance * 100,
    y: 50 + Math.sin(angle) * distance * 100,
    size: 3 + ((i * 7) % 4),
    delay: ((i * 0.37) % 3).toFixed(2)
  };
});

function CalorieRingCard({ summary, selectedDate, language }) {
  const eaten = summary.calories_eaten || 0;
  const goal = summary.target_calories;
  const goalKnown = hasGoal(goal);
  // The label shows the real percentage (it can pass 100%); only the ring itself is capped,
  // because an arc cannot be drawn past a full circle.
  const pct = goalKnown ? Math.round((eaten / goal) * 100) : null;
  const ringPct = goalKnown ? Math.min(eaten / goal, 1) : 0;

  const size = 240;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const isToday = selectedDate === getWarsawDateString();
  // Midday UTC keeps the calendar day stable in every timezone when formatting.
  const dayLabel = isToday
    ? t('Dzisiaj')
    : new Date(`${selectedDate}T12:00:00Z`).toLocaleDateString(localeFor(language), { day: 'numeric', month: 'long', timeZone: 'UTC' });

  const ringLabel = goalKnown
    ? t('Zjedzone {eaten} kcal z {goal} kcal celu ({pct}%)', { eaten: formatNumber(eaten, language), goal: formatNumber(goal, language), pct })
    : t('Zjedzone {eaten} kcal, cel kalorii nie jest ustawiony', { eaten: formatNumber(eaten, language) });

  return (
    <section className="hero-ring-card" aria-label={t('Kalorie dnia')}>
      <div className="calorie-ring" role="img" aria-label={ringLabel}>
        <div className="calorie-ring-glow" aria-hidden="true" />
        <div className="calorie-ring-particles" aria-hidden="true">
          {PARTICLES.map((p, i) => (
            <span
              key={i}
              style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, animationDelay: `${p.delay}s` }}
            />
          ))}
        </div>
        <svg className="calorie-ring-svg" viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="calorie-ring-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#7af5c6" />
              <stop offset="55%" stopColor="#2fdc98" />
              <stop offset="100%" stopColor="#12b47a" />
            </linearGradient>
          </defs>
          <circle className="calorie-ring-outline" cx={size / 2} cy={size / 2} r={radius + stroke / 2 + 7} />
          <circle className="calorie-ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
          {goalKnown && ringPct > 0 && (
            <circle
              className="calorie-ring-progress"
              cx={size / 2}
              cy={size / 2}
              r={radius}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - ringPct)}
              stroke="url(#calorie-ring-gradient)"
            />
          )}
        </svg>
        <div className="calorie-ring-text" aria-hidden="true">
          <span className="calorie-ring-day">{dayLabel}</span>
          <span className="calorie-ring-value">
            {formatNumber(eaten, language)}<span className="calorie-ring-unit">kcal</span>
          </span>
          {goalKnown ? (
            <>
              <span className="calorie-ring-goal">{t('z {goal} kcal celu', { goal: formatNumber(goal, language) })}</span>
              <span className={`calorie-ring-pct${pct > 100 ? ' is-over' : ''}`}>{pct}%</span>
            </>
          ) : (
            <span className="calorie-ring-goal">{t('Cel kalorii nie jest ustawiony')}</span>
          )}
        </div>
      </div>

      {/* Net calorie balance (eaten - burned) from summary.net_calories, computed in
          dashboard.js. Colour: red = a surplus of >200 kcal (bulking), green = a deficit
          of < -200 kcal (cutting), yellow = balance (+/-200 kcal). Moved here from the
          old nutrition card together with the calorie gauge it sat under. */}
      {summary.net_calories != null && (
        <p className="calorie-ring-net">
          {t('Bilans netto')}{' '}
          <strong className={summary.net_calories > 200 ? 'is-surplus' : summary.net_calories < -200 ? 'is-deficit' : 'is-even'}>
            {summary.calories_burned_is_estimate ? '≈' : ''}{summary.net_calories > 0 ? '+' : ''}{formatNumber(summary.net_calories, language)} kcal
          </strong>
          {/* The burn behind this balance uses a default BMR, not the user's (S2). */}
          {summary.calories_burned_is_estimate && (
            <span data-testid="bmr-default-note" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {t('Przybliżenie: BMR nieustawiony, przyjęto {bmr} kcal. Ustaw BMR w Ustawieniach.', { bmr: summary.bmr })}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function MacroCard({ summary, language }) {
  // Labels are resolved here, at render time, so a language switch re-translates them.
  const macros = [
    { key: 'protein', label: t('Białko'), eatenField: 'eaten_protein', goalField: 'target_protein' },
    { key: 'carbs', label: t('Węglowodany'), eatenField: 'eaten_carbs', goalField: 'target_carbs' },
    { key: 'fat', label: t('Tłuszcz'), eatenField: 'eaten_fat', goalField: 'target_fat' }
  ];
  return (
    <section className="hero-card hero-macros" aria-labelledby="hero-macros-title">
      <div className="hero-card-head">
        <h3 className="hero-card-title" id="hero-macros-title">{t('Makroskładniki')}</h3>
      </div>
      <div className="macro-rows">
        {macros.map((m) => {
          const eaten = summary[m.eatenField] || 0;
          const goal = summary[m.goalField];
          const goalKnown = hasGoal(goal);
          const pct = goalKnown ? Math.round((eaten / goal) * 100) : null;
          return (
            <div className={`macro-row macro-${m.key}`} key={m.key}>
              <div className="macro-row-head">
                <span className="macro-row-name">{m.label}</span>
                <span className="macro-row-goal">
                  {goalKnown ? t('cel {goal} g', { goal: formatNumber(goal, language) }) : t('brak celu')}
                </span>
              </div>
              <div className="macro-track">
                {goalKnown && eaten > 0 && (
                  <div className="macro-fill" style={{ '--p': Math.min(eaten / goal, 1) }} aria-hidden="true" />
                )}
                <span className="macro-value">
                  <strong>{formatNumber(eaten, language)}g</strong>
                  {goalKnown && <span className="macro-value-goal"> / {formatNumber(goal, language)}g</span>}
                </span>
                {goalKnown && <span className={`macro-pct${pct > 100 ? ' is-over' : ''}`}>{pct}%</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export { CalorieRingCard, MacroCard };
