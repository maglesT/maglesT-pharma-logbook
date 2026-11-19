import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlCycles } from '../server/cycles.js';
import { cycleForBatchMessage } from '../server/routes/entries.js';
import { connect, type Sql } from '../server/db.js';
import { addItem, call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';

// D-78 (owner, 19 Nov 2026: the product that owns a job keeps it, the linked one reads it): TrueBatch Injectables owns the
// sterilisation cycles run for its batches (report.steriliser_cycle_v1). With its link on, the Logbook shows them read only
// in the item's history card and records only cycles not made for a batch; without the link nothing changes.

let linked: TestApp;
let standalone: TestApp;
let reader: Sql;
const TI = `tic_${process.pid}`;
const SOURCE = 'TrueBatch Injectables';
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const period = () => `fromDay=${day(-1)}&toDay=${day()}`;
let n = 0;

interface Site { t: TestApp; c: Record<string, string>; op: string; autoclave: number; code: string }
const sites: Record<'linked' | 'standalone', Site> = {} as never;

// Each site has its own people (the stand-in directory is shared by the test file).
async function setUp(t: TestApp, x: string): Promise<Site> {
  const c: Record<string, string> = {};
  for (const [k, roles] of [['admin', ['admin']], ['qa', ['qa']], ['op', ['operator']], ['sup', ['supervisor']]] as const) {
    await seedUser(t.owner, `${k}${x}`, [...roles]);
    c[k] = (await login(t.app, `${k}${x}`)).cookie;
  }
  for (const type of ['steriliser_cycle', 'steriliser_test']) {
    const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
    const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((v: { versions: { id: number; contentHash: string }[] }) => v.versions)
      .find((v: { id: number }) => v.id === id).contentHash;
    await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig(`qa${x}`), contentHash: hash });
  }
  const code = `AC-CY-${++n}`;
  const autoclave = await addItem(t, { code, name: 'Autoclave', kind: 'equipment', sterile: true });
  // A verified passed air-removal test, needed before steam cycles (D-22).
  const id = (await call(t.app, c.op!, 'POST', `/api/equipment/${autoclave}/entries`, { logbookType: 'steriliser_test', activityStart: now(),
    data: { test: 'air_removal', result: 'pass' }, signature: sig(`op${x}`) })).json().id;
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json()[0];
  expect((await call(t.app, c.sup!, 'POST', `/api/entries/${id}/verify`, { ...sig(`sup${x}`), contentHash: v.contentHash })).statusCode).toBe(200);
  return { t, c, op: `op${x}`, autoclave, code };
}
const cycle = (s: Site, cycleId: string, extra: { load?: string; batch?: string } = {}) =>
  call(s.t.app, s.c.op!, 'POST', `/api/equipment/${s.autoclave}/entries`, {
    logbookType: 'steriliser_cycle', activityStart: now(), activityEnd: now(), ...(extra.batch ? { batch: extra.batch } : {}),
    data: { cycleType: 'steam', cycleId, programme: 'P2 121 °C', load: extra.load ?? 'Empty chamber', result: 'pass', controllerRecordRef: `PRN-${cycleId}` },
    signature: sig(s.op),
  });

beforeAll(async () => {
  reader = connect(TEST_DATABASE_URL, { role: 'logbook_app' });
  linked = await freshApp({ cycles: sqlCycles(reader, TI, SOURCE) });
  standalone = await freshApp();
  // Injectables' views are stood in for by tables of the same names and columns (migration 0026 of TrueBatch Injectables).
  await linked.owner.unsafe(`create schema ${TI};
    create table ${TI}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
      completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
    insert into ${TI}.batch_fact_v1 (batch_number, product_code, status, issued_at) values ('TI260007', 'FG-TI', 'IN_PRODUCTION', now() - interval '1 day');
    create table ${TI}.steriliser_cycle_v1 (cycle_id text, batch_number text, product_code text, step_key text, step_name text, equipment_code text,
      equipment_name text, equipment_type text, room_code text, cycle_type text, programme text, load text, controller_record_ref text,
      started_at timestamptz, ended_at timestamptz, result text, exposure_min numeric, lowest_temp_c numeric, lowest_f0 numeric,
      max_product_temp_c numeric, h2o2_ppm numeric, leak_rate numeric, units numeric, bi_id text, use_by date, signed text[],
      read_at timestamptz default now(), data_as_of timestamptz);
    grant usage on schema ${TI} to logbook_app; grant select on all tables in schema ${TI} to logbook_app;`);
  sites.linked = await setUp(linked, 'l');
  sites.standalone = await setUp(standalone, 's');
});
afterAll(async () => {
  await linked.owner.unsafe(`drop schema if exists ${TI} cascade`).catch(() => {});
  await linked.close();
  await standalone.close();
  await reader?.end();
});

