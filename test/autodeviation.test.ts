import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviationsClient, raiseOverdueDeviations, type DeviationReport, type DeviationSink } from '../server/autodeviation.js';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S16b (D-34): a missed cleaning limit raises a deviation in the Deviations system on its own, once.

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
let n = 0;
const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();

async function approve(type: string) {
  const settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: now() })).json().id;
  const types = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json();
  const hash = types.flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const newItem = async (body: object) => (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `AD-${++n}`, name: 'Granulator', kind: 'equipment', location: 'Block A', ...body })).json() as { id: number; code: string };
const entry = (id: number, body: object) => call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, body);
const hashOf = async (v: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${v}/versions`)).json().find((x: { id: number }) => x.id === v).contentHash;
async function clean(id: number, area = false) {
  const body = area
    ? { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op1') }
    : { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') };
  const v = (await entry(id, body)).json().id;
  await call(t.app, c.sup1!, 'POST', `/api/entries/${v}/verify`, { ...sig('sup1'), contentHash: await hashOf(v) });
}
async function useAndEnd(id: number) {
  const use = (await entry(id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-26-114', data: { stage: 'Granulation' } })).json().id;
  await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() });
}
async function age(id: number, hours: number) {
  await t.owner`alter table entries disable trigger entries_version_chain`;
  await t.owner`update entries set activity_start = activity_start - make_interval(hours => ${hours}),
                 activity_end = activity_end - make_interval(hours => ${hours}) where equipment_id = ${id}`;
  await t.owner`alter table entries enable trigger entries_version_chain`;
}
/** A stand-in for the Deviations system: numbers the reports it accepts. */
function fakeSink() {
  const reports: DeviationReport[] = [];
  let fail: string | null = null;
  const sink: DeviationSink = {
    async raise(r) {
      if (fail) throw new Error(fail);
      reports.push(r);
      return `DEV-2026-${String(900 + reports.length).padStart(4, '0')}`;
    },
  };
  return { sink, reports, failWith: (m: string | null) => { fail = m; } };
}
const rows = (id: number) => t.owner<{ kind: string; deviation_number: string | null; attempts: number; last_error: string | null }[]>`
  select kind, deviation_number, attempts, last_error from auto_deviations where equipment_id = ${id} order by id`;

beforeAll(async () => {
  t = await freshApp({ deviationsUrl: 'https://deviations.test' });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  product = (await call(t.app, c.admin!, 'POST', '/api/products', { code: 'P1', name: 'Paracetamol 500 mg' })).json().id;
  for (const type of ['equipment_use', 'equipment_cleaning', 'area_cleaning']) await approve(type);
});
afterAll(() => t.close());

describe('automatic deviations for missed cleaning limits (D-34)', () => {
  it('LB-07: an expired dirty hold raises one deviation, with the item, the batch and the time the hold ran out', async () => {
    const { sink, reports } = fakeSink();
    const item = await newItem({ dirtyHoldHours: 8, cleanHoldHours: 72 });
    await clean(item.id);
    await useAndEnd(item.id);
    await age(item.id, 9);
    const first = await raiseOverdueDeviations(t.sql, sink);
    const mine = reports.filter((r) => r.equipment === item.code);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe(`Dirty hold expired: ${item.code} not cleaned within 8 h of use`);
    expect(mine[0]!.description).toMatch(/batch B-26-114 of P1 Paracetamol 500 mg/);
    expect(Date.parse(mine[0]!.eventAt)).toBeLessThan(Date.now() - 3_600_000 + 60_000);
    expect(first.raised.length).toBeGreaterThanOrEqual(1);
    expect((await rows(item.id))[0]).toMatchObject({ kind: 'dirty_hold', deviation_number: expect.stringMatching(/^DEV-2026-/) });
    const [a] = await t.owner`select reason, new_value from audit_log where action = 'deviation.raised_automatically' and object_id = ${String(item.id)}`;
    expect(a?.new_value).toMatchObject({ limit: 'dirty_hold' });

    // Once only: the next checks report nothing more for the same miss.
    await raiseOverdueDeviations(t.sql, sink);
    expect(reports.filter((r) => r.equipment === item.code)).toHaveLength(1);

    // Shown on the dashboard data with its number.
    const auto = (await call(t.app, c.op1!, 'GET', '/api/auto-deviations')).json();
    expect(auto).toMatchObject({ enabled: true, deviationsUrl: 'https://deviations.test' });
    expect(auto.items.find((x: { code: string }) => x.code === item.code).deviationNumber).toMatch(/^DEV-2026-/);
  });

  it('LB-07: a missed scheduled cleaning of a frequency-based room raises a deviation', async () => {
    const { sink, reports } = fakeSink();
    const room = await newItem({ kind: 'area', name: 'Corridor', cleaningBasis: 'frequency', cleaningFrequencyHours: 24 });
    await clean(room.id, true);
    await age(room.id, 26);
    await raiseOverdueDeviations(t.sql, sink);
    const mine = reports.filter((r) => r.equipment === room.code);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe(`Scheduled cleaning missed: ${room.code} (every 24 h)`);
  });

  it('LB-07: an expired clean hold or a dirty hold still running raises nothing', async () => {
    const { sink, reports } = fakeSink();
    const held = await newItem({ cleanHoldHours: 24 });
    await clean(held.id);
    await age(held.id, 30);                                  // clean hold expired: clean again before use, no deviation
    const running = await newItem({ dirtyHoldHours: 8 });
    await clean(running.id);
    await useAndEnd(running.id);                            // dirty hold still running
    await raiseOverdueDeviations(t.sql, sink);
    expect(reports.filter((r) => [held.code, running.code].includes(r.equipment))).toHaveLength(0);
  });

  it('LB-07: when the Deviations system cannot take the report, the error is kept and the report is retried', async () => {
    const fake = fakeSink();
    const item = await newItem({ dirtyHoldHours: 2 });
    await clean(item.id);
    await useAndEnd(item.id);
    await age(item.id, 3);
    fake.failWith('the Deviations system refused the sign-in (401)');
    await raiseOverdueDeviations(t.sql, fake.sink);
    expect((await rows(item.id))[0]).toMatchObject({ deviation_number: null, attempts: 1, last_error: 'the Deviations system refused the sign-in (401)' });
    fake.failWith(null);
    await raiseOverdueDeviations(t.sql, fake.sink);
    expect((await rows(item.id))[0]).toMatchObject({ deviation_number: expect.stringMatching(/^DEV-/), attempts: 2, last_error: null });
  });
});

describe('the Deviations client (D-34)', () => {
  // The Deviations system's routes the client uses, with the checks of its own report form.
  const got: Record<string, unknown>[] = [];
  const server = Fastify();
  let base = '';
  beforeAll(async () => {
    server.post('/api/login', async (req, reply) => {
      const b = req.body as { username: string; password: string };
      if (b.username !== 'logbook.auto' || b.password !== 'secret-pass') return reply.code(401).send({ error: 'login_failed' });
      return reply.header('set-cookie', 'sid=abc; Path=/; HttpOnly').send({ ok: true });
    });
    server.get('/api/me', async (req, reply) => (req.headers.cookie === 'sid=abc' ? { passwordChangeRequired: false } : reply.code(401).send({})));
    server.get('/api/areas', async () => [{ id: 3, name: 'Production', active: true }, { id: 7, name: 'Cleaning (Logbook)', active: true }]);
    server.post('/api/deviations', async (req, reply) => {
      if (req.headers.cookie !== 'sid=abc' || !String(req.headers['content-type']).startsWith('application/json')) return reply.code(401).send({});
      got.push(req.body as Record<string, unknown>);
      return reply.code(201).send({ id: 65, number: 'DEV-2026-0065' });
    });
    server.post('/api/logout', async () => ({ ok: true }));
    await server.listen({ port: 0, host: '127.0.0.1' });
    const a = server.server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => server.close());
  const report: DeviationReport = { title: 'Dirty hold expired: GRN-01', description: 'd', equipment: 'GRN-01', eventAt: new Date().toISOString(), immediateAction: 'a', impactNotes: 'QA to assess' };

  it('LB-07: reports through the Deviations system\'s own route, in the configured area, unplanned, impact for QA to assess', async () => {
    const client = deviationsClient({ baseUrl: base, username: 'logbook.auto', password: 'secret-pass', areaName: 'cleaning (logbook)', timeoutMs: 5000 });
    expect(await client.raise(report)).toBe('DEV-2026-0065');
    expect(got[0]).toMatchObject({
      planned: false, areaId: 7, equipment: 'GRN-01', products: [], noBatch: true, title: 'Dirty hold expired: GRN-01',
      initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: 'QA to assess' },
    });
  });

  it('LB-07: a wrong password or a missing area is an error, not a silent skip', async () => {
    await expect(deviationsClient({ baseUrl: base, username: 'logbook.auto', password: 'wrong', areaName: 'Cleaning (Logbook)', timeoutMs: 5000 }).raise(report))
      .rejects.toThrow(/refused the sign-in \(401\)/);
    await expect(deviationsClient({ baseUrl: base, username: 'logbook.auto', password: 'secret-pass', areaName: 'Warehouse', timeoutMs: 5000 }).raise(report))
      .rejects.toThrow(/no active area "Warehouse"/);
  });
});
