import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Qualification, QualStatus } from '../server/qualification.js';
import { QualificationOff } from '../server/qualification.js';
import { recordOverdue, SOURCE_PREFIX, type Deviations } from '../server/overdue.js';
import { dayText } from '../server/dates.js';
import { addItem, asReport, call, directory, fakeSignOn, freshApp, login, proofFor, seedUser, TEST_PROOF_KEY, type TestApp } from './helpers.js';
import { buildApp } from '../server/app.js';

// Owner 2026-11-12 (D-37): a missed limit (dirty hold, clean hold, scheduled cleaning, PM, calibration, requalification)
// is recorded once, with the report Deviations files, in report.overdue_v1; the deviation number is read back.

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
  // D-80: the exception permission is given per person (not by any old role): qa1 holds it, sup1 does not.
  directory.get('qa1')!.permissions.push('logbook.exception.decide');
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[key] = (await login(t.app, u)).cookie;
  await approve('equipment_cleaning');
  // As on an installation with history: the feature was installed 30 days ago.
  await t.owner`update overdue_since set since = now() - interval '30 days'`;
});
afterAll(() => t.close());

describe('missed limits are recorded for DIVE (owner 2026-11-12, D-37)', () => {
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
    const v = await asReport(t.owner, `select event_id, equipment_code, equipment_name, location, kind, due_at, title, description, immediate_action, impact_notes
      from ${t.reportSchema}.overdue_v1 where equipment_code = '${a.code}'`);
    expect(v.error).toBeUndefined();
    expect(v.rows).toEqual([expect.objectContaining({ event_id: String(ev[0]!.id), equipment_name: `Item ${a.code}`, location: 'GRAN-1', kind: 'pm' })]);
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
    expect((await events(b.id)).map((e) => [e.kind, e.title])).toEqual([['requalification', `Requalification overdue: ${b.code} (due ${dayText(day(-3))})`]]);
    expect(await events(a.id)).toHaveLength(0);
  });

  it('LB-06: the overdue list shows the deviation number once DIVE has filed the record', async () => {
    const a = await item({ pmFrequencyDays: 5 });
    await t.owner`update equipment set created_at = now() - interval '8 days' where id = ${a.id}`;
    await record();
    const [ev] = await events(a.id);
    expect(ev!.kind).toBe('pm');
    const before = (await call(t.app, c.op1!, 'GET', '/api/overdue')).json();
    expect(before.linked).toBe(true);
    expect(before.events.find((e: { id: number }) => e.id === ev!.id)).toMatchObject({ code: a.code, label: 'Preventive maintenance overdue', deviation: null });
    raised.set(`${SOURCE_PREFIX}${ev!.id}`, { number: 'DEV-2026-0042', status: 'classification' });
    const after = (await call(t.app, c.op1!, 'GET', '/api/overdue')).json();
    expect(after.events.find((e: { id: number }) => e.id === ev!.id).deviation).toEqual({ number: 'DEV-2026-0042', status: 'classification' });
  });
});

