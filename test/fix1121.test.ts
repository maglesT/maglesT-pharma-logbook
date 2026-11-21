import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordOverdue } from '../server/overdue.js';
import { addItem, addProduct, asReport, call, directory, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Fix round 21 Nov 2026: D1/D4 steriliser leak test with a limit in one unit (D-83), D2 move to another room (D-84),
// D3 reservations (D-85).

let t: TestApp;
const c: Record<string, string> = {};
let n = 0;
let product: number;
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const historyOf = async (eq: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${eq}/history?fromDay=${day(-2)}&toDay=${day(2)}`)).json();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function approve(type: string, extra: object = {}) {
  const res = await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...extra }, effectiveFrom: now() });
  expect(res.statusCode).toBe(201);
  const id = res.json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  expect((await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash })).statusCode).toBe(200);
}
const entry = (who: string, eq: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${eq}/entries`, body);
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const published = async (code: string) => {
  await recordOverdue(t.sql, t.master, null);
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.equipment_status_v1 where code = '${code}'`);
  expect(r.error).toBeUndefined();
  return r.rows![0] as Record<string, unknown>;
};
async function verify(id: number) {
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json().find((x: { id: number }) => x.id === id);
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
}
async function clean(id: number) {
  const e = (await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json();
  await verify(e.id);
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  // D-84, D-85: given per employee, to no old role.
  directory.get('sup1')!.permissions.push('logbook.equipment.move', 'logbook.equipment.reserve');
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'P-FX', 'Product FX');
  await addItem(t, { code: 'RM-A', kind: 'area' });
  // A room of master data that is not a logbook of its own.
  t.master.items_.set('RM-B', { ...t.master.items_.get('RM-A')!, itemId: randomUUID(), code: 'RM-B', name: 'Room B' });
  for (const type of ['equipment_cleaning', 'equipment_use', 'room_move', 'steriliser_test']) await approve(type);
});
afterAll(() => t.close());

describe('steriliser vacuum leak test against a limit in one unit (D-83, D1/D4)', () => {
  const leak = (eq: number, data: object) => entry('op1', eq, { logbookType: 'steriliser_test', activityStart: now(), signature: sig('op1'), data: { test: 'leak', result: 'pass', ...data } });

  it('LB-12: with an approved limit the reading is in its unit and the result follows from it', async () => {
    await approve('steriliser_test', { leakLimit: { max: 1.3, unit: 'mbar/min' } });
    const ac = await addItem(t, { code: `AC-${++n}`, sterile: true });
    expect((await leak(ac, {})).json().problems).toEqual(['Give the leak rate in mbar/min (limit: not more than 1.3 mbar/min).']);
    expect((await leak(ac, { leakRate: 0.07, leakUnit: 'kPa/min' })).json().problems).toEqual(['The leak limit is in mbar/min: give the reading in mbar/min, not kPa/min.']);
    const ok = await leak(ac, { leakRate: 0.8 });
    expect(ok.statusCode).toBe(201);
    const [e] = (await call(t.app, c.qa!, 'GET', `/api/equipment/${ac}/entries`)).json();
    expect(e.data).toMatchObject({ test: 'leak', result: 'pass', leakRate: 0.8, leakUnit: 'mbar/min', leakMax: 1.3 });
    // A reading over the limit fails, whatever the form said; a failure needs a comment and a deviation.
    expect((await leak(ac, { leakRate: 2, result: 'pass' })).json().problems).toEqual(['A failed result needs a comment and a deviation reference.']);
    expect((await leak(ac, { leakRate: 2, comment: 'Door seal', deviationRef: 'DV-1' })).statusCode).toBe(201);
    const s = await status(ac);
    expect(s.state).toBe('out_of_service');
    expect(s.blockers[0]).toMatch(/leak test failed/);
  });

  it('LB-12: an air-removal (Bowie-Dick) test takes its test pack lot; leak fields are for a leak test only', async () => {
    const ac = await addItem(t, { code: `AC-${++n}`, sterile: true });
    const bd = await entry('op1', ac, { logbookType: 'steriliser_test', activityStart: now(), signature: sig('op1'),
      data: { test: 'air_removal', result: 'pass', testPackLot: 'BD-2611', cycleId: 'T-14' } });
    expect(bd.statusCode).toBe(201);
    expect((await entry('op1', ac, { logbookType: 'steriliser_test', activityStart: now(), signature: sig('op1'),
      data: { test: 'air_removal', result: 'pass', leakRate: 1 } })).json().problems).toContain('A leak rate is for a leak test only.');
    expect((await leak(ac, { leakRate: 1, testPackLot: 'X' })).json().problems).toContain('A test pack lot is for an air-removal (Bowie-Dick) test only.');
  });

  it('LB-12: without a limit the person gives the unit with the reading and records the result', async () => {
    await approve('steriliser_test');
    const ac = await addItem(t, { code: `AC-${++n}`, sterile: true });
    expect((await leak(ac, { leakRate: 0.5 })).json().problems).toEqual(['Choose the unit of the leak rate.']);
    expect((await leak(ac, { leakRate: 0.5, leakUnit: 'kPa/min' })).statusCode).toBe(201);
    expect((await leak(ac, {})).statusCode).toBe(201);
  });

  it('LB-24: a leak limit is approved with the settings: a number above 0 in one of the units', async () => {
    const bad = await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: 'steriliser_test', effectiveFrom: now(),
      settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false, leakLimit: { max: 7, unit: 'mmHg' } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('move to another room (D-84, D2)', () => {
  const move = (who: string, eq: number, toRoom: string, reason = 'Line change for the campaign') =>
    entry(who, eq, { logbookType: 'room_move', activityStart: now(), signature: sig(who), data: { toRoom, reason } });

  it('LB-21: only a person holding logbook.equipment.move moves an item, with the reason and an e-signature', async () => {
    const eq = await addItem(t, { code: `MV-${++n}`, location: 'RM-A' });
    expect((await move('op1', eq, 'RM-B')).statusCode).toBe(403);
    const types = (await call(t.app, c.sup1!, 'GET', '/api/logbook-types')).json();
    expect(types.find((x: { key: string }) => x.key === 'room_move').mayRecord).toBe(true);
    expect((await entry('sup1', eq, { logbookType: 'room_move', activityStart: now(), data: { toRoom: 'RM-B', reason: 'x' } })).json().error).toBe('signature_required');
    expect((await entry('sup1', eq, { logbookType: 'room_move', activityStart: now(), signature: sig('sup1'), data: { toRoom: 'RM-B' } })).statusCode).toBe(400);
  });

  it('LB-02: the room moved to is an active master-data room other than the current one; the room moved from is set by the Logbook', async () => {
    const eq = await addItem(t, { code: `MV-${++n}`, location: 'RM-A' });
    expect((await move('sup1', eq, 'RM-ZZ')).json().problems[0]).toMatch(/not an active room in master data/);
    expect((await move('sup1', eq, 'rm-a')).json().problems).toEqual([`MV-${n} is in RM-A already.`]);
    const res = await entry('sup1', eq, { logbookType: 'room_move', activityStart: now(), signature: sig('sup1'), data: { toRoom: 'rm-b', fromRoom: 'RM-Q', reason: 'Campaign' } });
    expect(res.statusCode).toBe(201);
    const [e] = (await call(t.app, c.qa!, 'GET', `/api/equipment/${eq}/entries`)).json();
    expect(e.data).toMatchObject({ fromRoom: 'RM-A', toRoom: 'RM-B', reason: 'Campaign' });
    expect(e.signatures.map((g: { meaning: string }) => g.meaning)).toEqual(['performed']);
    // The Logbook has it in the new room now; master data still says RM-A, which the status says.
    const listed = (await call(t.app, c.qa!, 'GET', '/api/equipment')).json().find((i: { id: number }) => i.id === eq);
    expect(listed.location).toBe('RM-B');
    const s = await status(eq);
    expect(s.room).toBe('RM-B');
    expect(s.warnings.some((w: string) => /^Moved to RM-B on .*; master data still shows RM-A: ask the master data editor to update it\.$/.test(w))).toBe(true);
    const row = await published(`MV-${n}`);
    expect(row.room_code).toBe('RM-B');
    expect(row.moved_at).toBeInstanceOf(Date);
    // Once master data follows, the warning goes.
    const m = t.master.items_.get(`MV-${n}`)!;
    t.master.items_.set(m.code, { ...m, room: 'RM-B', version: m.version + 1 });
    expect((await status(eq)).warnings.some((w: string) => w.startsWith('Moved to'))).toBe(false);
    // The history card shows the move with its rooms.
    const history = await historyOf(eq);
    expect(JSON.stringify(history.events)).toContain('"toRoom":"RM-B"');
  });

  it('LB-08: an item in use is not moved; a corrected move keeps the room it was moved from', async () => {
    const eq = await addItem(t, { code: `MV-${++n}`, location: 'RM-A', cleanHoldHours: 72 });
    await clean(eq);
    const use = await entry('op1', eq, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-MV1', data: {} });
    expect(use.statusCode).toBe(201);
    const busy = await move('sup1', eq, 'RM-B');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().problems[0]).toMatch(/is in use by batch B-MV1: move it once the use has ended/);
    expect((await call(t.app, c.op1!, 'POST', `/api/entries/${use.json().id}/complete`, { activityEnd: now() })).statusCode).toBe(200);
    const moved = await move('sup1', eq, 'RM-B');
    expect(moved.statusCode).toBe(201);
    const fixed = await call(t.app, c.sup1!, 'POST', `/api/entries/${moved.json().id}/correct`, {
      activityStart: now(), activityEnd: now(), data: { toRoom: 'RM-A', fromRoom: 'RM-B', reason: 'Wrong room picked' }, reason: 'Wrong room', signature: sig('sup1') });
    expect(fixed.json().problems).toEqual([`MV-${n} is in RM-A already.`]);
    t.master.items_.set('RM-C', { ...t.master.items_.get('RM-A')!, itemId: randomUUID(), code: 'RM-C', name: 'Room C' });
    const ok = await call(t.app, c.sup1!, 'POST', `/api/entries/${moved.json().id}/correct`, {
      activityStart: now(), activityEnd: now(), data: { toRoom: 'RM-C', fromRoom: 'RM-B', reason: 'Wrong room picked' }, reason: 'Wrong room', signature: sig('sup1') });
    expect(ok.statusCode).toBe(200);
    const [e] = (await call(t.app, c.qa!, 'GET', `/api/equipment/${eq}/entries`)).json();
    expect(e.data).toMatchObject({ fromRoom: 'RM-A', toRoom: 'RM-C' });
    expect((await status(eq)).room).toBe('RM-C');
  });

  it('LB-21: the rooms offered for a move are the active rooms of master data', async () => {
    const rooms = (await call(t.app, c.sup1!, 'GET', '/api/rooms')).json();
    expect(rooms.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['RM-A', 'RM-B']));
  });
});

describe('reservations (D-85, D3)', () => {
  const reserve = (who: string, eq: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${eq}/reservations`, body);

  it('LB-21: only a person holding logbook.equipment.reserve reserves; the reservation says from, to, who and why', async () => {
    const eq = await addItem(t, { code: `RS-${++n}`, location: 'RM-A' });
    expect((await reserve('op1', eq, { from: now(), until: inHours(4), purpose: 'Validation run' })).statusCode).toBe(403);
    expect((await reserve('sup1', eq, { from: now(), until: inHours(4) })).statusCode).toBe(400);
    expect((await reserve('sup1', eq, { from: inHours(4), until: inHours(2), purpose: 'x' })).json().problems).toEqual(['The end must be after the start.']);
    expect((await reserve('sup1', eq, { from: inHours(-5), until: inHours(-4), purpose: 'x' })).json().problems).toEqual(['The end is in the past: a reservation is for now or later.']);
    const res = await reserve('sup1', eq, { from: inHours(2), until: inHours(6), purpose: 'Validation run' });
    expect(res.statusCode).toBe(201);
    const [r] = (await call(t.app, c.op1!, 'GET', `/api/equipment/${eq}/reservations`)).json();
    expect(r).toMatchObject({ batch: null, purpose: 'Validation run', by: 'SUP1', cancelled: null });
    // An overlapping one is refused; one after it is fine.
    expect((await reserve('sup1', eq, { from: inHours(5), until: inHours(8), purpose: 'y' })).json().problems[0]).toMatch(/is already reserved from .* by SUP1\./);
    expect((await reserve('sup1', eq, { from: inHours(6), until: inHours(8), purpose: 'y' })).statusCode).toBe(201);
    // The next one shows on the status, not as a warning yet.
    const s = await status(eq);
    expect(s.reservation).toMatchObject({ purpose: 'Validation run', now: false });
    expect(s.warnings.some((w: string) => w.startsWith('Reserved'))).toBe(false);
  });

  it('LB-08: while a reservation for a batch is in force, the Logbook records a use for that batch only; it is published', async () => {
    const eq = await addItem(t, { code: `RS-${++n}`, location: 'RM-A', cleanHoldHours: 72 });
    await clean(eq);
    expect((await reserve('sup1', eq, { from: inHours(-1), until: inHours(3), batch: 'B-77', purpose: 'Campaign of B-77' })).statusCode).toBe(201);
    const s = await status(eq);
    expect(s.warnings.some((w: string) => /^Reserved for batch B-77 from .* to .* by SUP1: Campaign of B-77$/.test(w))).toBe(true);
    const other = await entry('op1', eq, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-78', data: {} });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('reserved');
    expect(other.json().problems[0]).toMatch(/Use it for batch B-77, or ask for the reservation to be cancelled\.$/);
    const row = await published(`RS-${n}`);
    expect(row).toMatchObject({ reserved_for_batch: 'B-77', reserved_by: 'SUP1', reserved_purpose: 'Campaign of B-77' });
    expect(row.reserved_from).toBeInstanceOf(Date);
    expect((await entry('op1', eq, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-77', data: {} })).statusCode).toBe(201);
  });

  it('LB-17: a reservation is cancelled with a reason, kept, and shown on the history card', async () => {
    const eq = await addItem(t, { code: `RS-${++n}`, location: 'RM-A' });
    const id = (await reserve('sup1', eq, { from: inHours(-1), until: inHours(3), batch: 'B-90', purpose: 'Campaign' })).json().id;
    const url = `/api/equipment/${eq}/reservations/${id}/cancel`;
    expect((await call(t.app, c.op1!, 'POST', url, { reason: 'x' })).statusCode).toBe(403);
    expect((await call(t.app, c.sup1!, 'POST', url, {})).statusCode).toBe(400);
    expect((await call(t.app, c.sup1!, 'POST', url, { reason: 'Batch postponed' })).statusCode).toBe(200);
    expect((await call(t.app, c.sup1!, 'POST', url, { reason: 'again' })).json().problems).toEqual(['This reservation is cancelled already.']);
    const [r] = (await call(t.app, c.op1!, 'GET', `/api/equipment/${eq}/reservations`)).json();
    expect(r.cancelled).toMatchObject({ by: 'SUP1', reason: 'Batch postponed' });
    expect((await status(eq)).reservation).toBeNull();
    expect((await published(`RS-${n}`)).reserved_for_batch).toBeNull();
    const events = (await historyOf(eq)).events
      .filter((e: { kind: string }) => e.kind === 'masterdata').map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['reservation.created', 'reservation.cancelled']));
    // The rows are insert-only for the app.
    expect((await asReport(t.owner, `select 1`)).error).toBeUndefined();
    await expect(t.sql`delete from reservations`).rejects.toThrow();
    await expect(t.sql`update reservations set purpose = 'x'`).rejects.toThrow();
  });
});
