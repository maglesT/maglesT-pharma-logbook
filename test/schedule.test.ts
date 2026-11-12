import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deadline } from '../server/status.js';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S16 (owner request): cleaning schedule. Equipment and operation-based rooms are cleaned after use, within the dirty
// hold, and stay clean for the clean hold; frequency-based rooms are cleaned every cleaning_frequency_hours. The status
// carries the next deadline, flagged soon (inside the warning window) or overdue.

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
const create = (body: object) => call(t.app, c.admin!, 'POST', '/api/equipment', { code: `SC-${++n}`, name: 'Item', kind: 'equipment', ...body });
const newItem = async (body: object = {}) => (await create(body)).json().id as number;
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const entry = (id: number, body: object) => call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, body);
const hashOf = async (v: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${v}/versions`)).json().find((x: { id: number }) => x.id === v).contentHash;
const verify = async (v: number) => expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${v}/verify`, { ...sig('sup1'), contentHash: await hashOf(v) })).statusCode).toBe(200);

async function clean(id: number, area = false) {
  const body = area
    ? { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op1') }
    : { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') };
  await verify((await entry(id, body)).json().id);
}
async function useAndEnd(id: number) {
  const use = (await entry(id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: `B${n}`, data: { stage: 'Blending' } })).json().id;
  expect((await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() })).statusCode).toBe(200);
}
// As if time had passed: moves the item's entries back, behind the application's back.
async function age(id: number, hours: number) {
  await t.owner`alter table entries disable trigger entries_version_chain`;
  await t.owner`update entries set activity_start = activity_start - make_interval(hours => ${hours}),
                 activity_end = activity_end - make_interval(hours => ${hours}) where equipment_id = ${id}`;
  await t.owner`alter table entries enable trigger entries_version_chain`;
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  product = (await call(t.app, c.admin!, 'POST', '/api/products', { code: 'P1', name: 'Product 1' })).json().id;
  for (const type of ['equipment_use', 'equipment_cleaning', 'area_cleaning']) await approve(type);
});
afterAll(() => t.close());

describe('warning window', () => {
  it('LB-07: a deadline is soon in the last quarter of its time (at least 1 hour), overdue once passed', () => {
    const from = new Date('2026-11-12T00:00:00Z');
    const at = (h: number) => from.getTime() + h * 3_600_000;
    expect(deadline('dirty_hold', from, 8, at(5.9))).toMatchObject({ soon: false, overdue: false });
    expect(deadline('dirty_hold', from, 8, at(6.1))).toMatchObject({ soon: true, overdue: false });
    expect(deadline('dirty_hold', from, 8, at(8.1))).toMatchObject({ soon: false, overdue: true });
    expect(deadline('frequency', from, 2, at(0.9))).toMatchObject({ soon: false });      // 1 hour minimum
    expect(deadline('frequency', from, 2, at(1.1))).toMatchObject({ soon: true });
    expect(deadline('clean_hold', from, 168, at(126)).soon).toBe(true);                // weekly: last 42 hours
  });
});

