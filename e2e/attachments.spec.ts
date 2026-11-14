import { expect, test } from '@playwright/test';
import { apiAs, logIn, newEntry, newEquipment, openLogbook, owner, sign } from './helpers.js';

// Owner 2026-11-14 (D-44): the certificate is attached in the calibration form; a document added later needs a reason;
// documents are listed on the entry, on the history card and downloadable.

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% calibration certificate CAL-778\n'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF\n')]);

test('LB-02: the engineer attaches the certificate with the calibration; it is listed, downloadable, and another is added later with a reason', async ({ page }) => {
  const item = await newEquipment({ name: 'Balance', kind: 'instrument' });
  await logIn(page, 'eng1');
  await openLogbook(page, item.code);
  await newEntry(page, 'Calibration');
  const form = page.getByRole('dialog');
  await form.getByLabel('Next due').fill(new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10));
  await form.getByLabel('Certificate / report reference').fill('CAL-778');
  await form.getByLabel('Attach documents (PDF, PNG or JPEG, up to 10 MB each)').setInputFiles({ name: 'CAL-778 certificate.pdf', mimeType: 'application/pdf', buffer: PDF });
  await form.getByLabel('Attach documents (PDF, PNG or JPEG, up to 10 MB each)').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(form).toContainText('notes.txt: only PDF, PNG and JPEG documents can be attached.');
  await expect(form.locator('.attachments')).toContainText('CAL-778 certificate.pdf');
  await sign(form, 'eng1', 'Sign and save');
  await expect(form).toHaveCount(0);
  const row = page.locator('tbody tr').filter({ hasText: 'Calibration' }).first();
  const link = row.getByRole('link', { name: /CAL-778 certificate.pdf/ });
  await expect(link).toBeVisible();
  // The download carries the file's type and name.
  const href = await link.getAttribute('href');
  const eng = await apiAs('eng1');
  const dl = await eng.get(href!);
  expect(dl.headers()['content-type']).toBe('application/pdf');
  expect(dl.headers()['content-disposition']).toContain('CAL-778 certificate.pdf');
  expect(Buffer.from(await dl.body()).equals(PDF)).toBe(true);
  await eng.dispose();

  // Two hours later the vendor's scan arrives: added with a reason.
  const db = owner();
  await db`update entries set entered_at = now() - interval '2 hours' where equipment_id = ${item.id} and logbook_type = 'calibration'`;
  await db.end();
  await row.getByRole('button', { name: 'Attach document' }).click();
  const attach = page.getByRole('dialog');
  await attach.getByLabel('Attach documents (PDF, PNG or JPEG, up to 10 MB each)').setInputFiles({ name: 'vendor scan.pdf', mimeType: 'application/pdf', buffer: PDF });
  await attach.getByLabel('Reason for adding it now').fill('Certificate scan received from the vendor');
  await attach.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(attach).toHaveCount(0);
  await expect(row.getByRole('link', { name: /vendor scan.pdf/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/attachments-entry.png', fullPage: true });
  // On the history card, with who added it and why.
  await page.getByRole('button', { name: 'History card' }).click();
  const history = page.locator('table.history');
  await expect(history).toContainText('CAL-778 certificate.pdf');
  await expect(history).toContainText('added: Certificate scan received from the vendor');
});
