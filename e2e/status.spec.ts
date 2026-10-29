import { expect, test, type Page } from '@playwright/test';
import { cleanVerified, logIn, logOut, newEquipment, openLogbook, owner, recordAndVerify, sign, statusBar } from './helpers.js';

async function tryUse(page: Page, batch: string) {
  await page.getByRole('button', { name: '+ Equipment use' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Product').selectOption({ label: 'P1 · Paracetamol 500 mg' });
  await form.getByLabel('Batch number').fill(batch);
  await form.getByRole('button', { name: 'Save' }).click();
  return form;
}

test('LB-06: a breakdown takes equipment out of service until QA releases it', async ({ page }) => {
  const { id, code } = await newEquipment();
  await cleanVerified(id);

  await logIn(page, 'eng1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: '+ Maintenance / breakdown' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Type').selectOption('breakdown');
  await form.getByLabel('What happened / what is planned').fill('Motor trips on start');
  await form.getByLabel('Work done').fill('Contactor replaced');
  await sign(form, 'eng1', 'Sign and save');
  await expect(statusBar(page)).toContainText('Out of service');
  await logOut(page);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  const blocked = await tryUse(page, 'B-E2E-10');
  await expect(blocked.locator('.error')).toContainText('Out of service: a breakdown has not been released by QA.');
  await blocked.getByRole('button', { name: 'Cancel' }).click();
  await logOut(page);

  await logIn(page, 'sup1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await sign(page.getByRole('dialog'), 'sup1');
  await expect(statusBar(page)).toContainText('Out of service');
  await logOut(page);

  await logIn(page, 'qa1');
  await openLogbook(page, code);
  await page.getByRole('button', { name: 'Release to service' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Sign: Released');
  await sign(dialog, 'qa1');
  await expect(statusBar(page)).toContainText('Clean');
  await expect(page.getByRole('row').filter({ hasText: 'Maintenance / breakdown' })).toContainText('Released: QA1');
  await logOut(page);

  await logIn(page, 'op1');
  await openLogbook(page, code);
  await tryUse(page, 'B-E2E-11');
  await expect(statusBar(page)).toContainText('In use');
});

test('LB-05: an instrument with an overdue calibration is shown as overdue and cannot be used', async ({ page }) => {
  const { id, code } = await newEquipment({ kind: 'instrument' });
  await cleanVerified(id);
  const cal = await recordAndVerify(id, { logbookType: 'calibration', data: { result: 'pass', nextDue: '2099-01-01', certificateRef: 'CAL-1' } }, 'eng1', 'qa1');
  // As if the due date had passed.
  const sql = owner();
  await sql`alter table entries disable trigger entries_version_chain`;
  await sql`update entries set data = jsonb_set(data, '{nextDue}', '"2020-01-01"') where id = ${cal}`;
  await sql`alter table entries enable trigger entries_version_chain`;
  await sql.end();

  await logIn(page, 'op1');
  await page.getByRole('button', { name: 'Logbooks' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`^${code} `) })).toContainText('Calibration overdue');
  await openLogbook(page, code);
  await expect(statusBar(page)).toContainText('Calibration overdue since 2020-01-01.');
  const form = await tryUse(page, 'B-E2E-12');
  await expect(form.locator('.error')).toContainText('Calibration overdue since 2020-01-01.');
});
