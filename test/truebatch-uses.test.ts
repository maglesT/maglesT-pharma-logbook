import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlTrueBatchUses } from '../server/batches.js';
import { recordOverdue } from '../server/overdue.js';
import { refreshStatus } from '../server/item-status.js';
import { statusContext, TRUEBATCH_USES_OFF, usesOffWarning } from '../server/status.js';
import { connect, type Sql } from '../server/db.js';
import { addItem, addProduct, asReport, call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type ItemBody, type TestApp } from './helpers.js';

// D-46 (owner 15 Nov 2026): the Logbook reads TrueBatch's equipment_use_v1 live. A machine or room is in use while a
// TrueBatch step using it is open, and dirty after the step is signed done, exactly as if the use had been entered in the
// Logbook: nothing typed twice, nothing copied. The published status (equipment_status_v1) follows.
// D-47: TrueBatch Tablets Packing's equipment_use_v1 (same columns, its own link) counts the same way, merged with
// TrueBatch's; its batches are not read.

let t: TestApp;
let reader: Sql;
const c: Record<string, string> = {};
const TB = `tbu_${process.pid}`;
const TBP = `tbp_${process.pid}`;
const PACKING_OFF = usesOffWarning('TrueBatch Packing');
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
let product: number;
let n = 0;

async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const item = async (body: Partial<ItemBody> = {}) => {
  const code = `TBU-${++n}`;
  return { code, id: await addItem(t, { code, location: 'GRAN-TB', ...body }) };
};
/** A TrueBatch step using the item, open (no end) or signed done `endedMinutesAgo` minutes ago. */
const tbUse = (batch: string, code: string, opts: { room?: string; startedMinutesAgo?: number; endedMinutesAgo?: number | null; schema?: string } = {}) => t.owner.unsafe(
  `insert into ${opts.schema ?? TB}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at, data_as_of)
   values ($1, $2, 'machine', $3, 'granulation/charge-api', now() - make_interval(mins => $4), case when $5::int is null then null else now() - make_interval(mins => $5::int) end, now())`,
  [batch, code, opts.room ?? 'GRAN-TB', opts.startedMinutesAgo ?? 60, opts.endedMinutesAgo ?? null]);
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const entry = (id: number, body: object) => call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, body);
const cleaning = (id: number, data: object = {}) => entry(id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {}, ...data }, signature: sig('op1') });
async function verify(versionId: number) {
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${versionId}/versions`)).json().find((x: { id: number }) => x.id === versionId);
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${versionId}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
}
const published = async (code: string) => {
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.equipment_status_v1 where code = '${code}'`);
  expect(r.error).toBeUndefined();
  return r.rows![0] as Record<string, unknown> | undefined;
};
const tick = () => recordOverdue(t.sql, t.master, null, t.app.trueBatchUses);

