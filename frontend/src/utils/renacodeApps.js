// The RenaCode apps listed in the header's app switcher (components/AppSwitcher.jsx).
//
// This is the one place to edit when an app is added, renamed or moves. All of them sit behind
// the same Authelia portal, so a plain same-tab link is enough: the SSO session carries over
// and the next app opens without another login.
//
// The list is built by a function that takes the translator instead of importing utils/i18n.js:
// i18n.js reads localStorage when it loads, so importing it here would make this file
// untestable under `node --test`. Naming the parameter `t` is deliberate - it keeps the
// descriptions as t() calls with a string literal, which is what scripts/check-i18n.js scans
// for; under any other name the strings would drop out of the drift check.
export const CURRENT_APP_ID = 'dietetyk';

// `adminOnly` entries are operator tools for the owner (Argo CD). Whether this user may see them
// is decided by the backend - GET /api/user/profile -> show_argo (backend/services/ssoIdentity.js,
// canSeeArgo: admin role, or a trusted Authelia identity in sso.argoGroups) - and passed in as
// `showArgo`. Anything other than literal `true` hides them, so a profile that has not loaded
// yet, or an older backend without the field, shows the family list.
export function renacodeApps(t = (text) => text, { showArgo = false } = {}) {
  const apps = [
    { id: 'trader', name: 'Trader', url: 'https://trader.renacode.com/', description: t('Handel i ryzyko') },
    { id: 'kidwatch', name: 'Kidwatch', url: 'https://kidwatch.renacode.com/', description: t('Czas ekranowy dzieci') },
    { id: 'dietetyk', name: 'Dietetyk', url: 'https://dietetyk.renacode.com/', description: t('Dieta i zdrowie') },
    { id: 'argocd', name: 'Argo CD', url: 'https://argocd.renacode.com/', description: t('Wdrożenia i klaster'), adminOnly: true }
  ];
  return apps.filter((app) => !app.adminOnly || showArgo === true);
}
