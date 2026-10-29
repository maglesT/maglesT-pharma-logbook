import { expect, test } from '@playwright/test';
import { approveSettings, cleanVerified, logIn, newEquipment, openLogbook, sign, statusBar } from './helpers.js';

test.beforeAll(async () => {
  // Switch the sterile types on for this site, as Admin and QA would in Logbook settings.
  for (const type of ['steriliser_cycle', 'steriliser_test']) await approveSettings(type);
});

test('LB-12: a failed steriliser test takes the steriliser out of service and stops new cycles', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Autoclave', sterile: true });
  await cleanVerified(id);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ Steriliser test' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Test').selectOption('air_removal');
  await form.getByLabel('Result').selectOption('fail');
  await form.getByLabel('Comment (needed if failed)').fill('Uneven colour change on the Bowie-Dick sheet');
  await form.getByLabel('Deviation reference (needed if failed)').fill('DV-2026-031');
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(statusBar(page)).toContainText('Out of service');
  await expect(statusBar(page)).toContainText('failed or awaiting verification');

  await page.getByRole('button', { name: '+ Sterilisation cycle' }).click();
  await form.getByLabel('Cycle number').fill('C-0001');
  await form.getByLabel('Programme').fill('121 °C porous load');
  await form.getByLabel('Controller printout / record reference').fill('PRN-0001');
  await sign(form, 'op1', 'Sign and save');
  await expect(form.locator('.error')).toContainText('failed or awaiting verification');
});
