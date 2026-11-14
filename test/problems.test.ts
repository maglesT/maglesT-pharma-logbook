import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Qualification } from '../server/qualification.js';
import { recordOverdue, SOURCE_PREFIX, type Deviations } from '../server/overdue.js';
import { runIntegrityCheck } from '../server/integrity.js';
import { addItem, addProduct, asReport, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Owner 2026-11-14 (D-43): two routes for a problem. A missed limit or a reported problem waits for QA, who sends it to
// Deviations (then published in report.overdue_v1) or handles it here as a Logbook exception EXC-YYYY-NNNN, signed,
// optionally allowing continued use for an overdue PM, calibration or requalification (at most 7 days). Cleaning is
// never waived; a critical problem always goes to Deviations.

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
const fakeQualification: Qualification = { statuses: async () => new Map(), protocols: async () => [] };
const raised = new Map<string, { number: string; status: string }>();
const fakeDeviations: Deviations = { bySource: async () => new Map(raised) };
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 4);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const record = () => recordOverdue(t.sql, t.master, fakeQualification);
let n = 0;
async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const problemsOf = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/problems`)).json();
const waiting = async (id: number) => (await problemsOf(id)).problems.filter((p: { decision: unknown }) => !p.decision);
const decide = (who: string, problemId: number, body: object, hash?: string) =>
  call(t.app, c[who]!, 'POST', `/api/problems/${problemId}/decide`, { contentHash: hash, signature: sig(who === 'qa' ? 'qa1' : who), ...body });
const startUse = (id: number) => call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: `B${++n}`, data: { stage: 'Mixing' } });
async function cleanAndVerify(id: number) {
  const e = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json();
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${e.id}/versions`)).json().find((x: { id: number }) => x.id === e.id);
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${e.id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
  return e.id as number;
}
/** A clean item whose PM ran out `daysAgo` days ago, recorded as a missed limit waiting for QA. */
async function pmOverdueItem(daysAgo = 2) {
  const code = `PR-${++n}`;
  const id = await addItem(t, { code, location: 'GRAN-1', pmFrequencyDays: 10 });
  await cleanAndVerify(id);
  await t.owner`update equipment set created_at = now() - make_interval(days => ${10 + daysAgo}) where id = ${id}`;
  await record();
  const [p] = await waiting(id);
  expect(p).toMatchObject({ source: 'overdue', dueKind: 'pm', label: 'Preventive maintenance overdue', mayAllowUse: true });
  return { id, code, problem: p as { id: number; contentHash: string } };
}
const exception = (extra: object = {}) => ({ route: 'exception', justification: 'PM slipped two days; the item ran within limits.', impactAssessment: 'No product impact: last PM found no wear.', action: 'PM booked for tomorrow (WO-9001).', ...extra });

beforeAll(async () => {
  t = await freshApp({ qualification: fakeQualification, deviations: fakeDeviations });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1']] as const) c[key] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'P1', 'Product 1');
  for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance']) await approve(type);
  await t.owner`update overdue_since set since = now() - interval '30 days'`;
  await t.owner.unsafe(`grant usage on schema ${t.reportSchema.replace(/_report$/, '')} to logbook_report`);
});
afterAll(() => t.close());

const published = async (code: string) => asReport(t.owner, `select event_id, kind, source, severity, title, description, immediate_action, decided_by from ${t.reportSchema}.overdue_v1 where equipment_code = '${code}' order by event_id`);

