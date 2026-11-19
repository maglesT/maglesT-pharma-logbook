import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMS, sqlLabUses } from '../server/batches.js';
import { loadConfig } from '../server/config.js';
import { recordOverdue } from '../server/overdue.js';
import { usesOffWarning } from '../server/status.js';
import { connect, type Sql } from '../server/db.js';
import { addItem, addProduct, asReport, call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type ItemBody, type TestApp } from './helpers.js';

// D-76 (owner, 19 Nov 2026): the Logbook reads Medhanta LIMS' instrument_use_v1 live (the columns of TrueBatch's
// equipment_use_v1; batch_number is the analysis number). A lab instrument is in use while an analysis step naming it is
// open in LIMS, and the use is a read-only row of its history card, as a batch use recorded in TrueBatch is. There is no
// "batch in production" filter: LIMS ends the use itself.

let t: TestApp;
let reader: Sql;
const c: Record<string, string> = {};
const LS = `lims_${process.pid}`;
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
/** A lab instrument (calibration not tracked here, so only the use decides its state). */
const instrument = async (body: Partial<ItemBody> = {}) => {
  const code = `HPLC-${++n}`;
  return { code, id: await addItem(t, { code, kind: 'instrument', needsCalibration: false, location: 'QC-LAB', ...body }) };
};
/** An analysis step naming the instrument in LIMS, open (no end) or done `endedMinutesAgo` minutes ago. */
const labUse = (analysis: string, code: string, opts: { startedMinutesAgo?: number; endedMinutesAgo?: number | null; stepName?: string } = {}) => t.owner.unsafe(
  `insert into ${LS}.instrument_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at, data_as_of, step_name)
   values ($1, $2, 'HPLC', 'QC-LAB', 'assay/inject', now() - make_interval(mins => $3), case when $4::int is null then null else now() - make_interval(mins => $4::int) end, now(), $5)`,
  [analysis, code, opts.startedMinutesAgo ?? 60, opts.endedMinutesAgo ?? null, opts.stepName ?? null]);
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const published = async (code: string) => {
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.equipment_status_v1 where code = '${code}'`);
  expect(r.error).toBeUndefined();
  return r.rows![0] as Record<string, unknown> | undefined;
};
const tick = () => recordOverdue(t.sql, t.master, null, t.app.trueBatchUses);
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const period = () => `fromDay=${day(-1)}&toDay=${day()}`;

beforeAll(async () => {
  // The reader logs in as the Logbook's link does; the view is stood in for by a table of the same name and columns.
  reader = connect(TEST_DATABASE_URL, { role: 'logbook_app' });
  t = await freshApp({ trueBatchUses: [sqlLabUses(reader, LS)] });
  await t.owner.unsafe(`create schema ${LS};
    create table ${LS}.instrument_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text,
      started_at timestamptz, ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text,
      use_id uuid, equipment_master_id text);
    grant usage on schema ${LS} to logbook_app; grant select on all tables in schema ${LS} to logbook_app;`);
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1']] as const) c[k] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'FG-QC', 'Product QC');
  await approve('equipment_use');
});
afterAll(async () => {
  await t.close();
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${LS} cascade`).catch(() => {});
});

