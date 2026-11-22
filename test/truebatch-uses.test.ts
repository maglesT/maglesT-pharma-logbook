import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trueBatchReaders } from '../server/batches.js';
import { TRUEBATCH_PROVIDERS, type TrueBatchProvider } from '../server/truebatch-providers.js';
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
// D-54: TrueBatch Injectables Packing's equipment_use_v1 counts as TrueBatch Packing's (its batches are not read either).
// D-75: the readers are built from the one list of TrueBatch products (TRUEBATCH_PROVIDERS), each with a stand-in schema;
// Capsules, Oral Liquids and API count as Injectables (bulk), their packing products as Packing.

let t: TestApp;
let reader: Sql;
const c: Record<string, string> = {};
const TB = `tbu_${process.pid}`;
const TBP = `tbp_${process.pid}`;
const TBI = `tbi_${process.pid}`;
const TBIP = `tbip_${process.pid}`;
// D-75: the stand-in schema of each TrueBatch product (the four above, and one per new product).
const SCHEMA: Record<TrueBatchProvider['id'], string> = { truebatch: TB, truebatch_packing: TBP, truebatch_injectables: TBI,
  truebatch_injectables_packing: TBIP, truebatch_capsules: `tbc_${process.pid}`, truebatch_capsules_packing: `tbcp_${process.pid}`,
  truebatch_liquids: `tbl_${process.pid}`, truebatch_liquids_packing: `tblp_${process.pid}`, truebatch_api: `tba_${process.pid}` };
const NEW = TRUEBATCH_PROVIDERS.filter((p) => !['truebatch', 'truebatch_packing', 'truebatch_injectables', 'truebatch_injectables_packing'].includes(p.id));
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
  // D-75: every TrueBatch product linked, read as index.ts reads them.
  t = await freshApp({ trueBatchUses: trueBatchReaders(TRUEBATCH_PROVIDERS.map((provider) => ({ provider, q: reader, schema: SCHEMA[provider.id] }))).uses });
  await t.owner.unsafe(`create schema ${TB}`);
  await t.owner.unsafe(`create schema ${TBP}`);
  await t.owner.unsafe(`create schema ${TBI}`);
  await t.owner.unsafe(`create schema ${TBIP}`);
  await t.owner.unsafe(`create table ${TB}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
      completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
    create table ${TB}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text);
    insert into ${TB}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
      ('TB260001', 'FG-TB', 'IN_PRODUCTION', now() - interval '1 day', null, false),
      ('TB260002', 'FG-TB', 'IN_PRODUCTION', now() - interval '1 day', null, false),
      ('TB250099', 'FG-TB', 'REJECTED', now() - interval '9 days', now() - interval '8 days', false);
    grant usage on schema ${TB} to logbook_app; grant select on all tables in schema ${TB} to logbook_app;
    -- Packing's view as before D-48: no step_name column.
    create table ${TBP}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz);
    grant usage on schema ${TBP} to logbook_app; grant select on all tables in schema ${TBP} to logbook_app;
    -- D-52: TrueBatch Injectables publishes the same two views as TrueBatch.
    create table ${TBI}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
      completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
    create table ${TBI}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text);
    insert into ${TBI}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
      ('TI260001', 'FG-TI', 'IN_PRODUCTION', now() - interval '1 day', null, false),
      ('TI250099', 'FG-TI', 'REJECTED', now() - interval '9 days', now() - interval '8 days', false);
    grant usage on schema ${TBI} to logbook_app; grant select on all tables in schema ${TBI} to logbook_app;
    -- D-54: TrueBatch Injectables Packing publishes equipment_use_v1 with Packing's columns; its batches are not read.
    create table ${TBIP}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text);
    grant usage on schema ${TBIP} to logbook_app; grant select on all tables in schema ${TBIP} to logbook_app;`);
  // D-75: the new products publish the same views: a bulk product batch_fact_v1 (one batch in production, one rejected) and
  // equipment_use_v1; a packing product packing_batch_v1 and equipment_use_v1.
  for (const p of NEW) {
    const x = SCHEMA[p.id];
    await t.owner.unsafe(`create schema ${x};
      create table ${x}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
        ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text);
      ${p.packing
        ? `create table ${x}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text,
            pack_type text, status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);`
        : `create table ${x}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
            completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
          insert into ${x}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
            ('${x.toUpperCase()}-1', 'FG-NEW', 'IN_PRODUCTION', now() - interval '1 day', null, false),
            ('${x.toUpperCase()}-X', 'FG-NEW', 'REJECTED', now() - interval '9 days', now() - interval '8 days', false);`}
      grant usage on schema ${x} to logbook_app; grant select on all tables in schema ${x} to logbook_app;`);
  }
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
  await t.owner.unsafe(`drop schema if exists ${TBI} cascade`).catch(() => {});
  await t.owner.unsafe(`drop schema if exists ${TBIP} cascade`).catch(() => {});
  for (const p of NEW) await t.owner.unsafe(`drop schema if exists ${SCHEMA[p.id]} cascade`).catch(() => {});
});

