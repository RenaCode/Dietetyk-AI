const { test, expect } = require('@playwright/test');

test.describe('Dashboard i Funkcjonalność UI', () => {
  // Zaloguj się przed każdym testem w tym bloku
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
  });

  test('Weryfikacja układu i braku rozjechania w premium dashboard', async ({ page }) => {
    // Sprawdzenie obecności głównych kolumn i baneru
    const banner = page.locator('.dietetyk-ai-banner');
    await expect(banner).toBeVisible();

    // Sprawdzenie statusu synchronizacji - upewnienie się, że gridColumn: 'span 2' jest obecny w stylu
    const syncStatus = page.locator('[data-testid="status-sync-bar"]');
    await expect(syncStatus).toBeVisible();

    const styleAttr = await syncStatus.getAttribute('style');
    expect(styleAttr).toContain('grid-column: span 2');

    // Sprawdzenie kolumn dashboardu
    const columns = page.locator('.dashboard-column');
    await expect(columns).toHaveCount(2);
  });

  test('Obsługa licznika nawodnienia (Dodawanie i Reset wody)', async ({ page }) => {
    // Automatycznie akceptuj okna dialogowe (np. confirm przy resecie wody)
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    // 1. Zlokalizuj kartę nawodnienia
    const waterCard = page.locator('.premium-card:has-text("💧 Nawodnienie")');
    await expect(waterCard).toBeVisible();

    // Opcjonalnie zresetuj na start, by mieć stabilny stan początkowy
    const resetButton = waterCard.locator('button:has-text("Reset")');
    await resetButton.click();
    await page.waitForTimeout(500); // krótka pauza na aktualizację stanu bazy

    // 2. Sprawdź początkową wartość
    await expect(waterCard).toContainText('0 /');

    // 3. Kliknij "+250 ml"
    const add250Button = waterCard.locator('button:has-text("+250 ml")');
    await add250Button.click();

    // Weryfikacja zmiany w UI
    await expect(waterCard).toContainText('250 /');

    // 4. Kliknij "+500 ml"
    const add500Button = waterCard.locator('button:has-text("+500 ml")');
    await add500Button.click();

    // Weryfikacja (250 + 500 = 750)
    await expect(waterCard).toContainText('750 /');

    // 5. Reset licznika wody
    await resetButton.click();
    await expect(waterCard).toContainText('0 /');
  });

  test('Nawigacja po zakładkach aplikacji', async ({ page }) => {
    const tabs = ['Kalkulator Posiłków', 'Trendy', 'Aktywność', 'Ustawienia'];

    for (const tabName of tabs) {
      // Kliknij zakładkę
      await page.click(`.nav-tab:has-text("${tabName}")`);
      
      // Sprawdź czy zakładka jest aktywna
      const activeTab = page.locator('.nav-tab.active');
      await expect(activeTab).toContainText(tabName);

      // Dodatkowe sprawdzenia renderowania komponentów dla danej zakładki
      if (tabName === 'Kalkulator Posiłków') {
        await expect(page.locator('.logger-card')).toBeVisible();
      } else if (tabName === 'Trendy') {
        await expect(page.locator('h2:has-text("Twoje wykresy")')).toBeVisible();
      } else if (tabName === 'Aktywność') {
        await expect(page.locator('h3:has-text("Cele Aktywności")')).toBeVisible();
      } else if (tabName === 'Ustawienia') {
        await expect(page.locator('h3:has-text("Twój Profil i Avatar")')).toBeVisible();
      }
    }
  });

  test('Obsługa treningów Apple Health (Dynamiczne rozciąganie, filtrowanie i ikona bokserska)', async ({ page, request }) => {
    // 1. Połącz się z bazą danych, aby wyciągnąć sync_token użytkownika admin
    const sqlite3 = require('../backend/node_modules/sqlite3').verbose();
    const path = require('path');
    const dbPath = path.join(__dirname, '../backend/dietetyk.db');
    const db = new sqlite3.Database(dbPath);
    
    const getSyncToken = () => {
      return new Promise((resolve, reject) => {
        db.get("SELECT sync_token FROM users WHERE username = 'admin'", (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.sync_token : null);
        });
      });
    };
    
    const syncToken = await getSyncToken();
    expect(syncToken).not.toBeNull();
    db.close();

    // 2. Dodaj dwa treningi (Boks i Bieg) na dzisiejszy dzień przez webhook Apple Health
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    
    // Wczorajsza data do testu filtrowania
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const yY = yesterday.getFullYear();
    const yM = String(yesterday.getMonth() + 1).padStart(2, '0');
    const yD = String(yesterday.getDate()).padStart(2, '0');
    const yesterdayDateStr = `${yY}-${yM}-${yD}`;
    
    const startStrBox = `${dateStr} 10:00:00 +0200`;
    const startStrRun = `${dateStr} 15:30:00 +0200`;

    // Wyślij żądanie POST pod webhook synchronizacji Apple Health
    const response = await request.post(`/api/integrations/apple-health/${syncToken}`, {
      data: {
        data: {
          workouts: [
            {
              id: 'playwright-test-box-1',
              name: 'Box',
              start: startStrBox,
              end: `${dateStr} 11:00:00 +0200`,
              duration: 3600, // 60 minut
              activeEnergyBurned: {
                qty: 650,
                units: 'kcal'
              }
            },
            {
              id: 'playwright-test-run-1',
              name: 'Running',
              start: startStrRun,
              end: `${dateStr} 16:00:00 +0200`,
              duration: 1800, // 30 minut
              activeEnergyBurned: {
                qty: 400,
                units: 'kcal'
              }
            }
          ]
        }
      }
    });

    expect(response.ok()).toBe(true);
    const responseJson = await response.json();
    expect(responseJson.status).toBe('ok');

    // 3. Przeładuj stronę i upewnij się, że jesteśmy zalogowani
    await page.goto('/');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');

    // Znajdź sekcję "Trening"
    const trainingCard = page.locator('.premium-card:has-text("Trening ⓘ")');
    await expect(trainingCard).toBeVisible();

    // Sprawdź czy oba treningi są wyświetlone
    const workoutsList = trainingCard.locator('.premium-workout-card');
    await expect(workoutsList).toHaveCount(2);

    // Box -> 60 min, 650 kcal, ikona 🥊
    const boxCard = trainingCard.locator('.premium-workout-card:has-text("Box")');
    await expect(boxCard).toBeVisible();
    await expect(boxCard.locator('.premium-workout-icon-box')).toContainText('🥊');
    await expect(boxCard).toContainText('60 min');
    await expect(boxCard).toContainText('650 kcal');

    // Running -> 30 min, 400 kcal, ikona 🏃
    const runCard = trainingCard.locator('.premium-workout-card:has-text("Running")');
    await expect(runCard).toBeVisible();
    await expect(runCard.locator('.premium-workout-icon-box')).toContainText('🏃');
    await expect(runCard).toContainText('30 min');
    await expect(runCard).toContainText('400 kcal');

    // 4. Zweryfikuj filtrowanie daty: przełącz na wczorajszą datę i upewnij się, że te treningi NIE są tam wyświetlane.
    const dateInput = page.locator('.date-input');
    await dateInput.fill(yesterdayDateStr);
    await page.waitForTimeout(500); // krótka pauza na aktualizację stanu bazy

    const yesterdayBox = trainingCard.locator('.premium-workout-card:has-text("Box")');
    await expect(yesterdayBox).not.toBeVisible();
    
    const yesterdayRun = trainingCard.locator('.premium-workout-card:has-text("Running")');
    await expect(yesterdayRun).not.toBeVisible();

    // Przywróć dzisiejszą datę
    await dateInput.fill(dateStr);
    await page.waitForTimeout(500);
  });

  test('Obsługa zapisywania suplementów i weryfikacja historii na Dashboardzie', async ({ page }) => {
    const initialResponsePromise = page.waitForResponse(response => response.url().includes('/api/dashboard') && response.status() === 200);
    await page.goto('/');
    await initialResponsePromise;

    // App.jsx odpala przy montowaniu RÓWNOLEGLE kilka zapytań (fetchDashboardData,
    // fetchSyncToken, fetchUserProfile - patrz App.jsx ~linia 168). Sam /api/dashboard
    // (initialResponsePromise powyżej) mógł już wrócić, podczas gdy pozostałe wciąż
    // trwają - jeśli jedno z nich odświeży stan/props Dashboardu PO tym, jak zaczniemy
    // wpisywać suplementy, pole może zostać zresetowane (Dashboard.jsx ~linia 242,
    // useEffect zależny od summary?.supplements/summary?.date). Czekamy więc na
    // uspokojenie sieci PRZED interakcją, żeby nie łapać się w to okno.
    await page.waitForLoadState('networkidle');

    const supplementsCard = page.locator('.premium-card:has-text("Suplementy")');
    await expect(supplementsCard).toBeVisible();

    const textarea = supplementsCard.locator('textarea');
    await expect(textarea).toBeVisible();

    // Wpisz testowe suplementy (kreatyna i multiwitamina)
    const testSups = 'Kreatyna, Multiwitamina 7Nutrition';
    await textarea.fill(testSups);
    try {
      await expect(textarea).toHaveValue(testSups, { timeout: 3000 }); // Upewnij się, że wartość została wpisana przed zapisem (uniknięcie race condition w React)
    } catch {
      // Jednorazowy retry - na wolniejszym CI runnerze wciąż może się zdarzyć spóźniony
      // re-render zerujący pole tuż po fill() (patrz komentarz o networkidle powyżej).
      // Jeśli PO retry pole nadal jest puste, test i tak poprawnie się wywali niżej.
      await textarea.fill(testSups);
      await expect(textarea).toHaveValue(testSups, { timeout: 5000 });
    }

    // Zapisz suplementy
    const saveButton = supplementsCard.locator('button:has-text("Zapisz")');
    await saveButton.click();

    // Weryfikacja komunikatu o sukcesie w UI
    await expect(supplementsCard).toContainText('Zapisano suplementy!');

    // Weryfikacja historii (powinna się zaktualizować od razu i pokazać ikony oraz aktywność)
    await expect(supplementsCard).toContainText('Historia suplementacji');
    await expect(supplementsCard).toContainText('Aktywność:');

    // Sprawdź, czy ikony suplementów są widoczne w historii (⚡ i 🧬 dla naszych testowych supli)
    await expect(supplementsCard.locator('span:text("⚡")').first()).toBeVisible();
    await expect(supplementsCard.locator('span:text("🧬")').first()).toBeVisible();

    // Odśwież stronę i upewnij się, że wartość się zachowała w bazie i wczytała z powrotem
    const reloadResponsePromise = page.waitForResponse(response => response.url().includes('/api/dashboard') && response.status() === 200);
    await page.reload();
    await reloadResponsePromise;
    // Jak wyżej - poczekaj na uspokojenie sieci (fetchSyncToken/fetchUserProfile
    // odpalone przy tym samym montowaniu), zanim odczytamy wartość pola.
    await page.waitForLoadState('networkidle');
    await expect(supplementsCard).toBeVisible();
    await expect(supplementsCard.locator('textarea')).toHaveValue(testSups, { timeout: 10000 });
  });

  test('Weryfikacja lokalizacji kafelka Waga i Skład Ciała w drugiej kolumnie', async ({ page }) => {
    await page.goto('/');

    // Pierwsza kolumna nie powinna zawierać tekstu "Waga i Skład Ciała"
    const col1 = page.locator('.dashboard-column').first();
    await expect(col1).not.toContainText('Waga i Skład Ciała');

    // Druga kolumna powinna zawierać tekst "Waga i Skład Ciała"
    const col2 = page.locator('.dashboard-column').nth(1);
    await expect(col2).toContainText('Waga i Skład Ciała');
  });
});

