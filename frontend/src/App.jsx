import React, { useState, useEffect, useRef } from 'react';
import Dashboard from './components/Dashboard';
import MealLogger from './components/MealLogger';
import ActivityTracker from './components/ActivityTracker';
import Settings from './components/Settings';
import AdminPanel from './components/AdminPanel';
import Trends from './components/Trends';
import { t, setLanguage, getLanguage } from './utils/i18n';

// Helper that returns today's date in YYYY-MM-DD format
function getLocalDateString() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

// Footer - shared by the login screen and the main application. The content (version
// number, links) used to be pasted twice in two different places in this file, so every
// update (the version number, for instance) meant remembering to edit both copies - it was
// easy to update one and leave the other stale.
function AppFooter() {
  const linkStyle = { color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'underline', marginRight: '10px' };
  return (
    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', textAlign: 'center' }}>
      Dietetyk AI v1.1.0 | Powered by <a href="https://renacode.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>RenaCode</a> | <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={linkStyle}>Regulamin</a> | <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={linkStyle}>{t("Polityka Prywatności")}</a> | <a href="/sync.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'underline' }}>{t("Jak zsynchronizować dane")}</a>
    </div>
  );
}

export default function App() {
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [appLang, setAppLang] = useState(getLanguage());
  const [selectedDate, setSelectedDate] = useState(getLocalDateString());
  const [sessionToken, setSessionToken] = useState(localStorage.getItem('diet_session_token') || '');
// NOTE: this used to default to 'admin', which suggested the administrator account name to
// anyone opening the login screen, making brute-force attempts easier (and confirming that
// an "admin" account exists). The login field should start empty.
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loginStep, setLoginStep] = useState('password'); // 'password', 'setup_2fa', 'require_2fa', 'force_password_change'
  const [tempToken, setTempToken] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [newPasswordForced, setNewPasswordForced] = useState('');
  const [confirmPasswordForced, setConfirmPasswordForced] = useState('');

  // Public registration states
  const [isPublicRegister, setIsPublicRegister] = useState(false);
  const [registerUsernameInput, setRegisterUsernameInput] = useState('');
  const [registerPasswordInput, setRegisterPasswordInput] = useState('');
  const [registerConfirmPasswordInput, setRegisterConfirmPasswordInput] = useState('');
  const [registerEmailInput, setRegisterEmailInput] = useState('');
  
  const handlePublicRegister = async (e) => {
    e.preventDefault();
    if (isRegistering) return; // F-S9: prevent a double submit
    setLoginError('');

    if (registerPasswordInput !== registerConfirmPasswordInput) {
      setLoginError(t('Hasła nie są identyczne.'));
      return;
    }

    setIsRegistering(true); // F-S9
    try {
      const res = await fetch('/api/register-public', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: registerUsernameInput,
          password: registerPasswordInput,
          email: registerEmailInput
        })
      });

      const data = await res.json();

      if (res.ok) {
        if (data.token) {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          setIsPublicRegister(false);
          setRegisterUsernameInput('');
          setRegisterPasswordInput('');
          setRegisterConfirmPasswordInput('');
          setRegisterEmailInput('');
        } else {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setIsPublicRegister(false);
          setRegisterUsernameInput('');
          setRegisterPasswordInput('');
          setRegisterConfirmPasswordInput('');
          setRegisterEmailInput('');
        }
      } else {
        setLoginError(data.error || t('Błąd rejestracji.'));
      }
    } catch (err) {
      setLoginError(t('Błąd połączenia z serwerem.'));
    } finally {
      setIsRegistering(false); // F-S9
    }
  };

  // Rejestracja z zaproszenia
  const [registerToken, setRegisterToken] = useState('');
  const [invitedEmail, setInvitedEmail] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [isCheckingToken, setIsCheckingToken] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false); // F-S9: guard against a double registration submit
  const [dashboardData, setDashboardData] = useState({
    summary: {
      target_calories: 2500,
      target_protein: 150,
      target_carbs: 250,
      target_fat: 80,
      bmr: 1800,
      calories_eaten: 0,
      calories_burned_active: 0,
      calories_burned_total: 1800,
      net_calories: -1800,
      eaten_protein: 0,
      eaten_carbs: 0,
      eaten_fat: 0,
      steps: 0,
      workouts: [],
      last_sync: null
    },
    meals: [],
    aiAdvice: t('Ładowanie porad dietetyka...')
  });
