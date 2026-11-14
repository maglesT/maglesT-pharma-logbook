import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA } from './config.js';

const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Owner connection to the e2e schema, only to move time behind the application's back.
export const owner = () => connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });

// Sign-on goes through Medhanta core (D-29); the test server's stand-in signs in whoever login_hint names.
export async function logIn(page: Page, username: string) {
  await page.goto(`/login?login_hint=${encodeURIComponent(username)}`);
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

export async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  // The browser goes on to core's sign-out page (here the stand-in's, on the app itself).
  await page.waitForURL(/signed-out=/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
}

// Signs in an open dialog or form sign box (PL-05): the click opens the window where core asks for the password
// again; the test server's stand-in confirms the signed-in person at once.
export async function sign(scope: Locator, _username: string, button = 'Sign') {
  await scope.getByRole('button', { name: button, exact: true }).click();
}

// A signing proof through the API, as the sign window gets it: /sign, core, /cb.
export async function proofOf(ctx: APIRequestContext, meaning: string): Promise<string> {
  const html = await (await ctx.get(`/sign?meanings=${meaning}`)).text();
  const proof = /"signProof":"([^"]+)"/.exec(html)?.[1];
  expect(proof, html).toBeTruthy();
  return proof!;
}

export async function openLogbook(page: Page, code: string) {
  await page.getByRole('button', { name: 'Logbooks' }).click();
  await page.getByRole('button', { name: new RegExp(`^${code} `) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
}

export const statusBar = (page: Page) => page.locator('.statusbar');

// Set-up that is not the point of a test goes through the API, as the given user.
export async function apiAs(username: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.get(`/login?login_hint=${encodeURIComponent(username)}`);
  expect(res.ok()).toBe(true);
  expect((await ctx.get('/api/me')).ok()).toBe(true);
  return ctx;
}

export async function post(ctx: APIRequestContext, url: string, data: object) {
  const res = await ctx.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return res.json();
}

let n = 0;
export async function newEquipment(body: object = {}): Promise<{ id: number; code: string }> {
  // Items are core's master data (D-29): added to the test server's stand-in, then given their Logbook settings.
  // Master data keeps the hold times and frequencies (platform D-24); the item is then added by its ID (owner, point 4).
  const { name, kind, location, sterile, type, grade, ...care } = { name: 'Test item', kind: 'equipment', location: 'Block A', ...body } as
    { name: string; kind: string; location: string; sterile?: boolean; type?: string; grade?: string } & Record<string, unknown>;
  const code = `E2E-${Date.now().toString(36)}-${++n}`.toUpperCase();
  const db = owner();
  const [row] = await db<{ item_id: string }[]>`insert into e2e_master_items (code, name, kind, room, care, type, grade)
    values (${code}, ${name}, ${kind}, ${kind === 'area' ? null : location}, ${db.json(care as never)}, ${type ?? null}, ${grade ?? null}) returning item_id::text`;
  await db.end();
  const admin = await apiAs('admin');
  const added = await post(admin, '/api/equipment', { itemId: row!.item_id, sterile: sterile ?? false, reason: 'E2E set-up' });
  await admin.dispose();
  return { id: added.id as number, code };
}

export async function recordAndVerify(equipmentId: number, body: object, performer = 'op1', verifier = 'sup1') {
  const by = await apiAs(performer);
  const now = new Date().toISOString();
  const { id } = await post(by, `/api/equipment/${equipmentId}/entries`, { activityStart: now, signature: { proof: await proofOf(by, 'performed') }, ...body });
  await by.dispose();
  const check = await apiAs(verifier);
  const [version] = await (await check.get(`/api/entries/${id}/versions`)).json();
  await post(check, `/api/entries/${id}/verify`, { proof: await proofOf(check, 'verified'), contentHash: version.contentHash });
  await check.dispose();
  return id as number;
}

export const cleanVerified = (equipmentId: number) =>
  recordAndVerify(equipmentId, { logbookType: 'equipment_cleaning', data: { cleaningType: 'major', checklist: {} } });

export async function approveSettings(logbookType: string, settings: object = {}) {
  const admin = await apiAs('admin');
  const { id } = await post(admin, '/api/settings', {
    logbookType, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...settings }, effectiveFrom: new Date().toISOString(),
  });
  await admin.dispose();
  const qa = await apiAs('qa1');
  const versions = (await (await qa.get('/api/logbook-types')).json()).flatMap((t: { versions: { id: number; contentHash: string }[] }) => t.versions);
  await post(qa, `/api/settings/${id}/approve`, { proof: await proofOf(qa, 'approved'), contentHash: versions.find((v: { id: number }) => v.id === id).contentHash });
  await qa.dispose();
}

// A datetime-local value some minutes ago, in the browser's own time zone.
export const localTime = (page: Page, minutesAgo: number) =>
  page.evaluate((m) => {
    const d = new Date(Date.now() - m * 60_000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }, minutesAgo);

// Owner 2026-11-12 (slide 3): a new entry starts from the Activity dropdown.
export async function newEntry(page: Page, activity: string) {
  await page.getByLabel('Activity').selectOption({ label: activity });
  await page.getByRole('button', { name: '+ New entry' }).click();
}
