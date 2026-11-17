import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordOverdue } from '../server/overdue.js';
import { QualificationOff, type Qualification } from '../server/qualification.js';
import { refreshStatus, RETIRED, saveStatuses } from '../server/item-status.js';
import { statusContext, statusOf } from '../server/status.js';
import { addItem, addProduct, asReport, call, changeItem, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// D-45 (owner 15 Nov 2026): the status the Logbook works out is published for TrueBatch Tablets in
// report.equipment_status_v1 (one row per item, written by the minute check and right after each entry).

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
let n = 0;
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const COLUMNS = ['master_id', 'code', 'kind', 'state', 'fit_for_use', 'blockers', 'warnings', 'in_use_batch', 'cleaned_at', 'cleaned_by',
  'clean_until', 'calibration_due', 'qualification', 'checked_at', 'read_at', 'data_as_of', 'last_decontamination', 'sterile_valid_until',
  'last_glove_test', 'only_product'];

async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
async function item() {
  const code = `IS-${++n}`;
  const id = await addItem(t, { code, location: 'GRAN-1' });
  return { id, code, masterId: t.master.items_.get(code)!.itemId };
}
const published = async (code: string) => {
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.equipment_status_v1 where code = '${code}'`);
  expect(r.error).toBeUndefined();
  return r.rows![0] as Record<string, unknown> | undefined;
};
const tick = () => recordOverdue(t.sql, t.master, null);
async function cleanAndVerify(id: number) {
  const e = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(),
    data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json();
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${e.id}/versions`)).json().find((x: { id: number }) => x.id === e.id);
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${e.id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[key] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'P-IS', 'Product IS');
  for (const type of ['equipment_cleaning', 'equipment_use']) await approve(type);
});
afterAll(() => t.close());

describe('the Logbook publishes each item\'s status for TrueBatch (D-45)', () => {
  it('LB-08: the minute check publishes each item\'s status in equipment_status_v1, with the columns TrueBatch reads', async () => {
    const a = await item();
    expect(await published(a.code)).toBeUndefined();
    await tick();
    const row = (await published(a.code))!;
    expect(Object.keys(row)).toEqual(COLUMNS);
    expect(row).toMatchObject({ master_id: a.masterId, code: a.code, kind: 'equipment', state: 'dirty', fit_for_use: false,
      blockers: ['Dirty: clean and verify before the next use.'], warnings: [], in_use_batch: null, cleaned_at: null, cleaned_by: null });
    expect(Math.abs((row.checked_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
    expect(row.data_as_of).toEqual(row.checked_at);
  });

  it('LB-07: a verified cleaning is published at once, with when it ended and who performed it', async () => {
    const a = await item();
    await tick();
    await cleanAndVerify(a.id);
    await expect.poll(async () => (await published(a.code))?.fit_for_use).toBe(true);
    const row = (await published(a.code))!;
    expect(row).toMatchObject({ state: 'clean', blockers: [], cleaned_by: 'OP1' });
    expect(row.cleaned_at).toBeInstanceOf(Date);
  });

  it('LB-08: a use in progress does not count against fit for use; in_use_batch names the batch, and the Logbook still refuses a second use', async () => {
    const a = await item();
    await cleanAndVerify(a.id);
    const use = await call(t.app, c.op1!, 'POST', `/api/equipment/${a.id}/entries`, { logbookType: 'equipment_use', activityStart: now(), productId: product,
      batch: 'TB-IS-1', data: { stage: 'Compression' } });
    expect(use.statusCode).toBe(201);
    await expect.poll(async () => (await published(a.code))?.in_use_batch).toBe('TB-IS-1');
    expect(await published(a.code)).toMatchObject({ state: 'in_use', fit_for_use: true, blockers: [], cleaned_by: 'OP1' });
    const again = await call(t.app, c.op1!, 'POST', `/api/equipment/${a.id}/entries`, { logbookType: 'equipment_use', activityStart: now(), productId: product,
      batch: 'TB-IS-2', data: { stage: 'Compression' } });
    expect(again.statusCode).toBe(409);
  });

  it('PL-08: an item retired in master data is published as not fit for use', async () => {
    const a = await item();
    await cleanAndVerify(a.id);
    changeItem(t, a.code, { active: false });
    await tick();
    expect(await published(a.code)).toMatchObject({ fit_for_use: false, blockers: [RETIRED] });
  });

  it('D-67: only_product names the antibiotic last used until a verified product-changeover cleaning; null otherwise', async () => {
    const ab = await addProduct(t, 'FG-AB-IS', 'Antibiotic IS');
    t.master.products_.set('FG-AB-IS', { ...t.master.products_.get('FG-AB-IS')!, antibiotic: true });
    const a = await item();
    await cleanAndVerify(a.id);
    await tick();
    expect((await published(a.code))!.only_product).toBeNull();
    const use = (await call(t.app, c.op1!, 'POST', `/api/equipment/${a.id}/entries`, { logbookType: 'equipment_use', activityStart: now(), productId: ab,
      batch: 'AB-1', data: {} })).json().id;
    expect((await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() })).statusCode).toBe(200);
    const clean = async (cleaningType: string) => {
      const e = (await call(t.app, c.op1!, 'POST', `/api/equipment/${a.id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(),
        data: { cleaningType, checklist: {} }, signature: sig('op1') })).json();
      const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${e.id}/versions`)).json().find((x: { id: number }) => x.id === e.id);
      expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${e.id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
    };
    await clean('batch_to_batch');
    await expect.poll(async () => (await published(a.code))?.fit_for_use).toBe(true);
    expect((await published(a.code))!.only_product).toBe('FG-AB-IS');
    await clean('product_change');
    await expect.poll(async () => (await published(a.code))?.only_product).toBeNull();
  });

  it('PL-08: while Qualification is linked but not answering, the status is not rewritten: it grows old and is never wrong', async () => {
    const a = await item();
    await tick();
    const before = (await published(a.code))!.checked_at as Date;
    const cut: Qualification = { statuses: async () => { throw new QualificationOff(); }, protocols: async () => [] };
    await recordOverdue(t.sql, t.master, cut);
    await refreshStatus(t.sql, () => statusContext(t.sql, t.master, cut), { equipmentId: a.id });
    expect((await published(a.code))!.checked_at).toEqual(before);
    await tick();
    expect(((await published(a.code))!.checked_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it('LB-08: a row is replaced only by a newer check', async () => {
    const a = await item();
    const ctx = await statusContext(t.sql, t.master, null);
    const s = (await statusOf(t.sql, a.id, ctx))!;
    await saveStatuses(t.sql, [s], ctx);
    await saveStatuses(t.sql, [{ ...s, state: 'available', blockers: [], checkedAt: new Date(s.checkedAt.getTime() - 60_000) }], ctx);
    expect(await published(a.code)).toMatchObject({ state: 'dirty', fit_for_use: false });
  });

  it('LB-21: the report role reads equipment_status_v1 only; the app may update a status row but not delete it', async () => {
    const a = await item();
    await tick();
    expect(['42501', '55000']).toContain((await asReport(t.owner, `delete from ${t.reportSchema}.equipment_status_v1`)).error);
    expect((await asReport(t.owner, `select * from ${t.reportSchema.replace(/_report$/, '')}.item_status`)).error).toBe('42501');
    expect(await t.sql`delete from item_status where equipment_id = ${a.id}`.then(() => 'ok', (e: { code?: string }) => e.code)).toBe('42501');
  });
});
