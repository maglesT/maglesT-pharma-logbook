import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { apiAs, cleanVerified, logIn, newEquipment, post, sign } from './helpers.js';

test('LB-25: QA signs a period review; the batch view and the PDF exports open', async ({ page }) => {
  const { id, code } = await newEquipment();
  await cleanVerified(id);
  const batch = `B-REV-${Date.now().toString(36)}`;
  const op = await apiAs('op1');
  const [product] = await (await op.get('/api/products')).json();
  const use = await post(op, `/api/equipment/${id}/entries`, { logbookType: 'equipment_use', activityStart: new Date().toISOString(), productId: product.id, batch, data: { stage: 'Granulation' } });
  await post(op, `/api/entries/${use.id}/complete`, { activityEnd: new Date().toISOString() });
  await op.dispose();

  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'Review' }).click();
  await page.locator('select').first().selectOption({ label: `${code} · Test item` });
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.locator('.statusbar')).toContainText('2 entries');
  await page.getByRole('button', { name: 'Sign as reviewed' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Sign: Reviewed');
  await expect(dialog).toContainText(`Logbook ${code}`);
  await sign(dialog, 'qa1');
  await expect(page.getByText(/^Reviewed by QA1/)).toBeVisible();

  const pdf = async (link: string) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: link, exact: true }).click()]);
    const head = (await readFile((await download.path())!)).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
    return download.suggestedFilename();
  };
  expect(await pdf('PDF')).toMatch(/\.pdf$/);

  await page.getByRole('button', { name: 'Batch view' }).click();
  await page.getByPlaceholder('Batch number').fill(batch);
  await page.getByRole('button', { name: 'Show' }).click();
  const row = page.locator('table').first().getByRole('row').filter({ hasText: 'Equipment use' }).filter({ hasText: 'completed' });
  await expect(row).toContainText(code);
  await expect(row).toContainText(`Batch ${batch}`);
  expect(await pdf('PDF')).toMatch(/\.pdf$/);
});