describe('a missed limit waits for QA, then goes to Deviations or becomes a Logbook exception (D-43)', () => {
  it('LB-06: a new missed limit is a problem waiting for QA and is not published to Deviations until QA sends it there', async () => {
    const { id, code, problem } = await pmOverdueItem();
    expect((await published(code)).rows).toEqual([]);
    expect((await call(t.app, c.op1!, 'GET', '/api/problems')).json()).toMatchObject({ mayDecide: false, problems: expect.arrayContaining([expect.objectContaining({ id: problem.id, code })]) });
    expect((await call(t.app, c.qa!, 'GET', '/api/problems')).json().mayDecide).toBe(true);
    expect((await call(t.app, c.op1!, 'GET', '/api/overdue')).json().events.find((e: { equipmentId: number }) => e.equipmentId === id)).toMatchObject({ route: 'waiting', problemId: problem.id, deviation: null });

    const r = await decide('qa', problem.id, { route: 'deviation' }, problem.contentHash);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ route: 'deviation', exceptionNumber: null });
    // Published under the problem's id, with the report text Deviations files, and the new columns at the end.
    const v = await published(code);
    expect(v.rows).toEqual([expect.objectContaining({ event_id: String(problem.id), kind: 'pm', source: 'overdue', severity: null, decided_by: 'QA1', title: expect.stringContaining(`Preventive maintenance overdue: ${code}`) })]);
    // The deviation number comes back by that id; the item page shows it.
    raised.set(`${SOURCE_PREFIX}${problem.id}`, { number: 'DEV-2026-0101', status: 'classification' });
    expect((await problemsOf(id)).problems[0].decision).toMatchObject({ route: 'deviation', decidedBy: 'QA1', deviation: { number: 'DEV-2026-0101' } });
    expect((await call(t.app, c.op1!, 'GET', '/api/overdue')).json().events.find((e: { equipmentId: number }) => e.equipmentId === id)).toMatchObject({ route: 'deviation', deviation: { number: 'DEV-2026-0101' } });
    // Signed "Route decided", audited; the item stays blocked (the PM is still overdue).
    const [g] = await t.owner`select meaning, printed_name from signatures where object_type = 'problem_decision' order by id desc limit 1`;
    expect(g).toMatchObject({ meaning: 'decided', printed_name: 'QA1' });
    expect((await t.owner`select action from audit_log where object_type = 'problem' and object_id = ${String(problem.id)}`).map((a) => a.action)).toEqual(['problem.recorded']);
    expect((await t.owner`select 1 from audit_log where action = 'problem.decided'`).length).toBeGreaterThan(0);
    expect((await status(id)).blockers).toEqual([expect.stringMatching(/^Preventive maintenance overdue/)]);
  });

  it('LB-06: QA approves a Logbook exception with continued use: numbered EXC-YYYY-0001, signed, use allowed until the date, then blocked again', async () => {
    const { id, code, problem } = await pmOverdueItem();
    expect((await startUse(id)).statusCode).toBe(409);
    const r = await decide('qa', problem.id, exception({ useAllowedUntil: day(3) }), problem.contentHash);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().exceptionNumber).toBe(`EXC-${year}-0001`);
    const s = await status(id);
    expect(s.blockers).toEqual([]);
    expect(s.warnings).toEqual([expect.stringMatching(new RegExp(`^Use allowed under exception EXC-${year}-0001, until ${day(3)} \\(end of day\\): Preventive maintenance overdue`))]);
    expect(s.dues.find((d: { kind: string }) => d.kind === 'pm')).toMatchObject({ overdue: true, waived: { number: `EXC-${year}-0001` } });
    expect(s.state).toBe('clean');
    const use = await startUse(id);
    expect(use.statusCode, use.body).toBe(201);
    await call(t.app, c.op1!, 'POST', `/api/entries/${use.json().id}/complete`, { activityEnd: now() });
    // Shown on the item, not published to Deviations, signed "Approved".
    const shown = (await problemsOf(id)).problems[0];
    expect(shown.decision).toMatchObject({ route: 'exception', exceptionNumber: `EXC-${year}-0001`, active: true, decidedBy: 'QA1', justification: expect.stringContaining('slipped') });
    expect((await published(code)).rows).toEqual([]);
    const [g] = await t.owner`select g.meaning from signatures g join problem_decisions d on d.id = g.object_id where g.object_type = 'problem_decision' and d.exception_number = ${`EXC-${year}-0001`}`;
    expect(g!.meaning).toBe('approved');
    // The integrity check accepts the signed decisions.
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([]);
    // The validity runs out (moved back in time by the owner): blocked again, the exception stays on record as no longer active.
    await t.owner`update problem_decisions set decided_at = decided_at - interval '4 days', use_allowed_until = now() - interval '1 minute' where exception_number = ${`EXC-${year}-0001`}`;
    expect((await status(id)).blockers).toContainEqual(expect.stringMatching(/^Preventive maintenance overdue/));   // (and dirty after the use)
    expect((await problemsOf(id)).problems[0].decision.active).toBe(false);
  });

  it('LB-06: exception numbers are gapless per year; a refused decision does not use one up', async () => {
    const a = await pmOverdueItem();
    expect((await decide('qa', a.problem.id, exception({ useAllowedUntil: day(8) }), a.problem.contentHash)).statusCode).toBe(400);   // more than 7 days: no number spent
    expect((await decide('qa', a.problem.id, exception(), a.problem.contentHash)).json().exceptionNumber).toBe(`EXC-${year}-0002`);
    const b = await pmOverdueItem();
    expect((await decide('qa', b.problem.id, exception({ useAllowedUntil: today() }), b.problem.contentHash)).json().exceptionNumber).toBe(`EXC-${year}-0003`);
    // Without continued use the item stays blocked although the exception is approved.
    expect((await status(a.id)).blockers).toEqual([expect.stringMatching(/^Preventive maintenance overdue/)]);
  });

  it('LB-07: a missed cleaning limit can only be documented: continued use is refused by the app and by the database', async () => {
    const id = await addItem(t, { code: `PR-${++n}`, location: 'GRAN-1', cleanHoldHours: 2 });
    const e = await cleanAndVerify(id);
    await t.owner`update entries set activity_start = now() - interval '3 hours', activity_end = now() - interval '3 hours' where entry_id = (select entry_id from entries where id = ${e})`;
    await record();
    const [p] = await waiting(id);
    expect(p).toMatchObject({ dueKind: 'clean_hold', mayAllowUse: false });
    const refused = await decide('qa', p.id, exception({ useAllowedUntil: day(1) }), p.contentHash);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().problems).toEqual([expect.stringMatching(/Cleaning cannot be waived/)]);
    await expect(t.owner`insert into problem_decisions (problem_id, route, exception_number, justification, impact_assessment, action, use_allowed_until, decided_by)
      values (${p.id}, 'exception', 'EXC-1999-0001', 'x', 'x', 'x', now() + interval '1 day', (select id from users where username = 'qa1'))`).rejects.toMatchObject({ code: 'P0001' });
    expect((await decide('qa', p.id, exception(), p.contentHash)).statusCode).toBe(201);
    const s = await status(id);
    expect(s.blockers).toEqual([expect.stringMatching(/^Clean-hold time expired/)]);
    expect(s.warnings).toEqual([]);
  });
});

