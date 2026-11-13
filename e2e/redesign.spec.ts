import { expect, test } from '@playwright/test';
import { approveSettings, cleanVerified, logIn, newEntry, newEquipment, owner, sign } from './helpers.js';

// Owner 2026-11-12 (D-36): items added by searching their master ID; dues and the sign-in banner; scanning an ID opens
// the item with its check before use; a change over from the Activity dropdown occupies the item.

test('LB-21: an admin adds an item by searching its master ID; name, location and parameters are pulled, nothing typed', async ({ page }) => {
  const code = `E2E-ADD-${Date.now().toString(36)}`.toUpperCase();
  const db = owner();
  await db`insert into e2e_master_items (code, name, kind, room, care) values (${code}, 'Bin blender 300 L', 'equipment', 'BLND-1',
    ${db.json({ cleanHoldHours: 72, dirtyHoldHours: 8, pmFrequencyDays: 90, requalificationFrequencyMonths: 24 } as never)})`;
  await db.end();
  await logIn(page, 'admin');
  await page.getByRole('button', { name: 'Master data' }).click();
  await page.getByLabel('Search the ID').fill(code.slice(0, 12));
  await page.getByRole('option', { name: new RegExp(code) }).click();
  const pulled = page.locator('.fields.pulled');
  await expect(pulled).toContainText('Bin blender 300 L');
  await expect(pulled).toContainText('BLND-1');
  await expect(pulled).toContainText('Dirty hold 8 h · clean hold 72 h');
  await expect(pulled).toContainText('every 90 days');
  await expect(pulled).toContainText('every 24 months');
  await page.screenshot({ path: 'test-results/redesign-add-item.png', fullPage: true });
  await page.getByLabel('Reason').fill('New blender line (CC-2026-014)');
  await page.getByRole('button', { name: 'Add to the Logbook' }).click();
  await expect(page.locator('.notice')).toContainText(`${code} added to the Logbook`);
  await expect(page.getByRole('row').filter({ hasText: code })).toContainText('every 90 days');
});

test('LB-06: PM due within 15 days shows in Dues and in the sign-in banner; scanning the ID opens the check before use', async ({ page }) => {
  const item = await newEquipment({ name: 'Rapid mixer granulator', pmFrequencyDays: 30 });
  await cleanVerified(item.id);
  const db = owner();
  await db`update equipment set created_at = now() - interval '27 days' where id = ${item.id}`;   // PM due in 3 days (90 % of 30 days passed)
  await db.end();
  await logIn(page, 'sup1');
  const banner = page.locator('.pending-banner');
  await expect(banner).toContainText('Pending activities');
  await banner.getByRole('button', { name: 'Show the list' }).click();
  await expect(banner).toContainText(`${item.code} · Preventive maintenance due`);
  const dues = page.locator('[aria-label="Preventive maintenance dues"]');
  await expect(dues.locator('.due-row').filter({ hasText: item.code })).toContainText('in 3 days');
  // Owner 2026-11-13 (D-41): three parts; the graph has four sections and zooms into lifecycle management.
  for (const t of ['Compliance', 'Workflow', 'Quality']) await expect(page.getByRole('tab', { name: new RegExp(t) })).toBeVisible();
  const graph = page.getByRole('region', { name: 'Status of the plant' });
  for (const g of ['Cleaning status', 'Lifecycle management', 'Change over', 'In use']) await expect(graph).toContainText(g);
  await graph.locator('.section-card').filter({ hasText: 'Lifecycle management' }).click();
  await expect(graph.locator('.zoom')).toContainText('PM due');
  await page.screenshot({ path: 'test-results/redesign-home.png', fullPage: true });
  await page.getByLabel('Scan or type the item ID').fill(item.code.toLowerCase());
  await page.getByLabel('Scan or type the item ID').press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(item.code);
  const check = page.getByRole('list', { name: 'Before use' });
  await expect(check).toContainText('Preventive maintenance');
  await expect(check.locator('li.warn')).toContainText('in 3 days');
  await expect(check.locator('li.ok').first()).toContainText('Cleaning status');
});

test('LB-01: a change over from the Activity dropdown occupies the item until it is ended; nothing else can be recorded meanwhile', async ({ page }) => {
  const item = await newEquipment({ name: 'Octagonal blender' });
  await cleanVerified(item.id);
  await approveSettings('change_over', { sopRef: 'SOP-CO-01', checklist: ['Previous product removed'] });

  await logIn(page, 'op1');
  await page.getByLabel('Scan or type the item ID').fill(item.code);
  await page.getByLabel('Scan or type the item ID').press('Enter');
  await newEntry(page, 'Change over');
  const form = page.getByRole('dialog');
  await form.getByLabel('From product').fill('Paracetamol 500 mg');
  await form.getByLabel('From batch').fill('B-101');
  await form.getByLabel('To product').fill('Ibuprofen 400 mg');
  await form.getByLabel('To batch').fill('B-205');
  await form.getByLabel('Previous product removed').check();
  await sign(form, 'op1', 'Sign and save');
  await expect(form).toHaveCount(0);
  await expect(page.locator('.statusbar')).toContainText('Change over');
  await newEntry(page, 'Operation (use)');
  await form.getByLabel('Product').selectOption({ index: 1 });
  await form.getByLabel('Batch number').fill('B-205');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.error')).toContainText('Change over in progress');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.screenshot({ path: 'test-results/redesign-change-over.png', fullPage: true });
  await page.getByRole('button', { name: 'End change over' }).click();
  await expect(page.locator('.statusbar')).not.toContainText('Change over in progress');
});
