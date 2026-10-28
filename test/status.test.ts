import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
let n = 0;

const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();

async function approve(type: string, settings: object = {}) {
  const base = { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...settings };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: base, effectiveFrom: now() })).json().id;
  const types = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json();
  const hash = types.flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const newItem = async (body: object = {}) =>
  (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `ST-${++n}`, name: 'Item', kind: 'equipment', ...body })).json().id as number;
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const entry = (who: string, id: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${id}/entries`, body);
const hashOf = async (versionId: number) =>
  (await call(t.app, c.qa!, 'GET', `/api/entries/${versionId}/versions`)).json().find((v: { id: number }) => v.id === versionId).contentHash;
const signEntry = async (who: string, action: 'verify' | 'release', versionId: number) =>
  call(t.app, c[who]!, 'POST', `/api/entries/${versionId}/${action}`, { ...sig(who === 'qa' ? 'qa1' : who), contentHash: await hashOf(versionId) });
const startUse = (id: number) => entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: `B${n}`, data: { stage: 'Blending' } });

async function cleanAndVerify(id: number) {
  const e = (await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
  expect((await signEntry('sup1', 'verify', e)).statusCode).toBe(200);
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) {
    await seedUser(t.owner, u, [...roles]);
  }
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1']] as const) c[key] = (await login(t.app, u)).cookie;
  product = (await call(t.app, c.admin!, 'POST', '/api/products', { code: 'P1', name: 'Product 1' })).json().id;
  for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration']) await approve(type);
});
afterAll(() => t.close());

describe('cleaning status (LB-07)', () => {
  it('LB-07: new equipment is dirty until a verified cleaning; use is refused with the reason', async () => {
    const id = await newItem();
    expect((await status(id)).state).toBe('dirty');
    const res = await startUse(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().problems[0]).toMatch(/Dirty/);
  });

  it('LB-07: an unverified cleaning does not make equipment clean', async () => {
    const id = await newItem();
    await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    const s = await status(id);
    expect(s.state).toBe('dirty');
    expect(s.blockers[0]).toMatch(/awaiting verification/);
  });

  it('LB-07: after use the equipment is dirty again', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    expect((await status(id)).state).toBe('clean');
    const use = (await startUse(id)).json().id;
    expect((await status(id)).state).toBe('in_use');
    await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() });
    expect((await status(id)).state).toBe('dirty');
    expect((await startUse(id)).statusCode).toBe(409);
  });

  it('LB-07: clean equipment past its clean-hold time is blocked (SchM 18.4.4)', async () => {
    const id = await newItem({ cleanHoldHours: 24 });
    await cleanAndVerify(id);
    expect((await status(id)).state).toBe('clean');
    // Move the cleaning back 25 hours behind the application's back, as if a day had passed.
    await t.owner`alter table entries disable trigger entries_version_chain`;
    await t.owner`update entries set activity_start = activity_start - interval '25 hours', activity_end = activity_end - interval '25 hours' where equipment_id = ${id}`;
    await t.owner`alter table entries enable trigger entries_version_chain`;
    const s = await status(id);
    expect(s.state).toBe('clean_expired');
    expect((await startUse(id)).json().problems[0]).toMatch(/Clean-hold time expired/);
  });

  it('LB-10: cleaning cannot be recorded while the equipment is in use', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    await startUse(id);
    const res = await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(res.json().error).toBe('in_use');
  });
});

describe('in use (LB-08)', () => {
  it('LB-08: equipment in use shows product, batch and stage, and a second use is refused', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    await startUse(id);
    const s = await status(id);
    expect(s.inUse).toMatchObject({ productId: product, batch: `B${n}`, stage: 'Blending' });
    expect((await startUse(id)).json().problems).toContain('In use: end the current use first.');
  });
});

describe('breakdown and release (LB-06)', () => {
  it('LB-06: a breakdown takes equipment out of service until QA releases the verified entry', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    const bd = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'breakdown', description: 'Motor trips' }, signature: sig('eng1') })).json().id;
    expect((await status(id)).state).toBe('out_of_service');
    expect((await startUse(id)).json().problems[0]).toMatch(/Out of service/);

    // Release needs the entry verified first, and only QA may release.
    expect((await signEntry('qa', 'release', bd)).json().error).toBe('not_verified');
    expect((await signEntry('sup1', 'verify', bd)).statusCode).toBe(200);
    expect((await signEntry('sup1', 'release', bd)).statusCode).toBe(403);
    expect((await signEntry('qa', 'release', bd)).statusCode).toBe(200);
    expect((await status(id)).state).toBe('clean');
    expect((await startUse(id)).statusCode).toBe(201);
  });

  it('LB-06: preventive maintenance does not take equipment out of service', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'preventive', description: 'Lubrication' }, signature: sig('eng1') });
    expect((await status(id)).state).toBe('clean');
  });
});

describe('calibration status (LB-05)', () => {
  const calibrate = (id: number, result: 'pass' | 'fail', nextDue: string) =>
    entry('eng1', id, { logbookType: 'calibration', activityStart: now(), data: { result, nextDue, comment: 'x', deviationRef: 'DV-1' }, signature: sig('eng1') });

  it('LB-05: an instrument that needs calibration is blocked until a verified passed calibration', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    expect((await status(id)).state).toBe('not_calibrated');
    const cal = (await calibrate(id, 'pass', '2099-01-01')).json().id;
    expect((await status(id)).state).toBe('not_calibrated'); // not yet verified
    await signEntry('qa', 'verify', cal);
    expect((await status(id)).state).toBe('clean');
    expect((await status(id)).calibrationDue).toMatch(/^2099-01-01/);
  });

  it('LB-05: a failed calibration blocks use (211.160(b)(4))', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    const cal = (await calibrate(id, 'fail', '2099-01-01')).json().id;
    await signEntry('qa', 'verify', cal);
    expect((await status(id)).state).toBe('calibration_failed');
    expect((await startUse(id)).json().problems[0]).toMatch(/Calibration failed/);
  });

  it('LB-05: an overdue calibration blocks use; one due soon only warns', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const cal = (await calibrate(id, 'pass', soon)).json().id;
    await signEntry('qa', 'verify', cal);
    const s = await status(id);
    expect(s.state).toBe('clean');
    expect(s.warnings[0]).toMatch(/Calibration due/);
    await t.owner`alter table entries disable trigger entries_version_chain`;
    await t.owner`update entries set data = jsonb_set(data, '{nextDue}', '"2020-01-01T00:00:00.000Z"') where id = ${cal}`;
    await t.owner`alter table entries enable trigger entries_version_chain`;
    expect((await status(id)).state).toBe('calibration_overdue');
  });

  it('LB-05: equipment that does not need calibration ignores calibration status', async () => {
    const id = await newItem({ kind: 'equipment' });
    await cleanAndVerify(id);
    expect((await status(id)).state).toBe('clean');
  });
});

describe('status list', () => {
  it('LB-08: every user can see the status of all equipment', async () => {
    const res = await call(t.app, c.op1!, 'GET', '/api/equipment/status');
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(5);
  });
});

describe('review fixes (S4)', () => {
  const calibrate = (id: number, result: 'pass' | 'fail', nextDue: string) =>
    entry('eng1', id, { logbookType: 'calibration', activityStart: now(), data: { result, nextDue, comment: 'x', deviationRef: 'DV-1' }, signature: sig('eng1') });

  it('LB-05: a newly recorded failed calibration blocks at once, before verification', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    await signEntry('qa', 'verify', (await calibrate(id, 'pass', '2099-01-01')).json().id);
    expect((await status(id)).state).toBe('clean');
    await calibrate(id, 'fail', '2099-01-01');
    expect((await status(id)).state).toBe('calibration_failed');
  });

  it('LB-05: correcting a failed calibration does not bring back an older pass', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    await signEntry('qa', 'verify', (await calibrate(id, 'pass', '2099-01-01')).json().id);
    const failed = (await calibrate(id, 'fail', '2099-01-01')).json().id;
    await signEntry('qa', 'verify', failed);
    const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${failed}/versions`)).json()[0];
    await call(t.app, c.eng1!, 'POST', `/api/entries/${failed}/correct`, {
      activityStart: v.activityStart, activityEnd: v.activityEnd, data: { ...v.data, remarks: 'typo fixed' }, reason: 'remarks', signature: sig('eng1'),
    });
    expect((await status(id)).state).toBe('calibration_failed');
  });

  it('LB-05: a newer pass awaiting verification keeps the older valid calibration in force, with a warning', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    await signEntry('qa', 'verify', (await calibrate(id, 'pass', '2099-01-01')).json().id);
    await calibrate(id, 'pass', '2099-06-01');
    const s = await status(id);
    expect(s.state).toBe('clean');
    expect(s.warnings).toContain('A newer calibration is awaiting verification.');
  });

  it('LB-05: an instrument is usable on its due day (plant-local date)', async () => {
    const id = await newItem({ kind: 'instrument' });
    await cleanAndVerify(id);
    const cal = (await calibrate(id, 'pass', '2099-01-01')).json().id;
    await signEntry('qa', 'verify', cal);
    const [row] = await t.owner`select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as today`;
    const today = String(row!.today);
    await t.owner`alter table entries disable trigger entries_version_chain`;
    await t.owner`update entries set data = jsonb_set(data, '{nextDue}', to_jsonb(${today}::text)) where id = ${cal}`;
    await t.owner`alter table entries enable trigger entries_version_chain`;
    expect((await status(id)).state).toBe('clean');
  });

  it('LB-07: a cleaning that started before the last use ended is refused', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    const use = (await startUse(id)).json().id;
    const endedAt = new Date().toISOString();
    await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: endedAt });
    const res = await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: new Date(Date.parse(endedAt) - 10 * 60_000).toISOString(), activityEnd: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(res.statusCode).toBe(400);
    expect(res.json().problems[0]).toMatch(/before the last use ended/);
  });

  it('LB-05: rooms cannot be set to need calibration', async () => {
    const res = await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `RM-${++n}`, name: 'Room', kind: 'area', needsCalibration: true });
    expect(res.statusCode).toBe(400);
  });

  it('LB-06: correcting a released breakdown withdraws the release until re-verified and released (D-19)', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    const bd = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'breakdown', description: 'Belt' }, signature: sig('eng1') })).json().id;
    await signEntry('sup1', 'verify', bd);
    await signEntry('qa', 'release', bd);
    expect((await status(id)).state).toBe('clean');
    const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${bd}/versions`)).json()[0];
    const corr = (await call(t.app, c.eng1!, 'POST', `/api/entries/${bd}/correct`, {
      activityStart: v.activityStart, activityEnd: v.activityEnd, data: { ...v.data, description: 'Drive belt' }, reason: 'clarified', signature: sig('eng1'),
    })).json().id;
    expect((await status(id)).state).toBe('out_of_service');
    await signEntry('sup1', 'verify', corr);
    await signEntry('qa', 'release', corr);
    expect((await status(id)).state).toBe('clean');
  });
});

describe('minute precision (S5 browser finding)', () => {
  it('LB-07: a cleaning entered with a minute-precision start in the same minute the use ended is accepted', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    const use = (await startUse(id)).json().id;
    const endedAt = new Date();
    await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: endedAt.toISOString() });
    const minute = new Date(Math.floor(endedAt.getTime() / 60_000) * 60_000).toISOString();
    const res = await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: minute, activityEnd: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(res.statusCode).toBe(201);
    await signEntry('sup1', 'verify', res.json().id);
    expect((await status(id)).state).toBe('clean');
  });
});
