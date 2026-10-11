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

  // Google sign-in was removed on 2026-10-11. The login screen must not offer it, must not ask
  // the backend about it, and a stale Google return URL must not produce an error or a login.
  test('Nie powinno pokazywać logowania przez Google ani pytać o nie backendu', async ({ page }) => {
    const googleRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/google')) googleRequests.push(req.url());
    });
    await page.goto('/?google_error=auth_failed#google_code=gx_stale');
    await expect(page.locator('button:has-text("Dalej")')).toBeVisible();
    await expect(page.locator('button:has-text("Google")')).toHaveCount(0);
    await expect(page.locator('.alert-error')).toHaveCount(0);
    expect(googleRequests).toEqual([]);
  });
});
