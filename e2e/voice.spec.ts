import { expect, test } from '@playwright/test';
import { approveSettings, logIn, newEquipment, openLogbook, newEntry } from './helpers.js';

// The speech service is mocked by e2e/server.ts; no real API calls (D-26).
test.beforeAll(async () => {
  await approveSettings('voice_notes', { voiceLanguages: ['hi-IN', 'mr-IN'] });
});

test('LB-20: a voice note becomes entry text only after the speaker signs the English text', async ({ page }) => {
  const { code } = await newEquipment({ name: 'Granulator' });
  await logIn(page, 'op1');
  await openLogbook(page, code);
  await newEntry(page, 'Others (general log)');
  const form = page.getByRole('dialog');
  await form.getByLabel('Voice language for notes').selectOption('hi-IN');
  await form.getByRole('button', { name: '🎤 Record voice note' }).click();
  await expect(form.getByRole('button', { name: /Stop/ })).toBeVisible();
  await page.waitForTimeout(1200);
  await form.getByRole('button', { name: /Stop/ }).click();

  // The English translation is a draft in the field; the original is shown beside it.
  await expect(form.getByLabel(/^Notes/)).toHaveValue('The motor stopped suddenly.');
  await expect(form.locator('.voice-draft')).toContainText('You said: मोटर अचानक बंद हो गई');
  await form.getByLabel(/^Notes/).fill('The motor stopped suddenly during mixing.');

  // Saved only with the speaker's confirmation signature (password again at core, PL-05).
  await expect(form.locator('.signbox')).toContainText('I confirm this English text is a true record of what I said.');
  await form.getByRole('button', { name: 'Sign and save' }).click();
  await expect(form).toHaveCount(0);

  const row = page.getByRole('row').filter({ hasText: 'during mixing' });
  await expect(row).toContainText('The motor stopped suddenly during mixing.');
  await row.getByRole('button', { name: /Voice note \(Hindi, notes\)/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('मोटर अचानक बंद हो गई');
  await expect(dialog).toContainText('Machine translation');
  await expect(dialog).toContainText('The motor stopped suddenly.');
  await expect(dialog).toContainText('edited by the speaker');
  await expect(dialog).toContainText('OP1');
  await expect(dialog.locator('audio')).toHaveAttribute('src', /\/api\/voice-notes\/\d+\/audio$/);
});

test('LB-26: when the speech service fails, the user sees why and types the entry by hand', async ({ page }) => {
  const { code } = await newEquipment({ name: 'Sifter' });
  await page.route('**/api/voice-notes', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'speech_timeout', problems: ['The speech service did not answer in time. Your entry is not affected: type the text instead.'] }) })
      : route.continue());
  await logIn(page, 'op1');
  await openLogbook(page, code);
  await newEntry(page, 'Others (general log)');
  const form = page.getByRole('dialog');
  await form.getByRole('button', { name: '🎤 Record voice note' }).click();
  await page.waitForTimeout(800);
  await form.getByRole('button', { name: /Stop/ }).click();
  await expect(form.getByRole('status')).toContainText('type the text instead');
  await expect(form.getByLabel(/^Notes/)).toHaveValue('');
  await form.getByLabel(/^Notes/).fill('Sieve torn, typed by hand');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Sieve torn, typed by hand' })).toHaveCount(1);
});
