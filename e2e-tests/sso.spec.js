const { test, expect } = require('@playwright/test');

// Single sign-on through Authelia (renacode-infra docs/sso-tozsamosc.md). The second web server
// in playwright.config.js runs with SSO_NAGLOWKI=1; these tests send the Remote-* headers that
// Traefik would add after Authelia's login. The account is the seeded admin, found by e-mail.
const SSO_URL = 'http://localhost:3001';
const owner = {
  'Remote-User': 'owner',
  // A different case than the stored address: the mapping ignores it.
  'Remote-Email': 'Owner@SSO-e2e.invalid',
  'Remote-Groups': 'admins',
  'Remote-Name': 'Owner'
};

test.describe('SSO on', () => {
  test.use({ baseURL: SSO_URL, extraHTTPHeaders: owner });

  test('signs in without the password form, e-mail read-only, logout through the portal', async ({ page }) => {
    // The portal is outside the test: answer for it, and record where the browser was sent.
    await page.route('https://auth.renacode.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>portal</body></html>' }));

    await page.goto('/');
    await expect(page.locator('.nav-tab.active')).toContainText('Dashboard');
    await expect(page.locator('input[placeholder="Wpisz hasło..."]')).toHaveCount(0);

    await page.click('.nav-tab:has-text("Ustawienia")');
    const email = page.locator('input[type="email"]').first();
    await expect(email).toHaveValue('owner@sso-e2e.invalid');
    await expect(email).toHaveAttribute('readonly', '');
    await expect(page.locator('text=To Twój login w portalu logowania (SSO).')).toBeVisible();

    await page.click('button:has-text("Wyloguj")');
    await page.waitForURL(/^https:\/\/auth\.renacode\.com\/logout\?rd=http%3A%2F%2Flocalhost%3A3001%2F$/);
  });
});

test.describe('SSO: unknown user', () => {
  test.use({ baseURL: SSO_URL, extraHTTPHeaders: { ...owner, 'Remote-User': 'obcy', 'Remote-Email': 'nobody@sso-e2e.invalid' } });

  test('gets a clear refusal instead of a new account', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.alert-error')).toContainText('Brak konta w Dietetyku dla adresu nobody@sso-e2e.invalid');
    await expect(page.locator('.nav-tab')).toHaveCount(0);
  });
});

test.describe('SSO off', () => {
  // The default server: no SSO_NAGLOWKI. A client sending the headers itself gets nothing.
  test.use({ extraHTTPHeaders: owner });

  test('forged headers do not sign anyone in', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('input[placeholder="Wpisz hasło..."]')).toBeVisible();
    await expect(page.locator('.nav-tab')).toHaveCount(0);
  });
});
