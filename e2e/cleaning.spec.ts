import { expect, test } from '@playwright/test';
import { apiAs, cleanVerified, logIn, logOut, newEquipment, openLogbook, owner, post, sign, statusBar, newEntry } from './helpers.js';

test('LB-07: after use the equipment is dirty and blocked until a cleaning verified by a second person', async ({ page }) => {
  const { id, code } = await newEquipment({ cleanHoldHours: 24 });
  await cleanVerified(id);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText('Clean');

  // Use: product and batch, then end it.
  await newEntry(page, 'Operation (use)');
  const form = page.getByRole('dialog');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-1');
  await form.getByLabel('Stage').fill('Blending');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(statusBar(page)).toContainText('In use');
  await expect(statusBar(page)).toContainText('Batch B-E2E-1 · Blending');
  // D-49: "End use" offers a reason (optional here: the batch was typed, not from another product's batch records).
  await page.getByRole('button', { name: 'End use' }).click();
  await expect(form.getByLabel('Why the use ends')).toBeVisible();
  await form.getByLabel('Why the use ends').fill('Batch finished');
  await form.getByRole('button', { name: 'End use' }).click();
  await expect(statusBar(page)).toContainText('Dirty');
  await expect(page.locator('table')).toContainText('Batch finished');

  // A new use is refused with the reason.
  await newEntry(page, 'Operation (use)');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('This equipment is not fit for use:');
  await expect(form.locator('.error')).toContainText('Dirty: clean and verify before the next use.');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // The operator cleans and signs; it stays dirty until verified.
  await newEntry(page, 'Cleaning');
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
  await newEntry(page, 'Operation (use)');
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
  try {
    await sql`update entries set activity_start = activity_start - interval '25 hours', activity_end = activity_end - interval '25 hours' where equipment_id = ${id}`;
  } finally {
    await sql.end();
  }

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText('Clean expired');
  await expect(statusBar(page)).toContainText('Clean-hold time expired');
  await newEntry(page, 'Operation (use)');
  const form = page.getByRole('dialog');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill('B-E2E-3');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('Clean-hold time expired');
});

test('LB-07: once the dirty hold ran out, the cleaning form asks why the cleaning is late and the logbook shows it; the time carries IST', async ({ page }) => {
  const { id, code } = await newEquipment({ dirtyHoldHours: 1 });
  await cleanVerified(id);
  const op = await apiAs('op1');
  const p1 = (await (await op.get('/api/products')).json()).find((p: { code: string }) => p.code === 'P1');
  const use = await post(op, `/api/equipment/${id}/entries`, { logbookType: 'equipment_use', activityStart: new Date().toISOString(), productId: p1.id, batch: 'B-E2E-LATE', data: {} });
  await post(op, `/api/entries/${use.id}/complete`, { activityEnd: new Date().toISOString() });
  await op.dispose();
  // As if the cleaning and the use had been three hours ago: the dirty hold of 1 h ran out two hours ago.
  const sql = owner();
  try {
    await sql`update entries set activity_start = activity_start - interval '3 hours', activity_end = activity_end - interval '3 hours' where equipment_id = ${id}`;
  } finally {
    await sql.end();
  }

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText(/Dirty-hold time expired at \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d IST: the cleaning is late; clean, verify and record why\./);
  await newEntry(page, 'Cleaning');
  const form = page.getByRole('dialog');
  const why = form.getByLabel(/Why the cleaning is late/);
  await expect(why).toBeVisible();
  await why.fill('Cleaning crew held on the line clearance of RM-104');
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Equipment cleaning' }).first()).toContainText('Why late');
  await expect(page.getByRole('row').filter({ hasText: 'Equipment cleaning' }).first()).toContainText('Cleaning crew held on the line clearance of RM-104');
});