// D-80 (owner decision, 20 Nov 2026): a missed limit is an exception, closed here (reason and e-signature) or sent to
// Deviations by a person holding logbook.exception.decide; Deviations sees only the ones sent (overdue_v1.sent_at).
describe('missed limits are exceptions: close here or send to DIVE (D-80)', () => {
  const view = async (code: string) => {
    await t.owner.unsafe(`grant usage on schema ${t.reportSchema.replace(/_report$/, '')} to logbook_report`);
    const v = await asReport(t.owner, `select event_id, decision, sent_at from ${t.reportSchema}.overdue_v1 where equipment_code = '${code}'`);
    expect(v.error).toBeUndefined();
    return v.rows![0]!;
  };
  async function missed() {
    const a = await item({ pmFrequencyDays: 5 });
    await t.owner`update equipment set created_at = now() - interval '8 days' where id = ${a.id}`;
    await record();
    const [ev] = await events(a.id);
    const row = (await call(t.app, c.qa!, 'GET', '/api/overdue')).json().events.find((e: { id: number }) => e.id === ev!.id);
    return { ...a, ev: ev!, row };
  }

  it('LB-06: a new missed limit waits for a decision; overdue_v1 says open, with no sent_at (DIVE files nothing)', async () => {
    const m = await missed();
    expect(m.row).toMatchObject({ decision: null, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await view(m.code)).toMatchObject({ decision: 'open', sent_at: null });
    expect((await call(t.app, c.qa!, 'GET', '/api/overdue')).json().mayDecide).toBe(true);
    expect((await call(t.app, c.sup1!, 'GET', '/api/overdue')).json().mayDecide).toBe(false);
  });

  it('LB-21: only a person holding logbook.exception.decide closes or sends (per person, not by role)', async () => {
    const m = await missed();
    expect((await call(t.app, c.sup1!, 'POST', `/api/overdue/${m.ev.id}/send`, {})).statusCode).toBe(403);
    expect((await call(t.app, c.sup1!, 'POST', `/api/overdue/${m.ev.id}/close`, { ...sig('sup1'), contentHash: m.row.contentHash, reason: 'x' })).statusCode).toBe(403);
    expect(await view(m.code)).toMatchObject({ decision: 'open' });
  });

  it('LB-19: close here needs a reason and an e-signature "Closed"; it stays in the Logbook with its audit trail and on the history card', async () => {
    const m = await missed();
    expect((await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/close`, { ...sig('qa1'), contentHash: m.row.contentHash, reason: ' ' })).statusCode).toBe(400);
    expect((await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/close`, { ...sig('qa1'), contentHash: '0'.repeat(64), reason: 'PM done next morning' })).statusCode).toBe(409);
    const ok = await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/close`, { ...sig('qa1'), contentHash: m.row.contentHash, reason: 'PM done next morning, no batch made meanwhile' });
    expect(ok.statusCode).toBe(200);
    expect(await view(m.code)).toMatchObject({ decision: 'closed', sent_at: null });
    const [g] = await t.owner`select printed_name, meaning from signatures where object_type = 'exception' and object_id = ${m.ev.id}`;
    expect(g).toEqual({ printed_name: 'QA1', meaning: 'closed' });
    const [a] = await t.owner`select reason from audit_log where action = 'exception.closed' and object_id = ${String(m.id)}`;
    expect(a!.reason).toBe('PM done next morning, no batch made meanwhile');
    expect((await call(t.app, c.qa!, 'GET', '/api/overdue')).json().events.find((e: { id: number }) => e.id === m.ev.id).decision)
      .toMatchObject({ kind: 'closed', reason: 'PM done next morning, no batch made meanwhile', by: 'QA1', signedBy: 'QA1' });
    // Decided once: neither a second close nor a send.
    expect((await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/send`, {})).json().error).toBe('already_decided');
    expect((await t.sql`update overdue_decisions set reason = 'x'`.catch((e) => e)).code).toBe('42501');   // insert-only
    const day0 = new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('en-CA');
    const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${m.id}/history?fromDay=${day0}&toDay=${day(1)}`)).json();
    const ex = h.events.filter((e: { kind: string }) => e.kind === 'exception');
    expect(ex).toHaveLength(1);
    expect(ex[0].exception).toMatchObject({ id: m.ev.id, decision: { kind: 'closed', reason: 'PM done next morning, no batch made meanwhile' } });
    expect(h.events.some((e: { kind: string; action?: string }) => e.kind === 'masterdata' && e.action?.startsWith('exception.'))).toBe(false);
    const csv = (await call(t.app, c.qa!, 'GET', `/api/export/history.csv?equipmentId=${m.id}&fromDay=${day0}&toDay=${day(1)}`)).body;
    expect(csv).toContain('Closed in LEAD by QA1');
  });

  it('LB-06: send to DIVE sets sent_at in overdue_v1, so DIVE files it; the number comes back as before', async () => {
    const m = await missed();
    expect((await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/send`, {})).statusCode).toBe(200);
    const v = await view(m.code);
    expect(v).toMatchObject({ decision: 'sent' });
    expect(Math.abs(new Date(v.sent_at as string).getTime() - Date.now())).toBeLessThan(60_000);
    expect(await t.owner`select 1 from audit_log where action = 'exception.sent' and object_id = ${String(m.id)}`).toHaveLength(1);
    expect((await call(t.app, c.qa!, 'POST', `/api/overdue/${m.ev.id}/close`, { ...sig('qa1'), contentHash: m.row.contentHash, reason: 'late' })).json().error).toBe('already_decided');
    raised.set(`${SOURCE_PREFIX}${m.ev.id}`, { number: 'DEV-2026-0077', status: 'classification' });
    expect((await call(t.app, c.qa!, 'GET', '/api/overdue')).json().events.find((e: { id: number }) => e.id === m.ev.id))
      .toMatchObject({ decision: { kind: 'sent', by: 'QA1' }, deviation: { number: 'DEV-2026-0077' } });
  });

  it('LB-06: without the DIVE link a missed limit cannot be sent: it is closed here', async () => {
    const m = await missed();
    const alone = await buildApp({ sql: t.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master: t.master, webRoot: '/nonexistent' });
    try {
      const cookie = (await login(alone, 'qa1')).cookie;
      const r = await call(alone, cookie, 'POST', `/api/overdue/${m.ev.id}/send`, {});
      expect(r.statusCode).toBe(409);
      expect(r.json().problems).toEqual(['DIVE is not linked: close it here.']);
      expect((await call(alone, cookie, 'GET', '/api/overdue')).json().linked).toBe(false);
    } finally { await alone.close(); }
  });
});
