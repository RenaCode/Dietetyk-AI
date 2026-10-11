import React, { useState, useEffect, useRef } from 'react';
import { t } from '../utils/i18n';

// Asks the administrator for their own password before an admin action (backend
// routes/admin.js, requireAdminPassword). Replaces the browser confirm() the panel used: that
// dialog proved only that someone clicked, which a session alone - an unlocked laptop, a
// borrowed SSO cookie - can always do.
//
// `request` is { title, message, confirmLabel, danger, execute(password) }. execute sends the
// request and resolves with { res, data }. A refusal of the PASSWORD (requirePassword, the
// 429 lockout, the 409 for an account without one) keeps the dialog open with the server's
// message, so a typo costs a retype and not the whole action; anything else is the action's
// own outcome and is handed to onDone(res, data), which reports it in the panel as before.
export default function AdminPasswordDialog({ request, onCancel, onDone, onLogout }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setPassword('');
    setError('');
    setIsSubmitting(false);
    if (request && inputRef.current) inputRef.current.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !isSubmitting) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, isSubmitting, onCancel]);

  if (!request) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password) {
      setError(t('Wpisz swoje hasło administratora.'));
      return;
    }
    setIsSubmitting(true);
    setError('');
    try {
      const { res, data } = await request.execute(password);
      if (res.status === 401) {
        if (onLogout) onLogout();
        return;
      }
      if (data.requirePassword || data.requirePasswordSetup || res.status === 429) {
        setError(data.error || t('Niepoprawne hasło.'));
        setPassword('');
        if (inputRef.current) inputRef.current.focus();
        return;
      }
      onDone(res, data);
    } catch (err) {
      setError(t('Błąd połączenia z serwerem.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px', zIndex: 9999
      }}
      onClick={() => { if (!isSubmitting) onCancel(); }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-password-title"
        data-testid="admin-password-dialog"
        className="glass-card"
        style={{ width: '100%', maxWidth: '440px', margin: 0 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="admin-password-title" className="card-title" style={{ marginBottom: '12px' }}>{request.title}</h3>
        {request.message && (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '16px' }}>{request.message}</p>
        )}
        <div className="input-group">
          <label className="input-label" htmlFor="admin-password-input">{t('Twoje hasło administratora')}</label>
          <input
            id="admin-password-input"
            ref={inputRef}
            type="password"
            className="input-field"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
          />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '4px' }}>
            {t('Akcje administracyjne wymagają hasła także po zalogowaniu przez SSO.')}
          </span>
        </div>
        {error && (
          <div className="alert alert-error" role="alert" style={{ marginTop: '12px' }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSubmitting}>
            {t('Anuluj')}
          </button>
          <button type="submit" className={request.danger ? 'btn-danger' : 'btn-primary'} disabled={isSubmitting}>
            {isSubmitting ? t('Sprawdzanie...') : (request.confirmLabel || t('Potwierdź'))}
          </button>
        </div>
      </form>
    </div>
  );
}
