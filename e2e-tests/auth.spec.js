const { test, expect } = require('@playwright/test');

test.describe('Autoryzacja (Login i Logout)', () => {
  test('Powinno wyświetlić stronę logowania i zalogować administratora bez 2FA', async ({ page }) => {
    // 1. Open the home page
    await page.goto('/');

    // Verify the login page heading
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
    await expect(page.locator('p')).toContainText('Twój osobisty asystent żywieniowy.');

    // 2. Fill in the login form as admin
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');

    // 3. Click Continue / Sign in
    await page.click('button:has-text("Dalej")');

    // 4. We should land on the Dashboard (no 2FA for admin)
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    await expect(page.locator('.nav-tab.active')).toContainText('Dashboard');
    await expect(page.locator('.dietetyk-greeting')).toBeVisible();

    // 5. Wylogowanie
    await page.click('button:has-text("Wyloguj")');

    // 6. Back to the login page
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
  });

  test('Powinno zalogować administratora przy użyciu adresu e-mail', async ({ page }) => {
    await page.goto('/');
    // Use the admin email instead of the username
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin@dietetyk-ai.local');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');

    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    await expect(page.locator('.nav-tab.active')).toContainText('Dashboard');
    
    // Wylogowanie
    await page.click('button:has-text("Wyloguj")');
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
  });

  test('Powinno pokazać błąd przy niepoprawnych danych logowania', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'nieistniejacy_user');
    await page.fill('input[placeholder="Wpisz hasło..."]', 'blednehaslo');
    await page.click('button:has-text("Dalej")');

    // Verify the error message
    await expect(page.locator('.alert-error')).toBeVisible();
    await expect(page.locator('.alert-error')).toContainText('Niepoprawny użytkownik lub hasło');
  });
});
