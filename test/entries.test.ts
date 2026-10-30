import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const cookies: Record<string, string> = {};
let mixer: number;
let room: number;
let cleanRoom: number;
let balance: number;
let product: number;

const sig = (username: string, password = PASSWORD) => ({ username, password });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const now = () => new Date().toISOString();

async function approveSettings(type: string, settings: object = {}) {
  const base = { enabled: true, sopRef: 'SOP-1', checklist: [], verificationRequired: false, ...settings };
  const id = (await call(t.app, cookies.admin!, 'POST', '/api/settings', { logbookType: type, settings: base, effectiveFrom: now() })).json().id;
  const types = (await call(t.app, cookies.qa!, 'GET', '/api/logbook-types')).json();
  const hash = types.flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === id).contentHash;
  const res = await call(t.app, cookies.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
  expect(res.statusCode).toBe(200);
}

const create = (who: string, equipmentId: number, body: object) => call(t.app, cookies[who]!, 'POST', `/api/equipment/${equipmentId}/entries`, body);
const versions = async (id: number) => (await call(t.app, cookies.qa!, 'GET', `/api/entries/${id}/versions`)).json();
const latest = async (equipmentId: number) => (await call(t.app, cookies.qa!, 'GET', `/api/equipment/${equipmentId}/entries`)).json();
const verify = async (who: string, versionId: number) => {
  const all = await versions(versionId);
  const v = all.find((x: { id: number }) => x.id === versionId);
  return call(t.app, cookies[who]!, 'POST', `/api/entries/${versionId}/verify`, { ...sig(who), contentHash: v.contentHash });
};

// A fresh item that has been cleaned and verified, so a use may start on it (S4 blocking).
let readyCount = 0;
async function ready(kind: 'equipment' | 'area' = 'equipment'): Promise<number> {
  const id = (await call(t.app, cookies.admin!, 'POST', '/api/equipment', { code: `RDY-${++readyCount}`, name: 'Ready item', kind })).json().id as number;
  const cleaning = kind === 'area'
    ? { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op2') }
    : { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: { 'Previous product removed': true } }, signature: sig('op2') };
  const entry = (await create('op2', id, cleaning)).json().id;
  expect((await verify('sup1', entry)).statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['op2', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) {
    await seedUser(t.owner, u, [...roles]);
    cookies[u === 'qa1' ? 'qa' : u] = (await login(t.app, u)).cookie;
  }
  cookies.qa1 = cookies.qa!;
  const eq = async (body: object) => (await call(t.app, cookies.admin!, 'POST', '/api/equipment', body)).json().id as number;
  mixer = await eq({ code: 'RMG-01', name: 'Mixer', kind: 'equipment', cleanHoldHours: 72 });
  room = await eq({ code: 'GR-01', name: 'Granulation room', kind: 'area' });
  cleanRoom = await eq({ code: 'FIL-B', name: 'Filling room B', kind: 'area', sterile: true, classified: true });
  balance = await eq({ code: 'BAL-01', name: 'Balance', kind: 'instrument' });
  product = (await call(t.app, cookies.admin!, 'POST', '/api/products', { code: 'PCM500', name: 'Paracetamol 500 mg' })).json().id;
  await approveSettings('equipment_use');
  await approveSettings('equipment_cleaning', { checklist: ['Previous product removed'] });
  await approveSettings('maintenance');
  await approveSettings('calibration');
  await approveSettings('area_cleaning');
});
afterAll(() => t.close());

describe('equipment use (LB-01, LB-10)', () => {
  it('LB-01: a use entry records product, batch and start/end with the logged-in user', async () => {
    const res = await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B2401', data: { stage: 'Granulation' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const done = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now() });
    expect(done.statusCode).toBe(200);
    const [v1, v2] = await versions(id);
    expect(v1).toMatchObject({ change: 'created', batch: 'B2401', enteredBy: 'OP1', activityEnd: null });
    expect(v2).toMatchObject({ change: 'completed', batch: 'B2401' });
    expect(v2.activityEnd).not.toBeNull();
  });

  it('LB-01: product and batch are required for a use entry', async () => {
    const res = await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: now(), data: {} });
    expect(res.statusCode).toBe(400);
  });

  it('LB-10: the end of use cannot be before its start', async () => {
    const id = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: minutesAgo(10), productId: product, batch: 'B2402', data: {} })).json().id;
    const res = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: minutesAgo(20) });
    expect(res.statusCode).toBe(400);
    await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now() });
  });

  it('LB-03: a use entry needs no signature; Admin cannot record entries', async () => {
    expect((await create('admin', mixer, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'X', data: {} })).statusCode).toBe(403);
  });
});

