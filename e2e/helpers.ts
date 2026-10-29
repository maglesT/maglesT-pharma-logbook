import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { PASSWORD, TEST_DATABASE_URL } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA } from './config.js';

export { PASSWORD };
const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Owner connection to the e2e schema, only to move time behind the application's back.
export const owner = () => connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });

export async function logIn(page: Page, username: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('User ID').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

// Signs in an open dialog or form sign box (user ID + password, LB-20).
export async function sign(scope: Locator, username: string, button = 'Sign') {
  await scope.getByLabel('User ID').fill(username);
  await scope.getByLabel('Password').fill(PASSWORD);
  await scope.getByRole('button', { name: button, exact: true }).click();
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
  const res = await ctx.post('/api/login', { data: { username, password: PASSWORD } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function post(ctx: APIRequestContext, url: string, data: object) {
  const res = await ctx.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return res.json();
}

let n = 0;
export async function newEquipment(body: object = {}): Promise<{ id: number; code: string }> {
  const admin = await apiAs('admin');
  const code = `E2E-${Date.now().toString(36)}-${++n}`.toUpperCase();
  const { id } = await post(admin, '/api/equipment', { code, name: 'Test item', kind: 'equipment', location: 'Block A', ...body });
  await admin.dispose();
  return { id, code };
}

export async function recordAndVerify(equipmentId: number, body: object, performer = 'op1', verifier = 'sup1') {
  const by = await apiAs(performer);
  const now = new Date().toISOString();
  const { id } = await post(by, `/api/equipment/${equipmentId}/entries`, { activityStart: now, signature: { username: performer, password: PASSWORD }, ...body });
  await by.dispose();
  const check = await apiAs(verifier);
  const [version] = await (await check.get(`/api/entries/${id}/versions`)).json();
  await post(check, `/api/entries/${id}/verify`, { username: verifier, password: PASSWORD, contentHash: version.contentHash });
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
  await post(qa, `/api/settings/${id}/approve`, { username: 'qa1', password: PASSWORD, contentHash: versions.find((v: { id: number }) => v.id === id).contentHash });
  await qa.dispose();
}
