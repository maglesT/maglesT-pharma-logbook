import { expect, test } from '@playwright/test';
import { approveSettings, logIn, owner } from './helpers.js';

// D-79: the test server links QMS. SOP references are picked from QMS' effective SOPs, never typed.
test('D-79: with QMS linked, a logbook type\'s SOPs are picked from QMS, not typed', async ({ page }) => {
  await approveSettings('requalification', { sopRef: 'SOP-1' });
  await logIn(page, 'admin');
  await page.getByRole('button', { name: 'Logbook settings' }).click();
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Requalification' }) });
  await expect(section).toContainText('SOP SOP-1');
  await section.getByRole('button', { name: 'New version' }).click();
  const form = page.getByRole('dialog');
  await expect(form).toContainText('SOPs come from QMS');
  await expect(form.getByRole('textbox', { name: 'SOP reference' })).toHaveCount(0);
  await expect(form).toContainText('SOP-1 rev 01 · Logbook entries');
  const add = form.getByLabel('Add an SOP from QMS');
  // Only effective SOPs are offered.
  await expect(add.locator('option', { hasText: 'SOP-ENG-020' })).toHaveCount(0);
  await add.selectOption('SOP-ENG-010');
  await form.getByRole('button', { name: 'Remove SOP-1' }).click();
  await expect(form).toContainText('SOP-ENG-010 rev 03 · Preventive maintenance');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(form).toHaveCount(0);
  const db = owner();
  const [row] = await db<{ sop: string }[]>`select settings->>'sopRef' as sop from logbook_settings where logbook_type = 'requalification' order by version desc limit 1`;
  await db.end();
  expect(row!.sop).toBe('SOP-ENG-010');
});
