import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Qualification, QualStatus } from '../server/qualification.js';
import { QualificationOff } from '../server/qualification.js';
import { recordOverdue, SOURCE_PREFIX, type Deviations } from '../server/overdue.js';
import { addItem, asReport, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Owner 2026-11-12 (D-37): a missed limit (dirty hold, clean hold, scheduled cleaning, PM, calibration, requalification)
// is recorded once, with the report Deviations files, in report.overdue_v1; the deviation number is read back.
// D-43: since 2026-11-14 a record waits for QA's route decision first; it is published once QA sends it to Deviations
// (test/problems.test.ts). Records made before D-43 (no problem row) are published as before.

let t: TestApp;
const c: Record<string, string> = {};
const qual = new Map<string, QualStatus>();
let qualCut = false;
const fakeQualification: Qualification = {
  statuses: async () => { if (qualCut) throw new QualificationOff(); return new Map(qual); },
  protocols: async () => [],
};
const raised = new Map<string, { number: string; status: string }>();
const fakeDeviations: Deviations = { bySource: async () => new Map(raised) };
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const record = () => recordOverdue(t.sql, t.master, fakeQualification);
const events = (id: number) => t.owner<{ id: number; kind: string; due_at: Date; title: string; description: string }[]>`
  select id::int, kind, due_at, title, description from overdue_events where equipment_id = ${id} order by id`;
// QA sends the item's waiting problems to Deviations (D-43).
async function sendToDeviations(equipmentId: number) {
  const open = (await call(t.app, c.qa!, 'GET', `/api/equipment/${equipmentId}/problems`)).json().problems.filter((p: { decision: unknown }) => !p.decision);
  for (const p of open) expect((await call(t.app, c.qa!, 'POST', `/api/problems/${p.id}/decide`, { route: 'deviation', contentHash: p.contentHash, signature: sig('qa1') })).statusCode).toBe(201);
  return open.map((p: { id: number }) => p.id) as number[];
}
let n = 0;
async function item(care: object, kind: 'equipment' | 'instrument' | 'area' = 'equipment') {
  const code = `OD-${++n}`;
  const id = await addItem(t, { code, kind, location: 'GRAN-1', ...care });
  const m = t.master.items_.get(code)!;
  qual.set(m.itemId, { masterId: m.itemId, code, status: 'qualified', nextReviewDue: day(365) });
  return { id, code, itemId: m.itemId };
}
async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
// A verified cleaning that ended `hoursAgo` hours ago (moved back in time by the owner: the app never back-dates this far).
async function cleanedAgo(id: number, hoursAgo: number) {
  const e = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(),
    data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json();
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${e.id}/versions`)).json().find((x: { id: number }) => x.id === e.id);
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${e.id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
  await t.owner`update entries set activity_start = now() - make_interval(hours => ${hoursAgo}), activity_end = now() - make_interval(hours => ${hoursAgo})
    where entry_id = (select entry_id from entries where id = ${e.id})`;
}

beforeAll(async () => {
  t = await freshApp({ qualification: fakeQualification, deviations: fakeDeviations });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[key] = (await login(t.app, u)).cookie;
  await approve('equipment_cleaning');
  // As on an installation with history: the feature was installed 30 days ago.
  await t.owner`update overdue_since set since = now() - interval '30 days'`;
});
afterAll(() => t.close());

describe('missed limits are recorded for Deviations (owner 2026-11-12, D-37)', () => {
  it('LB-06: a limit that ran out before the feature was installed is not recorded (no flood of old misses)', async () => {
    const a = await item({ pmFrequencyDays: 10 });
    await t.owner`update equipment set created_at = now() - interval '12 days' where id = ${a.id}`;   // PM due 2 days ago
    await t.owner`update overdue_since set since = now() - interval '1 day'`;
    await record();
    expect(await events(a.id)).toHaveLength(0);
    await t.owner`update overdue_since set since = now() - interval '30 days'`;
    await record();
    expect(await events(a.id)).toHaveLength(1);
  });

  it('LB-06: an overdue PM is recorded once, with the report text, and published in overdue_v1', async () => {
    const a = await item({ pmFrequencyDays: 10 });
    await t.owner`update equipment set created_at = now() - interval '12 days' where id = ${a.id}`;
    const fine = await item({ pmFrequencyDays: 90 });
    await record();
    await record();   // a second run adds nothing
    const ev = await events(a.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'pm', title: expect.stringContaining(`Preventive maintenance overdue: ${a.code}`) });
    expect(ev[0]!.description).toContain('every 10 days');
    expect(await events(fine.id)).toHaveLength(0);
    const audit = await t.owner`select 1 from audit_log where action = 'overdue.recorded' and object_id = ${String(a.id)}`;
    expect(audit).toHaveLength(1);

    await t.owner.unsafe(`grant usage on schema ${t.reportSchema.replace(/_report$/, '')} to logbook_report`);
    const query = `select event_id, equipment_code, equipment_name, location, kind, due_at, title, description, immediate_action, impact_notes
      from ${t.reportSchema}.overdue_v1 where equipment_code = '${a.code}'`;
    // D-43: published once QA sends it to Deviations, under the problem's id.
    expect((await asReport(t.owner, query)).rows).toEqual([]);
    const [problemId] = await sendToDeviations(a.id);
    const v = await asReport(t.owner, query);
    expect(v.error).toBeUndefined();
    expect(v.rows).toEqual([expect.objectContaining({ event_id: String(problemId), equipment_name: `Item ${a.code}`, location: 'GRAN-1', kind: 'pm', title: ev[0]!.title })]);
    expect((await asReport(t.owner, `insert into ${t.reportSchema}.overdue_v1 (kind) values ('pm')`)).error).toBeDefined();
    expect((await t.sql`update overdue_events set title = 'x' where id = ${ev[0]!.id}`.catch((e) => e)).code).toBe('42501');   // insert-only
  });

  it('LB-06: an expired clean hold is recorded with the time they ran out', async () => {
    const ch = await item({ cleanHoldHours: 2 });
    await cleanedAgo(ch.id, 3);
    await record();
    const ev = await events(ch.id);
    expect(ev.map((e) => e.kind)).toEqual(['clean_hold']);
    expect(Math.abs(ev[0]!.due_at.getTime() - (Date.now() - 3_600_000))).toBeLessThan(120_000);
    expect(ev[0]!.title).toBe(`Clean hold expired: ${ch.code} not used within 2 h of cleaning`);
  });

  it('LB-05: requalification overdue (Qualification\'s due date) is recorded; with the link cut, no requalification record is made', async () => {
    const a = await item({ requalificationFrequencyMonths: 12 });
    const b = await item({ requalificationFrequencyMonths: 12 });
    qual.set(t.master.items_.get(b.code)!.itemId, { ...qual.get(t.master.items_.get(b.code)!.itemId)!, nextReviewDue: day(-3) });
    qualCut = true;
    await record();
    expect(await events(b.id)).toHaveLength(0);
    qualCut = false;
    await record();
    expect((await events(b.id)).map((e) => [e.kind, e.title])).toEqual([['requalification', `Requalification overdue: ${b.code} (due ${day(-3)})`]]);
    expect(await events(a.id)).toHaveLength(0);
  });

  it('LB-06: a record made before D-43 (no problem row) stays published under its event id, as Deviations already filed it', async () => {
    const a = await item({ pmFrequencyDays: 5 });
    await t.owner`update equipment set created_at = now() - interval '8 days' where id = ${a.id}`;
    await record();
    const [ev] = await events(a.id);
    await t.owner`delete from audit_log where object_type = 'problem' and object_id in (select id::text from problems where overdue_event_id = ${ev!.id})`;
    await t.owner`delete from problems where overdue_event_id = ${ev!.id}`;   // as before D-43
    const v = await asReport(t.owner, `select event_id, kind from ${t.reportSchema}.overdue_v1 where equipment_code = '${a.code}'`);
    expect(v.rows).toEqual([{ event_id: String(ev!.id), kind: 'pm' }]);
    raised.set(`${SOURCE_PREFIX}${ev!.id}`, { number: 'DEV-2026-0007', status: 'closed' });
    const list = (await call(t.app, c.op1!, 'GET', '/api/overdue')).json();
    expect(list.events.find((e: { id: number }) => e.id === ev!.id)).toMatchObject({ route: 'deviation', problemId: null, deviation: { number: 'DEV-2026-0007' } });
  });

  it('LB-06: the overdue list shows the deviation number once Deviations has filed the record', async () => {
    const a = await item({ pmFrequencyDays: 5 });
    await t.owner`update equipment set created_at = now() - interval '8 days' where id = ${a.id}`;
    await record();
    const [ev] = await events(a.id);
    expect(ev!.kind).toBe('pm');
    const [problemId] = await sendToDeviations(a.id);
    const before = (await call(t.app, c.op1!, 'GET', '/api/overdue')).json();
    expect(before.linked).toBe(true);
    expect(before.events.find((e: { id: number }) => e.id === ev!.id)).toMatchObject({ code: a.code, label: 'Preventive maintenance overdue', route: 'deviation', deviation: null });
    raised.set(`${SOURCE_PREFIX}${problemId}`, { number: 'DEV-2026-0042', status: 'classification' });
    const after = (await call(t.app, c.op1!, 'GET', '/api/overdue')).json();
    expect(after.events.find((e: { id: number }) => e.id === ev!.id).deviation).toEqual({ number: 'DEV-2026-0042', status: 'classification' });
  });
});
