import React, { useState } from 'react';
import { t } from '../utils/i18n';

// The 2FA secret as text, next to the QR code (audit round 2, N-S5). Both enrolment screens -
// the one forced at login and the one in Settings - showed only the QR image, although the
// backend returns the secret as well. Someone with only a phone cannot scan their own screen,
// so a forced enrolment left them with no way in. Grouped by four like the authenticator apps
// show it, selectable, with a copy button.
export function formatTotpSecret(secret) {
  return String(secret || '').replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

export default function TotpSecretKey({ secret }) {
  const [copied, setCopied] = useState(false);
  if (!secret) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (_) { /* the key is selectable; copying is a convenience */ }
  };
  return (
    <div style={{ textAlign: 'left', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
      <div style={{ marginBottom: '4px' }}>{t('Nie możesz zeskanować kodu? Wpisz w aplikacji ten klucz:')}</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <code data-testid="totp-secret" style={{ fontSize: '0.9rem', color: 'var(--text-main)', userSelect: 'all', wordBreak: 'break-all', letterSpacing: '0.05em' }}>
          {formatTotpSecret(secret)}
        </code>
        <button type="button" className="btn-secondary" onClick={copy} style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
          {copied ? t('Skopiowano') : t('Kopiuj')}
        </button>
      </div>
    </div>
  );
}
