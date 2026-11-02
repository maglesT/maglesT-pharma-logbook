import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityCheck } from '../server/integrity.js';
import { call, freshApp, login, seedUser, type TestApp, proofFor, addItem, type ItemBody } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
let mixer: number;
let room: number;
let cleanRoom: number;
const sig = (username: string) => ({ proof: proofFor(username) });
const now = () => new Date().toISOString();

async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const v = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number }[] }) => x.versions).find((x: { id: number }) => x.id === id);
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: v.contentHash });
}
const entry = (who: string, eq: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${eq}/entries`, body);
const versionsOf = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json();

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1']] as const) c[k] = (await login(t.app, u)).cookie;
  const eq = async (body: ItemBody) => (await addItem(t, body)) as number;
  mixer = await eq({ code: 'MX-1', name: 'Mixer', kind: 'equipment' });
  room = await eq({ code: 'RM-1', name: 'Room', kind: 'area' });
  cleanRoom = await eq({ code: 'RM-B', name: 'Grade B room', kind: 'area', sterile: true, classified: true });
  for (const type of ['equipment_cleaning', 'maintenance', 'area_cleaning']) await approve(type);
});
afterAll(() => t.close());

describe('logbook records (LB-02, LB-14)', () => {
  it('LB-02: cleaning, maintenance and area cleaning are logged with dates and the identity of who did them', async () => {
    const ids = [
      (await entry('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id,
      (await entry('eng1', mixer, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'repair', description: 'Seal replaced' }, signature: sig('eng1') })).json().id,
      (await entry('op1', room, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op1') })).json().id,
    ];
    for (const id of ids) {
      const [v] = await versionsOf(id);
      expect(v.activityStart).toBeTruthy();
      expect(v.enteredBy).toMatch(/OP1|ENG1/);
      expect(v.signatures[0]).toMatchObject({ meaning: 'performed' });
    }
  });

  it('LB-14: cleaning of a classified room records the agent, whether it is sporicidal, and the disinfectant lot', async () => {
    const missing = await entry('op1', cleanRoom, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'weekly', sporicidal: true }, signature: sig('op1') });
    expect(missing.statusCode).toBe(400);
    const ok = await entry('op1', cleanRoom, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'weekly', agent: 'Hydrogen peroxide 6%', sporicidal: true, disinfectantLot: 'HP-221' }, signature: sig('op1') });
    expect(ok.statusCode).toBe(201);
    const [v] = await versionsOf(ok.json().id);
    expect(v.data).toMatchObject({ agent: 'Hydrogen peroxide 6%', sporicidal: true, disinfectantLot: 'HP-221' });
  });
});

describe('integrity check (LB-23)', () => {
  it('LB-23: a clean database passes and the result is written to the audit trail', async () => {
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems).toEqual([]);
    expect(r.entries).toBeGreaterThan(0);
    expect(r.signatures).toBeGreaterThan(0);
    const [row] = await t.owner`select * from audit_log where object_type = 'system' and object_id = 'integrity' order by id desc limit 1`;
    expect(row!.action).toBe('integrity.passed');
  });

  it('LB-23: content changed behind the application is detected', async () => {
    const id = (await entry('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
    await t.owner`update entries set data = jsonb_set(data, '{remarks}', '"tampered"') where id = ${id}`;
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems.some((p) => p.includes(`entry ${id}: content changed`))).toBe(true);
    const [row] = await t.owner`select * from audit_log where object_type = 'system' and object_id = 'integrity' order by id desc limit 1`;
    expect(row!.action).toBe('integrity.failed');
    await t.owner`update entries set data = data - 'remarks' || '{"remarks": ""}' where id = ${id}`;
  });

  it('LB-23: a missing audit row and a broken version chain are detected', async () => {
    const start = now();
    const id = (await entry('op1', room, { logbookType: 'area_cleaning', activityStart: start, data: { cleaningType: 'daily' }, signature: sig('op1') })).json().id;
    const v2 = (await call(t.app, c.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: start, activityEnd: start, data: { cleaningType: 'weekly' }, reason: 'type', signature: sig('op1') })).json().id;
    await t.owner`delete from audit_log where object_type = 'entry' and object_id = ${String(id)} and action = 'entry.created'`;
    await t.owner`update entries set version = 7 where id = ${v2}`;
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems).toContain(`Entry version ${id}: no audit row.`);
    expect(r.problems.some((p) => /version chain broken/.test(p))).toBe(true);
  });

  it('LB-23: QA and Admin can run the check and see the last result; operators cannot', async () => {
    expect((await call(t.app, c.qa!, 'POST', '/api/integrity/run')).statusCode).toBe(200);
    expect((await call(t.app, c.admin!, 'GET', '/api/integrity')).json().action).toMatch(/^integrity\./);
    expect((await call(t.app, c.op1!, 'POST', '/api/integrity/run')).statusCode).toBe(403);
  });
});
