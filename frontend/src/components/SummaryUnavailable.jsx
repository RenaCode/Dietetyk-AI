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
        <div className="glass-card" style={{ minHeight: '160px' }}>
          <div className="shimmer-placeholder" style={{ height: '20px', width: '45%', marginBottom: '16px' }} />
          <div className="shimmer-placeholder" style={{ height: '100px', width: '100%' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          <div className="glass-card" style={{ minHeight: '180px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '35%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '120px', width: '100%' }} />
          </div>
          <div className="glass-card" style={{ minHeight: '180px' }}>
            <div className="shimmer-placeholder" style={{ height: '20px', width: '50%', marginBottom: '16px' }} />
            <div className="shimmer-placeholder" style={{ height: '120px', width: '100%' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card" style={{ textAlign: 'center', padding: '40px 24px', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center', maxWidth: '640px', margin: '32px auto' }}>
      <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(124, 58, 237, 0.15)', border: '1px solid rgba(124, 58, 237, 0.3)', display: 'grid', placeItems: 'center', fontSize: '1.4rem', boxShadow: '0 0 20px rgba(124, 58, 237, 0.25)' }}>
        📡
      </div>
      <div style={{ fontSize: '1.1rem', color: '#fff', fontWeight: '700', fontFamily: 'var(--font-display)' }}>
        {t('Nie udało się wczytać danych dnia')}
      </div>
      <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: '1.6', maxWidth: '460px' }}>
        {t('Nie pokazujemy tu żadnych liczb, bo nie znamy Twoich dzisiejszych wartości — zamiast zgadywać, poczekaj i spróbuj ponownie.')}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="btn-secondary"
          style={{ marginTop: '8px' }}
        >
          {t('Spróbuj ponownie')}
        </button>
      )}
    </div>
  );
}
