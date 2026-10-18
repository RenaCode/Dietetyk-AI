// The HRV and resting heart rate cards of "Trendy zdrowotne" (audit 2026-10-10, U6).
//
// Both cards were rendered with a hard-coded status="success", so the footer showed a green
// ✓ next to "Niski < 48" (low HRV) and "Wysoki > 61" (high resting HR) - the two readings that
// usually mean poor recovery, presented as the all-clear. The neighbouring cards (SpO2,
// breathing rate, temperature deviation) already derived their status from the value; these
// two now do too, from the same thresholds their labels and range bars already used.
//
// The thresholds are the ones the cards have always shown, not clinical cut-offs: HRV in
// particular is highly individual, and 48 ms is a population-level rule of thumb. A missing
// reading gets a neutral state - neither a ✓ nor a warning about a value that does not exist.

export const HRV_LOW_BELOW_MS = 48;
export const RHR_HIGH_FROM_BPM = 61;

// { status: 'success' | 'warning' | 'neutral', activeSegment, footerText }
export function getHrvCardState(hrv) {
  if (hrv == null || !Number.isFinite(hrv)) {
    return { status: 'neutral', activeSegment: 'middle', footerText: 'Brak danych' };
  }
  return hrv >= HRV_LOW_BELOW_MS
    ? { status: 'success', activeSegment: 'right', footerText: `Wysoki ≥ ${HRV_LOW_BELOW_MS}` }
    : { status: 'warning', activeSegment: 'middle', footerText: `Niski < ${HRV_LOW_BELOW_MS}` };
}

export function getRhrCardState(rhr) {
  if (rhr == null || !Number.isFinite(rhr)) {
    return { status: 'neutral', activeSegment: 'middle', footerText: 'Brak danych' };
  }
  return rhr < RHR_HIGH_FROM_BPM
    ? { status: 'success', activeSegment: 'left', footerText: `Niski < ${RHR_HIGH_FROM_BPM}` }
    : { status: 'warning', activeSegment: 'middle', footerText: `Wysoki ≥ ${RHR_HIGH_FROM_BPM}` };
}

// The footer icon for a status. Only 'success' earns the ✓.
export function trendStatusIcon(status) {
  if (status === 'success') return '✓';
  if (status === 'warning') return '⚠️';
  return '–';
}
