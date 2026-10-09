import React from 'react';

// Line icons for the navigation (top bar, side rail, mobile bottom bar) and the logo mark.
// Hand-drawn SVG on purpose: the project keeps a small dependency surface (see CLAUDE.md),
// and an icon library would add more weight than these eight shapes are worth.
// Every icon is decorative - the button that holds it carries the accessible name.
const PATHS = {
  dashboard: <><rect x="3.5" y="3.5" width="7" height="9" rx="2" /><rect x="13.5" y="3.5" width="7" height="5" rx="2" /><rect x="13.5" y="11.5" width="7" height="9" rx="2" /><rect x="3.5" y="15.5" width="7" height="5" rx="2" /></>,
  meals: <><path d="M7 3v8" /><path d="M4.5 3v5a2.5 2.5 0 0 0 5 0V3" /><path d="M7 11v10" /><path d="M17 21V3c-2.2 1.3-3.5 3.9-3.5 7v3.5H17" /></>,
  trends: <><path d="M6 20V10" /><path d="M12 20V4" /><path d="M18 20v-7" /></>,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  settings: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.4-3.6 4.2-5.5 7.5-5.5s6.1 1.9 7.5 5.5" /></>,
  admin: <><path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z" /><path d="M9 12l2 2 4-4" /></>,
  insights: <><path d="M9.5 4.5a3 3 0 0 0-3 3v.3A3.2 3.2 0 0 0 4.5 11a3.2 3.2 0 0 0 1.6 2.8A3 3 0 0 0 9.5 18H12V4.5z" /><path d="M14.5 4.5a3 3 0 0 1 3 3v.3a3.2 3.2 0 0 1 2 3.2 3.2 3.2 0 0 1-1.6 2.8 3 3 0 0 1-3.4 4.2H12" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16l-4-4 4-4" /><path d="M6 12h10" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>
};

export function NavIcon({ name, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

// The brand mark: a rounded "D" with a leaf cut into it, filled with the app's green.
export function LogoMark({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="logo-mark-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5ff2b8" />
          <stop offset="100%" stopColor="#0ea371" />
        </linearGradient>
      </defs>
      <path d="M6 6h13c8.3 0 15 6.3 15 14s-6.7 14-15 14H6z" fill="url(#logo-mark-fill)" />
      <path d="M13 27c0-7.5 5-12.5 14-13-0.6 8.4-5.6 13.3-14 13z" fill="#06110c" opacity="0.9" />
      <path d="M13 27l7.5-7" stroke="url(#logo-mark-fill)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
