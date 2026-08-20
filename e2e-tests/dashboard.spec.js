const { test, expect } = require('@playwright/test');

test.describe('Dashboard and UI behaviour', () => {
  // Sign in before each test in this block
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
  });

  test('verifies the premium dashboard layout has no broken alignment', async ({ page }) => {
    // Check that the main columns and the banner are present
    const banner = page.locator('.dietetyk-ai-banner');
    await expect(banner).toBeVisible();

    // Check the sync status - making sure gridColumn: 'span 2' is present in the style
    const syncStatus = page.locator('[data-testid="status-sync-bar"]');
    await expect(syncStatus).toBeVisible();

    const styleAttr = await syncStatus.getAttribute('style');
    expect(styleAttr).toContain('grid-column: span 2');

    // Checking the dashboard columns
    const columns = page.locator('.dashboard-column');
    await expect(columns).toHaveCount(2);
  });

  test('handles the hydration counter (adding and resetting water)', async ({ page }) => {
    // Auto-accept dialogs (the confirm when resetting water, for instance)
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    // 1. Locate the hydration card
    const waterCard = page.locator('.premium-card:has-text("💧 Nawodnienie")');
    await expect(waterCard).toBeVisible();

    // Optionally reset first, for a stable starting state
    const resetButton = waterCard.locator('button:has-text("Reset")');
    await resetButton.click();
    await page.waitForTimeout(500); // brief pause for the database state to update

    // 2. Check the initial value
    await expect(waterCard).toContainText('0 /');

    // 3. Kliknij "+250 ml"
    const add250Button = waterCard.locator('button:has-text("+250 ml")');
    await add250Button.click();

    // Verifying the change in the UI
    await expect(waterCard).toContainText('250 /');

    // 4. Kliknij "+500 ml"
    const add500Button = waterCard.locator('button:has-text("+500 ml")');
    await add500Button.click();

    // Verification (250 + 500 = 750)
    await expect(waterCard).toContainText('750 /');

    // 5. Resetting the water counter
    await resetButton.click();
    await expect(waterCard).toContainText('0 /');
  });

  test('navigates the application tabs', async ({ page }) => {
    const tabs = ['Kalkulator Posiłków', 'Trendy', 'Aktywność', 'Ustawienia'];

    for (const tabName of tabs) {
      // Click the tab
      await page.click(`.nav-tab:has-text("${tabName}")`);
      
      // Check the tab is active
      const activeTab = page.locator('.nav-tab.active');
      await expect(activeTab).toContainText(tabName);

      // Additional render checks for that tab's components
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

  test('handles Apple Health workouts (dynamic stretching, filtering and the boxing icon)', async ({ page, request }) => {
    // 1. Connect to the database to read the admin user's sync_token
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

    // 2. Add two workouts (boxing and running) for today through the Apple Health webhook
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

    // POST to the Apple Health sync webhook
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

    // 3. Reload the page and confirm we are still signed in
    await page.goto('/');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');

    // Find the workout section
    const trainingCard = page.locator('.premium-card:has-text("Trening ⓘ")');
    await expect(trainingCard).toBeVisible();

    // Check that both workouts are displayed
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

    // 4. Verify date filtering: switch to yesterday and confirm those workouts are NOT shown there.
    const dateInput = page.locator('.date-input');
    await dateInput.fill(yesterdayDateStr);
    await page.waitForTimeout(500); // brief pause for the database state to update

    const yesterdayBox = trainingCard.locator('.premium-workout-card:has-text("Box")');
    await expect(yesterdayBox).not.toBeVisible();
    
    const yesterdayRun = trainingCard.locator('.premium-workout-card:has-text("Running")');
    await expect(yesterdayRun).not.toBeVisible();

    // Restore today's date
    await dateInput.fill(dateStr);
    await page.waitForTimeout(500);
  });

  test('saves supplements and verifies the history on the Dashboard', async ({ page }) => {
    const initialResponsePromise = page.waitForResponse(response => response.url().includes('/api/dashboard') && response.status() === 200);
    await page.goto('/');
    await initialResponsePromise;

    // On mount App.jsx fires several requests IN PARALLEL (fetchDashboardData,
    // fetchSyncToken, fetchUserProfile - see App.jsx around line 168). /api/dashboard
    // itself (initialResponsePromise above) may already have returned while the others are
    // still in flight - and if one of them refreshes the Dashboard's state or props AFTER
    // we start typing supplements, the field can be reset (Dashboard.jsx around line 242,
    // a useEffect depending on summary?.supplements / summary?.date). So we wait for the
    // network to go idle BEFORE interacting, to avoid landing in that window.
    await page.waitForLoadState('networkidle');

    const supplementsCard = page.locator('.premium-card:has-text("Suplementy")');
    await expect(supplementsCard).toBeVisible();

    const textarea = supplementsCard.locator('textarea');
    await expect(textarea).toBeVisible();

    // Enter test supplements (creatine and a multivitamin)
    const testSups = 'Kreatyna, Multiwitamina 7Nutrition';
    await textarea.fill(testSups);
    try {
      await expect(textarea).toHaveValue(testSups, { timeout: 3000 }); // make sure the value was entered before saving
    } catch {
      // A single retry - on a slower CI runner a late re-render can still clear the field
      // right after fill() (see the networkidle comment above). If the field is still empty
      // AFTER the retry, the test will correctly fail below anyway.
      await textarea.fill(testSups);
      await expect(textarea).toHaveValue(testSups, { timeout: 5000 });
    }

    // Save the supplements
    const saveButton = supplementsCard.locator('button:has-text("Zapisz")');
    await saveButton.click();

    // Verifying the success message in the UI
    await expect(supplementsCard).toContainText('Zapisano suplementy!');

    // Verify the history (it should update immediately and show the icons and the activity)
    await expect(supplementsCard).toContainText('Historia suplementacji');
    await expect(supplementsCard).toContainText('Aktywność:');

    // Check that the supplement icons are visible in the history (⚡ and 🧬 for our test supli)
    await expect(supplementsCard.locator('span:text("⚡")').first()).toBeVisible();
    await expect(supplementsCard.locator('span:text("🧬")').first()).toBeVisible();

    // Reload the page and confirm the value persisted in the database and loaded back
    const reloadResponsePromise = page.waitForResponse(response => response.url().includes('/api/dashboard') && response.status() === 200);
    await page.reload();
    await reloadResponsePromise;
    // As above - wait for the network to go idle (fetchSyncToken/fetchUserProfile fired on
    // the same mount) before reading the field's value.
    await page.waitForLoadState('networkidle');
    await expect(supplementsCard).toBeVisible();
    await expect(supplementsCard.locator('textarea')).toHaveValue(testSups, { timeout: 10000 });
  });

  test('verifies the Waga i Skład Ciała tile sits in the second column', async ({ page }) => {
    await page.goto('/');

    // The first column should not contain the body composition heading
    const col1 = page.locator('.dashboard-column').first();
    await expect(col1).not.toContainText('Waga i Skład Ciała');

    // The second column should contain the body composition heading
    const col2 = page.locator('.dashboard-column').nth(1);
    await expect(col2).toContainText('Waga i Skład Ciała');
  });
});

