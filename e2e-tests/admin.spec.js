const { test, expect } = require('@playwright/test');

// Admin actions need the admin's own password (audit D-4): the panel asks for it in a dialog
// instead of the browser's confirm(), keeps the dialog open on a wrong one, and the backend
// refuses the bare request.
const ADMIN_PASSWORD = '3bda877d518c8cf7a80b32bb';

test.describe('Panel admina: akcje potwierdzane hasłem administratora', () => {
  test('wymuszenie 2FA pyta o hasło, odrzuca złe i wykonuje z dobrym', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', ADMIN_PASSWORD);
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    const token = await page.evaluate(() => localStorage.getItem('diet_session_token'));
    const auth = { Authorization: `Bearer ${token}` };

    // The API itself: no password, no change.
    const bare = await page.request.post('/api/admin/config', { headers: auth, data: { allow_public_registration: '1' } });
    expect(bare.status()).toBe(403);
    expect((await bare.json()).requirePassword).toBe(true);

    // A target account, made through public registration switched on for the moment.
    const on = await page.request.post('/api/admin/config', { headers: auth, data: { allow_public_registration: '1', currentPassword: ADMIN_PASSWORD } });
    expect(on.status()).toBe(200);
    const username = 'e2e_target_' + Date.now().toString(36);
    const reg = await page.request.post('/api/register-public', { data: { username, password: 'targetpass123' } });
    expect(reg.status()).toBe(200);
    const off = await page.request.post('/api/admin/config', { headers: auth, data: { allow_public_registration: '0', currentPassword: ADMIN_PASSWORD } });
    expect(off.status()).toBe(200);

    await page.goto('/?tab=admin');
    const row = page.locator('tr', { hasText: username });
    await row.getByRole('button', { name: 'Wymuś 2FA' }).click();

    const dialog = page.locator('[data-testid="admin-password-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(username);

    // Empty: refused in the dialog, nothing sent.
    await dialog.getByRole('button', { name: 'Wymuś 2FA' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Wpisz swoje hasło administratora.');

    // Wrong: the server's refusal shows in the dialog, which stays open.
    await dialog.locator('#admin-password-input').fill('not-the-password-1');
    await dialog.getByRole('button', { name: 'Wymuś 2FA' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Niepoprawne hasło.');
    await expect(row).not.toContainText('Wymuszone');

    // Right: the action runs, the dialog closes, the row shows the result.
    await dialog.locator('#admin-password-input').fill(ADMIN_PASSWORD);
    await dialog.getByRole('button', { name: 'Wymuś 2FA' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.alert-success')).toContainText('Wymuszono 2FA');
    await expect(row).toContainText('Wymuszone');

    // Cancel leaves everything as it was.
    const deleteButton = row.getByRole('button', { name: 'Usuń' });
    await deleteButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#admin-password-input')).toBeFocused();
    // Tab stays inside the modal: from its last button back to the password field.
    await dialog.getByRole('button', { name: 'Usuń' }).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('#admin-password-input')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Usuń' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Anuluj' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    // Focus returns to the button that opened the dialog.
    await expect(deleteButton).toBeFocused();
  });
});
