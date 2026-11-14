import { expect, test } from '@playwright/test';
import { apiAs, cleanVerified, logIn, logOut, newEquipment, openLogbook, owner, sign } from './helpers.js';

// Owner 2026-11-14 (D-43): a missed limit or a reported problem waits for QA, who sends it to Deviations or handles it
// here as a Logbook exception; an approved exception may allow continued use for an overdue PM until a date QA chooses.

const panel = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Problems and exceptions' });

test('LB-06: QA handles an overdue PM as a Logbook exception with continued use; the item shows "Use allowed under exception EXC-…" and a use is accepted', async ({ page }) => {
  const item = await newEquipment({ name: 'Bin blender', pmFrequencyDays: 10 });
  await cleanVerified(item.id);
  const db = owner();
  await db`update equipment set created_at = now() - interval '12 days' where id = ${item.id}`;   // PM due 2 days ago
  await db.end();
  // The minute check records the missed limit; it waits for QA.
  const qaApi = await apiAs('qa1');
  await expect.poll(async () => (await (await qaApi.get(`/api/equipment/${item.id}/problems`)).json()).problems.length, { timeout: 20_000 }).toBe(1);
  await qaApi.dispose();

  await logIn(page, 'qa1');
  await openLogbook(page, item.code);
  await expect(page.locator('.statusbar')).toContainText('Preventive maintenance overdue');
  await expect(panel(page)).toContainText('Waiting for a QA decision');
  await expect(panel(page)).toContainText('Preventive maintenance overdue');
  await panel(page).getByRole('button', { name: 'Decide the route' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Send to Deviations');
  await expect(dialog).toContainText('Handle here as a Logbook exception');
  await dialog.getByLabel('Justification', { exact: true }).fill('PM slipped two days because the vendor rescheduled; the blender ran within limits.');
  await dialog.getByLabel('Impact assessment', { exact: true }).fill('No product impact: the last PM found no wear; batches since are within specification.');
  await dialog.getByLabel('Action', { exact: true }).fill('PM booked for tomorrow (WO-9001).');
  await dialog.getByRole('checkbox', { name: /Allow use of/ }).check();
  const until = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await dialog.getByLabel("Until (end of day, QA's choice)").fill(until);
  await page.screenshot({ path: 'test-results/problems-decide.png', fullPage: true });
  await sign(dialog, 'qa1', 'Sign and save');
  await expect(dialog).toHaveCount(0);
  await expect(panel(page)).toContainText(/EXC-\d{4}-\d{4}/);
  await expect(panel(page)).toContainText('Use allowed until');
  await expect(page.locator('.statusbar')).toContainText(/Use allowed under exception EXC-\d{4}-\d{4}/);
  await expect(page.locator('.statusbar')).not.toHaveClass(/blocked/);
  await expect(page.locator('.use-check li').filter({ hasText: 'Preventive maintenance' })).toContainText('use allowed under exception');
  await page.screenshot({ path: 'test-results/problems-exception.png', fullPage: true });
  await logOut(page);

  // The operator may use the item while the exception is valid.
  const op = await apiAs('op1');
  const products = await (await op.get('/api/products')).json();
  const use = await op.post(`/api/equipment/${item.id}/entries`, { data: { logbookType: 'equipment_use', activityStart: new Date().toISOString(), productId: products[0].id, batch: 'B-EXC-1', data: { stage: 'Blending' } } });
  expect(use.status(), await use.text()).toBe(201);
  await op.dispose();
});

test('LB-21: an operator reports a critical problem; QA can only send it to Deviations; it is listed as sent', async ({ page }) => {
  const item = await newEquipment({ name: 'Sifter' });
  await logIn(page, 'op1');
  await openLogbook(page, item.code);
  await panel(page).getByRole('button', { name: 'Report a problem' }).click();
  const report = page.getByRole('dialog');
  await report.getByLabel('What happened').fill('Metal fragment found on the sieve after batch B-77');
  await report.getByLabel('Impact (product, equipment, people)').fill('Batch B-77 may be contaminated');
  await report.getByLabel('Severity').selectOption('critical');
  await report.getByRole('button', { name: 'Report' }).click();
  await expect(report).toHaveCount(0);
  await expect(panel(page)).toContainText('Reported problem (Critical)');
  await expect(panel(page)).toContainText('reported by OP1');
  // The operator cannot decide.
  await expect(panel(page).getByRole('button', { name: 'Decide the route' })).toHaveCount(0);
  await logOut(page);

  await logIn(page, 'qa1');
  await openLogbook(page, item.code);
  await panel(page).getByRole('button', { name: 'Decide the route' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /Handle here as a Logbook exception/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /Send to Deviations/ })).toBeChecked();
  await sign(dialog, 'qa1', 'Sign and save');
  await expect(dialog).toHaveCount(0);
  await expect(panel(page)).toContainText('Sent to Deviations');
  await expect(panel(page)).toContainText('Sent by QA1');
  // Published for the Deviations product under the problem's id.
  const qa = await apiAs('qa1');
  const list = await (await qa.get(`/api/equipment/${item.id}/problems`)).json();
  expect(list.problems[0].decision.route).toBe('deviation');
  await qa.dispose();
});
