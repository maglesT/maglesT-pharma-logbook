import { expect, test } from '@playwright/test';
import { logIn, logOut } from './helpers.js';

// B1-2 (D-29): sign-on goes through Medhanta core; the test server signs in through a stand-in for core.
test('PL-01: the sign-in page sends people to core; after sign-on Home shows their name, and logout signs them out', async ({ page }) => {
  // Display round 21 Nov: the first load asks quietly whether someone is signed in; no 401 in the console.
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 401) errors.push(`401 ${r.url()}`); });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  expect(errors).toEqual([]);
  await expect(page.getByLabel('Password')).toHaveCount(0);

  await logIn(page, 'op1');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('.who')).toContainText('OP1');
  await expect(page.getByRole('button', { name: 'Users' })).toHaveCount(0);
  await logOut(page);
});

test('PL-01: a person without a Logbook role is refused', async ({ page }) => {
  await page.goto('/login?login_hint=norole');
  await expect(page.getByText('You have no right to use Medhanta LEAD')).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
