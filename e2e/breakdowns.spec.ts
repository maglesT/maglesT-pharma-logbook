import { expect, test } from '@playwright/test';
import { apiAs, proofOf, cleanVerified, localTime, logIn, logOut, newEquipment, openLogbook, post, sign, statusBar } from './helpers.js';

test('LB-06: a breakdown with parts is verified and released, then shows in the register with its downtime and on the history card', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Fluid bed dryer', location: 'Granulation' });
  await cleanVerified(id);

  // The engineer records the breakdown and the repair, with the parts used.
  await logIn(page, 'eng1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ Maintenance / breakdown' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Type').selectOption('breakdown');
  await form.getByLabel('Breakdown occurred at').fill(await localTime(page, 90));
  await form.getByLabel('Reported by').fill('Shift B operator');
  await form.getByLabel('Failure category').selectOption('mechanical');
  await form.getByLabel('Failure / symptom').fill('Inlet fan bearing noise, fan stopped');
  await form.getByLabel('Repair start').fill(await localTime(page, 80));
  await form.getByLabel('Repair end').fill(await localTime(page, 0));
  await form.getByLabel('Root cause').fill('Bearing worn out');
  await form.getByLabel('Work done').fill('Bearing replaced, fan balanced');
  await form.getByRole('button', { name: '+ Add part' }).click();
  await form.getByLabel('Part 1 name').fill('Deep groove ball bearing');
  await form.getByLabel('Part 1 number').fill('6205-2RS');
  await form.getByLabel('Part 1 quantity').fill('2');
  await form.getByLabel('Part 1 lot or serial').fill('LOT-B771');
  await form.getByLabel('Tools, consumables or lubricants used').fill('Bearing puller, grease EP2');
  await form.getByLabel('Done by').selectOption('in_house');
  await form.getByLabel('Work order reference (e.g. CMMS WO number)').fill('WO-55120');
  await form.getByLabel('Post-repair checks done (e.g. test run)').fill('Test run 15 min, vibration normal');
  await sign(form, 'eng1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(statusBar(page)).toContainText('Out of service');
  await logOut(page);

  // A supervisor verifies, QA releases.
  await logIn(page, 'sup1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await sign(page.getByRole('dialog'), 'sup1');
  await logOut(page);
  await logIn(page, 'qa1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Release to service' }).click();
  await sign(page.getByRole('dialog'), 'qa1');
  await expect(statusBar(page)).toContainText('Clean');
  await logOut(page);

  // Anyone can read the register: occurred 90 minutes before the release.
  await logIn(page, 'op1');
  await page.getByRole('button', { name: 'Breakdowns' }).click();
  await page.getByLabel('Machine').selectOption({ label: `${code} · Fluid bed dryer` });
  await page.getByRole('button', { name: 'Show' }).click();
  const row = page.locator('table.register tbody tr').filter({ hasText: code });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Granulation');
  await expect(row).toContainText(/1 h (29|3[0-2]) min/);
  await expect(row).not.toContainText('so far');
  await expect(row).toContainText('2 × Deep groove ball bearing (P/N 6205-2RS), lot/SN LOT-B771');
  await expect(row).toContainText('In-house');
  await expect(row).toContainText('WO-55120');
  await expect(row).toContainText('Released');
  await expect(page.locator('table').nth(1)).toContainText(`${code} · Fluid bed dryer`);

  // Clicking the row opens the machine; its history card shows the breakdown highlighted.
  await row.click();
  await page.getByRole('button', { name: 'History card' }).click();
  const breakdown = page.locator('table.history tr.breakdown');
  await expect(breakdown).toHaveCount(1);
  await expect(breakdown).toContainText(/Downtime 1 h (29|3[0-2]) min/);
  await expect(breakdown).toContainText('parts: 2 × Deep groove ball bearing');
  await expect(breakdown).toContainText('Released: QA1');
  await expect(page.locator('table.history')).toContainText('Equipment cleaning');
});

test('LB-06: a breakdown reported while the repair is open is completed later, signed by the repairer', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Tablet press' });
  await cleanVerified(id);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ Maintenance / breakdown' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Type').selectOption('breakdown');
  await form.getByLabel('Failure category').selectOption('electrical');
  await form.getByLabel('Failure / symptom').fill('Main drive trips');
  await form.getByLabel(/^Repair finished/).uncheck();
  await expect(form.getByLabel('Repair end')).toHaveCount(0);
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(statusBar(page)).toContainText('Out of service');
  await expect(page.getByRole('row').filter({ hasText: 'Main drive trips' })).toContainText('In progress');
  await logOut(page);

  await logIn(page, 'eng1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Complete repair' }).click();
  await expect(form.getByRole('heading')).toContainText('Complete repair');
  // What was reported stays as reported.
  await expect(form.getByLabel('Failure / symptom')).toBeDisabled();
  await form.getByLabel('Root cause').fill('Loose terminal');
  await form.getByLabel('No parts used').check();
  await form.getByLabel('Done by').selectOption('in_house');
  await sign(form, 'eng1', 'Sign and save');
  await expect(form).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'Main drive trips' });
  await expect(row).toContainText('Awaiting verification');
  await expect(row).toContainText('Performed: ENG1');
});

test('LB-18: Admin records equipment details with a reason; the change shows on the history card', async ({ page }) => {
  const { code } = await newEquipment({ name: 'Blender' });
  await logIn(page, 'admin');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'History card' }).click();
  await expect(page.getByText('No equipment details recorded yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Asset number').fill('AST-3301');
  await dialog.getByLabel('Make / manufacturer').fill('Bectochem');
  await dialog.getByLabel('Serial number').fill('BC-1188');
  await dialog.getByLabel('Reason for the change').fill('Initial record from IQ report');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('dl.details')).toContainText('AST-3301');
  await expect(page.locator('dl.details')).toContainText('Version 1, ADMIN');
  await expect(page.locator('table.history tr.masterdata').filter({ hasText: 'Equipment details changed' })).toContainText('Initial record from IQ report');
});

test('LB-17: completing a repair keeps the reported occurrence time exactly as stored', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Coating pan' });
  // Reported through the API, to the second: the form must not round it when completing.
  const op = await apiAs('op1');
  const occurredAt = new Date(Date.now() - 7 * 60_000 - 27_512).toISOString();
  await post(op, `/api/equipment/${id}/entries`, { logbookType: 'maintenance', activityStart: new Date().toISOString(),
    data: { kind: 'breakdown', description: 'Spray gun blocked', occurredAt, failureCategory: 'mechanical' }, signature: { proof: await proofOf(op, 'performed') } });
  await op.dispose();

  await logIn(page, 'eng1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Complete repair' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('No parts used').check();
  await form.getByLabel('Done by').selectOption('in_house');
  await sign(form, 'eng1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Spray gun blocked' })).toContainText('Awaiting verification');
});
