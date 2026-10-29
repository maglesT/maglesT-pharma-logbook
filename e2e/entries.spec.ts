import { expect, test } from '@playwright/test';
import { logIn, newEquipment, openLogbook, sign } from './helpers.js';


test('LB-17: a correction keeps the original readable, with the reason and a signature', async ({ page }) => {
  const { code } = await newEquipment();
  await logIn(page, 'op1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ General equipment log' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Notes').fill('Gauge reads 2.4 bar');
  await form.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('row').filter({ hasText: 'General equipment log' });
  await expect(row).toContainText('Notes: Gauge reads 2.4 bar');

  await row.getByRole('button', { name: 'Correct' }).click();
  await form.getByLabel('Notes').fill('Gauge reads 4.2 bar');
  await form.getByLabel('Reason for correction').fill('Digits swapped');
  await sign(form, 'op1', 'Sign and save');
  await expect(row).toContainText('Notes: Gauge reads 4.2 bar');
  await expect(row).toContainText('Corrected (version 2): Digits swapped');
  await expect(row).toContainText('Corrected: OP1');

  await row.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog');
  await expect(history.locator('.version').filter({ hasText: 'Version 1' })).toContainText('Notes: Gauge reads 2.4 bar');
  await expect(history.locator('.version').filter({ hasText: 'Version 2' })).toContainText('reason: Digits swapped');
});

test('LB-04: an entry for an activity more than 30 minutes ago needs a reason and is marked late', async ({ page }) => {
  const { code } = await newEquipment();
  await logIn(page, 'op1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ General equipment log' }).click();
  const form = page.getByRole('dialog');
  // A datetime-local value two hours ago, in the browser's own time zone.
  const twoHoursAgo = await page.evaluate(() => {
    const d = new Date(Date.now() - 120 * 60_000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  await form.getByLabel('Date and time').fill(twoHoursAgo);
  await form.getByLabel('Notes').fill('Noise from the gearbox');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('This is a late entry: give the reason below.');
  await form.getByLabel('Reason for late entry').fill('Transcribed from paper form 17');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'Noise from the gearbox' });
  await expect(row.getByText('Late entry')).toHaveAttribute('title', 'Transcribed from paper form 17');
});
