import React, { useState, useEffect } from 'react';
import { t } from '../utils/i18n';
import AdminPasswordDialog from './AdminPasswordDialog';

export default function AdminPanel({ sessionToken, onLogout }) {
  const [config, setConfig] = useState({
    mailgun_api_key: '',
    mailgun_domain: '',
    mailgun_region: 'us',
    mailgun_from: '',
    app_url: '',
    force_2fa: '0',
    allow_public_registration: '0',
    google_fit_enabled: '0',
    google_client_id: '',
    google_client_secret: ''
  });
  const [configMessage, setConfigMessage] = useState({ type: '', text: '' });
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // User management states
  const [users, setUsers] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('user');
  const [inviteMessage, setInviteMessage] = useState({ type: '', text: '' });
  const [isInviting, setIsInviting] = useState(false);
  const [userActionMessage, setUserActionMessage] = useState({ type: '', text: '' });
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  // Id of the user an action is running for (delete / reset 2FA / force password reset).
  // Unlike handleSaveConfig and handleInvite, this state did not exist before, so the action
  // buttons stayed clickable for the whole duration of the fetch - risking several parallel
  // requests from rapid repeated clicks.
  const [actioningUserId, setActioningUserId] = useState(null);
  // The action waiting for the admin's password (see AdminPasswordDialog) - every change made
  // from this panel goes through it, because the backend refuses them without the password.
  const [passwordRequest, setPasswordRequest] = useState(null);

  useEffect(() => {
  // F-W4: an async IIFE with `cancelled` checked AFTER every await - guards against
  // setting state on an unmounted component when the component disappeared during
  // fetchConfig (there is no other way without modifying fetchConfig/fetchUsers, which are
  // also called from elsewhere).
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchConfig();
      if (!cancelled) await fetchUsers();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sends an admin action with the password the dialog collected. A non-JSON body (a proxy's
  // HTML error page) comes back as {} - the caller then reports the bare status code.
  const sendAdminAction = async (url, method, body) => {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify(body)
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_parseErr) {
      data = {};
    }
    return { res, data };
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/admin/config', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setConfig({
          mailgun_api_key: data.mailgun_api_key || '',
          mailgun_domain: data.mailgun_domain || '',
          mailgun_region: data.mailgun_region || 'us',
          mailgun_from: data.mailgun_from || '',
          app_url: data.app_url || '',
          force_2fa: data.force_2fa || '0',
          allow_public_registration: data.allow_public_registration || '0',
          google_fit_enabled: data.google_fit_enabled || '0',
          google_client_id: data.google_client_id || '',
          google_client_secret: data.google_client_secret || ''
        });
      } else if (res.status === 401) {
        if (onLogout) onLogout();
      }
    } catch (err) {
      console.error('Failed to fetch the system configuration:', err);
    }
  };

  const fetchUsers = async () => {
    setIsLoadingUsers(true);
    try {
      const res = await fetch('/api/admin/users', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
      } else if (res.status === 401) {
        if (onLogout) onLogout();
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setIsLoadingUsers(false);
    }
  };

  const handleSaveConfig = (e) => {
    e.preventDefault();
    setConfigMessage({ type: '', text: '' });
    setPasswordRequest({
      title: t('Zapisać konfigurację systemową?'),
      message: t('Zmiana dotyczy wszystkich użytkowników (poczta, rejestracja, wymuszanie 2FA, integracje).'),
      confirmLabel: t('Zapisz konfigurację'),
      execute: async (password) => {
        setIsSavingConfig(true);
        try {
          return await sendAdminAction('/api/admin/config', 'POST', { ...config, currentPassword: password });
        } finally {
          setIsSavingConfig(false);
        }
      },
      onDone: (res, data) => {
        if (res.ok) {
          setConfigMessage({ type: 'success', text: t('Konfiguracja systemowa została zapisana pomyślnie!') });
          setTimeout(() => setConfigMessage({ type: '', text: '' }), 5000);
        } else {
          setConfigMessage({ type: 'error', text: data.error || t('Błąd zapisu konfiguracji.') });
        }
      }
    });
  };

  const handleInvite = (e) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    const role = inviteRole;
    const asAdmin = role === 'admin';
    setInviteMessage({ type: '', text: '' });
    setPasswordRequest({
      // The admin role is named in the dialog's title itself: the backend also wants
      // confirm_admin for it, and the dialog is where the admin explicitly confirms it.
      title: asAdmin ? t('Zaprosić nowego ADMINISTRATORA?') : t('Wysłać zaproszenie?'),
      message: asAdmin
        ? t('Konto {email} dostanie pełne uprawnienia administratora: zarządzanie użytkownikami i konfiguracją.', { email })
        : t('Na adres {email} zostanie wysłany link do rejestracji (rola: użytkownik).', { email }),
      confirmLabel: t('Wyślij zaproszenie'),
      danger: asAdmin,
      execute: async (password) => {
        setIsInviting(true);
        try {
          return await sendAdminAction('/api/admin/invite', 'POST', {
            email,
            role,
            confirm_admin: asAdmin,
            currentPassword: password
          });
        } finally {
          setIsInviting(false);
        }
      },
      onDone: (res, data) => {
        if (res.ok) {
          setInviteMessage({ type: 'success', text: t('Zaproszenie zostało wysłane na adres {email} (rola: {role}).', { email, role }) });
          setInviteEmail('');
          setInviteRole('user'); // Reset to default
          fetchUsers(); // Refresh list to show pending user
          setTimeout(() => setInviteMessage({ type: '', text: '' }), 5000);
        } else {
          setInviteMessage({ type: 'error', text: data.error || t('Błąd wysyłania zaproszenia.') });
        }
      }
    });
  };

  // What each per-user action asks in the password dialog.
  const USER_ACTIONS = {
    'force-password-change': {
      title: t('Wymusić zmianę hasła?'),
      message: (username) => t('Użytkownik {username} zostanie wylogowany i przy kolejnym logowaniu ustawi nowe hasło.', { username }),
      confirmLabel: t('Wymuś zmianę hasła')
    },
    'reset-2fa': {
      title: t('Zresetować 2FA?'),
      message: (username) => t('Weryfikacja 2FA użytkownika {username} zostanie wyłączona, a jego sesje zakończone.', { username }),
      confirmLabel: t('Resetuj 2FA'),
      danger: true
    },
    'force-2fa': {
      title: t('Wymusić 2FA?'),
      message: (username) => t('Użytkownik {username} zostanie wylogowany i przy kolejnym logowaniu skonfiguruje 2FA.', { username }),
      confirmLabel: t('Wymuś 2FA')
    },
    delete: {
      title: t('Usunąć użytkownika?'),
      message: (username) => t('Konto {username} i wszystkie jego dane zostaną usunięte. Tej operacji nie można cofnąć.', { username }),
      confirmLabel: t('Usuń'),
      danger: true
    }
  };

  const handleUserAction = (user, action) => {
    const spec = USER_ACTIONS[action];
    setUserActionMessage({ type: '', text: '' });
    const url = action === 'delete' ? `/api/admin/users/${user.id}` : `/api/admin/users/${user.id}/${action}`;
    const method = action === 'delete' ? 'DELETE' : 'POST';
    setPasswordRequest({
      title: spec.title,
      message: spec.message(user.username),
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      execute: async (password) => {
        setActioningUserId(user.id);
        try {
          return await sendAdminAction(url, method, { currentPassword: password });
        } finally {
          setActioningUserId(null);
        }
      },
      onDone: (res, data) => {
        if (res.ok) {
          setUserActionMessage({ type: 'success', text: data.message || t('Operacja wykonana pomyślnie!') });
          fetchUsers();
          setTimeout(() => setUserActionMessage({ type: '', text: '' }), 5000);
        } else {
          // A response without a JSON body (a proxy's HTML error page) says only its status;
          // it used to be reported as a connection failure, which a real 500 is not.
          setUserActionMessage({
            type: 'error',
            text: data.error || t('Serwer zwrócił błąd ({status}) bez szczegółów.', { status: res.status })
          });
        }
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <AdminPasswordDialog
        request={passwordRequest}
        onCancel={() => setPasswordRequest(null)}
        onDone={(res, data) => {
          const request = passwordRequest;
          setPasswordRequest(null);
          if (request) request.onDone(res, data);
        }}
        onLogout={onLogout}
      />
      
      {/* Sekcja 1: Konfiguracja Systemowa i Integracje */}
      <div className="glass-card">
        <h3 className="card-title">⚙️ Konfiguracja Systemowa i Integracje</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Skonfiguruj ustawienia poczty e-mail (Mailgun), domenę aplikacji oraz dane uwierzytelniające API Oura i Withings.
        </p>

        {configMessage.text && (
          <div className={`alert alert-${configMessage.type}`} style={{ marginBottom: '16px' }}>
            {configMessage.text}
          </div>
        )}

        <form onSubmit={handleSaveConfig}>
          <h4 style={{ color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', marginBottom: '16px' }}>📨 Silnik E-mail (Mailgun)</h4>
          <div className="settings-grid" style={{ marginBottom: '24px' }}>
            <div className="input-group">
              <label className="input-label">Klucz API Mailgun (Private API Key)</label>
              <input
                type="password"
                className="input-field"
                value={config.mailgun_api_key}
                onChange={(e) => setConfig({ ...config, mailgun_api_key: e.target.value })}
                placeholder="key-xxxxxxxxxxxxxxxxxxxxxxxx"
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Domena Mailgun (Domain)</label>
              <input
                type="text"
                className="input-field"
                value={config.mailgun_domain}
                onChange={(e) => setConfig({ ...config, mailgun_domain: e.target.value })}
                placeholder="mg.twojadomena.pl"
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Region API</label>
              <select
                className="input-field"
                value={config.mailgun_region}
                onChange={(e) => setConfig({ ...config, mailgun_region: e.target.value })}
                style={{ background: '#121629', color: '#fff' }}
              >
                <option value="us">Stany Zjednoczone (US / api.mailgun.net)</option>
                <option value="eu">Europa (EU / api.eu.mailgun.net)</option>
              </select>
            </div>

            <div className="input-group">
              <label className="input-label">{t("Nadawca wiadomości (From)")}</label>
              <input
                type="text"
                className="input-field"
                value={config.mailgun_from}
                onChange={(e) => setConfig({ ...config, mailgun_from: e.target.value })}
                placeholder='"Dietetyk AI" <noreply@mg.twojadomena.pl>'
                required
              />
            </div>
          </div>

          <h4 style={{ color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', marginBottom: '16px' }}>🔗 Domena i Adres URL Aplikacji</h4>
          <div className="settings-grid" style={{ marginBottom: '24px' }}>
            <div className="input-group" style={{ gridColumn: 'span 2' }}>
              <label className="input-label">Adres URL Aplikacji (np. https://dietetyk.renacode.com)</label>
              <input
                type="url"
                className="input-field"
                value={config.app_url}
                onChange={(e) => setConfig({ ...config, app_url: e.target.value })}
                placeholder="https://dietetyk.renacode.com"
                required
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                Wymagany do prawidłowego wyznaczania adresów powrotnych (Redirect URI) w przepływach OAuth2.
              </span>
            </div>
          </div>

          <h4 style={{ color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', marginBottom: '16px' }}>{t("🛡️ Bezpieczeństwo i Dwuetapowe Uwierzytelnianie (2FA)")}</h4>
          <div className="settings-grid" style={{ marginBottom: '24px' }}>
            <div className="input-group" style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="checkbox"
                id="force_2fa"
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                checked={config.force_2fa === '1'}
                onChange={(e) => setConfig({ ...config, force_2fa: e.target.checked ? '1' : '0' })}
              />
              <label htmlFor="force_2fa" style={{ color: '#fff', fontSize: '0.9rem', cursor: 'pointer', userSelect: 'none' }}>
                Wymuszaj konfigurację 2FA dla nowych użytkowników po 24 godzinach od rejestracji
              </label>
            </div>
            <div className="input-group" style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
              <input
                type="checkbox"
                id="allow_public_registration"
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                checked={config.allow_public_registration === '1'}
                onChange={(e) => setConfig({ ...config, allow_public_registration: e.target.checked ? '1' : '0' })}
              />
              <label htmlFor="allow_public_registration" style={{ color: '#fff', fontSize: '0.9rem', cursor: 'pointer', userSelect: 'none' }}>
                Zezwalaj na publiczną rejestrację bez zaproszeń
              </label>
            </div>
          </div>

          {/* Google Fit - off by default (backend isGoogleFitEnabled): while the box is
              unticked its routes are 404, the hourly sync skips it and Settings hides the card,
              but stored connections and history are kept. The Google OAuth client below serves
              Google Fit only (Google sign-in was removed on 2026-10-11). */}
          <h4 style={{ color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', marginBottom: '16px' }}>🏃 Google Fit</h4>
          <div className="settings-grid" style={{ marginBottom: '24px' }}>
            <div className="input-group" style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="checkbox"
                id="google_fit_enabled"
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                checked={config.google_fit_enabled === '1'}
                onChange={(e) => setConfig({ ...config, google_fit_enabled: e.target.checked ? '1' : '0' })}
              />
              <label htmlFor="google_fit_enabled" style={{ color: '#fff', fontSize: '0.9rem', cursor: 'pointer', userSelect: 'none' }}>
                {t('Włącz integrację Google Fit (kroki i kalorie) dla użytkowników')}
              </label>
            </div>
            <div className="input-group">
              <label className="input-label">Google Client ID</label>
              <input
                type="text"
                className="input-field"
                value={config.google_client_id}
                onChange={(e) => setConfig({ ...config, google_client_id: e.target.value })}
                placeholder="xxxxxxxx.apps.googleusercontent.com"
              />
            </div>
            <div className="input-group">
              <label className="input-label">Google Client Secret</label>
              <input
                type="password"
                className="input-field"
                value={config.google_client_secret}
                onChange={(e) => setConfig({ ...config, google_client_secret: e.target.value })}
                placeholder="••••••••"
              />
            </div>
            <div className="input-group" style={{ gridColumn: 'span 2' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                Utwórz dane logowania OAuth 2.0 w Google Cloud Console (bezpłatne), włącz Fitness API i ustaw Authorized redirect URI na: <code>{(config.app_url || 'https://twoja-domena.pl')}/api/auth/google-fit/callback</code>
              </span>
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={isSavingConfig} style={{ marginTop: '10px' }}>
            {isSavingConfig ? t('Zapisywanie...') : t('Zapisz konfigurację')}
          </button>
        </form>
      </div>

      {/* Section 2: inviting users */}
      <div className="glass-card">
        <h3 className="card-title">{t("✉️ Zaproś Nowego Użytkownika")}</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Wyślij zaproszenie do utworzenia konta w aplikacji Dietetyk AI. Użytkownik otrzyma wiadomość e-mail z unikalnym tokenem rejestracyjnym.
        </p>

        {inviteMessage.text && (
          <div className={`alert alert-${inviteMessage.type}`} style={{ marginBottom: '16px' }}>
            {inviteMessage.text}
          </div>
        )}

        <form onSubmit={handleInvite} style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="input-group" style={{ flex: '2', minWidth: '250px' }}>
            <label className="input-label">{t("Adres e-mail zapraszanego użytkownika")}</label>
            <input
              type="email"
              className="input-field"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="np. imie@example.com"
              required
            />
          </div>
          
          <div className="input-group" style={{ flex: '1', minWidth: '150px' }}>
            <label className="input-label">{t("Poziom uprawnień (rola)")}</label>
            <select
              className="input-field"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              style={{ background: '#121629', color: '#fff' }}
            >
              <option value="user">{t("Użytkownik (user)")}</option>
              <option value="admin">Administrator (admin)</option>
            </select>
          </div>

          <button type="submit" className="btn-primary" disabled={isInviting} style={{ height: '46px', padding: '0 24px' }}>
            {isInviting ? t('Wysyłanie...') : t('Wyślij zaproszenie')}
          </button>
        </form>
      </div>

      {/* Section 3: user list and management */}
      <div className="glass-card">
        <h3 className="card-title">{t("👥 Zarządzanie Użytkownikami")}</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Lista wszystkich zarejestrowanych oraz oczekujących kont w aplikacji.
        </p>

        {userActionMessage.text && (
          <div className={`alert alert-${userActionMessage.type}`} style={{ marginBottom: '16px' }}>
            {userActionMessage.text}
          </div>
        )}

        {isLoadingUsers ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
            Ładowanie listy użytkowników...
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-glass)', textAlign: 'left' }}>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>ID</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t("Użytkownik")}</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>E-mail</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Rola</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Status</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Weryfikacja 2FA</th>
                  <th style={{ padding: '12px 8px', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'right' }}>Akcje</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', transition: 'background 0.2s' }}>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem' }}>{u.id}</td>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem', fontWeight: 600 }}>
                      {u.username}
                      {u.force_password_change === 1 && (
                        <span style={{ marginLeft: '6px', color: '#fbbf24', fontSize: '0.75rem', fontWeight: 'normal' }}>🔑 Wymuszony reset</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>{u.email || '-'}</td>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem' }}>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        background: u.role === 'admin' ? 'rgba(124, 58, 237, 0.2)' : 'rgba(255,255,255,0.05)',
                        color: u.role === 'admin' ? '#c084fc' : 'var(--text-muted)',
                        border: u.role === 'admin' ? '1px solid rgba(124, 58, 237, 0.3)' : '1px solid rgba(255,255,255,0.05)'
                      }}>
                        {u.role}
                      </span>
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem' }}>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        background: u.status === 'active' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                        color: u.status === 'active' ? '#34d399' : '#fbbf24'
                      }}>
                        {u.status === 'active' ? 'Aktywny' : t('Oczekujący')}
                      </span>
                    </td>
                    <td style={{ padding: '12px 8px', fontSize: '0.9rem' }}>
                      {u.totp_enabled === 1 ? (
                        <span style={{ color: '#34d399', display: 'flex', alignItems: 'center', gap: '4px' }}>{t("🛡️ Włączona")}</span>
                      ) : u.force_2fa ? (
                        <span style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '4px' }}>⚠️ Wymuszone</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>{t("🔓 Wyłączona")}</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                      {u.role !== 'admin' && (
                        <>
                          <button
                            onClick={() => handleUserAction(u, 'force-password-change')}
                            className="btn-secondary"
                            disabled={actioningUserId === u.id}
                            style={{ padding: '4px 8px', fontSize: '0.75rem', border: '1px solid var(--border-glass)', opacity: actioningUserId === u.id ? 0.5 : 1 }}
                          >
                            Wymuś Reset Hasła
                          </button>
                          {u.totp_enabled === 1 ? (
                            <button
                              onClick={() => handleUserAction(u, 'reset-2fa')}
                              className="btn-secondary"
                              disabled={actioningUserId === u.id}
                              style={{ padding: '4px 8px', fontSize: '0.75rem', border: '1px solid var(--border-glass)', background: 'rgba(245, 158, 11, 0.05)', color: '#fbbf24', opacity: actioningUserId === u.id ? 0.5 : 1 }}
                            >
                              Resetuj 2FA
                            </button>
                          ) : (
                            !u.force_2fa && (
                              <button
                                onClick={() => handleUserAction(u, 'force-2fa')}
                                className="btn-secondary"
                                disabled={actioningUserId === u.id}
                                style={{ padding: '4px 8px', fontSize: '0.75rem', border: '1px solid var(--border-glass)', background: 'rgba(56, 189, 248, 0.05)', color: '#38bdf8', opacity: actioningUserId === u.id ? 0.5 : 1 }}
                              >
                                Wymuś 2FA
                              </button>
                            )
                          )}
                          <button
                            onClick={() => handleUserAction(u, 'delete')}
                            className="btn-danger"
                            disabled={actioningUserId === u.id}
                            style={{ padding: '4px 8px', fontSize: '0.75rem', opacity: actioningUserId === u.id ? 0.5 : 1 }}
                          >
                            {t("Usuń")}
                          </button>
                        </>
                      )}
                      {u.role === 'admin' && (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontStyle: 'italic', padding: '4px 0' }}>Brak akcji</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
