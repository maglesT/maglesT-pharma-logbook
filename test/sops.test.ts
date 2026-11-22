import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOPS_OFF, SopsOff, sqlSops, type QmsSop, type Sops } from '../server/sops.js';
import { addItem, asReport, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// D-79 (owner, 20 Nov 2026): QMS owns the controlled documents. Linked (QMS_DATABASE_URL), the Logbook's SOP references are
// picked from QMS' effective SOPs (document_v1) and cannot be typed; those recorded stay as recorded. QMS down: nothing new
// is added. Link off: typed, as before. logbook_sop_v1 keeps publishing what is recorded.

const sop = (number: string, title = `Title of ${number}`): QmsSop => ({ number, revision: '02', title, effectiveDate: '2026-10-01', nextReviewDue: '2028-10-01' });
let list: QmsSop[] = [];
let down = false;
const fakeSops: Sops = { effective: async () => { if (down) throw new SopsOff(); return list; } };

async function setUp(sops: Sops | null) {
  const t = await freshApp({ sops });
  const c: Record<string, string> = {};
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']]] as const) {
    await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  return { t, c };
}
const draft = (t: TestApp, c: Record<string, string>, sopRef: string) =>
  call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: 'maintenance', settings: { enabled: true, sopRef, checklist: [], verificationRequired: false }, effectiveFrom: new Date().toISOString() });
