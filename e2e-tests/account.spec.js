const { test, expect } = require('@playwright/test');

// Audit round 2 (2026-10-10), UI parts of the account fixes.
test.describe('Konto: wymuszone 2FA, stare linki i brak Google', () => {
  // N-S5: the forced 2FA enrolment showed only the QR code, although the backend returns the
  // secret too - someone with only a phone could not scan their own screen.
  test('wymuszone 2FA pokazuje klucz tekstowy obok kodu QR', async ({ page }) => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DP';
    await page.route('**/api/login', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'setup_2fa', tempToken: 'temp_x', secret, qrCode: 'data:image/png;base64,iVBORw0KGgo=' })
    }));
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', 'whatever123');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('[data-testid="totp-secret"]')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP');
    await expect(page.locator('text=**Google Authenticator**')).toHaveCount(0);
  });

  // N-S2: the (since removed) Google flows returned to `?tab=settings`, a tab that does not
  // exist - an empty page. Old links still say it.
  test('powrót na ?tab=settings otwiera Ustawienia', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    await page.goto('/?tab=settings');
    await expect(page.locator('h3:has-text("Twój Profil i Avatar")')).toBeVisible();
  });

  // Google sign-in and Google Fit were removed on 2026-10-11: neither Settings nor the Admin
  // Panel may offer them any more (linking Google, "set a password via Google", Google Fit,
  // the Google OAuth client fields).
  test('Ustawienia i panel admina nie pokazują niczego z Google', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');

    await page.goto('/?tab=setup');
    await expect(page.locator('h3:has-text("Twój Profil i Avatar")')).toBeVisible();
    await page.locator('h3:has-text("Zmiana Hasła")').click();
    await expect(page.locator('text=Obecne hasło')).toBeVisible();
    for (const text of ['Konto Google', 'Połącz z Google', 'Google Fit', 'Ustaw hasło przez Google']) {
      await expect(page.getByText(text)).toHaveCount(0);
    }

    await page.goto('/?tab=admin');
    await expect(page.locator('text=Mailgun').first()).toBeVisible();
    await expect(page.getByText('Logowanie Google')).toHaveCount(0);
    await expect(page.getByText('Google Client ID')).toHaveCount(0);
  });
});
