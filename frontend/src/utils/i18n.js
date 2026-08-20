// Słownik tłumaczeń: polskie zdanie źródłowe -> angielskie.
//
// ZNANE OGRANICZENIE tego podejścia: kluczem jest sam polski tekst, więc każda
// korekta polskiego copy (nawet literówki albo kropki) zrywa tłumaczenie po cichu -
// t() zwraca wtedy polski string również w trybie angielskim, bez błędu i bez
// ostrzeżenia. Tak właśnie powstał commit 6538e08: zmiana nazwy zakładki wyszła na
// jaw dopiero przez przypadkowo powiązany test e2e.
//
// Docelowo klucze powinny być semantyczne ("nav.mealLogger"), ale to przepisanie
// ~280 miejsc wywołania. Do tego czasu zamykamy samą klasę błędu dwoma tanimi
// zabezpieczeniami:
//   1. t() krzyczy w konsoli przy braku tłumaczenia (tylko w dev, raz na klucz),
//   2. `npm run check-i18n` skanuje wszystkie wywołania t('...') w kodzie i wykrywa
//      rozjazd ze słownikiem, zanim trafi on na produkcję (patrz scripts/check-i18n.js).
const TRANSLATIONS = {
  // Navigation / Tabs
  "Dashboard": "Dashboard",
  "Kalkulator Posiłków": "Meal Logger",
  "Aktywność": "Activity",
  "Trendy": "Trends",
  "Ustawienia": "Settings",
  "Panel Admina": "Admin Panel",

  // Login / Register
  "Zaloguj się": "Sign In",
  "Rejestracja": "Register",
  "Zarejestruj się": "Register",
  "Nazwa użytkownika": "Username",
  "Hasło": "Password",
  "Powtórz hasło": "Confirm Password",
  "Email (opcjonalny)": "Email (optional)",
  "Zaloguj przez Google": "Sign in with Google",
  "Weryfikacja dwuetapowa (2FA)": "Two-Factor Authentication (2FA)",
  "Wpisz 6-cyfrowy kod z aplikacji Google Authenticator:": "Enter the 6-digit code from Google Authenticator:",
  "Zweryfikuj kod": "Verify Code",
  "Błąd połączenia z serwerem.": "Server connection error.",
  "Hasła nie są identyczne.": "Passwords do not match.",
  "Błąd rejestracji.": "Registration error.",

  // Dashboard General
  "Dzisiejsze Podsumowanie": "Today's Summary",
  "Porada Dietetyka AI": "AI Dietician Advice",
  "Treningi (Apple Health)": "Workouts (Apple Health)",
  "Pomiary Ciała (Withings)": "Body Measurements (Withings)",
  "Gotowość i Sen (Oura)": "Readiness & Sleep (Oura)",
  "Zmień datę:": "Change date:",
  "Ostatnia synchronizacja:": "Last sync:",
  "brak synchronizacji": "no synchronization",
  "Zsynchronizuj dane": "Sync Data",
  "Synchronizacja...": "Syncing...",
  "Kalorie": "Calories",
  "Białko": "Protein",
  "Węglowodany": "Carbs",
  "Tłuszcz": "Fat",
  "Błonnik": "Fiber",
  "Cukry": "Sugar",
  "Sód": "Sodium",
  "cel:": "target:",
  "zjedzone:": "eaten:",
  "spalone:": "burned:",
  "pozostało:": "remaining:",
  "przekroczone o:": "exceeded by:",
  "Podstawowa przemiana materii (BMR)": "Basal metabolic rate (BMR)",
  "Aktywne kalorie spalone": "Active calories burned",
  "Wydalona energia (całkowita)": "Total energy burned",
  "Bilans netto": "Net balance",
  "Wypita woda": "Water Intake",
  "Suplementy": "Supplements",
  "brak zapisanych suplementów": "no supplements logged",
  "Treningi zarejestrowane dzisiaj": "Workouts logged today",
  "brak zarejestrowanych treningów": "no registered workouts",
  "Średnie odżywianie z ostatnich 7 dni:": "Avg nutrition (7 days):",
  "Średnie odżywianie z ostatnich 30 dni:": "Avg nutrition (30 days):",
  "Passa kaloryczna:": "Calorie target streak:",
  "Passa snu:": "Sleep target streak:",
  "Wynik Snu": "Sleep Score",
  "Wynik Gotowości": "Readiness Score",
  "Tętno spoczynkowe": "Resting HR",
  "Czas trwania snu": "Sleep duration",
  "Waga ciała": "Body weight",
  "Tkanka tłuszczowa": "Body fat",
  "Masa mięśniowa": "Muscle mass",
  "Ciśnienie tętnicze": "Blood pressure",
  "Obwody ciała": "Body circumferences",
  "Ładowanie porad dietetyka...": "Loading dietician advice...",
  "Brak wprowadzonych posiłków dla tego dnia.": "No meals logged for this day.",
  "Dzisiejsze Posiłki": "Today's Meals",

  // Meal Logger
  "Kalkulator posiłków i makroskładników": "Meal & Macronutrient Logger",
  "Opisz swój posiłek lub wklej tekst, a AI wyliczy kalorie i makroskładniki.": "Describe your meal or paste text, and AI will estimate calories and macros.",
  "np. jajecznica z 3 jajek na maśle, 2 kromki chleba żytniego": "e.g., 3 scrambled eggs cooked in butter, 2 slices of rye bread",
  "Wybierz plik (JPG, PNG, WebP)...": "Choose image file (JPG, PNG, WebP)...",
  "Analizuj posiłek przez AI": "Analyze meal with AI",
  "Dodawanie...": "Adding...",
  "Najczęściej powtarzające się posiłki (szybkie dodawanie):": "Most frequent meals (quick add):",
  "Dodaj ponownie": "Add again",
  "Nazwa posiłku / opis": "Meal name / description",
  "Komentarz dietetyka": "Dietician comment",
  "Ocena zdrowia": "Health rating",
  "Usuń": "Delete",

  // Activity Tracker
  "Dziennik aktywności i parametrów zdrowotnych": "Activity & Health Parameter Log",
  "Zapisz dane zdrowotne": "Save Health Data",
  "Zapisywanie...": "Saving...",
  "Kroki": "Steps",
  "Aktywne minuty": "Active minutes",
  "Dystans (metry)": "Distance (meters)",
  "Czas siedzący (minuty)": "Sedentary time (minutes)",
  "Niska aktywność (minuty)": "Light activity (minutes)",
  "Tętno spoczynkowe (RHR)": "Resting Heart Rate (RHR)",
  "Zmienność tętna (HRV)": "Heart Rate Variability (HRV)",
  "Wynik snu (0-100)": "Sleep score (0-100)",
  "Czas snu (godziny)": "Sleep duration (hours)",
  "Sen głęboki (godziny)": "Deep sleep (hours)",
  "Sen REM (godziny)": "REM sleep (hours)",
  "Wynik gotowości (Readiness, 0-100)": "Readiness score (0-100)",
  "Stres - wysoki (minuty)": "High stress (minutes)",
  "Stres - regeneracja (minuty)": "Stress recovery (minutes)",
  "Opis stresu": "Stress description",
  "Odchylenie temperatury (°C)": "Temperature deviation (°C)",
  "Temperatura nadgarstka (°C)": "Wrist temperature (°C)",
  "Częstość oddechów (oddechy/min)": "Respiratory rate (breaths/min)",
  "Utlenowanie krwi (SpO2, %)": "Blood oxygen (SpO2, %)",
  "Waga (kg)": "Weight (kg)",
  "Procent tłuszczu (%)": "Body fat percentage (%)",
  "Masa mięśniowa (kg)": "Muscle mass (kg)",
  "Ciśnienie skurczowe (mmHg)": "Systolic blood pressure (mmHg)",
  "Ciśnienie rozkurczowe (mmHg)": "Diastolic blood pressure (mmHg)",
  "Pas (cm)": "Waist (cm)",
  "Pas +2cm (cm)": "Waist +2cm (cm)",
  "Pas -2cm (cm)": "Waist -2cm (cm)",
  "Klatka piersiowa (cm)": "Chest (cm)",
  "Barki (cm)": "Shoulders (cm)",
  "Biodra (cm)": "Hips (cm)",
  "Biceps (cm)": "Biceps (cm)",
  "Biceps lewy (cm)": "Left biceps (cm)",
  "Biceps prawy (cm)": "Right biceps (cm)",
  "Udo (cm)": "Thigh (cm)",
  "Wypita woda (ml)": "Water intake (ml)",
  "Suplementy (oddzielone średnikami)": "Supplements (separated by semicolons)",
  "Energia (1-5)": "Energy level (1-5)",
  "Nastrój (1-5)": "Mood (1-5)",

  // Trends
  "Trendy i Analiza Długoterminowa": "Trends & Long-Term Analysis",
  "Waga i Skład Ciała": "Weight & Body Composition",
  "Kalorie i Makroskładniki": "Calories & Macronutrients",
  "Wskaźniki Zdrowotne": "Health Indicators",
  "Waga i tkanka tłuszczowa": "Weight and Body Fat",
  "Kaloryczność i bilans netto": "Calorie Intake & Net Balance",
  "Rozkład makroskładników (średnia 7-dniowa)": "Macronutrient Distribution (7-day average)",
  "Tętno spoczynkowe i HRV": "Resting Heart Rate and HRV",
  "Sen i gotowość": "Sleep and Readiness",
  "Brak danych do wyświetlenia wykresów.": "No data to display charts.",

  // Settings
  "Ustawienia Profilu i Integracji": "Profile & Integration Settings",
  "Dane Profilu": "Profile Data",
  "Imię": "First Name",
  "Nazwisko": "Last Name",
  "Rok urodzenia": "Birth Year",
  "Awatar": "Avatar",
  "Zmień awatar": "Change avatar",
  "Dwuskładnikowa autoryzacja (2FA)": "Two-Factor Authentication (2FA)",
  "Status 2FA:": "2FA Status:",
  "Włączone": "Enabled",
  "Wyłączone": "Disabled",
  "Włącz 2FA": "Enable 2FA",
  "Wyłącz 2FA": "Disable 2FA",
  "Dwuskładnikowa autoryzacja (2FA) - konfiguracja": "Two-Factor Authentication (2FA) - Setup",
  "Zeskanuj poniższy kod QR w aplikacji uwierzytelniającej (np. Google Authenticator), a następnie wpisz wygenerowany 6-cyfrowy kod, aby potwierdzić włączenie 2FA.": "Scan the QR code below in your authenticator app (e.g., Google Authenticator), then enter the generated 6-digit code to confirm enabling 2FA.",
  "Wpisz 6-cyfrowy kod:": "Enter 6-digit code:",
  "Potwierdź i włącz 2FA": "Confirm and Enable 2FA",
  "Dwuskładnikowa autoryzacja (2FA) - wyłączenie": "Two-Factor Authentication (2FA) - Disable",
  "Wpisz 6-cyfrowy kod z aplikacji uwierzytelniającej, aby potwierdzić wyłączenie 2FA.": "Enter the 6-digit code from your authenticator app to confirm disabling 2FA.",
  "Potwierdź i wyłącz": "Confirm and Disable",
  "Zabezpieczenia & Hasło": "Security & Password",
  "Aktualne hasło": "Current Password",
  "Nowe hasło": "New Password",
  "Potwierdź nowe hasło": "Confirm New Password",
  "Zmień hasło": "Change Password",
  "Raporty Okresowe (Email)": "Periodic Reports (Email)",
  "Wysyłaj cotygodniowe podsumowanie": "Send weekly summary",
  "Dzień wysyłki (1 = Poniedziałek, 7 = Niedziela)": "Send day (1 = Monday, 7 = Sunday)",
  "Godzina wysyłki": "Send time",
  "Wysyłaj comiesięczne podsumowanie": "Send monthly summary",
  "Dzień miesiąca (1-28)": "Day of the month (1-28)",
  "Opcje Integracji": "Integration Options",
  "Token synchronizacji": "Sync Token",
  "Klucz API Gemini (opcjonalny dla admina)": "Gemini API Key (optional for admin)",
  "Zapisz ustawienia integracji": "Save integration settings",
  "Cele Dietetyczne": "Dietary Targets",
  "Domyślny cel kaloryczny (kcal)": "Default calorie target (kcal)",
  "Docelowe białko (g)": "Target protein (g)",
  "Docelowe węglowodany (g)": "Target carbohydrates (g)",
  "Docelowy tłuszcz (g)": "Target fat (g)",
  "Cel nawodnienia (ml)": "Hydration target (ml)",
  "Zapisz cele": "Save targets",
  "Cel Sylwetki i Wagi": "Body & Weight Goals",
  "Opisz swój cel sylwetki (np. redukcja tłuszczu, budowa masy mięśniowej, poprawa kondycji)": "Describe your body goal (e.g., fat loss, muscle gain, conditioning)",
  "Zdjęcie referencyjne celu (opcjonalne, max 3MB)": "Reference goal photo (optional, max 3MB)",
  "Docelowa waga ciała (kg)": "Target body weight (kg)",
  "Docelowy procent tkanki tłuszczowej (%)": "Target body fat percentage (%)",
  "Zapisz cele sylwetki": "Save body goals",
  "Usuwanie Konta": "Account Deletion",
  "Usunięcie konta jest nieodwracalne. Wszystkie Twoje dane zostaną trwale usunięte z bazy danych.": "Account deletion is permanent. All your data will be permanently removed from the database.",
  "Usuń moje konto trwale": "Delete my account permanently",

  // General Dialogs / Messages
  "Ustawienia zostały zaktualizowane.": "Settings updated.",
  "Błąd zapisu ustawień.": "Error saving settings.",
  "Zapisz zmiany": "Save Changes",
  "Anuluj": "Cancel",
  "Wyloguj": "Log Out",
  "Sesja wygasła. Zaloguj się ponownie.": "Session expired. Please log in again.",
  "Błąd pobierania profilu.": "Error fetching user profile.",
  "Brak klucza API": "Missing API Key",

  // Language selectors
  "Język": "Language",
  "Polski": "Polish",
  "Angielski": "English",
  "Wybierz język:": "Select language:",

  // Chat translations
  "Twój osobisty asystent żywieniowy.": "Your personal nutrition assistant.",
  "Cześć! Jestem Twoim inteligentnym asystentem w aplikacji Dietetyk AI. Przeanalizowałem Twoje dzisiejsze wyniki gotowości (Readiness), snu oraz treningów. W czym mogę Ci pomóc w kontekście diety lub obciążenia treningowego?": "Hi! I am your intelligent assistant in the Dietetyk AI app. I have analyzed your readiness, sleep, and workouts. How can I help you today regarding diet or training load?",
  "Jak wygląda mój sen w tym tygodniu?": "How is my sleep looking this week?",
  "Czy jestem blisko celu kalorycznego?": "Am I close to my calorie target?",
  "Jak moja regeneracja po ostatnim treningu?": "How is my recovery after the last workout?",
  "Coś niepokojącego w moich danych?": "Anything concerning in my data?",
  "Dietetyk AI myśli...": "Dietetyk AI is thinking...",
  "Zapytaj agenta np. o swój dzisiejszy sen...": "Ask the agent e.g. about your sleep today..."
};