describe('uses recorded in TrueBatch count in the status (D-46)', () => {
  it('LB-08: a machine is in use while its TrueBatch step is open: shown and published with the batch; a Logbook use or cleaning is refused', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('TB260001', a.code.toLowerCase());
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'TB260001', stage: 'granulation/charge-api', source: 'TrueBatch', entryId: null } });
    expect(s.blockers).toEqual(['In use by batch TB260001 in TrueBatch (granulation/charge-api): it ends when the batch is done with it in TrueBatch (its last stage using it closes, or the batch is approved or terminated).']);
    const use = await entry(a.id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'TB260002', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems[0]).toMatch(/^In use by batch TB260001 in TrueBatch/);
    const clean = await cleaning(a.id);
    expect(clean.statusCode).toBe(409);
    expect(clean.json().problems).toEqual(['In use by batch TB260001 in TrueBatch: record the cleaning once the batch is done with it in TrueBatch.']);
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
    expect(early.json().problems).toEqual([expect.stringContaining('A cleaning cannot start before the last use ended (')]);
    const e = (await cleaning(a.id)).json().id;
    expect((await status(a.id)).state).toBe('dirty');
    await verify(e);
    await expect.poll(async () => (await published(a.code))?.fit_for_use).toBe(true);
    expect(await status(a.id)).toMatchObject({ state: 'clean', blockers: [], lastTrueBatchUse: { batch: 'TB260001' } });
  });

  it('LB-07: the dirty hold runs from the end of the TrueBatch use; once it ran out the cleaning says why, and the miss is recorded for DIVE', async () => {
    const a = await item({ dirtyHoldHours: 1 });
    await t.owner`update overdue_since set since = now() - interval '1 day'`;
    await tbUse('TB260002', a.code, { startedMinutesAgo: 200, endedMinutesAgo: 120 });
    const s = await status(a.id);
    expect(s.state).toBe('dirty_expired');
    expect(s.blockers[0]).toMatch(/^Dirty-hold time expired at \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d IST: the cleaning is late; clean, verify and record why\.$/);
    await tick();
    const [ev] = await t.owner<{ description: string }[]>`select description from overdue_events where equipment_id = ${a.id} and kind = 'dirty_hold'`;
    expect(ev!.description).toContain('batch TB260002 in TrueBatch (granulation/charge-api)');
    const noReason = await cleaning(a.id);
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().problems[0]).toMatch(/^The dirty hold ran out at \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d IST: give the reason the cleaning is late\.$/);
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

describe('the step is shown by its readable name (D-48)', () => {
  it('LB-08: TrueBatch\'s step_name ("Stage › Step") is shown in the status, the item page and the dirty-hold record; the key when it has none', async () => {
    const a = await item({ dirtyHoldHours: 1 });
    await t.owner`update overdue_since set since = now() - interval '1 day'`;
    await t.owner.unsafe(`insert into ${TB}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, step_name, started_at, ended_at, data_as_of)
      values ('TB260001', '${a.code}', 'machine', 'GRAN-TB', 'granulation/granulate', 'Granulation › Granulate to an end point', now() - interval '3 hours', now() - interval '2 hours', now())`);
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'dirty_expired', lastTrueBatchUse: { batch: 'TB260001', step: 'Granulation › Granulate to an end point' } });
    await tick();
    const [ev] = await t.owner<{ description: string }[]>`select description from overdue_events where equipment_id = ${a.id} and kind = 'dirty_hold'`;
    expect(ev!.description).toContain('batch TB260001 in TrueBatch (Granulation › Granulate to an end point)');
    // Open: the blocker names the step the same way.
    const b = await item();
    await t.owner.unsafe(`insert into ${TB}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, step_name, started_at, data_as_of)
      values ('TB260001', '${b.code}', 'machine', 'GRAN-TB', 'granulation/granulate', 'Granulation › Granulate to an end point', now(), now())`);
    expect((await status(b.id)).blockers).toEqual(['In use by batch TB260001 in TrueBatch (Granulation › Granulate to an end point): it ends when the batch is done with it in TrueBatch (its last stage using it closes, or the batch is approved or terminated).']);
    // An empty step_name falls back to the key.
    const c2 = await item();
    await t.owner.unsafe(`insert into ${TB}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, step_name, started_at, data_as_of)
      values ('TB260001', '${c2.code}', 'machine', 'GRAN-TB', 'granulation/granulate', '', now(), now())`);
    expect((await status(c2.id)).inUse).toMatchObject({ batch: 'TB260001', stage: 'granulation/granulate' });
  });

  it('PL-08: a view without the step_name column (a product not yet updated) still answers, with the key', async () => {
    const a = await item();
    await tbUse('PK260009', a.code, { schema: TBP });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'PK260009', stage: 'granulation/charge-api', source: 'TrueBatch Packing' } });
    expect(s.warnings).not.toContain(PACKING_OFF);
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
    expect(s.blockers).toEqual(['In use by batch PK260001 in TrueBatch Packing (granulation/charge-api): it ends when the batch is done with it in TrueBatch Packing (its last stage using it closes, or the batch is approved or terminated).']);
    const use = await entry(a.id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'TB260002', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems[0]).toMatch(/^In use by batch PK260001 in TrueBatch Packing/);
    expect((await cleaning(a.id)).json().problems).toEqual(['In use by batch PK260001 in TrueBatch Packing: record the cleaning once the batch is done with it in TrueBatch Packing.']);
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