const tiCycle = (code: string, cycleId: string, minutesAgo: number, extra: Record<string, unknown> = {}) => linked.owner.unsafe(
  `insert into ${TI}.steriliser_cycle_v1 (cycle_id, batch_number, product_code, step_key, step_name, equipment_code, cycle_type, programme, load,
     controller_record_ref, started_at, ended_at, result, exposure_min, lowest_temp_c, lowest_f0, signed, data_as_of)
   values ($1, 'TI260007', 'FG-TI', '1.0.2.0', 'Sterilise › Components', $2, 'steam', 'Rubber stoppers', $3, $4,
     now() - make_interval(mins => $5), now() - make_interval(mins => $5 - 40), $6, 20, 121.4, null, '{performed,checked}', now())`,
  [cycleId, code, String(extra.load ?? 'Load 3'), String(extra.printout ?? 'PRN-TI-1'), minutesAgo, String(extra.result ?? 'pass')]);

describe('cycles made for TrueBatch Injectables batches are read from it (D-78)', () => {
  it('LB-12: each cycle recorded in TrueBatch Injectables is a read-only row of the steriliser\'s history, with batch, result, load, printout and figures, and in the CSV and PDF', async () => {
    const s = sites.linked;
    await tiCycle(s.code, 'TI260007/1.0.2.0', 120);
    await tiCycle(s.code, 'TI260007/1.0.2.1', 60, { result: 'fail', load: 'Load 4', printout: 'PRN-TI-2' });
    await tiCycle(`${s.code}-X`, 'TI260007/1.0.3.0', 30);   // another steriliser: not shown
    expect((await cycle(s, 'BD-1')).statusCode).toBe(201);
    const h = (await call(linked.app, s.c.qa!, 'GET', `/api/equipment/${s.autoclave}/history?${period()}`)).json();
    expect(h.notes).toEqual([]);
    const rows = h.events.filter((e: { kind: string }) => e.kind === 'cycle');
    expect(rows.map((e: { cycle: { cycleId: string } }) => e.cycle.cycleId)).toEqual(['TI260007/1.0.2.0', 'TI260007/1.0.2.1']);
    expect(rows[1].cycle).toMatchObject({ batchNumber: 'TI260007', result: 'fail', load: 'Load 4', controllerRecordRef: 'PRN-TI-2', exposureMin: 20,
      lowestTempC: 121.4, lowestF0: null, source: SOURCE, signed: ['performed', 'checked'] });
    expect(rows[0].cycle.lines).toEqual(expect.arrayContaining(['Batch TI260007 · FG-TI', 'Result: pass', 'Load: Load 3', 'Printout: PRN-TI-1',
      'Exposure 20 min · Lowest temp 121.4 °C', 'Step: Sterilise › Components']));
    // The Logbook's own cycle stays in the history; the cycle filter keeps both kinds, another type neither.
    expect(h.events.some((e: { entry?: { logbookType: string } }) => e.entry?.logbookType === 'steriliser_cycle')).toBe(true);
    expect((await call(linked.app, s.c.qa!, 'GET', `/api/equipment/${s.autoclave}/history?${period()}&types=steriliser_cycle`)).json().events).toHaveLength(3);
    expect((await call(linked.app, s.c.qa!, 'GET', `/api/equipment/${s.autoclave}/history?${period()}&types=equipment_use`)).json().events).toHaveLength(0);
    const csv = await call(linked.app, s.c.qa!, 'GET', `/api/export/history.csv?equipmentId=${s.autoclave}&${period()}`);
    expect(csv.body).toContain('From TrueBatch Injectables, batch TI260007');
    expect(csv.body).toContain('Printout: PRN-TI-2');
    expect(csv.body).toContain('From TrueBatch Injectables: read only, recorded there');
    const pdf = await call(linked.app, s.c.qa!, 'GET', `/api/export/history.pdf?equipmentId=${s.autoclave}&${period()}`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('LB-12: with the link on, a cycle for a batch is refused (a batch given, or a batch number of its batch records in the load or cycle number); a non-batch cycle is recorded', async () => {
    const s = sites.linked;
    expect((await call(linked.app, s.c.op!, 'GET', '/api/cycles-link')).json()).toEqual({ from: SOURCE });
    const withBatch = await cycle(s, 'C-201', { batch: 'TI260007' });
    expect(withBatch.statusCode).toBe(400);
    expect(withBatch.json().problems).toEqual([cycleForBatchMessage(SOURCE, 'TI260007')]);
    const inLoad = await cycle(s, 'C-202', { load: 'Stoppers for batch ti260007, 3 bags' });
    expect(inLoad.statusCode).toBe(400);
    expect(inLoad.json().problems[0]).toContain('recorded in its batch record in TrueBatch Injectables');
    expect((await cycle(s, 'TI260007/1')).statusCode).toBe(400);
    expect((await cycle(s, 'C-203', { load: 'Garments L-12 (non-batch)' })).statusCode).toBe(201);
    // A correction that puts a batch into the load is refused too.
    const id = (await cycle(s, 'C-204')).json().id;
    const fix = await call(linked.app, s.c.op!, 'POST', `/api/entries/${id}/correct`, { activityStart: now(), reason: 'load',
      data: { cycleType: 'steam', cycleId: 'C-204', load: 'TI260007 vials', result: 'pass', controllerRecordRef: 'PRN-C-204' }, signature: sig(s.op) });
    expect(fix.statusCode).toBe(400);
  });

  it('PL-08: with TrueBatch Injectables not answering, the history says so and still shows; a cycle is recorded, marked "Batch not checked"', async () => {
    const s = sites.linked;
    await linked.owner.unsafe(`revoke select on all tables in schema ${TI} from logbook_app`);
    try {
      const h = (await call(linked.app, s.c.qa!, 'GET', `/api/equipment/${s.autoclave}/history?${period()}`)).json();
      expect(h.notes).toEqual(['Connection to TrueBatch Injectables is off: its sterilisation cycles on this item are not shown.']);
      expect(h.events.some((e: { kind: string }) => e.kind === 'cycle')).toBe(false);
      expect(h.events.some((e: { entry?: { logbookType: string } }) => e.entry?.logbookType === 'steriliser_cycle')).toBe(true);
      const res = await cycle(s, 'C-301');
      expect(res.statusCode).toBe(201);
      const v = (await call(linked.app, s.c.qa!, 'GET', `/api/entries/${res.json().id}/versions`)).json()[0];
      expect(v.data.batchNotChecked).toBe('TrueBatch Injectables was not reachable');
    } finally {
      await linked.owner.unsafe(`grant select on all tables in schema ${TI} to logbook_app`);
    }
  });

  it('LB-12: standalone (no link) nothing changes: every cycle is recorded in the Logbook, a batch named in the load too, and the history has no TrueBatch cycles', async () => {
    const s = sites.standalone;
    expect((await call(standalone.app, s.c.op!, 'GET', '/api/cycles-link')).json()).toEqual({ from: null });
    expect((await cycle(s, 'C-401', { load: 'Stoppers for batch TI260007' })).statusCode).toBe(201);
    const h = (await call(standalone.app, s.c.qa!, 'GET', `/api/equipment/${s.autoclave}/history?${period()}`)).json();
    expect(h.notes).toEqual([]);
    expect(h.events.some((e: { kind: string }) => e.kind === 'cycle')).toBe(false);
  });
});