describe('contemporaneous entries (LB-04)', () => {
  it('LB-04: activity times in the future are refused', async () => {
    const res = await create('op1', room, { logbookType: 'area_cleaning', activityStart: new Date(Date.now() + 3600_000).toISOString(), data: { cleaningType: 'daily' }, signature: sig('op1') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('future_time');
  });

  it('LB-04: an entry more than 30 minutes after the activity is a late entry and needs a reason', async () => {
    const without = await create('op1', room, { logbookType: 'area_cleaning', activityStart: minutesAgo(120), data: { cleaningType: 'daily' }, signature: sig('op1') });
    expect(without.json().error).toBe('late_reason_required');
    const withReason = await create('op1', room, { logbookType: 'area_cleaning', activityStart: minutesAgo(120), data: { cleaningType: 'daily' }, lateReason: 'Transcribed from paper form F-12 (system down)', signature: sig('op1') });
    expect(withReason.statusCode).toBe(201);
    expect(withReason.json().late).toBe(true);
    const [v] = await versions(withReason.json().id);
    expect(v).toMatchObject({ late: true, lateReason: 'Transcribed from paper form F-12 (system down)' });
  });

  it('LB-04: entry time is set by the database, not by the client', async () => {
    await expect(
      t.sql`insert into entries (equipment_id, logbook_type, settings_id, version, change, activity_start, data, entered_by, entered_at)
            values (${mixer}, 'general_log', 1, 1, 'created', now(), '{}', 1, now() - interval '1 day')`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe('signatures and verification (LB-03, LB-11)', () => {
  it('LB-03: cleaning is signed by the performer and verified by a different person', async () => {
    const res = await create('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: minutesAgo(5), activityEnd: now(), data: { cleaningType: 'batch_to_batch', checklist: { 'Previous product removed': true } }, signature: sig('op1') });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect((await verify('op1', id)).statusCode).toBe(403); // not a verifier role
    const ok = await verify('sup1', id);
    expect(ok.statusCode).toBe(200);
    const [v] = await versions(id);
    expect(v.signatures.map((s: { meaning: string; printedName: string }) => [s.meaning, s.printedName])).toEqual([['performed', 'OP1'], ['verified', 'SUP1']]);
    expect(v.signatures.every((s: { valid: boolean }) => s.valid)).toBe(true);
  });

  it('LB-03: cleaning without the performer\'s e-signature is refused', async () => {
    const res = await create('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: { 'Previous product removed': true } } });
    expect(res.json().error).toBe('signature_required');
  });

  it('LB-03: nobody verifies their own entry', async () => {
    await seedUser(t.owner, 'supop', ['supervisor']);
    const c = (await login(t.app, 'supop')).cookie;
    cookies.supop = c;
    const id = (await create('supop', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: { 'Previous product removed': true } }, signature: sig('supop') })).json().id;
    const res = await verify('supop', id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('own_entry');
  });

  it('LB-11: an unconfirmed checklist item is refused by the system check', async () => {
    const res = await create('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(res.statusCode).toBe(400);
    expect(res.json().problems[0]).toMatch(/Previous product removed/);
  });

  it('LB-11: calibration checks the next due date and always needs verification', async () => {
    const bad = await create('eng1', balance, { logbookType: 'calibration', activityStart: now(), data: { result: 'pass', nextDue: minutesAgo(60 * 24) }, signature: sig('eng1') });
    expect(bad.statusCode).toBe(400);
    const failNoDev = await create('eng1', balance, { logbookType: 'calibration', activityStart: now(), data: { result: 'fail', nextDue: '2027-01-01' }, signature: sig('eng1') });
    expect(failNoDev.json().problems[0]).toMatch(/deviation/);
    const ok = await create('eng1', balance, { logbookType: 'calibration', activityStart: now(), data: { result: 'pass', nextDue: '2027-04-01', certificateRef: 'CAL-778' }, signature: sig('eng1') });
    expect(ok.statusCode).toBe(201);
    const [entry] = (await latest(balance));
    expect(entry.awaitingVerification).toBe(true);
    expect((await verify('qa1', ok.json().id)).statusCode).toBe(200);
  });

  it('LB-11: classified rooms need the agent and disinfectant lot', async () => {
    const res = await create('op1', cleanRoom, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op1') });
    expect(res.statusCode).toBe(400);
    const ok = await create('op1', cleanRoom, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily', agent: 'IPA 70%', disinfectantLot: 'L-55' }, signature: sig('op1') });
    expect(ok.statusCode).toBe(201);
  });

  it('LB-11: a breakdown of sterile equipment needs an impact assessment (Annex 1 5.7)', async () => {
    const steriliser = (await call(t.app, cookies.admin!, 'POST', '/api/equipment', { code: 'AC-01', name: 'Autoclave', kind: 'equipment', sterile: true })).json().id;
    const res = await create('eng1', steriliser, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'breakdown', description: 'Door seal leak', occurredAt: minutesAgo(5), failureCategory: 'mechanical', partsNone: true, doneBy: 'in_house' }, signature: sig('eng1') });
    expect(res.json().problems).toEqual(['A breakdown of sterile equipment needs an impact assessment (Annex 1 5.7).']);
  });

  it('LB-24: a type without approved settings cannot be used', async () => {
    const res = await create('op1', mixer, { logbookType: 'general_log', activityStart: now(), data: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('type_not_configured');
  });
});

describe('corrections (LB-17)', () => {
  it('LB-17: a correction keeps the original visible, needs a reason and a Corrected e-signature', async () => {
    const id = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: minutesAgo(5), productId: product, batch: 'B2405', data: { stage: 'Drying' } })).json().id;
    const noReason = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: minutesAgo(5), batch: 'B2406', data: { stage: 'Drying' }, signature: sig('op1') });
    expect(noReason.statusCode).toBe(400);
    const res = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: minutesAgo(5), batch: 'B2406', data: { stage: 'Drying' }, reason: 'Wrong batch number typed', signature: sig('op1') });
    expect(res.statusCode).toBe(200);
    const all = await versions(id);
    expect(all.map((v: { batch: string }) => v.batch)).toEqual(['B2405', 'B2406']);
    expect(all[1]).toMatchObject({ change: 'corrected', correctionReason: 'Wrong batch number typed' });
    expect(all[1].signatures[0]).toMatchObject({ meaning: 'corrected', printedName: 'OP1' });
    const [audit] = await t.owner`select * from audit_log where action = 'entry.corrected' and object_id = ${String(all[1].id)}`;
    expect(audit!.old_value.batch).toBe('B2405');
    expect(audit!.reason).toBe('Wrong batch number typed');
  });

  it('LB-17: a correction voids the earlier verification, which must be redone', async () => {
    const start = minutesAgo(3);
    const id = (await create('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: start, data: { cleaningType: 'major', checklist: { 'Previous product removed': true } }, signature: sig('op1') })).json().id;
    await verify('sup1', id);
    const corrected = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: start, activityEnd: start, data: { cleaningType: 'product_change', checklist: { 'Previous product removed': true } }, reason: 'Was a product change', signature: sig('op1') });
    expect(corrected.json()).toMatchObject({ id: expect.any(Number) });
    const newId = corrected.json().id;
    const entry = (await latest(mixer)).find((e: { id: number }) => e.id === newId);
    expect(entry.awaitingVerification).toBe(true);
    expect((await verify('sup1', id)).json().error).toBe('not_latest_version');
    expect((await verify('sup1', newId)).statusCode).toBe(200);
  });

  it('LB-17: other operators cannot correct someone else\'s entry', async () => {
    const id = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B2407', data: {} })).json().id;
    const res = await call(t.app, cookies.op2!, 'POST', `/api/entries/${id}/correct`, { activityStart: now(), data: {}, reason: 'x', signature: sig('op2') });
    expect(res.statusCode).toBe(403);
    await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now() });
  });

  it('LB-17: the application cannot update or delete entries', async () => {
    await expect(t.sql`update entries set batch = 'X'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from entries`).rejects.toThrow(/permission denied/);
  });

  it('LB-19: a verification signature covers exactly the version shown', async () => {
    const id = (await create('op1', mixer, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: { 'Previous product removed': true } }, signature: sig('op1') })).json().id;
    const res = await call(t.app, cookies.sup1!, 'POST', `/api/entries/${id}/verify`, { ...sig('sup1'), contentHash: 'a'.repeat(64) });
    expect(res.json().error).toBe('content_changed');
  });
});

