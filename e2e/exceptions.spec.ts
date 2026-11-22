import { expect, test } from '@playwright/test';
import { logIn, newEquipment, owner } from './helpers.js';

// D-80 (owner decision, 20 Nov 2026): a missed limit is an exception in the Logbook. A person holding
// logbook.exception.decide closes it here (reason and e-signature) or sends it to Deviations; others only see it.
async function missed(equipmentId: number, code: string, kind: 'pm' | 'calibration', hoursAgo: number) {
  const db = owner();
  await db`insert into overdue_events (equipment_id, kind, due_at, code, name, item_kind, title, description, immediate_action, impact_notes)
    values (${equipmentId}, ${kind}, now() - make_interval(hours => ${hoursAgo}), ${code}, 'Exception item', 'equipment',
      ${`${kind === 'pm' ? 'Preventive maintenance' : 'Calibration'} overdue: ${code}`}, 'Missed.', 'Blocked.', 'QA to assess.')`;
  await db.end();
}

test('LB-06: a missed limit is closed here with a reason and a signature, or sent to DIVE; it shows on the history card', async ({ page }) => {
  const { id, code } = await newEquipment({ name: 'Exception item' });
  await missed(id, code, 'pm', 5);
  await missed(id, code, 'calibration', 3);

  // Without the permission: the exceptions are shown, without the two choices.
  await logIn(page, 'sup1');
  const panelOf = () => page.getByRole('region', { name: 'Missed limits' });
  await expect(panelOf()).toBeVisible();
  const pmRow = () => panelOf().locator('tr', { hasText: code }).filter({ hasText: 'Preventive maintenance overdue' });
  await expect(pmRow()).toContainText('Waiting for a decision');
  await expect(panelOf().getByRole('button', { name: 'Close here' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL(/signed-out=/);

  await logIn(page, 'qa1');
  await pmRow().getByRole('button', { name: 'Close here' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Sign: Closed');
  // No reason, no signature: the form does not go on.
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog.getByLabel('Reason')).toHaveJSProperty('validity.valueMissing', true);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reason').fill('PM done the next morning; no batch made meanwhile');
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pmRow()).toContainText('Closed here by QA1');
  await expect(pmRow()).toContainText('Reason: PM done the next morning; no batch made meanwhile');

  const calRow = panelOf().locator('tr', { hasText: code }).filter({ hasText: 'Calibration overdue' });
  await calRow.getByRole('button', { name: 'Send to DIVE' }).click();
  await expect(calRow).toContainText('Sent to DIVE by QA1');
  await expect(calRow).toContainText('being filed in DIVE');
  await expect(calRow.getByRole('button')).toHaveCount(1);   // only the item link: decided once

  // The equipment history card keeps both, the closed one with its reason and signature.
  await pmRow().getByRole('button', { name: code }).click();
  await page.getByRole('button', { name: 'History card' }).click();
  const rows = page.locator('table.history tr.exception');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Preventive maintenance overdue' })).toContainText('Closed in the Logbook by QA1');
  await expect(rows.filter({ hasText: 'Preventive maintenance overdue' })).toContainText('Closed: QA1');
  await expect(rows.filter({ hasText: 'Calibration overdue' })).toContainText('Sent to DIVE by QA1');
});
