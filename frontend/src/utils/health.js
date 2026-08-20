import { t } from './i18n';

// Helpery związane z interpretacją metryk zdrowotnych (a nie czystym formatowaniem
// tekstu - patrz utils/format.js) - wydzielone, bo próg ±0.5°C dla odchylenia
// temperatury (Oura) był wcześniej powtórzony inline w kilku komponentach.

// Status odchylenia temperatury ciała (Oura daily_readiness, temperature_deviation)
// względem normy ±0.5°C. Zwraca, czy wartość jest w normie, oraz gotową etykietę
// w języku wybranym przez użytkownika.
export function getTemperatureStatus(deviation) {
  const inRange = Math.abs(deviation) <= 0.5;
  return {
    inRange,
    label: inRange ? t('W normie ±0.5°C (Oura)') : t('Poza normą ±0.5°C (Oura)')
  };
}