// List of the most frequently repeated meals (round 9) - for quickly adding one again in
// MealLogger.jsx without another AI request. Independent of selectedDate (computed from the
// whole history), so it is kept separately from dashboardData.
  const [frequentMeals, setFrequentMeals] = useState([]);
// No default value or placeholder - the real token comes from the backend (fetchSyncToken).
// An empty string signals to components (Settings, for example) that the token is still
// loading, rather than building a webhook URL with a bogus token.
  const [syncToken, setSyncToken] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [userProfile, setUserProfile] = useState({ username: '', avatar_base64: '' });
// A "is this still the current request" flag - see the comment in the useEffect below
// (protection against a race condition when the date or session changes rapidly).
  const isCurrentRequestRef = useRef(true);

// The set of meal IDs that already have a delete request in flight - see the comment in
// handleDeleteMeal (protection against a double click sending a duplicate DELETE).
  const deletingMealIdsRef = useRef(new Set());

// Fetch the data on load and whenever the date or the session changes
  useEffect(() => {
// Race-condition guard: if the user changes the date quickly, the response to the previous
// (already stale) dashboard request could arrive later than the response for the new date
// and overwrite it with the wrong data. isCurrent, set to false in the effect's cleanup, is
// checked in fetchDashboardData before setDashboardData so a late response is ignored.
    isCurrentRequestRef.current = true;
    if (sessionToken) {
      fetchDashboardData();
      fetchSyncToken();
      fetchUserProfile();
    }
    return () => {
      isCurrentRequestRef.current = false;
    };
  }, [selectedDate, sessionToken]);

// Frequent meals (round 9) - independent of selectedDate (computed from the whole history),
// so they are fetched only when the session changes, not on every date change.
  useEffect(() => {
    if (sessionToken) {
      fetchFrequentMeals();
    }
  }, [sessionToken]);