describe('uses recorded in TrueBatch Injectables count too, merged with the others (D-52)', () => {
  it('LB-08: an autoclave is in use while its Injectables step is open; the messages name TrueBatch Injectables; published with the batch', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('TI260001', a.code, { schema: TBI });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'TI260001', source: 'TrueBatch Injectables', entryId: null } });
    expect((await cleaning(a.id)).json().problems).toEqual(['In use by batch TI260001 in TrueBatch Injectables: record the cleaning once the batch is done with it in TrueBatch Injectables.']);
    await tick();
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: 'TI260001' });
  });

  it('LB-07: after the Injectables step is signed done the item is dirty until a verified cleaning; an open use of a rejected batch does not hold it', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('TI260001', a.code, { schema: TBI, startedMinutesAgo: 0, endedMinutesAgo: 0 });
    expect(await status(a.id)).toMatchObject({ lastTrueBatchUse: { batch: 'TI260001', source: 'TrueBatch Injectables' } });
    const b = await item();
    await verify((await cleaning(b.id)).json().id);
    await tbUse('TI250099', b.code, { schema: TBI });
    expect((await status(b.id)).state).not.toBe('in_use');
  });
});

describe('uses recorded in TrueBatch Injectables Packing count too, as Packing\'s (D-54)', () => {
  it('LB-08: a labeller is in use while its Injectables packing step is open (no batch read); the messages name TrueBatch Injectables Packing; published with the batch', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('IP260001', a.code, { schema: TBIP });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'IP260001', source: 'TrueBatch Injectables Packing', entryId: null } });
    expect((await cleaning(a.id)).json().problems).toEqual(['In use by batch IP260001 in TrueBatch Injectables Packing: record the cleaning once the batch is done with it in TrueBatch Injectables Packing.']);
    await tick();
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: 'IP260001' });
  });

  it('LB-07: after the Injectables packing use ends the item is dirty until a verified cleaning; its link off is named in its own warning', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse('IP260002', a.code, { schema: TBIP, startedMinutesAgo: 0, endedMinutesAgo: 0 });
    expect(await status(a.id)).toMatchObject({ inUse: null, lastTrueBatchUse: { batch: 'IP260002', source: 'TrueBatch Injectables Packing' } });
    await t.owner.unsafe(`revoke select on all tables in schema ${TBIP} from logbook_app`);
    try {
      expect((await status(a.id)).warnings).toContain(usesOffWarning('TrueBatch Injectables Packing'));
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${TBIP} to logbook_app`);
    }
  });
});

describe('uses recorded in TrueBatch Capsules, Oral Liquids, API and their packing count too (D-75)', () => {
  it('LB-08: a capsule filler used by the first Capsules batch is in use, not clean; the messages name TrueBatch Capsules; published with the batch', async () => {
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    expect((await status(a.id)).state).toBe('clean');
    await tbUse(`${SCHEMA.truebatch_capsules.toUpperCase()}-1`, a.code, { schema: SCHEMA.truebatch_capsules });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: `${SCHEMA.truebatch_capsules.toUpperCase()}-1`, source: 'TrueBatch Capsules', entryId: null } });
    expect((await cleaning(a.id)).json().problems).toEqual([`In use by batch ${SCHEMA.truebatch_capsules.toUpperCase()}-1 in TrueBatch Capsules: record the cleaning once the batch is done with it in TrueBatch Capsules.`]);
    await tick();
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: `${SCHEMA.truebatch_capsules.toUpperCase()}-1` });
  });

  it.each(NEW.map((p) => [p.name, p] as const))('LB-07, LB-08, PL-08: %s: in use while open, dirty after; its link off is named in its own warning', async (name, p) => {
    const x = SCHEMA[p.id];
    // A packing product's batches are not read for its uses: any number holds the item.
    const batch = p.packing ? `${x.toUpperCase()}-P1` : `${x.toUpperCase()}-1`;
    const a = await item();
    await verify((await cleaning(a.id)).json().id);
    await tbUse(batch, a.code, { schema: x });
    expect(await status(a.id)).toMatchObject({ state: 'in_use', inUse: { batch, source: name } });
    expect((await status(a.id)).blockers).toEqual([`In use by batch ${batch} in ${name} (granulation/charge-api): it ends when the batch is done with it in ${name} (its last stage using it closes, or the batch is approved or terminated).`]);
    const b = await item();
    await verify((await cleaning(b.id)).json().id);
    await tbUse(batch, b.code, { schema: x, startedMinutesAgo: 0, endedMinutesAgo: 0 });
    expect(await status(b.id)).toMatchObject({ state: 'dirty', inUse: null, lastTrueBatchUse: { batch, source: name } });
    if (!p.packing) {
      // A bulk product's uses are read with its batches: an open use of a rejected batch does not hold the item.
      const r = await item();
      await verify((await cleaning(r.id)).json().id);
      await tbUse(`${x.toUpperCase()}-X`, r.code, { schema: x });
      expect((await status(r.id)).state).not.toBe('in_use');
    }
    await t.owner.unsafe(`revoke select on all tables in schema ${x} from logbook_app`);
    try {
      const s = await status(b.id);
      expect(s.warnings).toContain(usesOffWarning(name));
      expect(s.warnings).not.toContain(TRUEBATCH_USES_OFF);
      expect(s.state).toBe('clean');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${x} to logbook_app`);
    }
    expect((await status(b.id)).warnings).not.toContain(usesOffWarning(name));
  });
});

