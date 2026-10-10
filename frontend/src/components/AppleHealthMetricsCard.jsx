import { useEffect, useState } from 'react';
import { t } from '../utils/i18n';

// Every Apple Health metric the phone sent for the selected day that has no dedicated card
// elsewhere on the Dashboard (GET /api/health/apple-metrics, backed by
// backend/utils/appleHealthSamples.js). A metric ticked in Health Auto Export - or a new one
// added by a watchOS update - shows up here on its first sync, under its raw name if the
// backend does not know it yet, instead of needing a code change before it is visible.
//
// The card renders nothing while loading, on error, or when the day has no such metrics, so
// a user without Apple Health never sees an empty box.

function formatValue(value) {
  if (!Number.isFinite(value)) return '--';
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(value);
}

export default function AppleHealthMetricsCard({ sessionToken, selectedDate, onSessionExpired }) {
  const [metrics, setMetrics] = useState([]);

  useEffect(() => {
    let cancelled = false;
    // Cleared up front so the previous day's numbers never sit under a new date while the
    // request for that date is in flight.
    setMetrics([]);
    const load = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/health/apple-metrics${dateParam}`, {
          headers: { Authorization: `Bearer ${sessionToken}` }
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Called with `true`: Dashboard passes its useState setter directly. An inline
          // arrow there would be a new function every render and, being an effect
          // dependency, would refetch on every render.
          if (onSessionExpired) onSessionExpired(true);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setMetrics(Array.isArray(data.metrics) ? data.metrics : []);
        }
      } catch (err) {
        console.error('Failed to fetch Apple Health metrics:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, onSessionExpired]);

  if (metrics.length === 0) return null;

  return (
    <div className="premium-card">
      <div className="premium-title-row">
        <span className="premium-title">{t("Pozostałe dane z Apple Health")}</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          {metrics.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
        {metrics.map((m) => (
          <div
            key={m.metric}
            title={`${m.metric} · ${m.samples} pomiarów`}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '12px',
              fontSize: '0.85rem',
              padding: '4px 0',
              borderBottom: '1px solid rgba(255,255,255,0.06)'
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.7)', minWidth: 0, overflowWrap: 'anywhere' }}>
              {m.label}
            </span>
            <span style={{ fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere' }}>
              {formatValue(m.value)}
              {m.units ? <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}> {m.units}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