beforeAll(async () => {
  // The reader logs in as the Logbook's link does; the views are stood in for by tables of the same names and columns.
  reader = connect(TEST_DATABASE_URL, { role: 'logbook_app' });
  t = await freshApp({ trueBatchUses: [sqlTrueBatchUses(reader, TB), sqlTrueBatchUses(reader, TBP, 'TrueBatch Packing', null)] });
  await t.owner.unsafe(`create schema ${TB}`);
  await t.owner.unsafe(`create schema ${TBP}`);
  await t.owner.unsafe(`create table ${TB}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
      completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
    create table ${TB}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz);
    insert into ${TB}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
      ('TB260001', 'FG-TB', 'IN_PRODUCTION', now() - interval '1 day', null, false),
      ('TB260002', 'FG-TB', 'IN_PRODUCTION', now() - interval '1 day', null, false),
      ('TB250099', 'FG-TB', 'REJECTED', now() - interval '9 days', now() - interval '8 days', false);
    grant usage on schema ${TB} to logbook_app; grant select on all tables in schema ${TB} to logbook_app;
    create table ${TBP}.equipment_use_v1 (like ${TB}.equipment_use_v1 including defaults);
    grant usage on schema ${TBP} to logbook_app; grant select on all tables in schema ${TBP} to logbook_app;`);
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'FG-TB', 'Product TB');
  for (const type of ['equipment_use', 'equipment_cleaning', 'area_cleaning']) await approve(type);
});
afterAll(async () => {
  await t.close();
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${TB} cascade`).catch(() => {});
  await t.owner.unsafe(`drop schema if exists ${TBP} cascade`).catch(() => {});
});

describe('uses recorded in TrueBatch count in the status (D-46)', () => {
  it('LB-08: a machine is in use while its TrueBatch step is open: shown and published with the batch; a Logbook use or cleaning is refused', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('TB260001', a.code.toLowerCase());
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'TB260001', stage: 'granulation/charge-api', source: 'TrueBatch', entryId: null } });
    expect(s.blockers).toEqual(['In use by batch TB260001 in TrueBatch (granulation/charge-api): it ends when the step is signed done in TrueBatch.']);
    const use = await entry(a.id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'TB260002', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems[0]).toMatch(/^In use by batch TB260001 in TrueBatch/);
    const clean = await cleaning(a.id);
    expect(clean.statusCode).toBe(409);
    expect(clean.json().problems).toEqual(['In use by batch TB260001 in TrueBatch: record the cleaning once the step is signed done in TrueBatch.']);
    await tick();
    // As a Logbook use (D-45): the use itself does not count against fit for use; in_use_batch names the batch.
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: 'TB260001', fit_for_use: true, blockers: [] });
  });

  it('LB-07: after the TrueBatch step is signed done the machine is dirty and published unfit until a verified cleaning after the end', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    // Used in TrueBatch after that cleaning; the step was just signed done.
    await tbUse('TB260001', a.code, { startedMinutesAgo: 0, endedMinutesAgo: 0 });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'dirty', inUse: null, lastTrueBatchUse: { batch: 'TB260001', step: 'granulation/charge-api' } });
    expect(s.blockers).toEqual(['Dirty: clean and verify before the next use.']);
    await tick();
    expect(await published(a.code)).toMatchObject({ state: 'dirty', fit_for_use: false, in_use_batch: null });
    // A cleaning that started before the step was signed done does not count.
    const early = await entry(a.id, { logbookType: 'equipment_cleaning', activityStart: new Date(Date.now() - 20 * 60_000).toISOString(),
      data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(early.json().problems).toEqual(['A cleaning cannot start before the last use ended.']);
    const e = (await cleaning(a.id)).json().id;
    expect((await status(a.id)).state).toBe('dirty');
    await verify(e);
    await expect.poll(async () => (await published(a.code))?.fit_for_use).toBe(true);
    expect(await status(a.id)).toMatchObject({ state: 'clean', blockers: [], lastTrueBatchUse: { batch: 'TB260001' } });
  });

  it('LB-07: the dirty hold runs from the end of the TrueBatch use; once it ran out the cleaning says why, and the miss is recorded for Deviations', async () => {
    const a = await item({ dirtyHoldHours: 1 });
    await t.owner`update overdue_since set since = now() - interval '1 day'`;
    await tbUse('TB260002', a.code, { startedMinutesAgo: 200, endedMinutesAgo: 120 });
    const s = await status(a.id);
    expect(s.state).toBe('dirty_expired');
    expect(s.blockers[0]).toMatch(/^Dirty-hold time expired at \d{4}-\d\d-\d\d \d\d:\d\d IST: the cleaning is late; clean, verify and record why\.$/);
    await tick();
    const [ev] = await t.owner<{ description: string }[]>`select description from overdue_events where equipment_id = ${a.id} and kind = 'dirty_hold'`;
    expect(ev!.description).toContain('batch TB260002 in TrueBatch (granulation/charge-api)');
    const noReason = await cleaning(a.id);
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().problems[0]).toMatch(/^The dirty hold ran out at \d{4}-\d\d-\d\d \d\d:\d\d IST: give the reason the cleaning is late\.$/);
    const ok = await cleaning(a.id, { delayReason: 'Cleaning crew on the line clearance of RM-104' });
    expect(ok.statusCode).toBe(201);
    const [row] = await t.owner<{ data: Record<string, unknown> }[]>`select data from entries where id = ${ok.json().id}`;
    expect(row!.data.delayReason).toBe('Cleaning crew on the line clearance of RM-104');
  });

  it('LB-08: a room is in use by its own TrueBatch row (the room as equipment_code); a machine used in the room does not occupy the room', async () => {
    const room = await item({ kind: 'area' });
    const press = await item();
    await tbUse('TB260001', press.code, { room: room.code });
    expect((await status(room.id)).inUse).toBeNull();
    expect((await status(press.id)).inUse).toMatchObject({ batch: 'TB260001', source: 'TrueBatch' });
    await tbUse('TB260001', room.code, { room: room.code });
    expect((await status(room.id))).toMatchObject({ state: 'in_use', inUse: { batch: 'TB260001', source: 'TrueBatch' } });
  });

  it('LB-08: a step left open in a batch no longer in production does not hold the item', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('TB250099', a.code);
    expect(await status(a.id)).toMatchObject({ state: 'clean', inUse: null });
  });

  it('PL-08: with the TrueBatch link cut the status says so for that part, still answers, and is not published (it grows old, never wrong)', async () => {
    const a = await item();
    await tick();
    const before = (await published(a.code))!.checked_at as Date;
    await t.owner.unsafe(`revoke select on all tables in schema ${TB} from logbook_app`);
    try {
      const s = await status(a.id);
      expect(s.state).toBe('dirty');
      expect(s.warnings).toContain(TRUEBATCH_USES_OFF);
      await tick();
      await refreshStatus(t.sql, () => statusContext(t.sql, t.master, null, t.app.trueBatchUses), { equipmentId: a.id });
      expect((await published(a.code))!.checked_at).toEqual(before);
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${TB} to logbook_app`);
    }
    await tick();
    expect(((await published(a.code))!.checked_at as Date).getTime()).toBeGreaterThan(before.getTime());
    expect((await status(a.id)).warnings).not.toContain(TRUEBATCH_USES_OFF);
  });
});