describe('lab instrument uses recorded in Medhanta LIMS (D-76)', () => {
  it('LB-08: an HPLC is in use while its analysis step is open in LIMS: shown and published with the analysis; a Logbook use is refused', async () => {
    const a = await instrument();
    expect((await status(a.id)).inUse).toBeNull();
    await labUse('AN-2026-0012', a.code.toLowerCase(), { stepName: 'Assay › Inject the standard' });
    const s = await status(a.id);
    expect(s).toMatchObject({ state: 'in_use', inUse: { batch: 'AN-2026-0012', stage: 'Assay › Inject the standard', source: LIMS, entryId: null } });
    expect(s.blockers).toEqual(['In use by analysis AN-2026-0012 in Medhanta LIMS (Assay › Inject the standard): it ends when the analysis is done with it in Medhanta LIMS (every step naming it is signed done, or the analysis is stopped or reviewed).']);
    const use = await call(t.app, c.op1!, 'POST', `/api/equipment/${a.id}/entries`, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-1', data: {} });
    expect(use.statusCode).toBe(409);
    expect(use.json().problems[0]).toMatch(/^In use by analysis AN-2026-0012 in Medhanta LIMS/);
    await tick();
    // As a batch use (D-45): the use itself does not count against fit for use; in_use_batch names the analysis.
    expect(await published(a.code)).toMatchObject({ state: 'in_use', in_use_batch: 'AN-2026-0012', fit_for_use: true, blockers: [] });
  });

  it('LB-08: no "batch in production" filter: an open LIMS use holds the instrument; once LIMS ends it the instrument is free, not dirty (D-62)', async () => {
    const a = await instrument();
    await labUse('AN-2026-0013', a.code, { startedMinutesAgo: 30, endedMinutesAgo: null });
    expect((await status(a.id)).inUse).toMatchObject({ batch: 'AN-2026-0013', source: LIMS });
    await t.owner.unsafe(`update ${LS}.instrument_use_v1 set ended_at = now() - interval '1 minute' where equipment_code = $1`, [a.code]);
    const s = await status(a.id);
    expect(s).toMatchObject({ inUse: null, blockers: [], lastTrueBatchUse: { batch: 'AN-2026-0013', source: LIMS } });
    expect(s.state).not.toMatch(/dirty/);
  });

  it('LB-01: each use recorded in LIMS is a read-only row of the instrument\'s history card, named by its analysis, and in the CSV', async () => {
    const a = await instrument();
    await labUse('AN-2026-0014', a.code, { startedMinutesAgo: 50, endedMinutesAgo: 40, stepName: 'Assay › Inject the samples' });
    await labUse('AN-2026-0015', a.code, { startedMinutesAgo: 5, endedMinutesAgo: null });
    const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}`)).json();
    expect(h.notes).toEqual([]);
    expect(h.events.map((e: { use?: { batch: string } }) => e.use?.batch)).toEqual(['AN-2026-0014', 'AN-2026-0015']);
    expect(h.events[0]).toMatchObject({ kind: 'truebatch', use: { batch: 'AN-2026-0014', productCode: null, step: 'Assay › Inject the samples', source: LIMS } });
    expect(h.events[1].use).toMatchObject({ step: 'assay/inject', endedAt: null });
    expect((await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}&types=equipment_use`)).json().events).toHaveLength(2);
    const csv = await call(t.app, c.qa!, 'GET', `/api/export/history.csv?equipmentId=${a.id}&${period()}`);
    expect(csv.body).toContain('Analysis AN-2026-0014');
    expect(csv.body).toContain('From Medhanta LIMS: read only, recorded there');
    expect(csv.body).not.toContain('Batch AN-2026');
  });

  it('PL-08: the configuration takes LIMS_DATABASE_URL from the platform link; absent or empty, LIMS is not read, without an error', () => {
    const env = { LOGBOOK_DATABASE_URL: 'postgres://app:pw@db:5432/logbook', MASTER_DATA_DATABASE_URL: 'postgres://app:pw@db:5432/master_data',
      OIDC_ISSUER: 'https://site.test/oidc', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URI: 'https://logbook.site.test/cb' };
    expect(loadConfig(env).LIMS_DATABASE_URL).toBeUndefined();
    expect(loadConfig({ ...env, LIMS_DATABASE_URL: '' }).LIMS_DATABASE_URL).toBeUndefined();
    expect(loadConfig({ ...env, LIMS_DATABASE_URL: 'postgres://app:pw@db:5432/lims' }).LIMS_DATABASE_URL).toBe('postgres://app:pw@db:5432/lims');
  });

  it('PL-08: with the LIMS link cut the status says so, still answers, and the history card names it in a note', async () => {
    const a = await instrument();
    await t.owner.unsafe(`revoke select on all tables in schema ${LS} from logbook_app`);
    try {
      expect((await status(a.id)).warnings).toContain(usesOffWarning(LIMS));
      expect(usesOffWarning(LIMS)).toBe('Connection to Medhanta LIMS is off: instrument uses recorded in Medhanta LIMS (in use) are not shown. Ask your administrator.');
      const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${a.id}/history?${period()}`)).json();
      expect(h.notes).toEqual(['Connection to Medhanta LIMS is off: its uses of this item are not shown.']);
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${LS} to logbook_app`);
    }
    expect((await status(a.id)).warnings).not.toContain(usesOffWarning(LIMS));
  });
});