async function approve(t: TestApp, c: Record<string, string>, id: number) {
  const v = (await call(t.app, c.qa1!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((x: { id: number }) => x.id === id);
  expect((await call(t.app, c.qa1!, 'POST', `/api/settings/${id}/approve`, { proof: proofFor('qa1'), contentHash: v.contentHash })).statusCode).toBe(200);
}
const published = async (t: TestApp) =>
  ((await asReport(t.owner, `select type, sop_ref from ${t.reportSchema}.logbook_sop_v1 order by sop_ref`)).rows ?? []).map((r) => `${r.type}:${r.sop_ref}`);
const details = (t: TestApp, c: Record<string, string>, id: number, sopRefs: string, expectedVersion: number) =>
  call(t.app, c.admin!, 'PUT', `/api/equipment/${id}/details`, { details: { sopRefs }, reason: 'SOPs', expectedVersion });

describe('ASSURE document_v1 is read (D-79)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await freshApp(); });
  afterAll(() => t.close());

  it('D-79: the effective SOPs come from the view; a missing view is the link off', async () => {
    const s = `${t.reportSchema.replace(/_report$/, '')}_qms`;
    await t.owner.unsafe(`create schema ${s}`);
    await t.owner.unsafe(`create table ${s}.document_v1 (number text, revision text, title text, type text, effective_date date, next_review_due date,
      status text, record_number text, next_revision text, next_effective_date date, read_at timestamptz, data_as_of timestamptz)`);
    await t.owner.unsafe(`insert into ${s}.document_v1 (number, revision, title, type, effective_date, next_review_due, status) values
      ('SOP-ENG-010', '03', 'Preventive maintenance', 'SOP', '2026-09-01', '2028-09-01', 'effective'),
      ('SOP-QC-005', '01', 'Hardness tester', 'SOP', null, null, 'draft'),
      ('FRM-ENG-010', '01', 'PM form', 'Form', '2026-09-01', null, 'effective')`);
    expect(await sqlSops(t.owner, s).effective()).toEqual([
      { number: 'SOP-ENG-010', revision: '03', title: 'Preventive maintenance', effectiveDate: '2026-09-01', nextReviewDue: '2028-09-01' }]);
    await expect(sqlSops(t.owner, `${s}_missing`).effective()).rejects.toBeInstanceOf(SopsOff);
    await t.owner.unsafe(`drop schema ${s} cascade`);
  });
});

describe('linked: SOPs are picked from ASSURE (D-79)', () => {
  let t: TestApp; let c: Record<string, string>;
  beforeAll(async () => ({ t, c } = await setUp(fakeSops)));
  afterAll(() => t.close());

  it('D-79: settings take ASSURE SOPs only; recorded ones stay; ASSURE down adds nothing; logbook_sop_v1 publishes what is recorded', async () => {
    list = [sop('SOP-ENG-010'), sop('SOP-ENG-011')]; down = false;
    expect((await call(t.app, c.admin!, 'GET', '/api/sops')).json()).toMatchObject({ linked: true, available: true, sops: list });
    const typed = await draft(t, c, 'SOP-HAND-1');
    expect(typed.statusCode).toBe(400);
    expect(typed.json().problems[0]).toMatch(/SOP-HAND-1 is not an effective SOP in ASSURE/);
    const v1 = await draft(t, c, 'sop-eng-010');
    expect(v1.statusCode).toBe(201);
    await approve(t, c, v1.json().id);
    expect(await published(t)).toEqual(['maintenance:SOP-ENG-010']);

    // QMS withdraws SOP-ENG-010: the recorded reference stays as recorded; a new one is checked.
    list = [sop('SOP-ENG-011')];
    expect((await draft(t, c, 'SOP-ENG-010; SOP-ENG-011')).statusCode).toBe(201);
    expect((await draft(t, c, 'SOP-ENG-010, SOP-ENG-099')).statusCode).toBe(400);

    // QMS down: the pickers say so; keeping what is recorded works, adding refuses with the note.
    down = true;
    expect((await call(t.app, c.admin!, 'GET', '/api/sops')).json()).toEqual({ linked: true, available: false, sops: [], note: SOPS_OFF });
    const off = await draft(t, c, 'SOP-ENG-010, SOP-ENG-011, SOP-ENG-012');
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ error: 'connection_off', message: SOPS_OFF });
    const kept = await draft(t, c, 'SOP-ENG-010, SOP-ENG-011');
    expect(kept.statusCode).toBe(201);
    // Editing a draft: its own references stay.
    expect((await call(t.app, c.admin!, 'PATCH', `/api/settings/${kept.json().id}`, { settings: { enabled: true, sopRef: 'SOP-ENG-011', checklist: [], verificationRequired: false },
      effectiveFrom: new Date().toISOString(), reason: 'one SOP' })).statusCode).toBe(200);
    down = false;
    expect(await published(t)).toEqual(['maintenance:SOP-ENG-010']);
  });

  it('D-79: an item\'s SOP references are picked from ASSURE the same way', async () => {
    list = [sop('SOP-PRD-021')]; down = false;
    const id = await addItem(t, { code: 'PRESS-9' });
    expect((await details(t, c, id, 'SOP-TYPED', 0)).statusCode).toBe(400);
    expect((await details(t, c, id, 'sop-prd-021', 0)).statusCode).toBe(200);
    const card = (await call(t.app, c.admin!, 'GET', `/api/equipment/${id}/details`)).json();
    expect(card.details.details.sopRefs).toBe('SOP-PRD-021');
    list = []; down = true;
    expect((await details(t, c, id, 'SOP-PRD-021, SOP-PRD-022', 1)).json()).toMatchObject({ error: 'connection_off', message: SOPS_OFF });
    // Other details can still be changed while QMS is down: the recorded SOP stays.
    expect((await call(t.app, c.admin!, 'PUT', `/api/equipment/${id}/details`, { details: { sopRefs: 'SOP-PRD-021', capacity: '45 stations' }, reason: 'capacity', expectedVersion: 1 })).statusCode).toBe(200);
    down = false;
  });
});

describe('link off: SOPs are typed, as before (D-79)', () => {
  let t: TestApp; let c: Record<string, string>;
  beforeAll(async () => ({ t, c } = await setUp(null)));
  afterAll(() => t.close());

  it('D-79: any SOP reference is typed and published', async () => {
    expect((await call(t.app, c.admin!, 'GET', '/api/sops')).json()).toEqual({ linked: false, available: false, sops: [], note: '' });
    const v = await draft(t, c, 'SOP-LOCAL-7');
    expect(v.statusCode).toBe(201);
    await approve(t, c, v.json().id);
    expect(await published(t)).toEqual(['maintenance:SOP-LOCAL-7']);
    const id = await addItem(t, { code: 'FBD-9' });
    expect((await details(t, c, id, 'SOP-ANY-1', 0)).statusCode).toBe(200);
  });
});
