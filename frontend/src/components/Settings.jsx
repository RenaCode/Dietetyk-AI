import React, { useState, useEffect } from 'react';
import { t } from '../utils/i18n';

export default function Settings({ syncToken, sessionToken, userProfile = { username: '', avatar_base64: '' }, onProfileUpdate, onLogout, onLanguageChange }) {
  const [settings, setSettings] = useState({
    target_calories: 2500,
    target_protein: 150,
    target_carbs: 250,
    target_fat: 80,
    bmr: 1800,
    target_water_ml: 2500,
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

  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  // Zwijalne pola poświadczeń integracji (UX: runda 7) - gdy integracja jest już
  // połączona, pola Client ID/Secret i instrukcje nie muszą rzucać się w oczy,
  // więc startują zwinięte za "Zaawansowane". Gdy NIE jest połączona, muszą być
  // od razu widoczne, bo użytkownik musi je wypełnić, żeby połączyć.
  const [isOuraAdvancedOpen, setIsOuraAdvancedOpen] = useState(!userProfile.has_oura);
  const [isWithingsAdvancedOpen, setIsWithingsAdvancedOpen] = useState(!userProfile.has_withings);
  const [isAppleHealthInstructionsOpen, setIsAppleHealthInstructionsOpen] = useState(false);

  // Stan avatara i profilu
  const [avatarMessage, setAvatarMessage] = useState({ type: '', text: '' });
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  // Stan zmiany hasła
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState({ type: '', text: '' });
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [is2faOpen, setIs2faOpen] = useState(false);
  const [isDietGoalsOpen, setIsDietGoalsOpen] = useState(false);

  // Lokalizacja użytkownika dla kontekstu pogody wstrzykiwanego do promptów AI
  // (patrz backend/utils/weatherContext.js) - domyślnie serwer używa stałej
  // lokalizacji (Trzebnica), ale użytkownik może ją nadpisać wyszukując swoją
  // miejscowość. Wynik wyszukiwania (weather_lat/weather_lon/weather_location_label)
  // trafia do zwykłego stanu `settings` i jest zapisywany razem z resztą
  // ustawień przez istniejący handleSave/POST /api/settings - bez osobnego
  // zapisu, żeby nie dublować logiki.
  const [locationQuery, setLocationQuery] = useState('');
  const [locationResults, setLocationResults] = useState([]);
  const [isSearchingLocation, setIsSearchingLocation] = useState(false);
  const [locationMessage, setLocationMessage] = useState({ type: '', text: '' });

  // Stan eksportu danych i usuwania konta (RODO/GDPR)
  const [isExportingData, setIsExportingData] = useState(false);
  const [exportMessage, setExportMessage] = useState({ type: '', text: '' });
  // Stan eksportu raportu PDF dla lekarza/dietetyka - niezależny od eksportu JSON
  // powyżej (inny endpoint, inny format pliku, własny okres raportu).
  const [pdfReportDays, setPdfReportDays] = useState(30);
  const [isExportingPdfReport, setIsExportingPdfReport] = useState(false);
  const [pdfExportMessage, setPdfExportMessage] = useState({ type: '', text: '' });
  // Stan udostępniania raportu linkiem (read-only) - rozszerzenie eksportu PDF
  // powyżej o wariant "wyślij link" zamiast "pobierz i wyślij plik samodzielnie".
  // `shareLinkDays` to okres danych w samym raporcie (jak pdfReportDays), niezależny
  // od `shareValidityKey` - czyli tego, jak długo sam LINK będzie działał.
  const [shareLinkDays, setShareLinkDays] = useState(30);
  const [shareValidityKey, setShareValidityKey] = useState('7d');
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [shareLinkMessage, setShareLinkMessage] = useState({ type: '', text: '' });
  // Ostatnio wygenerowany link - pokazywany tylko raz, do skopiowania (backend nie
  // zwraca tokenu przy liście udostępnień, patrz listSharesForUser w sharedReports.js).
  const [lastCreatedShareUrl, setLastCreatedShareUrl] = useState('');
  const [sharedReports, setSharedReports] = useState([]);
  const [isLoadingSharedReports, setIsLoadingSharedReports] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState({ type: '', text: '' });

  // Stan e-mail, raportów tygodniowych i tokenu synchronizacji
  const [emailInput, setEmailInput] = useState(userProfile.email || '');
  // Imię/nazwisko - AI dietetyk używa imienia, by zwracać się do użytkownika po imieniu
  const [firstNameInput, setFirstNameInput] = useState(userProfile.first_name || '');
  const [lastNameInput, setLastNameInput] = useState(userProfile.last_name || '');
  // Rok urodzenia - opcjonalny, używany przez backend do wyliczenia realnego
  // maksymalnego tętna (220 - wiek) w strefach kardio na Dashboardzie. Trzymany
  // jako string w stanie inputu (pole number w JSX i tak je sparsuje przy zapisie).
  const [birthYearInput, setBirthYearInput] = useState(userProfile.birth_year || '');
  // Cel sylwetki (opis tekstowy) - AI dietetyk bierze go pod uwagę przy generowaniu
  // porad (dashboard.js) i odpowiedzi czatu (chat.js). Zdjęcie celu sylwetki ma
  // własny, niezależny stan/upload poniżej - mirror wzorca avatara.
  const [bodyGoalTextInput, setBodyGoalTextInput] = useState(userProfile.body_goal_text || '');
  const [bodyGoalPhotoMessage, setBodyGoalPhotoMessage] = useState({ type: '', text: '' });
  const [isUploadingBodyGoalPhoto, setIsUploadingBodyGoalPhoto] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [isRegeneratingToken, setIsRegeneratingToken] = useState(false);
  const [weeklySummaryEnabled, setWeeklySummaryEnabled] = useState(userProfile.weekly_summary_enabled || false);
  const [weeklySummaryDay, setWeeklySummaryDay] = useState(userProfile.weekly_summary_day || 1);
  const [weeklySummaryTime, setWeeklySummaryTime] = useState(userProfile.weekly_summary_time || '18:00');
  const [monthlySummaryEnabled, setMonthlySummaryEnabled] = useState(userProfile.monthly_summary_enabled || false);
  const [monthlySummaryDay, setMonthlySummaryDay] = useState(userProfile.monthly_summary_day || 1);
  const [monthlySummaryTime, setMonthlySummaryTime] = useState(userProfile.monthly_summary_time || '09:00');
  const [languageInput, setLanguageInput] = useState(userProfile.language || 'pl');

  // Stan zarządzania 2FA
  const [isSettingUp2fa, setIsSettingUp2fa] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState({ qrCode: '', secret: '', tempToken: '' });
  const [totpSetupCode, setTotpSetupCode] = useState('');
  const [totpMessage, setTotpMessage] = useState({ type: '', text: '' });
  const [isVerifying2fa, setIsVerifying2fa] = useState(false);
  const [isDisabling2fa, setIsDisabling2fa] = useState(false);

  useEffect(() => {
    if (userProfile.email !== undefined) {
      setEmailInput(userProfile.email || '');
    }
    if (userProfile.first_name !== undefined) {
      setFirstNameInput(userProfile.first_name || '');
    }
    if (userProfile.last_name !== undefined) {
      setLastNameInput(userProfile.last_name || '');
    }
    if (userProfile.birth_year !== undefined) {
      setBirthYearInput(userProfile.birth_year || '');
    }
    if (userProfile.body_goal_text !== undefined) {
      setBodyGoalTextInput(userProfile.body_goal_text || '');
    }
    if (userProfile.weekly_summary_enabled !== undefined) {
      setWeeklySummaryEnabled(userProfile.weekly_summary_enabled);
    }
    if (userProfile.weekly_summary_day !== undefined) {
      setWeeklySummaryDay(userProfile.weekly_summary_day);
    }
    if (userProfile.weekly_summary_time !== undefined) {
      setWeeklySummaryTime(userProfile.weekly_summary_time);
    }
    if (userProfile.monthly_summary_enabled !== undefined) {
      setMonthlySummaryEnabled(userProfile.monthly_summary_enabled);
    }
    if (userProfile.monthly_summary_day !== undefined) {
      setMonthlySummaryDay(userProfile.monthly_summary_day);
    }
    if (userProfile.monthly_summary_time !== undefined) {
      setMonthlySummaryTime(userProfile.monthly_summary_time);
    }
    if (userProfile.language !== undefined) {
      setLanguageInput(userProfile.language);
    }
  }, [userProfile]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) fetchSettings();
      if (!cancelled) fetchSharedReports();
    };
    run();
    return () => { cancelled = true; };
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(prev => ({
          ...prev,
          ...data
        }));
      } else if (res.status === 401) {
        // Wcześniej brak tej obsługi - wygasła sesja przy wejściu w Ustawienia
        // kończyła się ciche pustymi/domyślnymi formularzami, bez wylogowania
        // i bez informacji dla użytkownika, czemu nic się nie zapisuje.
        if (onLogout) onLogout();
        setMessage({ type: 'error', text: 'Sesja wygasła. Zaloguj się ponownie.' });
      } else {
        setMessage({ type: 'error', text: 'Nie udało się wczytać ustawień.' });
      }
    } catch (err) {
      console.error('Błąd pobierania ustawień:', err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem podczas wczytywania ustawień.' });
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/sync/manual', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.status === 401) { if (onLogout) onLogout(); return; }
      if (res.ok) {
        const data = await res.json();
        let statusText = 'Synchronizacja zakończona pomyślnie!';
        const parts = [];
        if (data.oura) {
          parts.push(`Oura: ${data.oura.success ? '✅ Zsynchronizowano' : '❌ Błąd (' + data.oura.error + ')'}`);
        }
        if (data.withings) {
          parts.push(`Withings: ${data.withings.success ? '✅ Zsynchronizowano' : '❌ Błąd (' + data.withings.error + ')'}`);
        }
        if (parts.length > 0) {
          statusText += ` (${parts.join(', ')})`;
        }
        setMessage({ type: 'success', text: statusText });
        setTimeout(() => setMessage({ type: '', text: '' }), 10000);
      } else {
        setMessage({ type: 'error', text: 'Wystąpił błąd podczas manualnej synchronizacji.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // Adres webhooka Apple Health (apka Health Auto Export) - zbudowany z tokenu
  // synchronizacji użytkownika (syncToken, prop z App.jsx). Backend: routes/appleHealth.js.
  const appleHealthWebhookUrl = syncToken
    ? `https://dietetyk.renacode.com/api/integrations/apple-health/${syncToken}`
    : '';

  const handleCopyWebhookUrl = async () => {
    if (!appleHealthWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(appleHealthWebhookUrl);
      setMessage({ type: 'success', text: 'Skopiowano URL webhooka Apple Health do schowka!' });
      setTimeout(() => setMessage({ type: '', text: '' }), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: 'Nie udało się skopiować URL do schowka.' });
    }
  };

  // Generuje nowy, losowy token synchronizacji (taki sam format jak tokeny
  // tworzone automatycznie przy rejestracji - patrz backend/routes/auth.js)
  // i zapisuje go przez istniejący endpoint POST /api/user/profile (już
  // wspiera pole syncToken - backend/routes/account.js).
  // UWAGA: Math.random() NIE jest kryptograficznie bezpieczny (generator PRNG silnika
  // JS jest odtwarzalny/przewidywalny w pewnych warunkach) - a ten token jest realnym
  // poświadczeniem: backend (account.js) przyjmuje go bez żadnej dodatkowej weryfikacji
  // i ustawia jako nowy sync_token użytkownika, który m.in. autoryzuje webhook Apple
  // Health (Health Auto Export) bez sesji/logowania. Używamy więc window.crypto.getRandomValues
  // (kryptograficznie bezpieczny generator dostępny w przeglądarce), tak jak backend
  // korzysta z crypto.randomBytes przy generowaniu tokenów w db.js/auth.js.
  const generateRandomToken = () => {
    const bytes = new Uint8Array(20);
    window.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return 'sync_' + hex;
  };

  const handleRegenerateToken = async () => {
    setIsRegeneratingToken(true);
    setMessage({ type: '', text: '' });
    try {
      const newToken = generateRandomToken();
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ syncToken: newToken })
      });

      if (res.ok) {
        setMessage({ type: 'success', text: 'Wygenerowano nowy token synchronizacji. Zaktualizuj URL webhooka w apce Health Auto Export!' });
        setTimeout(() => setMessage({ type: '', text: '' }), 8000);
        if (onProfileUpdate) onProfileUpdate();
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error || 'Błąd generowania nowego tokenu.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsRegeneratingToken(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    const numericFields = ['target_calories', 'target_protein', 'target_carbs', 'target_fat', 'bmr', 'target_water_ml', 'height_cm', 'target_weight_kg', 'target_body_fat_pct'];
    // POPRAWKA (runda 4 audytu): Number('') === 0, więc wyczyszczenie pola liczbowego
    // (np. żeby zostawić je puste do późniejszego wypełnienia) zapisywało w stanie
    // formularza realne 0 - np. dla "Wzrost" trwale wyłączało liczenie BMI, mimo że
    // backend (GET /api/settings, patrz komentarz przy `r.value === ''`) jest już
    // przygotowany na przechowywanie i poprawny odczyt pustej wartości. Teraz puste
    // pole zostaje pustym stringiem, a nie liczbą 0.
    setSettings(prev => ({
      ...prev,
      [name]: numericFields.includes(name) ? (value === '' ? '' : Number(value)) : value
    }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(settings)
      });

      if (res.status === 401) { if (onLogout) onLogout(); return; }
      if (res.ok) {
        setMessage({ type: 'success', text: 'Ustawienia zostały pomyślnie zaktualizowane!' });
        onProfileUpdate();
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Wystąpił błąd podczas zapisywania ustawień.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSaving(false);
    }
  };

  // Wyszukiwanie miejscowości (Open-Meteo Geocoding, patrz GET /api/settings/geocode-location
  // w backend/routes/account.js) - NIE zapisuje nic samo z siebie, tylko pokazuje
  // listę kandydatów do wyboru (jedna nazwa typu "Malin" bywa niejednoznaczna -
  // istnieje wiele miejscowości o tej samej nazwie na świecie).
  const handleSearchLocation = async (e) => {
    if (e) e.preventDefault();
    const query = locationQuery.trim();
    if (!query) return;
    setIsSearchingLocation(true);
    setLocationMessage({ type: '', text: '' });
    setLocationResults([]);
    try {
      const res = await fetch(`/api/settings/geocode-location?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.status === 401) { if (onLogout) onLogout(); return; }
      const data = await res.json();
      if (!res.ok) {
        setLocationMessage({ type: 'error', text: data.error || 'Błąd wyszukiwania lokalizacji.' });
        return;
      }
      if (!data.results || data.results.length === 0) {
        setLocationMessage({ type: 'error', text: 'Nie znaleziono takiej miejscowości. Spróbuj wpisać nazwę większego, pobliskiego miasta.' });
        return;
      }
      setLocationResults(data.results);
    } catch (err) {
      setLocationMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSearchingLocation(false);
    }
  };

  const handleSelectLocation = (result) => {
    const label = [result.name, result.admin1, result.country].filter(Boolean).join(', ');
    setSettings(prev => ({
      ...prev,
      weather_lat: result.latitude,
      weather_lon: result.longitude,
      weather_location_label: label
    }));
    setLocationResults([]);
    setLocationQuery('');
    setLocationMessage({ type: 'success', text: `Wybrano: ${label}. Kliknij "Zapisz ustawienia", żeby zapisać.` });
  };

  const handleClearLocation = () => {
    setSettings(prev => ({
      ...prev,
      weather_lat: '',
      weather_lon: '',
      weather_location_label: ''
    }));
    setLocationResults([]);
    setLocationMessage({ type: 'success', text: 'Przywrócono domyślną lokalizację. Kliknij "Zapisz ustawienia", żeby zapisać.' });
  };

  const handleAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploadingAvatar(true);
    setAvatarMessage({ type: '', text: '' });

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 150;
        const MAX_HEIGHT = 150;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        submitAvatar(dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const submitAvatar = async (base64Data) => {
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ avatar: base64Data })
      });

      if (res.ok) {
        setAvatarMessage({ type: 'success', text: 'Avatar został zaktualizowany!' });
        onProfileUpdate();
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 5000);
      } else {
        setAvatarMessage({ type: 'error', text: 'Błąd podczas wgrywania avatara.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (!confirm('Czy chcesz usunąć swoje zdjęcie profilowe?')) return;
    setIsUploadingAvatar(true);
    submitAvatar(null);
  };

  // Zdjęcie celu sylwetki - w odróżnieniu od avatara (150x150, mała ikonka) skalujemy
  // do 800x800 / jakość 0.7, bo to realne zdjęcie referencyjne, które AI dietetyk
  // analizuje wizualnie (patrz backend/routes/dashboard.js) - przy mniejszej
  // rozdzielczości analiza wizualna byłaby zbyt niedokładna. Wzorzec kompresji
  // identyczny jak w MealLogger.jsx (zdjęcia posiłków).
  const handleBodyGoalPhotoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploadingBodyGoalPhoto(true);
    setBodyGoalPhotoMessage({ type: '', text: '' });

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        submitBodyGoalPhoto(dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const submitBodyGoalPhoto = async (base64Data) => {
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ body_goal_photo: base64Data })
      });

      if (res.ok) {
        setBodyGoalPhotoMessage({ type: 'success', text: 'Zdjęcie celu sylwetki zostało zapisane!' });
        onProfileUpdate();
        setTimeout(() => setBodyGoalPhotoMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json().catch(() => ({}));
        setBodyGoalPhotoMessage({ type: 'error', text: data.error || 'Błąd podczas wgrywania zdjęcia.' });
      }
    } catch (err) {
      setBodyGoalPhotoMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsUploadingBodyGoalPhoto(false);
    }
  };

  const handleRemoveBodyGoalPhoto = async () => {
    if (!confirm('Czy chcesz usunąć zdjęcie celu sylwetki?')) return;
    setIsUploadingBodyGoalPhoto(true);
    submitBodyGoalPhoto(null);
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordMessage({ type: '', text: '' });

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'Nowe hasła nie są identyczne!' });
      return;
    }

    setIsChangingPassword(true);
    try {
      const res = await fetch('/api/user/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          currentPassword: passwordData.currentPassword,
          newPassword: passwordData.newPassword
        })
      });

      if (res.ok) {
        setPasswordMessage({ type: 'success', text: 'Hasło zostało pomyślnie zmienione!' });
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setTimeout(() => setPasswordMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setPasswordMessage({ type: 'error', text: data.error || 'Błąd podczas zmiany hasła.' });
      }
    } catch (err) {
      setPasswordMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsChangingPassword(false);
    }
  };

  // Eksport własnych danych (RODO art. 20) - pobiera plik JSON z profilem,
  // ustawieniami (sekrety zamaskowane), posiłkami i historią zdrowotną.
  const handleExportData = async () => {
    setExportMessage({ type: '', text: '' });
    setIsExportingData(true);
    try {
      const res = await fetch('/api/user/export', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setExportMessage({ type: 'error', text: data.error || 'Błąd eksportu danych.' });
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dietetyk-ai-eksport-danych.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setExportMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsExportingData(false);
    }
  };

  // Eksport raportu PDF dla lekarza/dietetyka - zwięzłe podsumowanie (cele, średnie
  // z wybranego okresu, sen/skład ciała, obwody ciała, suplementy), w odróżnieniu
  // od pełnego zrzutu JSON powyżej. Ten sam wzorzec pobierania pliku (blob + link).
  const handleExportPdfReport = async () => {
    setPdfExportMessage({ type: '', text: '' });
    setIsExportingPdfReport(true);
    try {
      const res = await fetch(`/api/user/export-pdf-report?days=${pdfReportDays}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPdfExportMessage({ type: 'error', text: data.error || 'Błąd generowania raportu PDF.' });
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dietetyk-ai-raport-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setPdfExportMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsExportingPdfReport(false);
    }
  };

  // Lista istniejących udostępnień (Produkt: udostępnianie raportu linkiem) -
  // wołane przy montowaniu komponentu i po każdej zmianie (stworzenie/odwołanie
  // linku), żeby lista w UI nie rozjeżdżała się ze stanem na backendzie.
  const fetchSharedReports = async () => {
    setIsLoadingSharedReports(true);
    try {
      const res = await fetch('/api/user/shared-reports', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSharedReports(data.shares || []);
      }
    } catch (err) {
      // Nieudane odświeżenie listy nie jest krytyczne (lista po prostu zostaje
      // nieaktualna do następnej próby) - nie pokazujemy z tego powodu błędu.
    } finally {
      setIsLoadingSharedReports(false);
    }
  };

  // Stworzenie nowego linku udostępniania - token jest pokazany TYLKO tu, w
  // odpowiedzi na stworzenie (patrz komentarz w listSharesForUser, backend), więc
  // zapisujemy go w stanie do wyświetlenia/skopiowania, zanim zniknie.
  const handleCreateShareLink = async () => {
    setShareLinkMessage({ type: '', text: '' });
    setLastCreatedShareUrl('');
    setIsCreatingShareLink(true);
    try {
      const res = await fetch('/api/user/shared-reports', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: shareLinkDays, validityKey: shareValidityKey })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShareLinkMessage({ type: 'error', text: data.error || 'Błąd tworzenia linku udostępniania.' });
        return;
      }
      setLastCreatedShareUrl(data.url);
      setShareLinkMessage({ type: 'success', text: 'Link utworzony. Skopiuj go poniżej - nie będzie ponownie wyświetlony.' });
      fetchSharedReports();
    } catch (err) {
      setShareLinkMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsCreatingShareLink(false);
    }
  };

  const handleCopyShareLink = () => {
    if (!lastCreatedShareUrl) return;
    navigator.clipboard.writeText(lastCreatedShareUrl).then(
      () => setShareLinkMessage({ type: 'success', text: 'Link skopiowany do schowka.' }),
      () => setShareLinkMessage({ type: 'error', text: 'Nie udało się skopiować linku - zaznacz i skopiuj go ręcznie.' })
    );
  };

  // Odwołanie udostępnienia - od razu odświeża listę, żeby status "active" zmienił
  // się na "revoked" bez konieczności ręcznego odświeżenia strony.
  const handleRevokeShareLink = async (shareId) => {
    setShareLinkMessage({ type: '', text: '' });
    try {
      const res = await fetch(`/api/user/shared-reports/${shareId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setShareLinkMessage({ type: 'error', text: data.error || 'Błąd odwoływania udostępnienia.' });
        return;
      }
      fetchSharedReports();
    } catch (err) {
      setShareLinkMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    }
  };

  // Etykiety statusu udostępnienia (status liczony na backendzie, patrz
  // listSharesForUser w services/sharedReports.js) i okresu ważności - do
  // czytelnego wyświetlenia listy w UI.
  const SHARE_STATUS_LABELS = { active: 'Aktywny', expired: 'Wygasł', revoked: 'Odwołany' };
  const formatShareDate = (isoString) => {
    try {
      return new Date(isoString).toLocaleString('pl-PL');
    } catch (e) {
      return isoString;
    }
  };

  // Usunięcie własnego konta (RODO art. 17) - wymaga potwierdzenia hasłem
  // oraz dodatkowego potwierdzenia w oknie dialogowym, bo to nieodwracalne.
  const handleDeleteAccount = async (e) => {
    e.preventDefault();
    setDeleteMessage({ type: '', text: '' });

    if (!confirm('Czy na pewno chcesz trwale usunąć swoje konto? Tej operacji nie można odwrócić - wszystkie posiłki, ustawienia i historia zdrowotna zostaną usunięte.')) {
      return;
    }

    setIsDeletingAccount(true);
    try {
      const res = await fetch('/api/user/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ password: deletePassword })
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        try {
          await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          });
        } catch (_) { /* ignorujemy błąd logout - konto i tak jest usuwane */ }
        localStorage.removeItem('diet_session_token');
        window.location.href = '/';
      } else {
        setDeleteMessage({ type: 'error', text: data.error || 'Błąd usuwania konta.' });
      }
    } catch (err) {
      setDeleteMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setIsSavingProfile(true);
    setAvatarMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          email: emailInput,
          first_name: firstNameInput,
          last_name: lastNameInput,
          // Pusty input -> null (backend liczy HRmax z fallbackiem), a nie ''
          // czy NaN z Number('').
          birth_year: birthYearInput ? Number(birthYearInput) : null,
          body_goal_text: bodyGoalTextInput,
          weekly_summary_enabled: weeklySummaryEnabled ? '1' : '0',
          weekly_summary_day: String(weeklySummaryDay),
          weekly_summary_time: weeklySummaryTime,
          monthly_summary_enabled: monthlySummaryEnabled ? '1' : '0',
          monthly_summary_day: String(monthlySummaryDay),
          monthly_summary_time: monthlySummaryTime,
          target_weight_kg: settings.target_weight_kg,
          target_body_fat_pct: settings.target_body_fat_pct
        })
      });

      if (res.ok) {
        setAvatarMessage({ type: 'success', text: 'Profil został pomyślnie zaktualizowany!' });
        onProfileUpdate();
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setAvatarMessage({ type: 'error', text: data.error || 'Wystąpił błąd podczas zapisywania profilu.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSendTestEmail = async (type = 'weekly') => {
    setIsSendingEmail(true);
    setAvatarMessage({ type: '', text: '' });

    try {
      const endpoint = type === 'daily' ? '/api/user/send-daily-summary' : (type === 'monthly' ? '/api/user/send-monthly-summary' : '/api/user/send-weekly-summary');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ email: emailInput })
      });

      if (res.ok) {
        const data = await res.json();
        const typeLabel = type === 'daily' ? 'Codzienne' : (type === 'monthly' ? 'Miesięczne' : 'Tygodniowe');
        let successText = `${typeLabel} podsumowanie zostało wysłane na e-mail!`;
        if (data.previewUrl) {
          successText += ` (Podgląd testowy Ethereal: ${data.previewUrl})`;
        }
        setAvatarMessage({ type: 'success', text: successText });
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 15000);
      } else {
        const data = await res.json();
        setAvatarMessage({ type: 'error', text: data.error || 'Błąd wysyłania e-maila.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleSetup2FA = async () => {
    setTotpMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/user/setup-2fa', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setTotpSetupData({
          qrCode: data.qrCode,
          secret: data.secret,
          tempToken: data.tempToken
        });
        setIsSettingUp2fa(true);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Błąd inicjalizacji setupu 2FA.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    }
  };

  const handleVerify2FASetup = async (e) => {
    e.preventDefault();
    if (!totpSetupCode.trim()) return;
    setIsVerifying2fa(true);
    setTotpMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/verify-2fa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          tempToken: totpSetupData.tempToken,
          code: totpSetupCode
        })
      });

      if (res.ok) {
        setTotpMessage({ type: 'success', text: 'Dwuetapowa weryfikacja (2FA) została aktywowana!' });
        setIsSettingUp2fa(false);
        setTotpSetupCode('');
        onProfileUpdate();
        setTimeout(() => setTotpMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Niepoprawny kod weryfikacyjny.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsVerifying2fa(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!confirm('Czy na pewno chcesz wyłączyć dwuetapową weryfikację (2FA) na swoim koncie? Obniży to bezpieczeństwo profilu.')) return;
    // Backend wymaga teraz ponownej weryfikacji aktualnym hasłem przed wyłączeniem 2FA
    // (patrz backend/routes/account.js) - samo posiadanie aktywnej sesji nie wystarczy.
    const password = prompt('Aby wyłączyć 2FA, potwierdź swoje aktualne hasło:');
    if (!password) return;
    setIsDisabling2fa(true);
    setTotpMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/disable-2fa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ password })
      });

      if (res.ok) {
        setTotpMessage({ type: 'success', text: 'Weryfikacja dwuetapowa została wyłączona.' });
        onProfileUpdate();
        setTimeout(() => setTotpMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Błąd podczas wyłączania 2FA.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsDisabling2fa(false);
    }
  };

  const handleDisconnect = async (service) => {
    if (!confirm(`Czy na pewno chcesz odłączyć integrację z ${service === 'oura' ? 'Oura' : 'Withings'}?`)) return;
    try {
      const res = await fetch(`/api/auth/${service}/disconnect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        onProfileUpdate();
        setMessage({ type: 'success', text: `Odłączono integrację z ${service === 'oura' ? 'Oura' : 'Withings'}!` });
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Nie udało się odłączyć integracji.' });
      }
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    }
  };

  const handleConnect = async (service) => {
    // WAŻNE: zapisujemy bieżący stan formularza (Client ID/Secret) PRZED przekierowaniem.
    // Wcześniej przycisk "Połącz" od razu robił window.location.href, więc jeśli
    // użytkownik wpisał dane i kliknął "Połącz" bez wcześniejszego kliknięcia
    // odrębnego przycisku "Zapisz poświadczenia integracji" na dole formularza,
    // backend przy budowaniu URL-a OAuth czytał z bazy starą/pustą wartość -
    // stąd zgłoszony błąd z client_id=0 w adresie autoryzacji Withings.
    // Przekierowanie do OAuth następuje TYLKO, jeśli zapis się powiódł - wcześniej
    // window.location.href wykonywało się bezwarunkowo, więc np. wygasła sesja w
    // trakcie zapisu (401) i tak przenosiła użytkownika do zewnętrznego dostawcy
    // ze starymi/błędnymi danymi konfiguracyjnymi, co kończyło się niewyjaśnionym
    // błędem autoryzacji po powrocie.
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(settings)
      });
      if (!res.ok) {
        if (res.status === 401 && onLogout) onLogout();
        setMessage({ type: 'error', text: 'Nie udało się zapisać poświadczeń integracji - połączenie przerwane.' });
        return;
      }
    } catch (err) {
      console.error('Błąd zapisu ustawień przed połączeniem:', err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem - nie połączono z integracją.' });
      return;
    }
    window.location.href = `${window.location.origin}/api/auth/${service}?token=${sessionToken}`;
  };

  // Połączenie/odłączenie konta Google (logowanie) - osobne od Google Fit (źródło danych).
  // Brak Client ID/Secret do zapisania (konfiguracja globalna admina), więc po prostu
  // przekierowujemy z tokenem sesji - backend rozpoznaje to jako przepływ "łączenia"
  // dzięki podpisanemu `state` (patrz backend/routes/auth.js, GET /api/auth/google/link).
  const handleConnectGoogle = () => {
    window.location.href = `${window.location.origin}/api/auth/google/link?token=${sessionToken}`;
  };

  const handleUnlinkGoogle = async () => {
    if (!confirm('Czy na pewno chcesz odłączyć konto Google? Logowanie będzie wtedy możliwe tylko hasłem.')) return;
    try {
      const res = await fetch('/api/user/unlink-google', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        onProfileUpdate();
        setMessage({ type: 'success', text: 'Odłączono konto Google!' });
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Nie udało się odłączyć konta Google.' });
      }
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    }
  };

  // Połączenie/odłączenie Google Fit (źródło danych o krokach/kaloriach), analogicznie
  // do Oura/Withings, ale bez własnych Client ID/Secret - korzysta z tej samej,
  // globalnej konfiguracji Google co logowanie Google.
  const handleConnectGoogleFit = () => {
    window.location.href = `${window.location.origin}/api/auth/google-fit?token=${sessionToken}`;
  };

  const handleDisconnectGoogleFit = async () => {
    if (!confirm('Czy na pewno chcesz odłączyć integrację z Google Fit?')) return;
    try {
      const res = await fetch('/api/auth/google-fit/disconnect', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        onProfileUpdate();
        setMessage({ type: 'success', text: 'Odłączono integrację z Google Fit!' });
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Nie udało się odłączyć integracji.' });
      }
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    }
  };

  return (
    <div className="setup-container">
      
      {/* 1. Panel Ustawień Celów */}
      {/* 1. Panel Ustawień Celów */}
      <div
        className="glass-card"
        role="button"
        tabIndex={0}
        aria-expanded={isDietGoalsOpen}
        onClick={() => setIsDietGoalsOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsDietGoalsOpen(o => !o); } }}
        style={{ cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="card-title" style={{ margin: 0 }}>⚙️ Twoje Cele Dietetyczne</h3>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            {isDietGoalsOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
          </span>
        </div>
      </div>

      {isDietGoalsOpen && (
        <div className="glass-card">
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Skonfiguruj swoje dzienne limity, aby Dietetyk AI mógł poprawnie obliczać Twój bilans i dawać spersonalizowane porady.
          </p>

          {message.text && (
            <div className={`alert alert-${message.type}`} style={{ marginBottom: '16px' }}>
              {message.text}
            </div>
          )}

          <form onSubmit={handleSave}>
            <div className="settings-grid">
              <div className="input-group">
                <label className="input-label">Cel kalorii (kcal)</label>
                <input
                  type="number"
                  name="target_calories"
                  className="input-field"
                  value={settings.target_calories}
                  onChange={handleInputChange}
                  min="500"
                  max="10000"
                  required
                />
              </div>
              
              <div className="input-group">
                <label className="input-label">BMR / PPM (kcal)*</label>
                <input
                  type="number"
                  name="bmr"
                  className="input-field"
                  value={settings.bmr}
                  onChange={handleInputChange}
                  min="500"
                  max="5000"
                  title="Podstawowa przemiana materii - kalorie, które Twój organizm spala na samo przeżycie leżąc."
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Białko (g)</label>
                <input
                  type="number"
                  name="target_protein"
                  className="input-field"
                  value={settings.target_protein}
                  onChange={handleInputChange}
                  min="0"
                  max="1000"
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Węglowodany (g)</label>
                <input
                  type="number"
                  name="target_carbs"
                  className="input-field"
                  value={settings.target_carbs}
                  onChange={handleInputChange}
                  min="0"
                  max="1500"
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Tłuszcz (g)</label>
                <input
                  type="number"
                  name="target_fat"
                  className="input-field"
                  value={settings.target_fat}
                  onChange={handleInputChange}
                  min="0"
                  max="500"
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Cel wody (ml)</label>
                <input
                  type="number"
                  name="target_water_ml"
                  className="input-field"
                  value={settings.target_water_ml}
                  onChange={handleInputChange}
                  min="0"
                  max="10000"
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Wzrost (cm)**</label>
                <input
                  type="number"
                  name="height_cm"
                  className="input-field"
                  value={settings.height_cm}
                  onChange={handleInputChange}
                  min="0"
                  placeholder="np. 178"
                  title="Potrzebny do wyliczenia rzeczywistego BMI na Pulpicie."
                />
              </div>

            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '4px' }}>
              * BMR (Podstawowa przemiana materii) służy do wyliczania całkowitego dziennego spalania: Całkowite spalanie = BMR + Aktywne kalorie ze zintegrowanych sensorów.
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
              ** Wzrost jest opcjonalny, ale bez niego BMI na Pulpicie nie będzie wyliczane (nie zgadujemy go za Ciebie).
            </p>

            <button type="submit" className="btn-primary" disabled={isSaving}>
              {isSaving ? 'Zapisywanie...' : 'Zapisz cele'}
            </button>
          </form>
        </div>
      )}

      {/* Panel Profilu (Avatar) oraz pozostałe karty ustawień.
          Karta Profilu jest dużo wyższa niż pozostałe (Cel Sylwetki, Twoje Dane,
          Zmiana Hasła, 2FA), więc zamiast jednej siatki auto-fit (gdzie 5 kart różnej
          wysokości nierówno "łamało się" w wiersze i zostawiało puste komórki w drugim
          rzędzie - patrz zgłoszenie użytkownika), dzielimy układ na dwie kolumny:
          lewa - sama, wysoka karta Profilu; prawa - stała siatka 2x2 dla czterech
          mniejszych kart, więc nie ma już "dziur" ani nierównych linii. */}
      <div className="settings-main-grid">

        {/* Panel Profilu i Avatara */}
        <div className="glass-card">
          <h3 className="card-title">👤 Twój Profil i Avatar</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Wgraj zdjęcie profilowe, które będzie wyświetlane w nagłówku aplikacji.
          </p>

          {avatarMessage.text && (
            <div className={`alert alert-${avatarMessage.type}`} style={{ marginBottom: '16px' }}>
              {avatarMessage.text}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
            {userProfile.avatar_base64 ? (
              <img 
                src={userProfile.avatar_base64} 
                alt="Avatar" 
                style={{ width: '80px', height: '80px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--primary-color)' }} 
              />
            ) : (
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--primary-color), var(--primary-hover))', color: '#fff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', fontSize: '2.5rem', border: '2px solid var(--border-glass)' }}>
                {userProfile.username ? userProfile.username[0].toUpperCase() : '?'}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.9rem', display: 'inline-block', cursor: 'pointer', textAlign: 'center' }}>
                Wybierz zdjęcie
                <input 
                  type="file" 
                  accept="image/*" 
                  onChange={handleAvatarUpload} 
                  style={{ display: 'none' }} 
                  disabled={isUploadingAvatar}
                />
              </label>
              {userProfile.avatar_base64 && (
                <button 
                  type="button" 
                  className="btn-danger"
                  onClick={handleRemoveAvatar}
                  style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                >
                  Usuń zdjęcie
                </button>
              )}
            </div>
          </div>

          <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px' }}>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <div className="input-group" style={{ flex: '1 1 140px' }}>
                <label className="input-label">Imię</label>
                <input
                  type="text"
                  className="input-field"
                  value={firstNameInput}
                  onChange={(e) => setFirstNameInput(e.target.value)}
                  placeholder="np. Marcin"
                  maxLength={50}
                />
              </div>
              <div className="input-group" style={{ flex: '1 1 140px' }}>
                <label className="input-label">Nazwisko</label>
                <input
                  type="text"
                  className="input-field"
                  value={lastNameInput}
                  onChange={(e) => setLastNameInput(e.target.value)}
                  placeholder="np. Kowalski"
                  maxLength={50}
                />
              </div>
              <div className="input-group" style={{ flex: '1 1 140px' }}>
                <label className="input-label">Rok urodzenia</label>
                <input
                  type="number"
                  className="input-field"
                  value={birthYearInput}
                  onChange={(e) => setBirthYearInput(e.target.value)}
                  placeholder="np. 1990"
                  min={1900}
                  max={new Date().getFullYear()}
                />
              </div>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '-8px 0 0' }}>
              Tego imienia AI dietetyk będzie używać, zwracając się do Ciebie w poradach.
              Rok urodzenia jest opcjonalny - używany do obliczenia maksymalnego tętna w strefach kardio na Dashboardzie.
            </p>

            <div className="input-group">
              <label className="input-label">Adres e-mail do raportów</label>
              <input 
                type="email" 
                className="input-field" 
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="np. jan.kowalski@example.com"
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">{t("Język")}</label>
              <select
                className="input-field"
                value={languageInput}
                onChange={(e) => {
                  const newLang = e.target.value;
                  setLanguageInput(newLang);
                  if (onLanguageChange) {
                    onLanguageChange(newLang);
                  }
                }}
              >
                <option value="pl">Polski / Polish</option>
                <option value="en">Angielski / English</option>
              </select>
            </div>

            {/* Połączenie konta z Google - niezależne od logowania Google (które łączy
                konta automatycznie tylko po zgodnym e-mailu). To pozwala powiązać konto
                założone hasłem z Google bez zmiany/zgodności adresu e-mail. */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '12px',
              padding: '16px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-glass)',
              borderRadius: '12px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '1.6rem' }}>🔗</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Konto Google</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_google ? 'var(--success-light)' : 'var(--text-dim)' }}>
                    {userProfile.has_google ? '✅ Połączono z kontem Google' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              {userProfile.has_google ? (
                <button
                  type="button"
                  className="btn-danger"
                  style={{ padding: '8px 16px' }}
                  onClick={handleUnlinkGoogle}
                >
                  Odłącz Google
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  style={{ padding: '8px 16px' }}
                  onClick={handleConnectGoogle}
                >
                  Połącz z Google
                </button>
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input
                  type="checkbox"
                  id="weekly_summary_enabled"
                  checked={weeklySummaryEnabled}
                  onChange={(e) => setWeeklySummaryEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--color-primary)' }}
                />
                <label htmlFor="weekly_summary_enabled" style={{ fontSize: '0.9rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Włącz podsumowanie
                </label>
              </div>

              {weeklySummaryEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                  <div className="input-group">
                    <label className="input-label">Dzień wysyłki</label>
                    <select 
                      className="input-field" 
                      value={weeklySummaryDay}
                      onChange={(e) => setWeeklySummaryDay(Number(e.target.value))}
                      style={{ background: 'rgba(0, 0, 0, 0.2)', color: 'white', border: '1px solid var(--border-glass)' }}
                    >
                      <option value={1}>Poniedziałek</option>
                      <option value={2}>Wtorek</option>
                      <option value={3}>Środa</option>
                      <option value={4}>Czwartek</option>
                      <option value={5}>Piątek</option>
                      <option value={6}>Sobota</option>
                      <option value={7}>Niedziela</option>
                    </select>
                  </div>
                  
                  <div className="input-group">
                    <label className="input-label">Godzina wysyłki</label>
                    <input 
                      type="time" 
                      className="input-field" 
                      value={weeklySummaryTime}
                      onChange={(e) => setWeeklySummaryTime(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input
                  type="checkbox"
                  id="monthly_summary_enabled"
                  checked={monthlySummaryEnabled}
                  onChange={(e) => setMonthlySummaryEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--color-primary)' }}
                />
                <label htmlFor="monthly_summary_enabled" style={{ fontSize: '0.9rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Włącz raport miesięczny
                </label>
              </div>

              {monthlySummaryEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                  <div className="input-group">
                    <label className="input-label">Dzień miesiąca</label>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      className="input-field"
                      value={monthlySummaryDay}
                      onChange={(e) => {
                        // Pozwalamy na tymczasowo pusty string podczas wpisywania
                        // (wzorzec jak dla pozostałych pól liczbowych w tym pliku).
                        // Clamp do 1-31 stosowany dopiero przy submit (server-side też waliduje).
                        if (e.target.value === '') {
                          setMonthlySummaryDay('');
                          return;
                        }
                        const val = Number(e.target.value);
                        setMonthlySummaryDay(Math.min(31, Math.max(1, val)));
                      }}
                      title="Jeśli dany miesiąc jest krótszy (np. luty), raport zostanie wysłany w ostatnim dniu tego miesiąca."
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Godzina wysyłki</label>
                    <input
                      type="time"
                      className="input-field"
                      value={monthlySummaryTime}
                      onChange={(e) => setMonthlySummaryTime(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px' }}>
              <button type="submit" className="btn-primary" disabled={isSavingProfile} style={{ width: '100%' }}>
                {isSavingProfile ? 'Zapisywanie...' : 'Zapisz profil'}
              </button>
              {/* minmax(0, 1fr) zamiast samego 1fr - bez tego kolumna nie skurczy się
                  poniżej szerokości tekstu przycisku (np. "Wyślij tygodniowe") na
                  wąskich ekranach, ten sam mechanizm co naprawiony .premium-grid-2 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('daily')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij codzienne'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('weekly')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij tygodniowe'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('monthly')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij miesięczne'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Prawa kolumna - podzielona na dwie pionowe pod-kolumny (flex), aby zapobiec powstawaniu dziur/pustych obszarów spowodowanych różnymi wysokościami kart */}
        <div className="settings-right-grid">

          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Panel Celu Sylwetki - opis tekstowy + zdjęcie referencyjne, brane pod uwagę
                przez AI dietetyka przy generowaniu porad (dashboard.js) i odpowiedzi
                czatu (chat.js). Zapisywane na backendzie w users.body_goal_text /
                users.body_goal_photo_base64 (patrz migracja w db.js). */}
            <div className="glass-card">
              <h3 className="card-title">🎯 Cel Sylwetki</h3>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
                Opisz, do jakiej sylwetki/celu dążysz (np. &quot;redukcja tkanki tłuszczowej, widoczne mięśnie brzucha&quot; albo &quot;budowa masy mięśniowej, +5kg&quot;), opcjonalnie dołącz zdjęcie referencyjne. AI dietetyk weźmie to pod uwagę przy poradach i w czacie.
              </p>

              {bodyGoalPhotoMessage.text && (
                <div className={`alert alert-${bodyGoalPhotoMessage.type}`} style={{ marginBottom: '16px' }}>
                  {bodyGoalPhotoMessage.text}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
                {userProfile.body_goal_photo_base64 ? (
                  <img
                    src={userProfile.body_goal_photo_base64}
                    alt="Cel sylwetki"
                    style={{ width: '100px', height: '100px', borderRadius: '12px', objectFit: 'cover', border: '2px solid var(--primary-color)' }}
                  />
                ) : (
                  <div style={{ width: '100px', height: '100px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.04)', border: '2px dashed var(--border-glass)', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2rem', color: 'var(--text-dim)' }}>
                    🖼️
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.9rem', display: 'inline-block', cursor: 'pointer', textAlign: 'center' }}>
                    {isUploadingBodyGoalPhoto ? 'Wgrywanie...' : 'Wybierz zdjęcie'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleBodyGoalPhotoUpload}
                      style={{ display: 'none' }}
                      disabled={isUploadingBodyGoalPhoto}
                    />
                  </label>
                  {userProfile.body_goal_photo_base64 && (
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={handleRemoveBodyGoalPhoto}
                      disabled={isUploadingBodyGoalPhoto}
                      style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                    >
                      Usuń zdjęcie
                    </button>
                  )}
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Waga docelowa (kg)</label>
                <input
                  type="number"
                  step="0.1"
                  name="target_weight_kg"
                  className="input-field"
                  value={settings.target_weight_kg}
                  onChange={handleInputChange}
                  min="0"
                  placeholder="np. 75"
                  title="Cel wagowy używany do prognozy daty osiągnięcia celu na Pulpicie."
                />
              </div>
              <div className="input-group">
                <label className="input-label">Docelowy % tkanki tłuszczowej</label>
                <input
                  type="number"
                  step="0.1"
                  name="target_body_fat_pct"
                  className="input-field"
                  value={settings.target_body_fat_pct}
                  onChange={handleInputChange}
                  min="0"
                  max="60"
                  placeholder="np. 15"
                  title="Docelowy procent tkanki tłuszczowej — używany przez algorytmy analiz."
                />
              </div>

              <div className="input-group">
                <label className="input-label">Opis celu sylwetki</label>
                <textarea
                  className="input-field"
                  value={bodyGoalTextInput}
                  onChange={(e) => setBodyGoalTextInput(e.target.value)}
                  placeholder="np. Redukcja tkanki tłuszczowej do ~15%, zachowanie masy mięśniowej"
                  maxLength={1000}
                  rows={3}
                  style={{ resize: 'vertical', minHeight: '80px' }}
                />
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '8px 0 16px' }}>
                Waga i % tłuszczu zapisują się przyciskiem &quot;Zapisz cele&quot; (sekcja Cele powyżej). Opis i zdjęcie — przyciskiem &quot;Zapisz profil&quot;.
              </p>
            </div>

            {/* Panel Zmiany Hasła */}
            {/* Panel Zmiany Hasła */}
            <div
              className="glass-card"
              role="button"
              tabIndex={0}
              aria-expanded={isPasswordOpen}
              onClick={() => setIsPasswordOpen(o => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsPasswordOpen(o => !o); } }}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 className="card-title" style={{ margin: 0 }}>🔑 Zmiana Hasła</h3>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {isPasswordOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
                </span>
              </div>
            </div>

            {isPasswordOpen && (
              <div className="glass-card">
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
                  Zmień hasło logowania dla swojego konta.
                </p>

                {passwordMessage.text && (
                  <div className={`alert alert-${passwordMessage.type}`} style={{ marginBottom: '16px' }}>
                    {passwordMessage.text}
                  </div>
                )}

                <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="input-group">
                    <label className="input-label">Obecne hasło</label>
                    <input
                      type="password"
                      className="input-field"
                      value={passwordData.currentPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, currentPassword: e.target.value }))}
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Nowe hasło</label>
                    <input
                      type="password"
                      className="input-field"
                      value={passwordData.newPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, newPassword: e.target.value }))}
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Powtórz nowe hasło</label>
                    <input
                      type="password"
                      className="input-field"
                      value={passwordData.confirmPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                      required
                    />
                  </div>

                  <button type="submit" className="btn-primary" disabled={isChangingPassword} style={{ marginTop: '8px' }}>
                    {isChangingPassword ? 'Zmienianie...' : 'Zmień hasło'}
                  </button>
                </form>
              </div>
            )}

            {/* Panel 2FA (MFA) */}
            <div
              className="glass-card"
              role="button"
              tabIndex={0}
              aria-expanded={is2faOpen}
              onClick={() => setIs2faOpen(o => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIs2faOpen(o => !o); } }}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 className="card-title" style={{ margin: 0 }}>🛡️ Dwuetapowa Weryfikacja (2FA)</h3>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {is2faOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
                </span>
              </div>
            </div>

            {(is2faOpen || isSettingUp2fa) && (
              <div className="glass-card">
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
                  Zabezpiecz dodatkowo swoje konto za pomocą kodu z aplikacji Google Authenticator lub Authy.
                </p>

                {totpMessage.text && (
                  <div className={`alert alert-${totpMessage.type}`} style={{ marginBottom: '16px' }}>
                    {totpMessage.text}
                  </div>
                )}

                {userProfile.totp_enabled ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '8px', color: 'var(--success-light)', fontSize: '0.9rem' }}>
                      <span>🛡️</span>
                      <strong>Weryfikacja 2FA jest aktywna.</strong>
                    </div>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={handleDisable2FA}
                      disabled={isDisabling2fa}
                      style={{ width: '100%', padding: '10px' }}
                    >
                      {isDisabling2fa ? 'Wyłączanie...' : 'Wyłącz 2FA'}
                    </button>
                  </div>
                ) : !isSettingUp2fa ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', background: 'rgba(245, 158, 11, 0.05)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '8px', color: '#fbbf24', fontSize: '0.9rem' }}>
                      <span>🔓</span>
                      <strong>Weryfikacja 2FA jest nieaktywna.</strong>
                    </div>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleSetup2FA}
                      style={{ width: '100%', padding: '10px' }}
                    >
                      Skonfiguruj i Włącz 2FA
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleVerify2FASetup} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                      Zeskanuj ten kod w aplikacji autoryzacyjnej i podaj 6-cyfrowy kod, aby włączyć zabezpieczenie.
                    </p>

                    <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
                      <img
                        src={totpSetupData.qrCode}
                        alt="QR Code"
                        style={{ borderRadius: '12px', border: '1px solid var(--border-glass)', padding: '6px', background: '#fff', width: '150px', height: '150px' }}
                      />
                    </div>

                    <div className="input-group">
                      <label className="input-label">Kod z aplikacji (6 cyfr)</label>
                      <input
                        type="text"
                        pattern="[0-9]*"
                        inputMode="numeric"
                        maxLength="6"
                        className="input-field"
                        value={totpSetupCode}
                        onChange={(e) => setTotpSetupCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="000 000"
                        required
                        autoFocus
                      />
                    </div>

                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setIsSettingUp2fa(false)}
                        style={{ flex: 1, padding: '8px' }}
                      >
                        Anuluj
                      </button>
                      <button
                        type="submit"
                        className="btn-primary"
                        disabled={isVerifying2fa}
                        style={{ flex: 2, padding: '8px' }}
                      >
                        {isVerifying2fa ? 'Weryfikacja...' : 'Aktywuj 2FA'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Panel Twoje Dane (RODO) - eksport i usunięcie konta */}
            <div className="glass-card">
              <h3 className="card-title">📦 Twoje Dane</h3>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
                Zgodnie z RODO możesz pobrać kopię swoich danych albo trwale usunąć swoje konto.
              </p>

              {exportMessage.text && (
                <div className={`alert alert-${exportMessage.type}`} style={{ marginBottom: '16px' }}>
                  {exportMessage.text}
                </div>
              )}

              <button
                type="button"
                className="btn-secondary"
                onClick={handleExportData}
                disabled={isExportingData}
                style={{ marginBottom: '24px' }}
              >
                {isExportingData ? 'Przygotowywanie...' : '⬇️ Eksportuj moje dane (JSON)'}
              </button>

              {/* Raport PDF dla lekarza/dietetyka - zwięzłe podsumowanie danych z
                  wybranego okresu (cele, średnie, sen/skład ciała, obwody, suplementy),
                  bez tekstu generowanego przez AI, żeby dokument pokazywany lekarzowi
                  zawierał tylko surowe, policzone dane. */}
              <h4 style={{ fontSize: '1rem', color: 'var(--text-main)', marginBottom: '8px' }}>Raport dla lekarza/dietetyka</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Pobierz zwięzłe podsumowanie PDF z wybranego okresu - możesz zabrać je na wizytę.
              </p>

              {pdfExportMessage.text && (
                <div className={`alert alert-${pdfExportMessage.type}`} style={{ marginBottom: '16px' }}>
                  {pdfExportMessage.text}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '24px' }}>
                <select
                  className="input-field"
                  aria-label="Okres raportu PDF"
                  value={pdfReportDays}
                  onChange={(e) => setPdfReportDays(Number(e.target.value))}
                  style={{ width: 'auto' }}
                  disabled={isExportingPdfReport}
                >
                  <option value={30}>Ostatnie 30 dni</option>
                  <option value={90}>Ostatnie 90 dni</option>
                  <option value={180}>Ostatnie 180 dni</option>
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleExportPdfReport}
                  disabled={isExportingPdfReport}
                >
                  {isExportingPdfReport ? 'Generowanie...' : '📄 Pobierz raport PDF'}
                </button>
              </div>

              {/* Udostępnianie raportu linkiem (read-only) - alternatywa dla pobrania
                  pliku powyżej: link można wysłać lekarzowi/dietetykowi, który otworzy
                  go bez konta w aplikacji. Token jest jedyną autoryzacją (patrz
                  backend/routes/sharedReport.js), więc link ma ograniczony czas
                  ważności i można go w każdej chwili odwołać poniżej. */}
              <h4 style={{ fontSize: '1rem', color: 'var(--text-main)', marginBottom: '8px' }}>Udostępnij raport linkiem</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Wygeneruj link do raportu, który można wysłać lekarzowi/dietetykowi - otworzy go bez logowania się do aplikacji.
              </p>

              {shareLinkMessage.text && (
                <div className={`alert alert-${shareLinkMessage.type}`} style={{ marginBottom: '16px' }}>
                  {shareLinkMessage.text}
                </div>
              )}

              {lastCreatedShareUrl && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' }}>
                  <input
                    type="text"
                    className="input-field"
                    readOnly
                    value={lastCreatedShareUrl}
                    onFocus={(e) => e.target.select()}
                    style={{ flex: '1 1 280px' }}
                    aria-label="Link udostępniania raportu"
                  />
                  <button type="button" className="btn-secondary" onClick={handleCopyShareLink} aria-label="Kopiuj link do schowka">
                    📋 Kopiuj
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' }}>
                <select
                  className="input-field"
                  aria-label="Okres danych w udostępnianym raporcie"
                  value={shareLinkDays}
                  onChange={(e) => setShareLinkDays(Number(e.target.value))}
                  style={{ width: 'auto' }}
                  disabled={isCreatingShareLink}
                >
                  <option value={30}>Dane z ostatnich 30 dni</option>
                  <option value={90}>Dane z ostatnich 90 dni</option>
                  <option value={180}>Dane z ostatnich 180 dni</option>
                </select>
                <select
                  className="input-field"
                  aria-label="Czas ważności linku"
                  value={shareValidityKey}
                  onChange={(e) => setShareValidityKey(e.target.value)}
                  style={{ width: 'auto' }}
                  disabled={isCreatingShareLink}
                >
                  <option value="24h">Link ważny 24 godziny</option>
                  <option value="7d">Link ważny 7 dni</option>
                  <option value="30d">Link ważny 30 dni</option>
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleCreateShareLink}
                  disabled={isCreatingShareLink}
                >
                  {isCreatingShareLink ? 'Tworzenie...' : '🔗 Utwórz link'}
                </button>
              </div>

              {sharedReports.length > 0 && (
                <div style={{ marginBottom: '24px' }}>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    Historia udostępnień:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {sharedReports.map((share) => (
                      <div
                        key={share.id}
                        style={{
                          display: 'flex',
                          gap: '12px',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          fontSize: '0.85rem',
                          padding: '8px 12px',
                          borderRadius: '8px',
                          background: 'var(--bg-secondary)'
                        }}
                      >
                        <span>Utworzono: {formatShareDate(share.createdAt)}</span>
                        <span>Dane: {share.days} dni</span>
                        <span>Ważny do: {formatShareDate(share.expiresAt)}</span>
                        <span>Status: {SHARE_STATUS_LABELS[share.status] || share.status}</span>
                        {share.status === 'active' && (
                          <button
                            type="button"
                            className="btn-danger"
                            style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '0.8rem' }}
                            onClick={() => handleRevokeShareLink(share.id)}
                          >
                            Odwołaj
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {sharedReports.length === 0 && !isLoadingSharedReports && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '24px' }}>
                  Brak utworzonych linków udostępniania.
                </p>
              )}

              <h4 style={{ fontSize: '1rem', color: 'var(--danger)', marginBottom: '8px' }}>Usunięcie konta</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                Trwale usuwa Twoje konto i wszystkie powiązane dane (posiłki, ustawienia, historię zdrowotną, połączenia Oura/Withings/Google). Tej operacji nie można odwrócić.
              </p>

              {deleteMessage.text && (
                <div className={`alert alert-${deleteMessage.type}`} style={{ marginBottom: '16px' }}>
                  {deleteMessage.text}
                </div>
              )}

              <form onSubmit={handleDeleteAccount} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="input-group">
                  <label className="input-label">Potwierdź hasłem</label>
                  <input
                    type="password"
                    className="input-field"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn-danger" disabled={isDeletingAccount}>
                  {isDeletingAccount ? 'Usuwanie...' : 'Usuń moje konto na zawsze'}
                </button>
              </form>
            </div>
          </div>

        </div>

      </div>

      {/* 2. Integracje ze Źródłami Danych */}
      <div className="glass-card">
        <h3 className="card-title">🔌 Integracje ze Źródłami Danych</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Skonfiguruj swoje poświadczenia deweloperskie i połącz konto z API Oura Ring oraz Withings, aby automatycznie importować dane o aktywności, śnie, wadze i składzie ciała.
        </p>
        <p style={{ fontSize: '0.85rem', marginBottom: '24px' }}>
          <a href="/sync.html" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline' }}>
            📖 Pełna instrukcja: jak zsynchronizować dane (Apple Health, Oura, Withings)
          </a>
        </p>

        {/* Komunikat o wyniku akcji (np. synchronizacji lub odłączenia integracji) -
            zduplikowany tutaj, bo oryginalny alert renderuje się tylko w karcie "Cele
            Dietetyczne" na samym szczycie strony. Bez tego, kliknięcie "Wymuś ręczną
            synchronizację" (które jest w tej karcie, niżej na stronie) nie dawało
            żadnej widocznej reakcji, jeśli użytkownik nie przewinął strony do góry. */}
        {message.text && (
          <div className={`alert alert-${message.type}`} style={{ marginBottom: '16px' }}>
            {message.text}
          </div>
        )}

        {(userProfile.has_oura || userProfile.has_withings || userProfile.has_google_fit) && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '20px' }}>
            <button
              type="button"
              className="btn-primary"
              style={{
                background: 'rgba(59, 130, 246, 0.15)',
                color: '#60a5fa',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                padding: '10px 20px',
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderRadius: '8px',
                cursor: isSyncing ? 'not-allowed' : 'pointer'
              }}
              onClick={handleManualSync}
              disabled={isSyncing}
            >
              {isSyncing ? '🔄 Synchronizowanie...' : '🔄 Wymuś ręczną synchronizację'}
            </button>
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Lokalizacja dla kontekstu pogody w poradach AI (czat i codzienna porada na
              Dashboardzie - patrz backend/utils/weatherContext.js) - domyślnie serwer
              używa stałej lokalizacji, tu użytkownik może ją nadpisać swoją miejscowością. */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem' }}>📍</span>
              <div>
                <strong style={{ display: 'block', color: '#fff' }}>Lokalizacja (pogoda w poradach AI)</strong>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                  {settings.weather_location_label
                    ? `Aktualnie: ${settings.weather_location_label}`
                    : 'Aktualnie: domyślna lokalizacja serwera'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={locationQuery}
                onChange={(e) => setLocationQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSearchLocation(); } }}
                placeholder="np. Trzebnica, Wrocław, Warszawa..."
                style={{ flex: '1 1 200px' }}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleSearchLocation}
                disabled={isSearchingLocation || !locationQuery.trim()}
                style={{ padding: '8px 16px' }}
              >
                {isSearchingLocation ? 'Szukam...' : '🔍 Szukaj'}
              </button>
              {settings.weather_location_label && (
                <button
                  type="button"
                  className="btn-danger"
                  onClick={handleClearLocation}
                  style={{ padding: '8px 16px' }}
                >
                  Przywróć domyślną
                </button>
              )}
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              Bardzo małe miejscowości (np. pojedyncze wsie) mogą nie być w bazie wyszukiwania -
              w takim wypadku wyszukaj najbliższe większe miasto (pogoda w promieniu kilku km jest praktycznie taka sama).
            </span>

            {locationMessage.text && (
              <div style={{ fontSize: '0.85rem', color: locationMessage.type === 'error' ? 'var(--danger-light)' : 'var(--success-light)' }}>
                {locationMessage.text}
              </div>
            )}

            {locationResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {locationResults.map((r, idx) => (
                  <button
                    key={`${r.latitude},${r.longitude},${idx}`}
                    type="button"
                    onClick={() => handleSelectLocation(r)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 12px',
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border-glass)',
                      borderRadius: '8px',
                      color: '#fff',
                      cursor: 'pointer'
                    }}
                  >
                    {[r.name, r.admin1, r.country].filter(Boolean).join(', ')}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Google Fit - źródło danych o krokach/kaloriach/aktywności, analogicznie do
              Oura/Withings, ale bez własnych Client ID/Secret (korzysta z globalnej
              konfiguracji Google ustawionej przez admina - tej samej, co logowanie Google). */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>🏃</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Google Fit (Kroki, Kalorie, Aktywność)</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_google_fit ? 'var(--success-light)' : 'var(--text-dim)' }}>
                    {userProfile.has_google_fit ? '✅ Połączono z Google Fit' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              <div>
                {userProfile.has_google_fit ? (
                  <button
                    type="button"
                    className="btn-danger"
                    style={{ padding: '8px 16px' }}
                    onClick={handleDisconnectGoogleFit}
                  >
                    Odłącz Google Fit
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '8px 16px' }}
                    onClick={handleConnectGoogleFit}
                  >
                    Połącz z Google Fit
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Oura Ring */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>💍</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Oura Ring (Sen, HRV, Aktywność)</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_oura ? 'var(--success-light)' : 'var(--text-dim)' }}>
                    {userProfile.has_oura ? '✅ Połączono z kontem Oura' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              <div>
                {userProfile.has_oura ? (
                  <button
                    type="button"
                    className="btn-danger"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleDisconnect('oura')}
                  >
                    Odłącz Oura
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleConnect('oura')}
                    disabled={!settings.oura_client_id || !settings.oura_client_secret}
                    title={(!settings.oura_client_id || !settings.oura_client_secret) ? 'Wpisz Client ID i Secret, aby połączyć' : ''}
                  >
                    Połącz z Oura
                  </button>
                )}
              </div>
            </div>

            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOuraAdvancedOpen}
              onClick={() => setIsOuraAdvancedOpen(o => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOuraAdvancedOpen(o => !o); } }}
              style={{ fontSize: '0.8rem', color: '#60a5fa', cursor: 'pointer', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}
            >
              {isOuraAdvancedOpen ? '▲ Zwiń ustawienia Oura' : '▼ Zaawansowane (Client ID/Secret)'}
            </div>
            {isOuraAdvancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Oura Client ID</label>
                  <input
                    type="text"
                    name="oura_client_id"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.oura_client_id || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Oura Client ID..."
                  />
                </div>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Oura Client Secret</label>
                  <input
                    type="password"
                    name="oura_client_secret"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.oura_client_secret || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Oura Client Secret..."
                  />
                </div>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.05)', border: '1px solid rgba(251, 191, 36, 0.15)', padding: '10px', borderRadius: '8px', marginTop: '4px', lineHeight: '1.4' }}>
                ⚠️ <strong>Ważne:</strong> Upewnij się, że w konfiguracji Twojej aplikacji na
                <a href="https://cloud.ouraring.com/developer/manage" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline', marginLeft: '4px', marginRight: '4px' }}>
                  Oura Developer Portal
                </a> zaznaczyłeś zakresy (scopes) <strong>&quot;daily&quot;</strong> (dane dobowe), <strong>&quot;heartrate&quot;</strong> oraz <strong>&quot;personal&quot;</strong>. Bez tych zakresów API Oura zwróci błąd autoryzacji (401 - Token is not authorized access daily scope) i pobranie parametrów snu, gotowości oraz aktywności nie powiedzie się. Po zmianie zakresów na portalu Oura, odłącz i połącz Oura ponownie w aplikacji.
              </div>
            </div>
            )}
          </div>

          {/* Withings */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>⚖️</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Withings (Waga, Skład ciała)</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_withings ? 'var(--success-light)' : 'var(--text-dim)' }}>
                    {userProfile.has_withings ? '✅ Połączono z kontem Withings' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              <div>
                {userProfile.has_withings ? (
                  <button
                    type="button"
                    className="btn-danger"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleDisconnect('withings')}
                  >
                    Odłącz Withings
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleConnect('withings')}
                    disabled={!settings.withings_client_id || !settings.withings_client_secret}
                    title={(!settings.withings_client_id || !settings.withings_client_secret) ? 'Wpisz Client ID i Secret, aby połączyć' : ''}
                  >
                    Połącz z Withings
                  </button>
                )}
              </div>
            </div>

            <div
              role="button"
              tabIndex={0}
              aria-expanded={isWithingsAdvancedOpen}
              onClick={() => setIsWithingsAdvancedOpen(o => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsWithingsAdvancedOpen(o => !o); } }}
              style={{ fontSize: '0.8rem', color: '#60a5fa', cursor: 'pointer', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}
            >
              {isWithingsAdvancedOpen ? '▲ Zwiń ustawienia Withings' : '▼ Zaawansowane (Client ID/Secret)'}
            </div>
            {isWithingsAdvancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Client ID</label>
                  <input
                    type="text"
                    name="withings_client_id"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_client_id || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Withings Client ID..."
                  />
                </div>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Client Secret</label>
                  <input
                    type="password"
                    name="withings_client_secret"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_client_secret || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Withings Client Secret..."
                  />
                </div>
                <div className="input-group" style={{ gridColumn: 'span 2' }}>
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Custom Redirect URI (Opcjonalnie)</label>
                  <input
                    type="text"
                    name="withings_redirect_uri"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_redirect_uri || ''}
                    onChange={handleInputChange}
                    placeholder="np. https://dietetyk.renacode.com/api/auth/withings/callback"
                  />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px', display: 'block' }}>
                    Domyślnie używany jest: <code>https://dietetyk.renacode.com/api/auth/withings/callback</code>. Jeżeli w portalu Withings Developer masz zarejestrowany inny adres (np. własna domena), wpisz go powyżej.
                  </span>
                </div>
              </div>
            </div>
            )}
          </div>

          {/* Apple Health (poprzez Health Auto Export) */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem' }}>🍏</span>
              <div>
                <strong style={{ display: 'block', color: '#fff' }}>Apple Health (Kroki, Kalorie, Minuty Aktywności)</strong>
                <span style={{ fontSize: '0.8rem', color: 'var(--success-light)' }}>
                  ✅ Webhook gotowy do skonfigurowania
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.5' }}>
                Dane aktywności z Apple Health docierają od razu (w przeciwieństwie do Oura, która finalizuje dobowe podsumowanie zwykle następnego ranka). Gdy obie integracje są aktywne, dane z Apple Health są traktowane jako bardziej wiarygodne dla kroków/kalorii/minut aktywności - Oura uzupełnia te wartości tylko wtedy, gdy Apple Health jeszcze nic nie przysłało dla danego dnia (albo przysłało same zera).
              </p>

              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.8rem' }}>URL webhooka (wklej w apce Health Auto Export)</label>
                <div className="code-block">
                  {/* syncToken jeszcze nie przyszedł z backendu (fetchSyncToken w App.jsx) -
                      pokazujemy informację o ładowaniu, a nie URL z puste/fałszywym tokenem. */}
                  <span style={!appleHealthWebhookUrl ? { color: 'var(--text-dim)', fontStyle: 'italic' } : undefined}>
                    {appleHealthWebhookUrl || 'Ładowanie tokenu...'}
                  </span>
                  <button type="button" className="btn-copy" onClick={handleCopyWebhookUrl} disabled={!appleHealthWebhookUrl}>
                    Kopiuj
                  </button>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleRegenerateToken}
                  disabled={isRegeneratingToken}
                  style={{ marginTop: '8px', width: '100%' }}
                >
                  {isRegeneratingToken ? 'Generowanie...' : 'Wygeneruj nowy losowy token'}
                </button>
              </div>

              <div
                role="button"
                tabIndex={0}
                aria-expanded={isAppleHealthInstructionsOpen}
                onClick={() => setIsAppleHealthInstructionsOpen(o => !o)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsAppleHealthInstructionsOpen(o => !o); } }}
                style={{ fontSize: '0.8rem', color: '#60a5fa', cursor: 'pointer' }}
              >
                {isAppleHealthInstructionsOpen ? '▲ Zwiń instrukcję' : '▼ Pokaż instrukcję konfiguracji (Health Auto Export)'}
              </div>
              {isAppleHealthInstructionsOpen && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', lineHeight: '1.6' }}>
                <strong style={{ color: 'var(--text-muted)' }}>Konfiguracja w apce Health Auto Export (iOS):</strong>
                <ol style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                  <li>Zainstaluj apkę <strong>Health Auto Export</strong> z App Store.</li>
                  <li>Przejdź do zakładki <strong>Automations</strong> i utwórz nową automatyzację typu <strong>REST API</strong>.</li>
                  <li>Wklej powyższy URL jako adres docelowy, format danych: <strong>JSON</strong>.</li>
                  <li>Wybierz metryki: <strong>Steps</strong>, <strong>Active Energy</strong>, <strong>Basal Energy Burned</strong>, <strong>Apple Exercise Time</strong>.</li>
                  <li>Ustaw harmonogram automatycznego wysyłania (np. co godzinę) lub wysyłaj ręcznie.</li>
                </ol>
              </div>
              )}
            </div>
          </div>

          {/* Gemini AI API Key */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem' }}>🤖</span>
              <div>
                <strong style={{ display: 'block', color: '#fff' }}>Gemini AI (Inteligentne Analizy i Wskazówki)</strong>
                <span style={{ fontSize: '0.8rem', color: settings.gemini_api_key ? 'var(--success-light)' : 'var(--text-dim)' }}>
                  {settings.gemini_api_key ? '✅ Klucz skonfigurowany' : '❌ Brak skonfigurowanego klucza'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.8rem' }}>Gemini API Key</label>
                <input
                  type="password"
                  name="gemini_api_key"
                  className="input-field"
                  style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                  value={settings.gemini_api_key || ''}
                  onChange={handleInputChange}
                  placeholder="Wpisz swój klucz API Gemini..."
                />
              </div>
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={isSaving} style={{ width: '100%', padding: '12px', marginTop: '10px' }}>
            {isSaving ? 'Zapisywanie...' : 'Zapisz poświadczenia integracji'}
          </button>
        </form>
      </div>
    </div>
  );
}
