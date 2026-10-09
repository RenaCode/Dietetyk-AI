const { test, expect } = require('@playwright/test');

// W1 (audit 2026-10-09): when GET /api/settings failed, the targets form showed
// 2500/1800/150/250/80/2500 next to "Could not load the settings", and "Save targets" wrote
// those defaults over the user's real targets and BMR - then reported success.
test.describe('Ustawienia: zapis celów po nieudanym wczytaniu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
  });

  test('nie pokazuje domyślnych celów i blokuje zapis, gdy ustawienia się nie wczytały', async ({ page }) => {
    const posts = [];
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      } else {
        posts.push(route.request().postData());
        await route.continue();
      }
    });

    await page.click('.nav-tab:has-text("Ustawienia")');
    await page.click('h3:has-text("Twoje Cele Dietetyczne")');

    await expect(page.locator('text=Zapis jest zablokowany').first()).toBeVisible();
    await expect(page.locator('input[name="target_calories"]')).toHaveValue('');
    await expect(page.locator('input[name="bmr"]')).toHaveValue('');
    await expect(page.locator('button:has-text("Zapisz cele")')).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  test('po wczytaniu wysyła tylko zmienione pole', async ({ page }) => {
    const posts = [];
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'POST') posts.push(JSON.parse(route.request().postData()));
      await route.continue();
    });

    await page.click('.nav-tab:has-text("Ustawienia")');
    await page.click('h3:has-text("Twoje Cele Dietetyczne")');
    const protein = page.locator('input[name="target_protein"]');
    await expect(protein).not.toHaveValue('');
    await expect(page.locator('button:has-text("Zapisz cele")')).toBeEnabled();

    // A value different from the stored one, so the test also holds on a retry.
    const next = Number(await protein.inputValue()) + 1;
    await protein.fill(String(next));
    await page.click('button:has-text("Zapisz cele")');
    await expect(page.locator('text=Ustawienia zostały pomyślnie zaktualizowane!').first()).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ target_protein: next });
  });
});
