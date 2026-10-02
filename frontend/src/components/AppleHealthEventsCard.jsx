import { useEffect, useState } from 'react';
import { t } from '../utils/i18n';

// Symptoms, menstrual cycle position and heart-rate notifications from Apple Health
// (GET /api/health/apple-events, backed by backend/utils/appleHealthEvents.js).
//
// Each section renders only when it has data, and the whole card renders nothing otherwise -
// a user who does not track a cycle or never gets a notification should not see empty boxes
// for them.

const MEDICATION_COLORS = {
  Taken: 'var(--color-secondary, #34d399)',
  Skipped: 'var(--warning, #fbbf24)'
};

const SEVERITY_COLORS = {
  Severe: 'var(--danger-light, #f87171)',
  Moderate: 'var(--warning, #fbbf24)'
};

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('pl-PL', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '';
  }
}

const sectionTitle = { fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '10px' };
const row = { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '0.85rem', padding: '4px 0' };
const note = { fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px', lineHeight: 1.4 };

export default function AppleHealthEventsCard({ sessionToken, selectedDate, onSessionExpired }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/health/apple-events${dateParam}`, {
          headers: { Authorization: `Bearer ${sessionToken}` }
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Dashboard passes its useState setter directly (stable identity) - see
          // AppleHealthMetricsCard for why an inline arrow must not be used here.
          if (onSessionExpired) onSessionExpired(true);
          return;
        }
        if (res.ok) {
          const body = await res.json();
          if (!cancelled) setData(body);
        }
      } catch (err) {
        console.error('Failed to fetch Apple Health events:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, onSessionExpired]);

  if (!data) return null;
  const symptoms = (data.events || []).filter((e) => e.kind === 'symptom' && e.value !== 'Not Present');
  const cycleEntries = (data.events || []).filter((e) => e.kind === 'cycle');
  const notifications = data.heartRateNotifications || [];
  const medications = (data.events || []).filter((e) => e.kind === 'medication');
  const cycle = data.cycle;
  if (symptoms.length === 0 && cycleEntries.length === 0 && notifications.length === 0 && medications.length === 0 && !cycle) return null;

  return (
    <div className="premium-card">
      <div className="premium-title-row">
        <span className="premium-title">{t("Objawy, cykl, serce i leki")}</span>
      </div>

      {notifications.length > 0 && (
        <>
          <div style={sectionTitle}>Powiadomienia o tętnie (7 dni)</div>
          {notifications.map((n) => (
            <div key={`${n.start}-${n.name}`} style={row}>
              <span style={{ color: 'var(--warning, #fbbf24)' }}>⚠ {n.label}{n.value ? ` · ${n.value}` : ''}</span>
              <span style={{ color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>{formatTime(n.start)}</span>
            </div>
          ))}
          <div style={note}>
            Zegarek zgłasza je przy tętnie poza progiem w spoczynku lub nieregularnym rytmie. To sygnał
            przesiewowy, nie diagnoza - jeśli się powtarzają, skonsultuj je z lekarzem.
          </div>
        </>
      )}

      {cycle && (
        <>
          <div style={sectionTitle}>Cykl miesiączkowy</div>
          <div style={row}>
            <span>{cycle.phaseLabel}</span>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>dzień {cycle.day}</span>
          </div>
          <div style={note}>
            {cycle.note}
            {cycle.estimated
              ? ' Faza szacowana z typowego cyklu 28 dni - po dwóch zapisanych cyklach użyję Twojej średniej.'
              : ` Średnia długość Twojego cyklu: ${cycle.cycleLength} dni.`}
          </div>
        </>
      )}
      {cycleEntries.length > 0 && (
        <div style={{ marginTop: cycle ? '4px' : '10px' }}>
          {!cycle && <div style={sectionTitle}>Cykl miesiączkowy</div>}
          {cycleEntries.map((e) => (
            <div key={`${e.start}-${e.name}`} style={row}>
              <span style={{ color: 'rgba(255,255,255,0.7)' }}>{e.label}</span>
              <span>{e.valueLabel || '✓'}</span>
            </div>
          ))}
        </div>
      )}

      {medications.length > 0 && (
        <>
          <div style={sectionTitle}>{t('Leki i suplementy (Zdrowie)')}</div>
          {medications.map((m) => (
            <div key={`${m.start}-${m.name}`} style={row}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {m.name}
                <span style={{ color: 'rgba(255,255,255,0.45)' }}> · {formatTime(m.start).split(', ').pop()}</span>
              </span>
              <span style={{ whiteSpace: 'nowrap', color: MEDICATION_COLORS[m.value] || 'rgba(255,255,255,0.5)' }}>
                {m.value === 'Taken' ? '✓ ' : ''}{m.valueLabel || ''}
              </span>
            </div>
          ))}
        </>
      )}

      {symptoms.length > 0 && (
        <>
          <div style={sectionTitle}>Objawy</div>
          {symptoms.map((s) => (
            <div key={`${s.start}-${s.name}`} style={row}>
              <span>{s.label}</span>
              <span style={{ color: SEVERITY_COLORS[s.value] || 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>
                {s.valueLabel || ''}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
