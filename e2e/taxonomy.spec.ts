import { expect, test, type Page } from '@playwright/test';
import { logIn, newEquipment } from './helpers.js';

// Owner 2026-11-14 (D-42): the Logbooks page narrows the list level by level (kind → facility → dosage form → process →
// step), every level optional, the search within the selection, the choice remembered in the URL.

const chip = (page: Page, row: string, name: string | RegExp) => page.getByRole('group', { name: row }).getByRole('button', { name });
const tiles = (page: Page) => page.locator('.tiles .tile');
// The count on a chip; other specs add items of their own, so counts are checked as "at least".
const countOn = async (c: ReturnType<typeof chip>) => Number(/(\d+)$/.exec((await c.innerText()).trim())?.[1]);

test.describe('Logbooks: cascading classification filter', () => {
  const codes: Record<string, string> = {};
  test.beforeAll(async () => {
    codes.rmg = (await newEquipment({ name: 'Rapid mixer granulator 150 L', type: 'Rapid mixer granulator' })).code;
    codes.rc = (await newEquipment({ name: 'Roller compactor', type: 'Roller compactor' })).code;
    codes.press = (await newEquipment({ name: 'Rotary tablet press', type: 'Tablet press' })).code;
    codes.lyo = (await newEquipment({ name: 'Lyophiliser 20 m2', type: 'Lyophiliser' })).code;
    codes.hplc = (await newEquipment({ name: 'HPLC system', kind: 'instrument', type: 'HPLC' })).code;
    codes.room = (await newEquipment({ name: 'Beta-lactam (penicillin) block: granulation room', kind: 'area', type: 'Granulation', grade: 'D' })).code;
    codes.odd = (await newEquipment({ name: 'Odd machine', type: 'Flux capacitor' })).code;
  });

  test('Equipment → OSD → Tablet → Granulation → Dry granulation shows only the roller compactor, with counts and a breadcrumb', async ({ page }) => {
    await logIn(page, 'op1');
    await page.getByRole('button', { name: 'Logbooks' }).click();
    await expect(page.getByRole('group', { name: 'Kind' })).toBeVisible();
    // Nothing chosen: no process row yet.
    await expect(page.getByRole('group', { name: 'Process' })).toHaveCount(0);

    await chip(page, 'Kind', /^Equipment/).click();
    await chip(page, 'Dosage form', /^Oral solid dosage/).click();
    await expect(page.getByRole('group', { name: 'Oral solid dosage (OSD)' })).toBeVisible();
    await chip(page, 'Oral solid dosage (OSD)', /^Tablet/).click();
    expect(await countOn(chip(page, 'Process', /^Granulation/))).toBeGreaterThanOrEqual(2);
    await chip(page, 'Process', /^Granulation/).click();
    await expect(page.getByRole('group', { name: 'Granulation' })).toBeVisible();
    await chip(page, 'Granulation', /^Dry granulation/).click();

    await expect(tiles(page).filter({ hasText: codes.rc! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.rmg! })).toHaveCount(0);
    await expect(tiles(page).filter({ hasText: codes.press! })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Current selection' })).toContainText('Equipment›Oral solid dosage (OSD)›Tablet›Granulation›Dry granulation');
    expect(page.url()).toContain('#logbooks=equipment%2F%2Fosd.tablet%2Fgranulation.dry');

    // Going back up the breadcrumb to Granulation shows both granulators.
    await page.getByRole('navigation', { name: 'Current selection' }).getByRole('button', { name: 'Granulation', exact: true }).click();
    await expect(tiles(page).filter({ hasText: codes.rmg! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.rc! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.press! })).toHaveCount(0);
    // The selection survives a reload (URL hash).
    await page.reload();
    await page.getByRole('button', { name: 'Logbooks' }).click();
    await expect(tiles(page).filter({ hasText: codes.rmg! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.press! })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Current selection' })).toContainText('Granulation');
    await page.getByRole('button', { name: 'Clear' }).click();
  });

  test('stopping at Equipment and searching works; facility, areas with grade, and "Other" for an unknown type', async ({ page }) => {
    await logIn(page, 'op1');
    await page.getByRole('button', { name: 'Logbooks' }).click();
    await page.getByRole('button', { name: 'All items' }).click();
    await chip(page, 'Kind', /^Equipment/).click();
    await expect(page.getByRole('group', { name: 'Process' })).toHaveCount(0);
    const before = await tiles(page).count();
    expect(before).toBeGreaterThanOrEqual(5);
    await page.getByLabel('Search by ID, name or location').fill(codes.rmg!);
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).first()).toContainText('Rapid mixer granulator');
    await page.getByLabel('Search by ID, name or location').fill('');
    await expect(tiles(page)).toHaveCount(before);

    // The facility row: the penicillin room is the only beta-lactam item.
    await chip(page, 'Kind', /^Areas/).click();
    await chip(page, 'Facility', /^Beta-lactam/).click();
    await expect(page.getByRole('group', { name: 'Beta-lactam' })).toBeVisible();
    expect(await countOn(chip(page, 'Beta-lactam', /^Penicillin/))).toBeGreaterThanOrEqual(1);
    await expect(chip(page, 'Cleanroom grade', /^Grade D/)).toBeVisible();
    await chip(page, 'Cleanroom grade', /^Grade D/).click();
    await expect(tiles(page).filter({ hasText: codes.room! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.rmg! })).toHaveCount(0);

    // Unknown type: never hidden, found under "Other".
    await page.getByRole('button', { name: 'Clear' }).click();
    await chip(page, 'Kind', /^Equipment/).click();
    await chip(page, 'Dosage form', /^Other/).click();
    await expect(tiles(page).filter({ hasText: codes.odd! })).toHaveCount(1);
    await expect(tiles(page).filter({ hasText: codes.rmg! })).toHaveCount(0);
    await expect(page.getByText(/of \d+ logbooks \(\d+ in the selection\)/)).toBeVisible();
  });
});
