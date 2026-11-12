import { expect, test } from '@playwright/test';
import { apiAs, approveSettings, cleanVerified, logIn, newEquipment, owner, post, recordAndVerify } from './helpers.js';

// S16: the home dashboard keeps equipment and areas apart, and lists only the cleaning deadlines that are close or past;
// each opens its item. The cleaning schedule is set on Master data.

async function useAndEnd(id: number) {
  const op = await apiAs('op1');
  const products = await (await op.get('/api/products')).json();
  const use = await post(op, `/api/equipment/${id}/entries`, { logbookType: 'equipment_use', activityStart: new Date().toISOString(), productId: products[0].id, batch: 'B-DASH', data: { stage: 'Blending' } });
  await post(op, `/api/entries/${use.id}/complete`, { activityEnd: new Date().toISOString() });
  await op.dispose();
}
async function age(id: number, hours: number) {
  const sql = owner();
  await sql`alter table entries disable trigger entries_version_chain`;
  await sql`update entries set activity_start = activity_start - make_interval(hours => ${hours}),
            activity_end = activity_end - make_interval(hours => ${hours}) where equipment_id = ${id}`;
  await sql`alter table entries enable trigger entries_version_chain`;
  await sql.end();
}

test('LB-07: the dashboard warns of dirty-hold and frequency deadlines near their end, in four parts (equipment, instruments, operation- and frequency-based rooms), and opens the item', async ({ page }) => {
  await approveSettings('area_cleaning');
  const mixer = await newEquipment({ dirtyHoldHours: 8, cleanHoldHours: 72 });
  await cleanVerified(mixer.id);
  await useAndEnd(mixer.id);
  await age(mixer.id, 7);                                    // 1 hour of the 8-hour dirty hold left
  const calm = await newEquipment({ dirtyHoldHours: 8 });    // just used: its dirty hold is not close
  await cleanVerified(calm.id);
  await useAndEnd(calm.id);
  const store = await newEquipment({ kind: 'area', cleaningBasis: 'frequency', cleaningFrequencyHours: 24 });
  await recordAndVerify(store.id, { logbookType: 'area_cleaning', data: { cleaningType: 'daily' } });
  await age(store.id, 30);                                   // daily cleaning 6 hours overdue

  await logIn(page, 'sup1');
  const machines = page.getByRole('region', { name: 'Equipment', exact: true });
  const rooms = page.getByRole('region', { name: 'Frequency-based rooms' });
  await expect(machines.locator('.deadline').filter({ hasText: mixer.code })).toContainText(/Ends in (59|60) min|Ends in 1 h/);
  await expect(machines.locator('.deadline').filter({ hasText: mixer.code })).toContainText('Dirty hold (8 h)');
  await expect(machines.locator('.deadline').filter({ hasText: calm.code })).toHaveCount(0);
  await expect(rooms.locator('.deadline.overdue').filter({ hasText: store.code })).toContainText(/Overdue by 6 h/);
  await expect(rooms.locator('.deadline').filter({ hasText: store.code })).toContainText('Scheduled cleaning (every 24 h)');
  await expect(rooms.locator('.deadline').filter({ hasText: mixer.code })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Instruments' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Operation-based rooms' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Operation-based rooms' }).locator('.deadline').filter({ hasText: store.code })).toHaveCount(0);

  // A count opens the list of those items; a row opens the item.
  await rooms.getByRole('button', { name: /^Overdue \d/ }).click();
  await expect(rooms.locator('.dash-item').filter({ hasText: store.code })).toContainText('Cleaning overdue');
  await machines.locator('.deadline').filter({ hasText: mixer.code }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(mixer.code);
  await expect(page.locator('.statusbar')).toContainText('Dirty hold ends at');
});

test('LB-07: an admin sets a room to frequency-based, weekly, on Master data', async ({ page }) => {
  const room = await newEquipment({ kind: 'area' });
  await logIn(page, 'admin');
  await page.getByRole('button', { name: 'Master data' }).click();
  const row = page.getByRole('row').filter({ hasText: room.code });
  await expect(row).toContainText('Operation-based: no hold times');
  await row.getByRole('button', { name: 'Cleaning schedule' }).click();
  await page.getByLabel('Room cleaning').selectOption('frequency');
  await page.getByRole('button', { name: 'Weekly' }).click();
  page.once('dialog', (d) => void d.accept('Store room: cleaned weekly per SOP-HK-04'));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row').filter({ hasText: room.code })).toContainText('Every 168 h');
});
