import { expect, test } from '@playwright/test';
import { cleanVerified, logIn, logOut, newEquipment, openLogbook, owner, sign, statusBar } from './helpers.js';

test('LB-07: after use the equipment is dirty and blocked until a cleaning verified by a second person', async ({ page }) => {
  const { id, code } = await newEquipment({ cleanHoldHours: 24 });
  await cleanVerified(id);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText('Clean');

  // Use: product and batch, then end it.
  await page.getByRole('button', { name: '+ Equipment use' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-1');
  await form.getByLabel('Stage').fill('Blending');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(statusBar(page)).toContainText('In use');
  await expect(statusBar(page)).toContainText('Batch B-E2E-1 · Blending');
  await page.getByRole('button', { name: 'End use' }).click();
  await expect(statusBar(page)).toContainText('Dirty');

  // A new use is refused with the reason.
  await page.getByRole('button', { name: '+ Equipment use' }).click();
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('This equipment is not fit for use:');
  await expect(form.locator('.error')).toContainText('Dirty: clean and verify before the next use.');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // The operator cleans and signs; it stays dirty until verified.
  await page.getByRole('button', { name: '+ Equipment cleaning' }).click();
  await form.getByLabel('Cleaning type').selectOption('batch_to_batch');
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(statusBar(page)).toContainText('Dirty: the cleaning is awaiting verification.');
  await logOut(page);

  // A second person verifies with the sign dialog.
  await logIn(page, 'sup1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Verify' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Sign: Verified');
  await expect(dialog).toContainText('entered by OP1');
  await sign(dialog, 'sup1');
  await expect(statusBar(page)).toContainText('Clean');
  await expect(page.getByRole('row').filter({ hasText: 'Equipment cleaning' }).first()).toContainText('Verified: SUP1');

  // Use is allowed again.
  await page.getByRole('button', { name: '+ Equipment use' }).click();
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(statusBar(page)).toContainText('In use');
});

test('LB-07: past its clean-hold time the equipment shows Clean expired and use is blocked', async ({ page }) => {
  const { id, code } = await newEquipment({ cleanHoldHours: 24 });
  await cleanVerified(id);
  // As if a day had passed since the cleaning.
  const sql = owner();
  await sql`alter table entries disable trigger entries_version_chain`;
  await sql`update entries set activity_start = activity_start - interval '25 hours', activity_end = activity_end - interval '25 hours' where equipment_id = ${id}`;
  await sql`alter table entries enable trigger entries_version_chain`;
  await sql.end();

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText('Clean expired');
  await expect(statusBar(page)).toContainText('Clean-hold time expired');
  await page.getByRole('button', { name: '+ Equipment use' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-3');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('Clean-hold time expired');
});
