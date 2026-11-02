import { expect, test } from '@playwright/test';
import { logIn, logOut } from './helpers.js';

// B1-2 (D-29): sign-on goes through Medhanta core; the test server signs in through a stand-in for core.
test('PL-01: the sign-in page sends people to core; after sign-on Home shows their name, and logout signs them out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  await expect(page.getByLabel('Password')).toHaveCount(0);

  await logIn(page, 'op1');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('.who')).toContainText('OP1');
  await expect(page.getByRole('button', { name: 'Users' })).toHaveCount(0);
  await logOut(page);
});

test('PL-01: a person without a Logbook role is refused', async ({ page }) => {
  await page.goto('/login?login_hint=norole');
  await expect(page.getByText('You have no right to use the Pharma Logbook')).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