let currentLang = localStorage.getItem("language") || "pl";

export function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem("language", lang);
}

export function getLanguage() {
  return currentLang;
}

// Ostrzegamy o brakującym tłumaczeniu tylko RAZ na klucz - inaczej komponent
// renderowany w pętli zalałby konsolę i ostrzeżenie przestałoby być czytelne.
const warnedMissing = new Set();

/**
 * Tłumaczy tekst i podstawia zmienne.
 *
 * @param {string} text polskie zdanie źródłowe (klucz)
 * @param {Object} [vars] wartości do podstawienia pod {nazwa}
 *
 * Interpolacja istnieje po to, żeby nie sklejać zdań z kawałków
 * (`t('Zostało') + n + t('dni')`) - taka konstrukcja jest nieprzetłumaczalna,
 * bo szyk zdania różni się między językami.
 */
export function t(text, vars) {
  let result = text;

  if (currentLang === "en") {
    const translated = TRANSLATIONS[text];
    if (translated === undefined) {
      // import.meta.env.DEV jest podmieniane przez Vite na stałą przy budowaniu,
      // więc cały ten blok znika z bundla produkcyjnego.
      if (import.meta.env.DEV && !warnedMissing.has(text)) {
        warnedMissing.add(text);
        console.warn(
          `[i18n] Brak tłumaczenia EN dla: "${text}"\n` +
          `       Prawdopodobnie zmieniono polskie copy bez aktualizacji utils/i18n.js. ` +
          `Uruchom "npm run check-i18n", żeby zobaczyć pełną listę.`
        );
      }
    } else {
      result = translated;
    }
  }

  if (vars) {
    result = result.replace(/\{(\w+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  return result;
}

// Eksport słownika wyłącznie na potrzeby skryptu kontrolnego (scripts/check-i18n.js).
// Nie używać w komponentach - do tłumaczenia służy t().
export const __TRANSLATIONS_FOR_CHECK = TRANSLATIONS;