describe('antibiotic last used in TrueBatch (D-67)', () => {
  it('D-67: after a TrueBatch Injectables batch of an antibiotic, only_product names its product until a verified product-changeover cleaning', async () => {
    await t.owner.unsafe(`insert into ${TBI}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released)
      values ('TI26AB01', 'FG-AB-TI', 'IN_PRODUCTION', now() - interval '1 day', null, false)`);
    await addProduct(t, 'FG-AB-TI', 'Antibiotic injection');
    t.master.products_.set('FG-AB-TI', { ...t.master.products_.get('FG-AB-TI')!, antibiotic: true });
    const a = await item();
    await tbUse('TI26AB01', a.code, { schema: TBI, startedMinutesAgo: 30, endedMinutesAgo: 1 });
    await verify((await cleaning(a.id, { cleaningType: 'batch_to_batch' })).json().id);
    await tick();
    expect(await published(a.code)).toMatchObject({ fit_for_use: true, only_product: 'FG-AB-TI',
      warnings: ['Last used for an antibiotic (FG-AB-TI): only FG-AB-TI may follow until a product-changeover cleaning.'] });
    const use = await entry(a.id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'TB260002', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems).toEqual(['Last used for an antibiotic (FG-AB-TI): a product-changeover cleaning is needed before another product.']);
    await verify((await cleaning(a.id, { cleaningType: 'product_change' })).json().id);
    await expect.poll(async () => (await published(a.code))?.only_product).toBeNull();
  });
});

