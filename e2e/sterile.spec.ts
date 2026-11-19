import { expect, test } from '@playwright/test';
import { approveSettings, cleanVerified, logIn, newEquipment, openLogbook, owner, recordAndVerify, sign, statusBar, newEntry } from './helpers.js';
import { E2E_SCHEMA } from './config.js';

test.beforeAll(async () => {
  // Switch the sterile types on for this site, as Admin and QA would in Logbook settings.
  for (const type of ['steriliser_cycle', 'steriliser_test']) await approveSettings(type);
});

test('LB-12: a failed steriliser test takes the steriliser out of service and stops new cycles', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Autoclave', sterile: true });
  await cleanVerified(id);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await newEntry(page, 'Steriliser test');
  const form = page.getByRole('dialog');
  await form.getByLabel('Test').selectOption('air_removal');
  await form.getByLabel('Result').selectOption('fail');
  await form.getByLabel('Comment (needed if failed)').fill('Uneven colour change on the Bowie-Dick sheet');
  await form.getByLabel('Deviation reference (needed if failed)').fill('DV-2026-031');
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(statusBar(page)).toContainText('Out of service');
  await expect(statusBar(page)).toContainText('failed or awaiting verification');

  await newEntry(page, 'Sterilisation cycle');
  await form.getByLabel('Cycle number').fill('C-0001');
  await form.getByLabel('Programme').fill('121 °C porous load');
  await form.getByLabel('Controller printout / record reference').fill('PRN-0001');
  await sign(form, 'op1', 'Sign and save');
  await expect(form.locator('.error')).toContainText('failed or awaiting verification');
});

// D-78: with TrueBatch Injectables linked (the test server links it), a cycle made for one of its batches is recorded
// there and shown read only in the steriliser's history card; the Logbook's cycle form is for cycles not made for a batch.
test('LB-12: a cycle recorded in TrueBatch Injectables shows read only in the history card; the cycle form refuses a batch', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Autoclave TI', sterile: true });
  await cleanVerified(id);
  await recordAndVerify(id, { logbookType: 'steriliser_test', data: { test: 'air_removal', result: 'pass' } });
  const db = owner();
  await db.unsafe(`insert into ${E2E_SCHEMA}_ti.steriliser_cycle_v1 (cycle_id, batch_number, product_code, step_key, step_name, equipment_code, cycle_type,
      programme, load, controller_record_ref, started_at, ended_at, result, exposure_min, lowest_temp_c, signed, data_as_of)
    values ('TI260007/1.0.2.0', 'TI260007', 'FG-TI', '1.0.2.0', 'Sterilise › Components', $1, 'steam', 'Rubber stoppers', 'Load 3', 'PRN-TI-77',
      now() - interval '2 hours', now() - interval '80 minutes', 'pass', 20, 121.4, '{performed,checked}', now())`, [code]);
  await db.end();

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await newEntry(page, 'Sterilisation cycle');
  const form = page.getByRole('dialog');
  await expect(form.getByRole('status')).toContainText('A cycle for a batch is recorded in its batch record in TrueBatch Injectables');
  await form.getByLabel('Cycle number').fill('C-0101');
  await form.getByRole('textbox', { name: 'Load', exact: true }).fill('Stoppers for TI260007');
  await form.getByLabel('Controller printout / record reference').fill('PRN-0101');
  await sign(form, 'op1', 'Sign and save');
  await expect(form.locator('.error')).toContainText('Batch TI260007: a sterilisation cycle for a batch is recorded in its batch record');
  await form.getByRole('textbox', { name: 'Load', exact: true }).fill('Empty chamber');
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);

  await page.getByRole('button', { name: 'History card' }).click();
  const row = page.locator('tr.truebatch', { hasText: 'TI260007' });
  await expect(row).toContainText('from TrueBatch Injectables, batch TI260007 (read only)');
  await expect(row).toContainText('Printout: PRN-TI-77');
  await expect(row).toContainText('Exposure 20 min · Lowest temp 121.4 °C');
  await expect(page.locator('table.history')).toContainText('C-0101');
});