describe('open items (LB-26)', () => {
  it('LB-26: unfinished uses and entries awaiting verification are listed', async () => {
    const id = (await create('op2', await ready('area'), { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B9', data: {} })).json().id;
    const open = (await call(t.app, cookies.qa!, 'GET', '/api/entries/open')).json();
    expect(open.some((e: { id: number; inProgress: boolean }) => e.id === id && e.inProgress)).toBe(true);
    expect(open.some((e: { awaitingVerification: boolean }) => e.awaitingVerification)).toBe(true);
  });
});

describe('review fixes (S3)', () => {
  it('LB-04: a correction that moves times back past the late window needs a reason and is flagged late', async () => {
    const id = (await create('op1', room, { logbookType: 'area_cleaning', activityStart: now(), data: { cleaningType: 'daily' }, signature: sig('op1') })).json().id;
    const twoDaysAgo = minutesAgo(48 * 60);
    const body = { activityStart: twoDaysAgo, activityEnd: twoDaysAgo, data: { cleaningType: 'daily' }, reason: 'Wrong day', signature: sig('op1') };
    const without = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, body);
    expect(without.json().error).toBe('late_reason_required');
    const ok = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, { ...body, lateReason: 'Recorded from the paper log' });
    expect(ok.statusCode).toBe(200);
    const all = await versions(id);
    expect(all[1]).toMatchObject({ late: true, lateReason: 'Recorded from the paper log' });
  });

  it('LB-10: a correction cannot end an open use or reopen a finished activity', async () => {
    const id = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B3001', data: {} })).json().id;
    const close = await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: now(), activityEnd: now(), data: {}, reason: 'x', signature: sig('op1') });
    expect(close.statusCode).toBe(400);
    const ended = (await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now() })).json().id;
    const reopen = await call(t.app, cookies.op1!, 'POST', `/api/entries/${ended}/correct`, { activityStart: now(), activityEnd: null, data: {}, reason: 'x', signature: sig('op1') });
    expect(reopen.statusCode).toBe(400);
  });

  it('LB-21: QA cannot rewrite entries; a supervisor may correct entries of types they may record', async () => {
    const id = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: minutesAgo(1), productId: product, batch: 'B3002', data: {} })).json().id;
    const ended = (await call(t.app, cookies.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now() })).json().id;
    const v = (await versions(ended))[1];
    const body = { activityStart: v.activityStart, activityEnd: v.activityEnd, batch: 'B3003', data: {}, reason: 'typo' };
    expect((await call(t.app, cookies.qa!, 'POST', `/api/entries/${ended}/correct`, { ...body, signature: sig('qa1') })).statusCode).toBe(403);
    expect((await call(t.app, cookies.sup1!, 'POST', `/api/entries/${ended}/correct`, { ...body, signature: sig('sup1') })).statusCode).toBe(200);
  });

  it('LB-17: the database refuses a version that does not follow its predecessor', async () => {
    const a = (await create('op1', await ready(), { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B3004', data: {} })).json().id;
    const [row] = await t.owner`select * from entries where id = ${a}`;
    const other = row!.equipment_id === mixer ? room : mixer;
    await expect(t.sql`
      insert into entries (equipment_id, logbook_type, settings_id, entry_id, version, supersedes, change, activity_start, data, entered_by)
      values (${other}, ${row!.logbook_type}, ${row!.settings_id}, ${row!.entry_id}, 2, ${a}, 'completed', now(), '{}', ${row!.entered_by})`,
    ).rejects.toThrow(/does not follow/);
    await expect(t.sql`
      insert into entries (equipment_id, logbook_type, settings_id, entry_id, version, supersedes, change, activity_start, data, entered_by)
      values (${row!.equipment_id}, ${row!.logbook_type}, ${row!.settings_id}, ${row!.entry_id}, 5, ${a}, 'completed', now(), '{}', ${row!.entered_by})`,
    ).rejects.toThrow(/does not follow/);
    await call(t.app, cookies.op1!, 'POST', `/api/entries/${a}/complete`, { activityEnd: now() });
  });

  it('LB-26: open items are found in the database, not cut off by a list limit', async () => {
    const id = (await create('op1', room, { logbookType: 'area_cleaning', activityStart: minutesAgo(25), data: { cleaningType: 'weekly' }, signature: sig('op1') })).json().id;
    // Simulate many newer, closed entries elsewhere: the open item must still be listed.
    const [row] = await t.owner`select * from entries where id = ${id}`;
    await t.owner`insert into entries (equipment_id, logbook_type, settings_id, version, change, activity_start, activity_end, data, entered_by)
      select ${mixer}, 'equipment_use', (select settings_id from entries where logbook_type = 'equipment_use' limit 1), 1, 'created',
             now(), now(), '{}', ${row!.entered_by} from generate_series(1, 520)`;
    const open = (await call(t.app, cookies.qa!, 'GET', '/api/entries/open')).json();
    expect(open.some((e: { id: number }) => e.id === id)).toBe(true);
  });
});
