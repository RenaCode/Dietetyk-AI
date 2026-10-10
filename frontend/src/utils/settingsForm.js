// The Settings form's starting state and what a save sends.
//
// The form used to start from hard-coded defaults (2500 kcal, BMR 1800, 150/250/80 g, 2500 ml)
// and every save posted the WHOLE form state (audit 2026-10-09, W1). When GET /api/settings
// failed, the form kept showing those defaults next to "Could not load the settings", and
// "Save" wrote them over the user's real targets and BMR - followed by a success message. The
// same happened with no failure at all for any key missing from the database: registration
// never stores target_water_ml, so the form displayed 2500 ml as if the user had chosen it,
// and saving ANY section of the form persisted it.
//
// So: the form starts EMPTY (an empty field means "not set", never a guess), a save is only
// possible once the GET has succeeded, and it sends only the fields that differ from what was
// loaded. Pure functions, so src/utils/settingsForm.test.js can pin the rules down.

export const EMPTY_SETTINGS_FORM = Object.freeze({
  target_calories: '',
  target_protein: '',
  target_carbs: '',
  target_fat: '',
  bmr: '',
  target_water_ml: '',
  height_cm: '',
  target_weight_kg: '',
  target_body_fat_pct: '',
  oura_client_id: '',
  oura_client_secret: '',
  withings_client_id: '',
  withings_client_secret: '',
  withings_redirect_uri: '',
  gemini_api_key: '',
  weather_lat: '',
  weather_lon: '',
  weather_location_label: ''
});

// The form state built from a successful GET: every field present, missing keys empty.
export function formFromLoadedSettings(data) {
  return { ...EMPTY_SETTINGS_FORM, ...(data || {}) };
}

const asComparable = (value) => (value === null || value === undefined ? '' : String(value));

// The keys whose value the user actually changed, relative to what was loaded. Throws when
// nothing was loaded - there is no honest diff against a state we never saw, and posting the
// whole form instead is exactly the bug this module exists to prevent.
export function settingsPatch(loaded, current) {
  if (!loaded) {
    throw new Error('settingsPatch: the settings were never loaded - refusing to build a save');
  }
  const patch = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (key === 'sync_token') continue;
    if (asComparable(value) !== asComparable(loaded[key])) {
      patch[key] = value;
    }
  }
  return patch;
}
