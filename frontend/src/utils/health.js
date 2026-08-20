import { t } from './i18n';

// Helpers for interpreting health metrics (as opposed to plain text formatting - see
// utils/format.js) - extracted because the ±0.5 °C threshold for temperature deviation
// (Oura) used to be repeated inline across several components.

// Status of body temperature deviation (Oura daily_readiness, temperature_deviation)
// against the ±0.5 °C range. Returns whether the value is within range, plus a ready
// label in the language the user selected.
export function getTemperatureStatus(deviation) {
  const inRange = Math.abs(deviation) <= 0.5;
  return {
    inRange,
    label: inRange ? t('W normie ±0.5°C (Oura)') : t('Poza normą ±0.5°C (Oura)')
  };
}
