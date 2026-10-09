import React from 'react';
import { t } from '../utils/i18n';

// The one way an AI ESTIMATE is labelled on screen (audit 2026-10-09, W3). Fibre, sugar and
// sodium come from Gemini guessing them from a description or a photo (backend
// utils/mealPrompts.js says "szacunkowo"), yet the chips and the sodium -> blood pressure card
// showed them in the same voice as a Withings reading. The same rule as SummaryUnavailable:
// what a person reads as a measurement of their body must be one - and what is not, has to
// say so. Days without a complete estimate are left out of comparisons by the backend
// (utils/estimatedNutrients.js); `excludedDays` says how many.
export default function EstimateNote({ what, excludedDays }) {
  return (
    <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '10px', marginBottom: 0, lineHeight: 1.5 }}>
      {t('≈ {what} to szacunek AI na podstawie opisu lub zdjęcia posiłku, nie pomiar.', { what })}
      {excludedDays > 0 && (
        <> {t('Pominięto dni bez pełnego szacunku: {n}.', { n: excludedDays })}</>
      )}
    </p>
  );
}
