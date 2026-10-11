// The tab a `?tab=` parameter opens, or null to stay where the app is (audit round 2, N-S2).
// The backend's Google re-authentication and linking flows (removed since, together with Google
// sign-in) redirected to `?tab=settings`, but the Settings tab is called `setup` - App.jsx set
// currentTab to a name no tab renders and the user landed on an empty page with only the date
// picker. Old links (and any bookmark) still say `settings`, so that name is mapped; anything
// else unknown is ignored rather than rendered as nothing. The OAuth callbacks of Oura and
// Withings still return with `?tab=setup`.
//
// This file used to be utils/googleReturn.js, which also parsed the return from "Sign in with
// Google" (a one-time code in the fragment, an error in the query string). Nothing reads those
// parameters any more, so a stale link carrying them simply opens the app.
export const APP_TABS = ['dashboard', 'meals', 'activity', 'trends', 'setup', 'admin'];
const LEGACY_TAB_NAMES = { settings: 'setup' };

export function resolveTabParam(tab) {
  if (!tab) return null;
  const name = LEGACY_TAB_NAMES[tab] || tab;
  return APP_TABS.includes(name) ? name : null;
}
