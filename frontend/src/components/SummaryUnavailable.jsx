import React from 'react';
import { t } from '../utils/i18n';

// Placeholder rendered INSTEAD of the dashboard / activity tab whenever the day summary
// (/api/dashboard) has not been read successfully.
//
// Why it exists: App.jsx used to seed `dashboardData.summary` with a literal object
// (target_calories: 2500, bmr: 1800, calories_burned_total: 1800, net_calories: -1800).
// `fetchDashboardData` only ever assigned to that state inside the `res.ok` branch, so a
// 500 from the backend, a Gemini timeout in /api/dashboard or a dropped connection left
// those literals on screen - and the dashboard rendered them next to the unit "kcal".
// A user on a reduction diet was shown a deficit of 1800 kcal that nobody measured, and
// the same screen appeared for the first second of every single launch.
//
// The rule this encodes: a number a human reads as a measurement of their body must come
// from a reading that actually succeeded. "Not known yet" and "known to be zero" are
// different states and must look different.
// hasFailed distinguishes "the read failed" from "the read has not come back yet"; only
// the first may tell the user something went wrong.
export default function SummaryUnavailable({ hasFailed = false, onRetry }) {
  if (!hasFailed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div className="premium-card" style={{ minHeight: '160px' }}>
          <div className="shimmer-placeholder" style={{ height: '20px', width: '45%', marginBottom: '16px' }} />
          <div className="shimmer-placeholder" style={{ height: '100px', width: '100%' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          <div className="premium-card" style={{ minHeight: '180px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '35%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '120px', width: '100%' }} />
          </div>
          <div className="premium-card" style={{ minHeight: '180px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '50%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '120px', width: '100%' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="premium-card" style={{ textAlign: 'center', padding: '32px 20px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
      <div style={{ fontSize: '1.6rem' }}>📡</div>
      <div style={{ fontSize: '1rem', color: '#fff', fontWeight: '600' }}>
        {t('Nie udało się wczytać danych dnia')}
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)', maxWidth: '420px' }}>
        {t('Nie pokazujemy tu żadnych liczb, bo nie znamy Twoich dzisiejszych wartości — zamiast zgadywać, poczekaj i spróbuj ponownie.')}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: '8px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid var(--border-glass)',
            borderRadius: '8px',
            color: '#fff',
            padding: '8px 18px',
            fontSize: '0.85rem',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          {t('Spróbuj ponownie')}
        </button>
      )}
    </div>
  );
}