describe('a person reports a problem on an item (D-43)', () => {
  it('LB-21: anyone signed in reports what happened, impact and severity; only QA (logbook.exception.decide) decides', async () => {
    const id = await addItem(t, { code: `PR-${++n}`, location: 'GRAN-1' });
    const bad = await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/problems`, { whatHappened: 'Lid seal torn', impact: '', severity: 'minor' });
    expect(bad.statusCode).toBe(400);
    const r = await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/problems`, { whatHappened: 'Lid seal torn during cleaning', impact: 'None: found before use, seal replaced', severity: 'minor' });
    expect(r.statusCode).toBe(201);
    const [p] = await waiting(id);
    expect(p).toMatchObject({ source: 'reported', severity: 'minor', reportedBy: 'OP1', label: 'Reported problem (Minor)', mayAllowUse: false, title: expect.stringContaining('Lid seal torn') });
    expect((await t.owner`select action, actor_id from audit_log where object_type = 'problem' and object_id = ${String(p.id)}`)[0]).toMatchObject({ action: 'problem.reported' });
    // A reported problem does not block the item.
    expect((await status(id)).blockers.some((b: string) => /problem/i.test(b))).toBe(false);
    for (const who of ['op1', 'sup1', 'eng1', 'admin']) expect((await decide(who, p.id, exception(), p.contentHash)).statusCode).toBe(403);
    // Continued use is not a question for a reported problem.
    expect((await decide('qa', p.id, exception({ useAllowedUntil: day(1) }), p.contentHash)).json().problems).toEqual([expect.stringMatching(/does not block use/)]);
    expect((await decide('qa', p.id, exception(), p.contentHash)).statusCode).toBe(201);
    expect((await decide('qa', p.id, exception(), p.contentHash)).statusCode).toBe(409);   // decided once
  });

  it('LB-06: a critical problem cannot become a Logbook exception (app and database); sent to Deviations it is published with its text', async () => {
    const code = `PR-${++n}`;
    const id = await addItem(t, { code, location: 'GRAN-1' });
    await call(t.app, c.sup1!, 'POST', `/api/equipment/${id}/problems`, { whatHappened: 'Metal fragment found in the bowl after a batch', impact: 'Batch B-77 may be contaminated', severity: 'critical' });
    const [p] = await waiting(id);
    const refused = await decide('qa', p.id, exception(), p.contentHash);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().problems[0]).toMatch(/critical problem cannot be handled as a Logbook exception/);
    await expect(t.owner`insert into problem_decisions (problem_id, route, exception_number, justification, impact_assessment, action, decided_by)
      values (${p.id}, 'exception', 'EXC-1999-0002', 'x', 'x', 'x', (select id from users where username = 'qa1'))`).rejects.toMatchObject({ code: 'P0001' });
    // Nothing is assessed here when it goes to Deviations.
    expect((await decide('qa', p.id, { route: 'deviation', justification: 'x' }, p.contentHash)).statusCode).toBe(400);
    expect((await decide('qa', p.id, { route: 'deviation' }, p.contentHash)).statusCode).toBe(201);
    const v = await published(code);
    expect(v.rows).toEqual([expect.objectContaining({ event_id: String(p.id), kind: 'reported', source: 'reported', severity: 'critical', decided_by: 'QA1' })]);
    expect(String(v.rows![0]!.description)).toContain('Metal fragment found in the bowl');
    expect(String(v.rows![0]!.description)).toContain('Reported in the Logbook by SUP1');
    expect(String(v.rows![0]!.immediate_action)).toContain('QA (QA1) sent this problem to Deviations');
  });

  it('LB-19: the decision is signed against the problem shown and against its own content; a changed hash or a stale proof is refused and audited', async () => {
    const id = await addItem(t, { code: `PR-${++n}`, location: 'GRAN-1' });
    await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/problems`, { whatHappened: 'Display flickers', impact: 'None so far', severity: 'major' });
    const [p] = await waiting(id);
    expect((await decide('qa', p.id, { route: 'deviation' }, 'ab'.repeat(32))).statusCode).toBe(409);   // not the problem QA was shown
    const stale = await call(t.app, c.qa!, 'POST', `/api/problems/${p.id}/decide`, { route: 'deviation', contentHash: p.contentHash, signature: { proof: proofFor('qa1', Date.now() - 600_000) } });
    expect(stale.statusCode).toBe(401);
    expect((await t.owner`select 1 from audit_log where action = 'signature.failed' and object_type = 'problem_decision' and object_id = ${String(p.id)}`).length).toBe(1);
    // A proof meant for another meaning does not approve an exception.
    const other = await call(t.app, c.qa!, 'POST', `/api/problems/${p.id}/decide`, { ...exception(), contentHash: p.contentHash, signature: { proof: proofFor('qa1', undefined, ['decided']) } });
    expect(other.statusCode).toBe(401);
    expect((await decide('qa', p.id, exception(), p.contentHash)).statusCode).toBe(201);
    const [d] = await t.owner<{ id: number; content_hash: string }[]>`select d.id::int, g.content_hash from problem_decisions d join signatures g on g.object_id = d.id and g.object_type = 'problem_decision' where d.problem_id = ${p.id}`;
    expect(d!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('LB-18: problems and decisions are insert-only for the app and the view is read-only for Deviations', async () => {
    const [p] = await t.owner<{ id: number }[]>`select id::int from problems order by id limit 1`;
    expect((await t.sql`update problems set title = 'x' where id = ${p!.id}`.catch((e) => e)).code).toBe('42501');
    expect((await t.sql`delete from problems where id = ${p!.id}`.catch((e) => e)).code).toBe('42501');
    expect((await t.sql`update problem_decisions set use_allowed_until = now() + interval '30 days'`.catch((e) => e)).code).toBe('42501');
    expect((await t.sql`delete from problem_decisions`.catch((e) => e)).code).toBe('42501');
    expect((await asReport(t.owner, `update ${t.reportSchema}.overdue_v1 set title = 'x'`)).error).toBeDefined();
    // The database caps continued use: no decision may allow use for more than 8 days from the decision.
    const id = await addItem(t, { code: `PR-${++n}`, location: 'GRAN-1', pmFrequencyDays: 10 });
    await t.owner`update equipment set created_at = now() - interval '12 days' where id = ${id}`;
    await record();
    const [w] = await waiting(id);
    await expect(t.owner`insert into problem_decisions (problem_id, route, exception_number, justification, impact_assessment, action, use_allowed_until, decided_by)
      values (${w.id}, 'exception', 'EXC-1999-0003', 'x', 'x', 'x', now() + interval '30 days', (select id from users where username = 'qa1'))`).rejects.toMatchObject({ code: '23514' });
  });
});