// Automatically refresh the data from the database every hour (matching the backend's
// hourly Oura/Withings sync), so an open dashboard shows the latest data without a manual
// page reload.
  useEffect(() => {
    if (!sessionToken) return;
    const intervalId = setInterval(() => {
      fetchDashboardData();
    }, 60 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [sessionToken, selectedDate]);

// Receiving the token after returning from Google sign-in. This works independently of
// sessionToken, because for a new or signed-out user this token is what establishes the session.
  //
  // Tokeny (google_token/google_temp_token) backend przekazuje w FRAGMENCIE URL (#),
// not in the query string - the fragment is never sent to the server with the page request,
// so a live session token does not end up in the server logs (morgan) or in the browser
// history/Referer. google_error is not a secret, so it still arrives through an ordinary
// query string.
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const params = new URLSearchParams(window.location.search);
    const googleToken = hashParams.get('google_token');
    const googleTempToken = hashParams.get('google_temp_token');
    const googleError = params.get('google_error');

    if (googleToken) {
      setSessionToken(googleToken);
      localStorage.setItem('diet_session_token', googleToken);
      window.history.replaceState({}, document.title, '/');
    } else if (googleTempToken) {
      setTempToken(googleTempToken);
      setLoginStep('require_2fa');
      window.history.replaceState({}, document.title, '/');
    } else if (googleError) {
      let msg = t('Nie udało się zalogować przez Google.');
      if (googleError === 'account_inactive') {
        msg = t('To konto jest nieaktywne. Skontaktuj się z administratorem.');
      } else if (googleError === 'email_exists') {
        msg = t('Konto z tym adresem e-mail już istnieje. Zaloguj się hasłem i połącz konto Google w Ustawieniach.');
      } else if (googleError === 'csrf_failed') {
        msg = t('Błąd weryfikacji żądania (CSRF). Spróbuj ponownie.');
      }
      setLoginError(msg);
      window.history.replaceState({}, document.title, '/');
    }
  }, []);

  useEffect(() => {
    if (sessionToken) {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      const successParam = params.get('success');
      const errorParam = params.get('error');
      const googleLinkParam = params.get('google_link');
      const googleLinkErrorParam = params.get('google_link_error');

      if (tabParam) {
        setCurrentTab(tabParam);
      }

// Return from the flow that links an account with Google (Settings -> "Connect with Google").
// These are separate parameters from `success`/`error` above, because this is not an
// integration with a data source (Oura/Withings) but a link to a sign-in method.
      if (googleLinkParam === 'success') {
        setSuccessMessage(t('Pomyślnie połączono konto z Google!'));
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/?tab=settings');
        fetchUserProfile();
      } else if (googleLinkErrorParam) {
        let msg = t('Nie udało się połączyć konta z Google.');
        if (googleLinkErrorParam === 'already_linked') {
          msg = t('To konto Google jest już połączone z innym użytkownikiem.');
        }
        setErrorMessage(msg);
        setTimeout(() => setErrorMessage(''), 6000);
        window.history.replaceState({}, document.title, '/?tab=settings');
      }

      if (successParam === 'oura') {
        setSuccessMessage(t('Pomyślnie zintegrowano z Oura Ring!'));
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
        fetchUserProfile();
        fetchDashboardData();
      } else if (successParam === 'withings') {
        setSuccessMessage(t('Pomyślnie zintegrowano z Withings!'));
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
        fetchUserProfile();
        fetchDashboardData();
      } else if (successParam === 'google_fit') {
        setSuccessMessage(t('Pomyślnie zintegrowano z Google Fit!'));
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
        fetchUserProfile();
        fetchDashboardData();
      } else if (errorParam) {
        let msg = t('Wystąpił błąd podczas integracji.');
        if (errorParam === 'oura_auth_failed' || errorParam === 'oura_exchange_failed') {
          msg = t('Nie udało się połączyć z Oura Ring. Sprawdź poświadczenia w panelu admina.');
        } else if (errorParam === 'google_fit_auth_failed' || errorParam === 'google_fit_exchange_failed') {
          msg = t('Nie udało się połączyć z Google Fit. Sprawdź konfigurację Google w panelu admina.');
        } else if (errorParam === 'withings_auth_failed' || errorParam === 'withings_exchange_failed') {
          msg = t('Nie udało się połączyć z Withings. Sprawdź poświadczenia w panelu admina.');
        }
        setErrorMessage(msg);
        setTimeout(() => setErrorMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
      }
    }
  }, [sessionToken]);

  useEffect(() => {
    if (window.location.pathname === '/register') {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) {
        setRegisterToken(token);
        checkInvitationStatus(token);
      } else {
        setRegisterError('Brak tokenu zaproszenia w adresie URL.');
      }
    }
  }, []);

  const checkInvitationStatus = async (token) => {
    setIsCheckingToken(true);
    try {
      const res = await fetch(`/api/invitation-status?token=${token}`);
      if (res.ok) {
        const data = await res.json();
        setInvitedEmail(data.email);
      } else {
        const data = await res.json();
        setRegisterError(data.error || t('Nieprawidłowy lub wygasły token zaproszenia.'));
      }
    } catch (err) {
      setRegisterError(t('Błąd połączenia z serwerem.'));
    } finally {
      setIsCheckingToken(false);
    }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    if (isRegistering) return; // F-S9: prevent a double submit
    setRegisterError('');

    if (registerPassword !== registerConfirmPassword) {
      setRegisterError(t('Hasła nie są identyczne.'));
      return;
    }

    setIsRegistering(true); // F-S9
    try {
      const res = await fetch('/api/register-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token: registerToken,
          username: registerUsername,
          password: registerPassword
        })
      });

      const data = await res.json();

      if (res.ok) {
        if (data.token) {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          window.history.replaceState({}, document.title, '/');
          setRegisterToken('');
        } else {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          window.history.replaceState({}, document.title, '/');
          setRegisterToken('');
        }
      } else {
        setRegisterError(data.error || t('Błąd rejestracji.'));
      }
    } catch (err) {
      setRegisterError(t('Błąd połączenia z serwerem.'));
    } finally {
      setIsRegistering(false); // F-S9
    }
  };

  const fetchUserProfile = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch('/api/user/profile', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setUserProfile(data);
        if (data.language) {
          setAppLang(data.language);
          setLanguage(data.language);
        }
      } else if (res.status === 401) {
// Previously there was no 401 handling here (unlike fetchSyncToken/fetchDashboardData) -
// the session expired "silently": userProfile stayed in its initial or stale state, with no
// sign-out and no information whatsoever for the user about the cause.
        handleLogout();
        setErrorMessage(t('Sesja wygasła. Zaloguj się ponownie.'));
      } else {
        setErrorMessage(t('Nie udało się pobrać profilu użytkownika.'));
      }
    } catch (err) {
      console.error('Failed to fetch the profile:', err);
      setErrorMessage(t('Błąd połączenia z serwerem podczas pobierania profilu.'));
    }
  };

  const handleLanguageChange = async (newLang) => {
    setAppLang(newLang);
    setLanguage(newLang);
    if (sessionToken) {
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ language: newLang })
        });
        fetchUserProfile();
      } catch (err) {
        console.error(err);
      }
    }
  };

  const fetchDashboardData = async () => {
    if (!sessionToken) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const res = await fetch(`/api/dashboard?date=${selectedDate}`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
// If the date or session changed in the meantime (a new effect has already started and set
// the flag to false in its cleanup), we ignore this late response so that newer, already
// displayed data is not overwritten with older data.
        if (!isCurrentRequestRef.current) return;
        setDashboardData({
          summary: data.summary,
          meals: data.meals,
          aiAdvice: data.aiAdvice
        });
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage(t('Sesja wygasła. Zaloguj się ponownie.'));
        } else {
          setErrorMessage(t('Nie udało się pobrać danych z serwera backend.'));
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMessage(t('Błąd połączenia z serwerem. Upewnij się, że backend działa.'));
    } finally {
// FIX (audit round 17): `setIsLoading(false)` previously ran regardless of
// `isCurrentRequestRef.current` - a late response from an already stale request (after a
// rapid date change, for instance) could switch off the loading spinner of a newer request
// that was still in flight. Same condition as for `setDashboardData` above.
      if (isCurrentRequestRef.current) {
        setIsLoading(false);
      }
    }
  };

  const fetchFrequentMeals = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch('/api/meals/frequent', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        setFrequentMeals(await res.json());
      }
    } catch (err) {
      console.error('Failed to fetch the frequent meals:', err);
    }
  };

  const fetchSyncToken = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch('/api/settings', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sync_token) {
          setSyncToken(data.sync_token);
        }
      } else if (res.status === 401) {
        handleLogout();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddMeal = async (rawText, imageBase64) => {
    setIsAnalyzing(true);
    setErrorMessage('');
// The returned boolean (success/failure) - MealLogger.jsx waits for it so it can show the
// "Posiłek zapisany!" message ONLY after the save genuinely succeeded, rather than optimistically
// right after the click (previously the form gave no confirmation beyond a new entry in the
// list, which could easily be lost in a long list of that day's meals).
    let success = false;
    try {
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          rawText,
          date: selectedDate,
          image: imageBase64
        })
      });

      if (res.ok) {
// The meal was added successfully - reload the dashboard
        await fetchDashboardData();
// The new meal may have changed the "frequent meals" ranking (reaching the 2-repetition
// threshold, say) - refresh in the background without blocking the returned success value.
        fetchFrequentMeals();
        success = true;
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage(t('Sesja wygasła. Zaloguj się ponownie.'));
        } else {
          let errorMsg = t('Błąd podczas analizowania posiłku.');
          try {
            const errData = await res.json();
            errorMsg = errData.error || errorMsg;
          } catch (e) {
            errorMsg = `Serwer zwrócił kod błędu ${res.status} (${res.statusText || t('Błąd połączenia/Limit czasu')}).`;
          }
          setErrorMessage(errorMsg);
        }
      }
    } catch (err) {
      setErrorMessage(t('Nie udało się połączyć z serwerem w celu analizy posiłku.'));
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
    return success;
  };

