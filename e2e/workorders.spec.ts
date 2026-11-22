import { expect, test } from '@playwright/test';
import { approveSettings, logIn, logOut, newEquipment, recordAndVerify, sign } from './helpers.js';

// Engineering work orders (22 Nov 2026): raised by hand, assigned from the people list, started, work recorded, Done
// (the doer signs), Closed (a second person signs); the menu list finds it, the item has a Work orders tab, a PDF copy.
test('LB-17: the breakdown register headers and Status cells are fully visible at 1440 px', async ({ page }) => {
  await approveSettings('maintenance');
  const { id } = await newEquipment({ name: 'Register item' });
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  await recordAndVerify(id, { logbookType: 'maintenance', activityStart: ago(60), activityEnd: ago(10), lateReason: 'after the repair',
    data: { kind: 'breakdown', description: 'Motor trips on start', occurredAt: ago(90), reportedBy: 'Shift A', failureCategory: 'electrical', rootCause: 'Contactor',
      workDone: 'Replaced', partsNone: true, doneBy: 'in_house', postRepairChecks: 'ok' } }, 'eng1', 'sup1');
  await page.setViewportSize({ width: 1440, height: 900 });
  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'Breakdowns' }).click();
  await expect(page.locator('table.register tbody .chip').first()).toBeVisible();
  const clipped = await page.locator('table.register th').evaluateAll((ths) => ths.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent));
  expect(clipped).toEqual([]);
  // Every Status chip lies inside the box that holds the table (not cut at its right edge).
  const cut = await page.locator('table.register tbody tr').evaluateAll((rows) => rows.map((r) => {
    const chip = r.querySelector('.chip')!.getBoundingClientRect();
    const box = r.closest('.table-wrap')!.getBoundingClientRect();
    return { right: Math.round(chip.right), boxRight: Math.round(box.right), page: document.documentElement.scrollWidth };
  }).filter((x) => x.right > x.boxRight || x.page > 1440));
  expect(cut).toEqual([]);
  await page.screenshot({ path: 'test-results/register-1440.png' });
});

test('LB-06: raise, assign, start, record the work, mark done and close a work order', async ({ page }) => {
  const { code } = await newEquipment({ name: 'WO item' });
  await logIn(page, 'sup1');
  await page.getByRole('button', { name: 'Work orders' }).click();
  await page.getByRole('button', { name: '+ Raise a work order' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Item').selectOption({ label: `${code} · WO item` });
  await dlg.getByLabel('Kind').selectOption('preventive');
  await dlg.getByLabel('Title').fill('Quarterly service');
  await dlg.getByLabel('Assigned to').selectOption({ label: 'ENG1' });
  await dlg.getByRole('button', { name: 'Raise', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Quarterly service');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/^WO-\d\d-\d{4}/);
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  await logOut(page);

  await logIn(page, 'eng1');
  await page.getByRole('button', { name: 'Work orders' }).click();
  await page.locator('tr', { hasText: 'Quarterly service' }).click();
  await page.getByRole('button', { name: 'Start work' }).click();
  await page.getByLabel('What was done').fill('Lubricated and checked');
  await page.getByRole('button', { name: '+ Add a spare part' }).click();
  await page.getByLabel('Part', { exact: true }).fill('Grease');
  await page.getByLabel('hours').fill('1');
  await page.getByLabel('minutes').fill('30');
  await page.getByRole('button', { name: 'Save the work' }).click();
  await page.getByRole('button', { name: 'Mark done (sign)' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Sign: Performed');
  await sign(page.getByRole('dialog'), 'eng1');
  await expect(page.getByText('Performed: ENG1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close work order' })).toHaveCount(0);
  await logOut(page);

  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'Work orders' }).click();
  await page.getByLabel('Status').selectOption('done');
  await page.locator('tr', { hasText: 'Quarterly service' }).click();
  await page.getByRole('button', { name: 'Close work order' }).click();
  await sign(page.getByRole('dialog'), 'qa1');
  await expect(page.getByText('Closed: QA1')).toBeVisible();
  await expect(page.getByText('Work order closed')).toBeVisible();
  await page.screenshot({ path: 'test-results/workorders-page.png', fullPage: true });
  await page.getByRole('link', { name: 'PDF' }).waitFor();

  // On a phone nothing sticks out of the page.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'Work orders' }).first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('tr', { hasText: 'Quarterly service' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 800 });

  // The item's Work orders tab lists it too.
  await page.getByRole('button', { name: 'Logbooks' }).click();
  await page.getByRole('button', { name: new RegExp(`^${code} `) }).click();
  await page.getByRole('main').getByRole('button', { name: /^Work orders/ }).click();
  await expect(page.locator('tr', { hasText: 'Quarterly service' })).toContainText('Closed');
});