describe('uses recorded in TrueBatch Packing count too, merged with TrueBatch\'s (D-47)', () => {
  const pkUse = (batch: string, code: string, opts: { startedMinutesAgo?: number; endedMinutesAgo?: number | null } = {}) =>
    tbUse(batch, code, { ...opts, schema: TBP });

  it('LB-08: a machine is in use while its packing step is open; the messages name TrueBatch Packing; published with the batch', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    // A packing batch number: TrueBatch's batch_fact_v1 does not have it, and packing's batches are not read.
    await pkUse('PK260001', a.code);
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'PK260001', source: 'TrueBatch Packing', entryId: null } });
    expect(s.blockers).toEqual(['In use by batch PK260001 in TrueBatch Packing (granulation/charge-api): it ends when the step is signed done in TrueBatch Packing.']);
    const use = await entry(a.id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'TB260002', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems[0]).toMatch(/^In use by batch PK260001 in TrueBatch Packing/);
    expect((await cleaning(a.id)).json().problems).toEqual(['In use by batch PK260001 in TrueBatch Packing: record the cleaning once the step is signed done in TrueBatch Packing.']);
    await tick();
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: 'PK260001', fit_for_use: true });
  });

  it('LB-07: the newest ended use of either product is the last use: dirty after it, and the dirty-hold record names that product', async () => {
    const a = await item({ dirtyHoldHours: 1 });
    await t.owner`update overdue_since set since = now() - interval '1 day'`;
    await tbUse('TB260001', a.code, { startedMinutesAgo: 300, endedMinutesAgo: 240 });
    await pkUse('PK260002', a.code, { startedMinutesAgo: 200, endedMinutesAgo: 120 });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'dirty_expired', inUse: null, lastTrueBatchUse: { batch: 'PK260002', source: 'TrueBatch Packing' } });
    await tick();
    const [ev] = await t.owner<{ description: string }[]>`select description from overdue_events where equipment_id = ${a.id} and kind = 'dirty_hold'`;
    expect(ev!.description).toContain('batch PK260002 in TrueBatch Packing (granulation/charge-api)');
    // A later TrueBatch use is the last use again.
    await tbUse('TB260002', a.code, { startedMinutesAgo: 30, endedMinutesAgo: 10 });
    expect((await status(a.id)).lastTrueBatchUse).toMatchObject({ batch: 'TB260002', source: 'TrueBatch' });
  });

  it('PL-08: each link off says so on its own: with TrueBatch Packing cut, TrueBatch\'s uses still count, the warning names Packing, nothing is published', async () => {
    const a = await item();
    const b = await item();
    await tbUse('TB260001', a.code);
    await pkUse('PK260003', b.code);
    await tick();
    const before = (await published(a.code))!.checked_at as Date;
    await t.owner.unsafe(`revoke select on all tables in schema ${TBP} from logbook_app`);
    try {
      const sa = await status(a.id);
      expect(sa).toMatchObject({ state: 'in_use', inUse: { batch: 'TB260001', source: 'TrueBatch' } });
      expect(sa.warnings).toContain(PACKING_OFF);
      expect(sa.warnings).not.toContain(TRUEBATCH_USES_OFF);
      expect(PACKING_OFF).toBe('Connection to TrueBatch Packing is off: machine and room uses recorded in TrueBatch Packing (in use, dirty after use) are not shown. Ask your administrator.');
      // The packing use is not shown (checked by hand on the floor).
      expect((await status(b.id)).inUse).toBeNull();
      await tick();
      await refreshStatus(t.sql, () => statusContext(t.sql, t.master, null, t.app.trueBatchUses), { equipmentId: a.id });
      expect((await published(a.code))!.checked_at).toEqual(before);
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${TBP} to logbook_app`);
    }
    await tick();
    expect(((await published(a.code))!.checked_at as Date).getTime()).toBeGreaterThan(before.getTime());
    expect((await status(b.id)).inUse).toMatchObject({ batch: 'PK260003', source: 'TrueBatch Packing' });
    expect((await status(b.id)).warnings).not.toContain(PACKING_OFF);
  });
});
