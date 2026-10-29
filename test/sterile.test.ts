import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
let autoclave: number;
let isolator: number;
let room: number;
let nonSterile: number;
let n = 0;

const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();

async function approve(type: string, extra: object = {}) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', {
    logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...extra }, effectiveFrom: now(),
  })).json().id;
  const v = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number }[] }) => x.versions).find((x: { id: number }) => x.id === id);
  expect((await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: v.contentHash })).statusCode).toBe(200);
}
const entry = (who: string, eq: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${eq}/entries`, body);
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const cycle = (eq: number, cycleId: string, result: 'pass' | 'fail' = 'pass', extra: object = {}) =>
  entry('op1', eq, {
    logbookType: 'steriliser_cycle', activityStart: now(), activityEnd: now(),
    data: { cycleType: 'steam', cycleId, programme: 'P4 121°C 20 min', load: 'Garments L-12', result, controllerRecordRef: `AC1-${cycleId}`, ...extra },
    signature: sig('op1'),
  });
const test = (eq: number, kind: 'leak' | 'air_removal', result: 'pass' | 'fail') =>
  entry('op1', eq, { logbookType: 'steriliser_test', activityStart: now(), data: { test: kind, result, comment: 'c', deviationRef: 'DV-9' }, signature: sig('op1') });

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  const eq = async (body: object) => (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `S-${++n}`, name: 'Item', ...body })).json().id as number;
  autoclave = await eq({ kind: 'equipment', sterile: true });
  isolator = await eq({ kind: 'equipment', sterile: true });
  room = await eq({ kind: 'area', sterile: true, classified: true });
  nonSterile = await eq({ kind: 'equipment' });
  for (const type of ['steriliser_cycle', 'steriliser_test', 'glove_integrity']) await approve(type);
  await approve('pressure_reading', { pressurePoints: [{ name: 'Filling B / corridor', critical: false, ccsRef: 'CCS-4.2', min: 10, max: 30, unit: 'Pa' }] });
});
afterAll(() => t.close());

describe('sterilisation cycles (LB-12)', () => {
  it('LB-12: a cycle record has a unique ID per steriliser, a controller record reference and a performer signature', async () => {
    const res = await cycle(autoclave, 'C-1001');
    expect(res.statusCode).toBe(201);
    const dup = await cycle(autoclave, 'c-1001');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().problems[0]).toMatch(/already recorded/);
    // The same number on another steriliser is fine.
    expect((await cycle(isolator, 'C-1001')).statusCode).toBe(201);
    const noRef = await entry('op1', autoclave, { logbookType: 'steriliser_cycle', activityStart: now(), data: { cycleType: 'steam', cycleId: 'C-1002', result: 'pass' }, signature: sig('op1') });
    expect(noRef.statusCode).toBe(400);
  });

  it('LB-12: cycles always need second-person verification', async () => {
    const id = (await cycle(autoclave, 'C-1003')).json().id;
    const open = (await call(t.app, c.qa!, 'GET', '/api/entries/open')).json();
    expect(open.some((e: { id: number; awaitingVerification: boolean }) => e.id === id && e.awaitingVerification)).toBe(true);
  });

  it('LB-12: a failed cycle needs a deviation and shows as a warning', async () => {
    expect((await cycle(autoclave, 'C-1004', 'fail')).json().problems[0]).toMatch(/deviation/);
    expect((await cycle(autoclave, 'C-1005', 'fail', { comment: 'F0 low', deviationRef: 'DV-77' })).statusCode).toBe(201);
    expect((await status(autoclave)).warnings).toContain('The last sterilisation cycle failed: see its deviation.');
  });

  it('LB-12: sterile types cannot be used on non-sterile equipment', async () => {
    expect((await cycle(nonSterile, 'X-1')).json().error).toBe('type_not_for_equipment');
  });
});

describe('steriliser tests (LB-12, A1 8.60–8.61)', () => {
  it('LB-12: a failed leak test takes the steriliser out of service and stops new cycles until a pass', async () => {
    const ac = (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `AC-${++n}`, name: 'Autoclave 2', kind: 'equipment', sterile: true })).json().id;
    expect((await test(ac, 'leak', 'fail')).statusCode).toBe(201);
    const s = await status(ac);
    expect(s.state).toBe('out_of_service');
    expect(s.blockers[0]).toMatch(/leak test failed/);
    expect((await cycle(ac, 'C-1')).json().error).toBe('not_fit_for_use');
    await test(ac, 'leak', 'pass');
    expect((await status(ac)).blockers.some((b: string) => /leak/.test(b))).toBe(false);
    expect((await cycle(ac, 'C-1')).statusCode).toBe(201);
  });

  it('LB-12: each test type is judged on its own latest result', async () => {
    const ac = (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `AC-${++n}`, name: 'Autoclave 3', kind: 'equipment', sterile: true })).json().id;
    await test(ac, 'air_removal', 'fail');
    await test(ac, 'leak', 'pass');
    expect((await status(ac)).blockers[0]).toMatch(/air-removal/);
  });
});

describe('glove integrity (LB-15)', () => {
  it('LB-15: a failed glove test on a port blocks the isolator until that port passes', async () => {
    const res = await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), data: { port: 'P3', method: 'pressure decay', result: 'fail', comment: 'Pinhole', deviationRef: 'DV-5' } });
    expect(res.statusCode).toBe(201);
    expect((await status(isolator)).blockers).toContain('Glove integrity failed on port P3: replace and pass before use.');
    await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), data: { port: 'P4', result: 'pass' } });
    expect((await status(isolator)).blockers.some((b: string) => /P3/.test(b))).toBe(true);
    await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), data: { port: 'P3', result: 'pass' } });
    expect((await status(isolator)).blockers.some((b: string) => /Glove/.test(b))).toBe(false);
  });
});

describe('pressure readings (LB-16)', () => {
  it('LB-16: readings are taken only at approved non-critical points', async () => {
    const res = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), data: { point: 'Unknown point', value: 15 } });
    expect(res.json().problems[0]).toMatch(/Unknown pressure point/);
  });

  it('LB-16: an out-of-limit reading is flagged and needs a comment and deviation reference', async () => {
    const bad = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), data: { point: 'Filling B / corridor', value: 4 } });
    expect(bad.json().problems[0]).toMatch(/outside 10–30 Pa/);
    const ok = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), data: { point: 'Filling B / corridor', value: 4, comment: 'Door left open', deviationRef: 'DV-12' } });
    expect(ok.statusCode).toBe(201);
    const [v] = (await call(t.app, c.qa!, 'GET', `/api/entries/${ok.json().id}/versions`)).json();
    expect(v.data.outOfLimit).toBe(true);
    expect((await status(room)).warnings).toContain('Last pressure reading out of limits: Filling B / corridor.');
    await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), data: { point: 'Filling B / corridor', value: 15 } });
    expect((await status(room)).warnings.some((w: string) => /pressure/.test(w))).toBe(false);
  });

  it('LB-16: the client cannot set the out-of-limit flag', async () => {
    const res = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), data: { point: 'Filling B / corridor', value: 50, outOfLimit: false } });
    expect(res.statusCode).toBe(400);
  });
});
