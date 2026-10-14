import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from '../utils/i18n';
import { renacodeApps, CURRENT_APP_ID } from '../utils/renacodeApps';

// The 3x3 "grid" button next to the logo that opens a list of the other RenaCode apps, in the
// manner of the Atlassian header. The app list itself lives in utils/renacodeApps.js.
//
// Semantics: a non-modal dialog opened by a button (aria-haspopup="dialog"), not role="menu".
// A menu promises arrow-key navigation and menuitem roles; the panel holds plain links and one
// static entry, so Tab order is the honest model and screen readers announce links as links.
//
// `showArgo` comes from the profile (show_argo, decided on the backend) and adds the owner-only
// Argo CD entry; see utils/renacodeApps.js.

function GridIcon() {
  const dots = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      dots.push(<rect key={`${row}-${col}`} x={3.5 + col * 6.5} y={3.5 + row * 6.5} width="4" height="4" rx="1.2" />);
    }
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      {dots}
    </svg>
  );
}

export default function AppSwitcher({ showArgo = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();
  const titleId = useId();
  const apps = renacodeApps(t, { showArgo });

  useEffect(() => {
    if (!open) return undefined;

    // Focus moves into the panel so a keyboard user lands on the first app instead of having
    // to Tab past whatever follows the button in the header.
    const firstLink = panelRef.current && panelRef.current.querySelector('a[href]');
    if (firstLink) firstLink.focus();

    // pointerdown rather than click: a click on another header control would otherwise run
    // that control's handler first and leave the panel hanging open over the result.
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        if (buttonRef.current) buttonRef.current.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Tabbing out of the panel closes it; otherwise it stays open over the page with focus
  // somewhere else, which is the state Escape and outside-click exist to prevent.
  const handleBlur = (event) => {
    if (open && rootRef.current && event.relatedTarget && !rootRef.current.contains(event.relatedTarget)) {
      setOpen(false);
    }
  };

  return (
    <div className="app-switcher" ref={rootRef} onBlur={handleBlur}>
      <button
        type="button"
        ref={buttonRef}
        className={`app-switcher-btn ${open ? 'open' : ''}`}
        aria-label={t('Przełącz aplikację')}
        title={t('Przełącz aplikację')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <GridIcon />
      </button>

      {open && (
        <div className="app-switcher-panel" id={panelId} ref={panelRef} role="dialog" aria-labelledby={titleId}>
          <div className="app-switcher-title" id={titleId}>{t('Aplikacje RenaCode')}</div>
          <ul className="app-switcher-list">
            {apps.map((app) => {
              const current = app.id === CURRENT_APP_ID;
              const body = (
                <>
                  <span className={`app-switcher-tile app-switcher-tile-${app.id}`} aria-hidden="true">{app.name[0]}</span>
                  <span className="app-switcher-text">
                    <span className="app-switcher-name">
                      {app.name}
                      {current && <span className="app-switcher-current-badge">{t('Tutaj jesteś')}</span>}
                    </span>
                    <span className="app-switcher-desc">{app.description}</span>
                  </span>
                </>
              );
              return (
                <li key={app.id}>
                  {current ? (
                    <div className="app-switcher-item current" aria-current="page">{body}</div>
                  ) : (
                    <a className="app-switcher-item" href={app.url}>{body}</a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