describe('TrueBatch uses in the item\'s history card (D-72, suite S30)', () => {
  const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const period = () => `fromDay=${day(-1)}&toDay=${day()}`;
  it('LB-01: each use recorded in a TrueBatch product is a read-only row, merged in time order with the Logbook entries, and in the CSV and PDF', async () => {
    const a = await item();
    await tbUse('TB260001', a.code, { startedMinutesAgo: 50, endedMinutesAgo: 40 });
    await verify((await cleaning(a.id)).json().id);
    await t.owner.unsafe(`update ${TB}.equipment_use_v1 set step_name = 'Granulation › Charge API' where equipment_code = $1`, [a.code]);
    await tbUse('TP26001', a.code, { schema: TBP, startedMinutesAgo: 120, endedMinutesAgo: 100 });
    await tbUse('TI260001', a.code, { schema: TBI, startedMinutesAgo: 1, endedMinutesAgo: null });
    // Another item's use and a use outside the period are not shown.
    await tbUse('TB260002', `${a.code}-X`, { startedMinutesAgo: 30, endedMinutesAgo: 20 });
    const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}`)).json();
    expect(h.notes).toEqual([]);
    const kinds = h.events.map((e: { kind: string; use?: { batch: string }; entry?: { logbookType: string } }) => e.use?.batch ?? e.entry?.logbookType);
    expect(kinds).toEqual(['TP26001', 'TB260001', 'TI260001', 'equipment_cleaning']);
    expect(h.events[1]).toMatchObject({ kind: 'truebatch', use: { batch: 'TB260001', productCode: 'FG-TB', step: 'Granulation › Charge API', source: 'TrueBatch' } });
    expect(h.events[0].use).toMatchObject({ source: 'TrueBatch Packing', productCode: null, step: 'granulation/charge-api' });
    expect(h.events[2].use).toMatchObject({ source: 'TrueBatch Injectables', productCode: 'FG-TI', endedAt: null });
    // The "Equipment use" filter keeps them; another type leaves them out.
    expect((await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}&types=equipment_use`)).json().events).toHaveLength(3);
    expect((await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}&types=equipment_cleaning`)).json().events).toHaveLength(1);
    const csv = await call(t.app, c.qa!, 'GET', `/api/export/history.csv?equipmentId=${a.id}&${period()}`);
    expect(csv.body).toContain('Batch TB260001 · FG-TB');
    expect(csv.body).toContain('Step: Granulation › Charge API');
    expect(csv.body).toContain('From TrueBatch: read only, recorded there');
    expect(csv.body).toContain('Not ended yet');
    const pdf = await call(t.app, c.qa!, 'GET', `/api/export/history.pdf?equipmentId=${a.id}&${period()}`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('PL-08: a TrueBatch product that does not answer is left out with a note; the rest of the history still shows', async () => {
    const a = await item();
    await tbUse('TB260001', a.code, { startedMinutesAgo: 50, endedMinutesAgo: 40 });
    await tbUse('TI260001', a.code, { schema: TBI, startedMinutesAgo: 30, endedMinutesAgo: 20 });
    await t.owner.unsafe(`revoke select on all tables in schema ${TB} from logbook_app`);
    try {
      const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}`)).json();
      expect(h.notes).toEqual(['Connection to TrueBatch is off: its uses of this item are not shown.']);
      expect(h.events.map((e: { use?: { batch: string } }) => e.use?.batch)).toEqual(['TI260001']);
      expect((await call(t.app, c.qa!, 'GET', `/api/export/history.pdf?equipmentId=${a.id}&${period()}`)).statusCode).toBe(200);
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${TB} to logbook_app`);
    }
  });
});
