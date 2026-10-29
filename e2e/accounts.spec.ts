import { expect, test } from '@playwright/test';
import { PASSWORD, logIn, logOut } from './helpers.js';

test('LB-21: a new user logs in with the temporary password and must change it first', async ({ page }) => {
  await logIn(page, 'admin');
  await page.getByRole('button', { name: 'Users' }).click();
  const username = `new${Date.now().toString(36)}`;
  await page.getByPlaceholder('User ID').fill(username);
  await page.getByPlaceholder('Full name').fill('Neha New');
  await page.getByRole('button', { name: 'Add user' }).click();
  const notice = await page.locator('.notice').textContent();
  const temporary = /shown once\): (\S+)/.exec(notice ?? '')![1]!;
  await logOut(page);

  await logIn(page, username, temporary);
  await expect(page.getByText('You must set a new password before you continue.')).toBeVisible();
  // Nothing else is reachable until the password is changed.
  await expect(page.getByRole('button', { name: 'Logbooks' })).toHaveCount(0);
  await page.getByLabel('Current password').fill(temporary);
  await page.getByLabel(/^New password/).fill('Fresh-Spring-42');
  await page.getByLabel('Repeat new password').fill('Fresh-Spring-42');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('.who')).toContainText('Neha New');

  await logOut(page);
  await logIn(page, username, 'Fresh-Spring-42');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('LB-21: five failed logins lock the account and alert Admin and QA on screen', async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await logIn(page, 'locky', 'wrong-password');
    await expect(page.getByText('Login failed.')).toBeVisible();
  }
  // Locked: even the right password is refused now.
  await logIn(page, 'locky', PASSWORD);
  await expect(page.getByText('Login failed.')).toBeVisible();

  for (const watcher of ['qa1', 'admin']) {
    await logIn(page, watcher);
    const alert = page.getByRole('alert').filter({ hasText: 'Account locky locked after 5 failed password attempts.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Security alert');
    await logOut(page);
  }
});