describe('dirty hold (equipment and operation-based rooms)', () => {
  it('LB-07: after use the dirty hold runs; near its end it warns, past it the state is dirty hold expired', async () => {
    const id = await newItem({ dirtyHoldHours: 8, cleanHoldHours: 72 });
    await clean(id);
    await useAndEnd(id);
    let s = await status(id);
    expect(s.state).toBe('dirty');
    expect(s.deadline).toMatchObject({ kind: 'dirty_hold', hours: 8, soon: false, overdue: false });
    expect(Date.parse(s.dirtyUntil) - Date.now()).toBeGreaterThan(7.9 * 3_600_000);

    await age(id, 7);
    s = await status(id);
    expect(s.deadline).toMatchObject({ kind: 'dirty_hold', soon: true, overdue: false });
    expect(s.warnings.join()).toMatch(/Dirty hold ends at/);

    await age(id, 2);
    s = await status(id);
    expect(s.state).toBe('dirty_expired');
    expect(s.deadline).toMatchObject({ overdue: true });
    expect(s.blockers[0]).toMatch(/Dirty-hold time expired .* the cleaning is late/);
  });

  it('LB-07: the cleaning ends the dirty hold and starts the clean hold, which warns near its end', async () => {
    const id = await newItem({ dirtyHoldHours: 8, cleanHoldHours: 24 });
    await clean(id);
    let s = await status(id);
    expect(s.state).toBe('clean');
    expect(s.deadline).toMatchObject({ kind: 'clean_hold', hours: 24, soon: false });
    await age(id, 19);
    s = await status(id);
    expect(s.deadline).toMatchObject({ kind: 'clean_hold', soon: true, overdue: false });
    expect(s.warnings.join()).toMatch(/Clean hold ends at/);
  });

  it('LB-07: an operation-based room follows dirty hold and clean hold like equipment', async () => {
    const room = await newItem({ kind: 'area', dirtyHoldHours: 4, cleanHoldHours: 24 });
    expect((await call(t.app, c.qa!, 'GET', '/api/equipment')).json().find((e: { id: number }) => e.id === room).cleaningBasis).toBe('operation');
    await clean(room, true);
    await useAndEnd(room);
    await age(room, 5);
    const s = await status(room);
    expect(s.schedule).toBe('hold');
    expect(s.state).toBe('dirty_expired');
  });
});

describe('cleaning frequency (frequency-based rooms)', () => {
  it('LB-07: a frequency-based room is due every cleaning_frequency_hours: warns near the time, then is overdue', async () => {
    const room = await newItem({ kind: 'area', cleaningBasis: 'frequency', cleaningFrequencyHours: 24 });
    expect((await status(room)).state).toBe('dirty');                                  // never cleaned
    await clean(room, true);
    let s = await status(room);
    expect(s).toMatchObject({ state: 'clean', schedule: 'frequency', deadline: { kind: 'frequency', hours: 24, soon: false } });
    await age(room, 19);
    s = await status(room);
    expect(s.deadline).toMatchObject({ soon: true, overdue: false });
    expect(s.warnings.join()).toMatch(/Next cleaning due at/);
    await age(room, 6);
    s = await status(room);
    expect(s.state).toBe('cleaning_due');
    expect(s.blockers[0]).toMatch(/Cleaning overdue since .* \(every 24 h\)/);
    await clean(room, true);
    expect((await status(room)).state).toBe('clean');
  });

  it('LB-07: the schedule fields are checked: frequency only for frequency-based rooms, which need one', async () => {
    expect((await create({ cleaningFrequencyHours: 24 })).statusCode).toBe(400);
    expect((await create({ cleaningBasis: 'frequency' })).statusCode).toBe(400);
    expect((await create({ kind: 'area', cleaningBasis: 'frequency' })).json().message).toMatch(/needs its cleaning frequency/);
    expect((await create({ kind: 'area', cleaningFrequencyHours: 24 })).json().message).toMatch(/Only a frequency-based room/);
    const room = await newItem({ kind: 'area' });
    const switched = await call(t.app, c.admin!, 'PATCH', `/api/equipment/${room}`, { cleaningBasis: 'frequency', cleaningFrequencyHours: 168, reason: 'store room, weekly' });
    expect(switched.json()).toMatchObject({ cleaningBasis: 'frequency', cleaningFrequencyHours: 168 });
    const back = await call(t.app, c.admin!, 'PATCH', `/api/equipment/${room}`, { cleaningBasis: 'operation', cleaningFrequencyHours: null, dirtyHoldHours: 4, reason: 'now a process room' });
    expect(back.json()).toMatchObject({ cleaningBasis: 'operation', cleaningFrequencyHours: null, dirtyHoldHours: 4 });
  });
});