// Quickly re-add a previously saved meal (the "frequent meals" chip in MealLogger.jsx) -
// calls /api/meals/repeat, which copies the nutrition values from the original entry WITHOUT
// invoking the AI again (unlike handleAddMeal above), so it is instant and does not consume
// the Gemini request quota.
  const handleRepeatMeal = async (mealId) => {
    setIsAnalyzing(true);
    setErrorMessage('');
    let success = false;
    try {
      const res = await fetch('/api/meals/repeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ mealId, date: selectedDate })
      });

      if (res.ok) {
        await fetchDashboardData();
        fetchFrequentMeals();
        success = true;
      } else if (res.status === 401) {
        handleLogout();
        setErrorMessage(t('Sesja wygasła. Zaloguj się ponownie.'));
      } else {
        let errorMsg = t('Błąd podczas powtarzania posiłku.');
        try {
          const errData = await res.json();
          errorMsg = errData.error || errorMsg;
        } catch (e) {
          // no error body in the response - the default message stands
        }
        setErrorMessage(errorMsg);
      }
    } catch (err) {
      setErrorMessage(t('Nie udało się połączyć z serwerem w celu powtórzenia posiłku.'));
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
    return success;
  };

  const handleDeleteMeal = async (id) => {
// Duplicate guard: a rapid double click (or a hung confirm() followed by another click)
// used to send two parallel DELETE requests for the same meal - the second returned a 404
// (the meal was already deleted), showing the user a pointless error message even though
// the deletion had succeeded.
    if (deletingMealIdsRef.current.has(id)) return;

    if (!confirm(t('Czy na pewno chcesz usunąć ten posiłek?'))) return;

    deletingMealIdsRef.current.add(id);
    try {
      const res = await fetch(`/api/meals/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        await fetchDashboardData();
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage(t('Sesja wygasła. Zaloguj się ponownie.'));
        } else {
          setErrorMessage(t('Nie udało się usunąć posiłku.'));
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMessage(t('Problem z połączeniem przy usuwaniu posiłku.'));
    } finally {
      deletingMealIdsRef.current.delete(id);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!passwordInput.trim()) return;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: usernameInput, password: passwordInput })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'require_2fa') {
          setTempToken(data.tempToken);
          setLoginStep('require_2fa');
          setTotpCode('');
        } else if (data.status === 'setup_2fa') {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setTotpCode('');
        } else if (data.status === 'force_password_change') {
          setTempToken(data.tempToken);
          setLoginStep('force_password_change');
          setNewPasswordForced('');
          setConfirmPasswordForced('');
        } else {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
        }
      } else {
        const errData = await res.json();
        setLoginError(errData.error || t('Nieprawidłowe dane logowania.'));
      }
    } catch (err) {
      setLoginError(t('Błąd połączenia z serwerem.'));
      console.error(err);
    }
  };

  const handleForcePasswordChange = async (e) => {
    e.preventDefault();
    setLoginError('');

    if (newPasswordForced !== confirmPasswordForced) {
      setLoginError(t('Hasła nie są identyczne.'));
      return;
    }

    try {
      const res = await fetch('/api/change-password-forced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, newPassword: newPasswordForced })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'require_2fa') {
          setTempToken(data.tempToken);
          setLoginStep('require_2fa');
          setTotpCode('');
        } else if (data.status === 'setup_2fa') {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setTotpCode('');
        } else {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          setLoginStep('password');
          setPasswordInput('');
          setNewPasswordForced('');
          setConfirmPasswordForced('');
        }
      } else {
        const errData = await res.json();
        setLoginError(errData.error || t('Błąd podczas zmiany hasła.'));
      }
    } catch (err) {
      setLoginError(t('Błąd połączenia z serwerem.'));
      console.error(err);
    }
  };

  const handleVerifySetup2FA = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!totpCode.trim() || !tempToken) return;

    try {
      const res = await fetch('/api/verify-2fa-setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, code: totpCode })
      });

      if (res.ok) {
        const data = await res.json();
        setSessionToken(data.token);
        localStorage.setItem('diet_session_token', data.token);
        setLoginStep('password');
        setPasswordInput('');
        setTotpCode('');
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Niepoprawny kod 2FA.');
      }
    } catch (err) {
      setLoginError(t('Błąd połączenia z serwerem.'));
    }
  };

  const handleLogin2FA = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!totpCode.trim() || !tempToken) return;

    try {
      const res = await fetch('/api/login-2fa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, code: totpCode })
      });

      if (res.ok) {
        const data = await res.json();
        setSessionToken(data.token);
        localStorage.setItem('diet_session_token', data.token);
        setLoginStep('password');
        setPasswordInput('');
        setTotpCode('');
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Niepoprawny kod 2FA.');
      }
    } catch (err) {
      setLoginError(t('Błąd połączenia z serwerem.'));
    }
  };

  const handleLogout = async () => {
    if (sessionToken) {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        });
      } catch (e) {
        console.error(e);
      }
    }
    setSessionToken('');
    localStorage.removeItem('diet_session_token');
    setLoginStep('password');
    setUserProfile({ username: '', avatar_base64: '' });
// FIX (audit round 17): syncToken (the manual-sync token, see Settings) was not reset on
// sign-out, unlike dashboardData/userProfile - it could stay visible to the next user
// signing in on the same device or tab.
    setSyncToken('');
    setDashboardData({
      summary: {
        target_calories: 2500,
        target_protein: 150,
        target_carbs: 250,
        target_fat: 80,
        bmr: 1800,
        calories_eaten: 0,
        calories_burned_active: 0,
        calories_burned_total: 1800,
        net_calories: -1800,
        eaten_protein: 0,
        eaten_carbs: 0,
        eaten_fat: 0,
        steps: 0,
        workouts: [],
        last_sync: null
      },
      meals: [],
      aiAdvice: t('Zaloguj się, aby zobaczyć porady.')
    });
  };

  if (registerToken) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh', padding: '16px', position: 'relative', zIndex: 10 }}>
        <div className="glass-card" style={{ width: '100%', maxWidth: '400px', textAlign: 'center' }}>
          <span style={{ fontSize: '3rem' }}>🥗</span>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '10px' }}>{t("Utwórz Konto")}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px' }}>
            Dokończ rejestrację w aplikacji Dietetyk AI.
          </p>

          {registerError && (
            <div className="alert alert-error" style={{ marginBottom: '16px' }}>
              ⚠️ {registerError}
            </div>
          )}

          {isCheckingToken ? (
            <div style={{ color: 'var(--text-muted)' }}>Weryfikacja tokenu zaproszenia...</div>
          ) : invitedEmail ? (
            <form onSubmit={handleRegisterSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <div className="input-group">
                <label className="input-label">Zaproszony e-mail</label>
                <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', fontSize: '0.95rem' }}>
                  {invitedEmail}
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">{t("Nazwa użytkownika (login)")}</label>
                <input
                  type="text"
                  className="input-field"
                  value={registerUsername}
                  onChange={(e) => setRegisterUsername(e.target.value)}
                  placeholder={t("Wybierz nazwę użytkownika...")}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t("Hasło dostępowe")}</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  placeholder={t("Wpisz silne hasło...")}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t("Powtórz hasło")}</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerConfirmPassword}
                  onChange={(e) => setRegisterConfirmPassword(e.target.value)}
                  placeholder={t("Powtórz hasło...")}
                  required
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px', marginTop: '8px' }} disabled={isRegistering}>
                {isRegistering ? 'Rejestrowanie…' : t('Zarejestruj się i przejdź do 2FA')}
              </button>
            </form>
          ) : (
            <div>
              <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>{t("Link jest nieprawidłowy, wygasł lub został już użyty.")}</p>
              <button className="btn-primary" onClick={() => { setRegisterToken(''); window.history.replaceState({}, document.title, '/'); }} style={{ width: '100%' }}>
                Przejdź do logowania
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!sessionToken) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '90vh', padding: '16px', position: 'relative', zIndex: 10 }}>
        <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 20 }}>
          <button 
            onClick={() => handleLanguageChange('pl')} 
            style={{ 
              background: appLang === 'pl' ? 'var(--accent-glow)' : 'transparent', 
              border: '1px solid var(--border-glass)', 
              color: 'var(--text-main)', 
              padding: '6px 12px', 
              borderRadius: '6px', 
              cursor: 'pointer',
              fontWeight: appLang === 'pl' ? 'bold' : 'normal'
            }}
          >🇵🇱 PL</button>
          <button 
            onClick={() => handleLanguageChange('en')} 
            style={{ 
              background: appLang === 'en' ? 'var(--accent-glow)' : 'transparent', 
              border: '1px solid var(--border-glass)', 
              color: 'var(--text-main)', 
              padding: '6px 12px', 
              borderRadius: '6px', 
              cursor: 'pointer',
              fontWeight: appLang === 'en' ? 'bold' : 'normal'
            }}
          >🇬🇧 EN</button>
        </div>
        <div className="glass-card" style={{ width: '100%', maxWidth: '400px', textAlign: 'center', marginBottom: '20px' }}>
          <span style={{ fontSize: '3rem' }}>🥗</span>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '10px' }}>Dietetyk AI</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px' }}>
            {t("Twój osobisty asystent żywieniowy.")}
          </p>

          {loginError && (
            <div className="alert alert-error" style={{ marginBottom: '16px' }}>
              ⚠️ {loginError}
            </div>
          )}

          {isPublicRegister ? (
            <form onSubmit={handlePublicRegister} style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <div className="input-group">
                <label className="input-label">{t("Nazwa użytkownika")}</label>
                <input
                  type="text"
                  className="input-field"
                  value={registerUsernameInput}
                  onChange={(e) => setRegisterUsernameInput(e.target.value)}
                  placeholder={t("Wybierz nazwę...")}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">E-mail (opcjonalnie)</label>
                <input
                  type="email"
                  className="input-field"
                  value={registerEmailInput}
                  onChange={(e) => setRegisterEmailInput(e.target.value)}
                  placeholder="np. jan.kowalski@example.com"
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t("Hasło")}</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerPasswordInput}
                  onChange={(e) => setRegisterPasswordInput(e.target.value)}
                  placeholder={t("Wpisz silne hasło...")}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t("Powtórz hasło")}</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerConfirmPasswordInput}
                  onChange={(e) => setRegisterConfirmPasswordInput(e.target.value)}
                  placeholder={t("Powtórz hasło...")}
                  required
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px' }} disabled={isRegistering}>
                {isRegistering ? 'Rejestrowanie…' : t('Zarejestruj się')}
              </button>

              <button 
                type="button" 
                className="btn-secondary" 
                onClick={() => { setIsPublicRegister(false); setLoginError(''); }}
                style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center', marginTop: '4px' }}
              >
                Masz już konto? Zaloguj się
              </button>
            </form>
          ) : (
            <>
              {loginStep === 'password' && (
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">{t("Nazwa użytkownika lub e-mail")}</label>
                    <input
                      type="text"
                      className="input-field"
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value)}
                      placeholder="Wpisz login lub e-mail..."
                      style={{ width: '100%' }}
                      required
                    />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">{t("Hasło dostępowe")}</label>
                    <input
                      type="password"
                      className="input-field"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder={t("Wpisz hasło...")}
                      autoFocus
                      required
                    />
                  </div>

                  <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px' }}>
                    Dalej
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0' }}>
                    <div style={{ flex: 1, height: '1px', background: 'var(--border-glass)' }} />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>lub</span>
                    <div style={{ flex: 1, height: '1px', background: 'var(--border-glass)' }} />
                  </div>

                  <button
                    type="button"
                    onClick={() => { window.location.href = '/api/auth/google'; }}
                    style={{ width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', background: '#fff', color: '#1f1f1f', border: '1px solid var(--border-glass)', borderRadius: '8px', fontWeight: 500, fontSize: '0.9rem', cursor: 'pointer' }}
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>
                      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"/>
                    </svg>
                    Zaloguj się przez Google
                  </button>

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => { setIsPublicRegister(true); setLoginError(''); }}
                    style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center', marginTop: '4px' }}
                  >
                    Nie masz konta? Zarejestruj się
                  </button>
                </form>
              )}

              {loginStep === 'setup_2fa' && (
                <form onSubmit={handleVerifySetup2FA} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>🔐 Skonfiguruj 2FA</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Zeskanuj poniższy kod QR w aplikacji **Google Authenticator** lub **Authy**, a następnie wpisz wygenerowany 6-cyfrowy kod.
                  </p>
                  
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                    <img src={qrCode} alt="2FA QR" style={{ borderRadius: '12px', border: '1px solid var(--border-glass)', padding: '6px', background: '#fff', width: '180px', height: '180px' }} />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">6-cyfrowy kod weryfikacyjny</label>
                    <input
                      type="text"
                      pattern="[0-9]*"
                      inputMode="numeric"
                      maxLength="6"
                      className="input-field"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000 000"
                      autoFocus
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      Wróć
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      Aktywuj i Zaloguj
                    </button>
                  </div>
                </form>
              )}

              {loginStep === 'require_2fa' && (
                <form onSubmit={handleLogin2FA} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>🔐 Dwuetapowa weryfikacja</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Wprowadź 6-cyfrowy kod wygenerowany przez aplikację autoryzacyjną na Twoim telefonie.
                  </p>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Kod weryfikacyjny 2FA</label>
                    <input
                      type="text"
                      pattern="[0-9]*"
                      inputMode="numeric"
                      maxLength="6"
                      className="input-field"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000 000"
                      autoFocus
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      Wróć
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      {t("Zaloguj się")}
                    </button>
                  </div>
                </form>
              )}

              {loginStep === 'force_password_change' && (
                <form onSubmit={handleForcePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>{t("🔑 Wymuszona zmiana hasła")}</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Administrator wymusił zmianę hasła dla Twojego konta. Wprowadź nowe hasło poniżej.
                  </p>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">{t("Nowe hasło")}</label>
                    <input
                      type="password"
                      className="input-field"
                      value={newPasswordForced}
                      onChange={(e) => setNewPasswordForced(e.target.value)}
                      placeholder={t("Wpisz nowe hasło...")}
                      autoFocus
                      required
                    />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">{t("Powtórz nowe hasło")}</label>
                    <input
                      type="password"
                      className="input-field"
                      value={confirmPasswordForced}
                      onChange={(e) => setConfirmPasswordForced(e.target.value)}
                      placeholder={t("Powtórz nowe hasło...")}
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      {t("Anuluj")}
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      Zapisz i zaloguj
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <AppFooter />
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div className="logo-container">
            <span className="logo-icon">🥗</span>
            <div>
              <span className="logo-text">Dietetyk AI</span>
              <span className="logo-badge">Gemini AI</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '20px', border: '1px solid var(--border-glass)' }}>
            {userProfile.avatar_base64 ? (
              <img src={userProfile.avatar_base64} alt="Avatar" style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--primary-color), var(--primary-hover))', color: '#fff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', fontSize: '0.8rem' }}>
                {userProfile.username ? userProfile.username[0].toUpperCase() : '?'}
              </div>
            )}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>{userProfile.username}</span>
          </div>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${currentTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentTab('dashboard')}
          >
            {t("Dashboard")}
          </button>
          <button
            className={`nav-tab ${currentTab === 'meals' ? 'active' : ''}`}
            onClick={() => setCurrentTab('meals')}
          >
            {t("Kalkulator Posiłków")}
          </button>
          <button
            className={`nav-tab ${currentTab === 'trends' ? 'active' : ''}`}
            onClick={() => setCurrentTab('trends')}
          >
            {t("Trendy")}
          </button>
          <button
            className={`nav-tab ${currentTab === 'activity' ? 'active' : ''}`}
            onClick={() => setCurrentTab('activity')}
          >
            {t("Aktywność")}
          </button>
          <button
            className={`nav-tab ${currentTab === 'setup' ? 'active' : ''}`}
            onClick={() => setCurrentTab('setup')}
          >
            {t("Ustawienia")}
          </button>
          {userProfile.role === 'admin' && (
            <button
              className={`nav-tab ${currentTab === 'admin' ? 'active' : ''}`}
              onClick={() => setCurrentTab('admin')}
            >
              {t("Panel Admina")}
            </button>
          )}
          <button
            className="nav-tab"
            onClick={handleLogout}
            style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.15)' }}
          >
            {t("Wyloguj")}
          </button>
        </nav>
      </header>

      {/* Global controls: date and errors */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div className="date-selector">
          <span>{t("Dzień:")}</span>
          <input
            type="date"
            className="date-input"
            aria-label={t("Wybierz dzień")}
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
        </div>

        {isLoading && <div style={{ fontSize: '0.9rem', color: 'var(--text-dim)' }}>Aktualizowanie danych...</div>}
      </div>

      {errorMessage && (
        <div className="alert alert-error">
          ⚠️ {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="alert alert-success">
          ✅ {successMessage}
        </div>
      )}

      {/* Render the active tab */}
      <main>
        {currentTab === 'dashboard' && (
          <div className="premium-tab-content">
            <Dashboard summary={dashboardData.summary} aiAdvice={dashboardData.aiAdvice} sessionToken={sessionToken} selectedDate={selectedDate} onNavigate={setCurrentTab} onRefresh={fetchDashboardData} onLogout={handleLogout} userProfile={userProfile} language={appLang} />
          </div>
        )}

        {currentTab === 'meals' && (
          <div className="premium-tab-content">
            <MealLogger
              meals={dashboardData.meals}
              onAddMeal={handleAddMeal}
              onDeleteMeal={handleDeleteMeal}
              isAnalyzing={isAnalyzing}
              frequentMeals={frequentMeals}
              onRepeatMeal={handleRepeatMeal}
              language={appLang}
            />
          </div>
        )}

        {currentTab === 'activity' && (
          <div className="premium-tab-content">
            <ActivityTracker summary={dashboardData.summary} userProfile={userProfile} sessionToken={sessionToken} onGoalsUpdate={fetchDashboardData} onLogout={handleLogout} language={appLang} />
          </div>
        )}

        {currentTab === 'trends' && (
          <div className="premium-tab-content">
            <Trends selectedDate={selectedDate} sessionToken={sessionToken} onLogout={handleLogout} language={appLang} />
          </div>
        )}

        {currentTab === 'setup' && (
          <div className="premium-tab-content">
            <Settings syncToken={syncToken} sessionToken={sessionToken} userProfile={userProfile} onProfileUpdate={() => { fetchUserProfile(); fetchSyncToken(); fetchDashboardData(); }} onLogout={handleLogout} onLanguageChange={handleLanguageChange} />
          </div>
        )}

        {currentTab === 'admin' && userProfile.role === 'admin' && (
          <div className="premium-tab-content">
            <AdminPanel sessionToken={sessionToken} onLogout={handleLogout} />
          </div>
        )}
      </main>

      {/* Footer inside the application */}
      <footer>
        <div style={{ textAlign: 'center', marginTop: '40px', padding: '20px 0', borderTop: '1px solid var(--border-glass)' }}>
          <AppFooter />
        </div>
      </footer>
    </div>
  );
}
