// The "Zastosuj cel" button of the calorie target card (audit 2026-10-10, U5).
//
// The button used to save the suggested target in one click, although the suggestion rests on
// a weight trend whose noise the audit put at ±314 kcal/day. The backend now proposes a target
// only when the gap is larger than that noise and sends the range of targets consistent with
// the data (backend/utils/calorieSuggestion.js); this module decides whether the button may
// appear at all and words the confirmation that shows the range before anything is saved.
// `t` is passed in rather than imported because utils/i18n.js reads localStorage on load,
// which node:test does not have.

// Applying needs a concrete target AND its range. A response without the range comes from a
// backend older than this change - which also skipped the noise test - so the button stays
// hidden rather than offering a number nobody checked against its own uncertainty.
export function canApplyCalorieSuggestion(suggestion) {
  if (!suggestion || suggestion.suggestionNeeded !== true) return false;
  const target = suggestion.suggestedTargetCalories;
  const range = suggestion.suggestedTargetRange;
  return Number.isFinite(target) && target > 0 &&
    !!range && Number.isFinite(range.min) && Number.isFinite(range.max);
}

export function calorieSuggestionConfirmText(suggestion, t) {
  return t(
    'Zmienić cel z {current} na {target} kcal?\n\nTo szacunek z wahań wagi z ostatnich tygodni - z 95% pewnością właściwy cel leży między {min} a {max} kcal (niepewność ±{uncertainty} kcal/dzień). Możesz go później zmienić w Aktywności.',
    {
      current: suggestion.currentTargetCalories,
      target: suggestion.suggestedTargetCalories,
      min: suggestion.suggestedTargetRange.min,
      max: suggestion.suggestedTargetRange.max,
      uncertainty: suggestion.gapUncertainty
    }
  );
}
