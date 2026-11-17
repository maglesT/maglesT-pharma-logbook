import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QualificationOff, type MediaFill, type Qualification, type QualStatus } from '../server/qualification.js';
import { NO_CARE, type MasterItem } from '../server/master.js';
import { call, freshApp, login, seedUser, type TestApp, proofFor, addItem, addProduct } from './helpers.js';
import { randomUUID } from 'node:crypto';

// Owner 2026-11-12 (platform D-24): items are added by their master ID (qualified only), and their hold times,
// PM / calibration / requalification frequencies come from master data and the Qualification product; dues are worked
// out, never stored. Overdue PM, calibration or requalification blocks use.

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
let n = 0;
const qual = new Map<string, QualStatus>();
const protocols: Record<string, unknown>[] = [];
let qualDown = false;   // D-70: the link is on but does not answer
const fakeQualification: Qualification = {
  statuses: async () => { if (qualDown) throw new QualificationOff(); return new Map(qual); },
  protocols: async (masterId) => { if (qualDown) throw new QualificationOff(); return protocols.filter((p) => p.masterId === masterId) as never; },
  mediaFills: async () => { if (qualDown) throw new QualificationOff(); return new Map(mediaFills); },
};
const mediaFills = new Map<string, MediaFill>();   // D-73: newest approved media fill by master item id

const sig = (username: string) => ({ proof: proofFor(username) });
const now = () => new Date().toISOString();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const entry = (who: string, id: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${id}/entries`, body);
const hashOf = async (v: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${v}/versions`)).json().find((x: { id: number }) => x.id === v).contentHash;
const verify = async (v: number) => expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${v}/verify`, { ...sig('sup1'), contentHash: await hashOf(v) })).statusCode).toBe(200);
async function clean(id: number) {
  await verify((await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id);
}
const masterItem = (code: string, kind: MasterItem['kind'] = 'equipment', care = {}): MasterItem => {
  const m: MasterItem = { itemId: randomUUID(), code, name: `Name of ${code}`, version: 1, active: true, kind, room: kind === 'area' ? null : 'GRAN-1',
    make: 'Acme', model: 'X1', serial: 'S-1', needsCalibration: false, care: { ...NO_CARE, cleaningBasis: kind === 'area' ? 'operation' : null, ...care } };
  t.master.items_.set(code, m);
  return m;
};
const qualify = (m: MasterItem, status: QualStatus['status'] = 'qualified', nextReviewDue: string | null = day(365)) =>
  qual.set(m.itemId, { masterId: m.itemId, code: m.code, status, nextReviewDue });
// An item already in the Logbook, qualified, with the given master-data parameters.
async function item(care: object = {}, kind: MasterItem['kind'] = 'equipment') {
  const code = `RD-${++n}`;
  const id = await addItem(t, { code, kind, ...care });
  qualify(t.master.items_.get(code)!);
  return id;
}

beforeAll(async () => {
  t = await freshApp({ qualification: fakeQualification });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1']] as const) c[key] = (await login(t.app, u)).cookie;
  product = await addProduct(t, 'P1', 'Product 1');
  for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration', 'change_over', 'requalification', 'general_log']) await approve(type);
});
afterAll(() => t.close());

describe('adding an item by its ID (owner, point 4)', () => {
  it('PL-08: the ID list offers master items not yet in the Logbook; only qualified ones can be chosen; everything else is pulled', async () => {
    const ok = masterItem('AD-OK', 'equipment', { cleanHoldHours: 72, dirtyHoldHours: 8, pmFrequencyDays: 90 });
    const notQ = masterItem('AD-NQ');
    const unknown = masterItem('AD-UK');
    qualify(ok);
    qualify(notQ, 'not_qualified', null);
    const list = (await call(t.app, c.admin!, 'GET', '/api/equipment/candidates')).json();
    expect(list.qualificationLinked).toBe(true);
    const row = (code: string) => list.items.find((x: { code: string }) => x.code === code);
    expect(row('AD-OK')).toMatchObject({ name: 'Name of AD-OK', location: 'GRAN-1', make: 'Acme', cleanHoldHours: 72, dirtyHoldHours: 8, pmFrequencyDays: 90,
      qualification: 'qualified', selectable: true });
    expect(row('AD-NQ')).toMatchObject({ qualification: 'not_qualified', selectable: false });
    expect(row('AD-UK')).toMatchObject({ qualification: 'not_in_qualification', selectable: false });

    expect((await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: notQ.itemId, reason: 'r' })).json().error).toBe('not_qualified');
    expect((await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: unknown.itemId, reason: 'r' })).json().error).toBe('not_qualified');
    expect((await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: ok.itemId })).statusCode).toBe(400);   // reason required
    const added = await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: ok.itemId, reason: 'New granulator line' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ code: 'AD-OK', name: 'Name of AD-OK', location: 'GRAN-1', cleanHoldHours: 72, dirtyHoldHours: 8, pmFrequencyDays: 90 });
    expect((await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: ok.itemId, reason: 'again' })).json().error).toBe('code_taken');
    expect((await call(t.app, c.admin!, 'GET', '/api/equipment/candidates')).json().items.some((x: { code: string }) => x.code === 'AD-OK')).toBe(false);
    const [a] = await t.owner`select reason from audit_log where action = 'equipment.added' and object_id = ${String(added.json().id)}`;
    expect(a?.reason).toBe('New granulator line');
    expect((await call(t.app, c.op1!, 'POST', '/api/equipment', { itemId: ok.itemId, reason: 'x' })).statusCode).toBe(403);
  });

  it('PL-08 D-53: an instrument is calibrated, not qualified: it can be chosen and added without a qualification; its calibration decides its status', async () => {
    const ins = masterItem('AD-INS', 'instrument', { calibrationFrequencyDays: 180 });
    const row = (await call(t.app, c.admin!, 'GET', '/api/equipment/candidates')).json().items.find((x: { code: string }) => x.code === 'AD-INS');
    expect(row).toMatchObject({ kind: 'instrument', qualification: 'not_in_qualification', selectable: true });
    const added = await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: ins.itemId, reason: 'Filter integrity tester for the sterile filtration room' });
    expect(added.statusCode).toBe(201);
    // Equipment and rooms still need their qualification.
    const eq = masterItem('AD-EQ2');
    expect((await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: eq.itemId, reason: 'r' })).json().error).toBe('not_qualified');
    // Not qualified is never said of an instrument: no qualification blocker in its status.
    const s = (await call(t.app, c.qa!, 'GET', `/api/equipment/${added.json().id}/status`)).json();
    expect(s.blockers.join(' ')).not.toMatch(/qualif/i);
  });

  it('PL-08: a change of a hold time in master data shows at once; the Logbook keeps no copy', async () => {
    const id = await item({ cleanHoldHours: 24 });
    const code = `RD-${n}`;
    const m = t.master.items_.get(code)!;
    t.master.items_.set(code, { ...m, version: 2, care: { ...m.care, cleanHoldHours: 48 } });
    expect((await call(t.app, c.qa!, 'GET', '/api/equipment')).json().find((e: { id: number }) => e.id === id).cleanHoldHours).toBe(48);
  });
});

describe('dues from master data and the Qualification product (owner, slide 4 and point 8)', () => {
  it('LB-07: the cleaning holds come from master data: the dirty hold runs after use, the clean hold after cleaning', async () => {
    const id = await item({ dirtyHoldHours: 8, cleanHoldHours: 72 });
    await clean(id);
    expect((await status(id)).deadline).toMatchObject({ kind: 'clean_hold', hours: 72 });
    const use = (await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B1', data: { stage: 'S' } })).json().id;
    await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() });
    expect((await status(id))).toMatchObject({ state: 'dirty', deadline: { kind: 'dirty_hold', hours: 8, overdue: false } });
  });

  it('LB-06: preventive maintenance is due its frequency after the last verified PM (from the day the item was added before the first)', async () => {
    const id = await item({ pmFrequencyDays: 30 });
    let s = await status(id);
    expect(s.dues.filter((d: { kind: string }) => d.kind === 'pm')).toEqual([{ kind: 'pm', due: day(30), frequency: 'every 30 days', soon: false, overdue: false, dueFrom: day(25) }]);
    await t.owner`update equipment set created_at = now() - interval '40 days' where id = ${id}`;
    s = await status(id);
    expect(s.dues[0]).toMatchObject({ due: day(-10), overdue: true });
    expect(s.blockers.join(' ')).toMatch(/Preventive maintenance overdue since/);
    const pm = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), activityEnd: now(),
      data: { kind: 'preventive', description: 'Monthly PM per SOP-ENG-010', workDone: 'Lubricated, belts checked', partsNone: true }, signature: sig('eng1') })).json().id;
    await verify(pm);
    s = await status(id);
    expect(s.dues[0]).toMatchObject({ due: day(30), overdue: false });
    expect(s.blockers.join(' ')).not.toMatch(/Preventive maintenance/);
  });

  it('LB-06: an activity is "due" once 85 % of its allowed time has passed (owner 2026-11-13, D-41)', async () => {
    const id = await item({ pmFrequencyDays: 30 });
    await t.owner`update equipment set created_at = now() - interval '20 days' where id = ${id}`;   // 67 % passed
    expect((await status(id)).dues[0]).toMatchObject({ due: day(10), soon: false, overdue: false, dueFrom: day(5) });
    await t.owner`update equipment set created_at = now() - interval '26 days' where id = ${id}`;   // 87 % passed
    expect((await status(id)).dues[0]).toMatchObject({ due: day(4), soon: true, overdue: false });
  });

  it('LB-05: with a calibration frequency the item needs calibration, and the next one is due that long after the last verified pass', async () => {
    const id = await item({ calibrationFrequencyDays: 30 }, 'instrument');
    expect((await status(id)).state).toBe('not_calibrated');
    const cal = (await entry('eng1', id, { logbookType: 'calibration', activityStart: now(), activityEnd: now(),
      data: { result: 'pass', certificateRef: 'C-1', nextDue: day(365) }, signature: sig('eng1') })).json().id;
    await verify(cal);
    const s = await status(id);
    expect(s.calibrationDue).toBe(day(30));                                       // the frequency comes first
    expect(s.dues.filter((d: { kind: string }) => d.kind === 'calibration')).toEqual([{ kind: 'calibration', due: day(30), frequency: 'every 30 days', soon: false, overdue: false, dueFrom: day(25) }]);
  });

  it('LB-05: requalification due and status come from the Qualification product; overdue or not qualified blocks use', async () => {
    const id = await item({ requalificationFrequencyMonths: 12 });
    const m = t.master.items_.get(`RD-${n}`)!;
    await clean(id);
    qualify(m, 'qualified', day(10));
    let s = await status(id);
    expect(s.dues).toEqual([expect.objectContaining({ kind: 'requalification', due: day(10), frequency: 'every 12 months', soon: true, overdue: false })]);
    expect(s.qualification).toBe('qualified');
    qualify(m, 'qualified', day(-1));
    s = await status(id);
    expect(s).toMatchObject({ state: 'requalification_overdue', dues: [{ kind: 'requalification', overdue: true }] });
    const refused = await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B2', data: { stage: 'S' } });
    expect(refused.json().problems.join(' ')).toMatch(/Requalification overdue since/);
    qualify(m, 'requalification_needed', day(100));
    expect((await status(id)).blockers.join(' ')).toMatch(/Requalification needed/);
  });
});

describe('activities (owner, slides 1-3): change over, requalification, one activity at a time', () => {
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  it('LB-01: a change over is started, occupies the item, and is ended like a use', async () => {
    const id = await item();
    await clean(id);
    const co = await entry('op1', id, { logbookType: 'change_over', activityStart: now(), signature: sig('op1'),
      data: { fromProduct: 'P1', fromBatch: 'B1', toProduct: 'P2', toBatch: 'B9', remarks: 'Line change' } });
    expect(co.statusCode, co.body).toBe(201);
    const s = await status(id);
    expect(s.state).toBe('in_change_over');
    expect(s.blockers.join(' ')).toMatch(/Change over in progress/);
    // One activity at a time: no cleaning, use or calibration during the change over; a breakdown or a note is allowed.
    const cleaning = await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    expect(cleaning.json()).toMatchObject({ error: 'busy' });
    expect(cleaning.json().problems[0]).toMatch(/in change over since .* end that first/);
    expect((await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B9', data: { stage: 'S' } })).statusCode).toBe(409);
    expect((await entry('op1', id, { logbookType: 'general_log', activityStart: now(), data: { notes: 'Waiting for QA line clearance' } })).statusCode).toBe(201);
    expect((await call(t.app, c.op1!, 'POST', `/api/entries/${co.json().id}/complete`, { activityEnd: now() })).statusCode).toBe(200);
    expect((await status(id)).state).not.toBe('in_change_over');
  });

  it('LB-01: activities may not overlap in time on one item', async () => {
    const id = await item();
    await verify((await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: ago(20), activityEnd: ago(10), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id);
    const inside = await entry('eng1', id, { logbookType: 'calibration', activityStart: ago(15), activityEnd: ago(12),
      data: { result: 'pass', certificateRef: 'C', nextDue: day(30) }, signature: sig('eng1') });
    expect(inside.json()).toMatchObject({ error: 'busy' });
    expect(inside.json().problems[0]).toMatch(/overlaps another activity .*equipment cleaning/);
    expect((await entry('eng1', id, { logbookType: 'calibration', activityStart: ago(9), activityEnd: ago(8),
      data: { result: 'pass', certificateRef: 'C', nextDue: day(30) }, signature: sig('eng1') })).statusCode).toBe(201);
  });

  it('LB-02: a requalification from a protocol takes stage, result and next due date from the Qualification product', async () => {
    const id = await item({ requalificationFrequencyMonths: 12 });
    const m = t.master.items_.get(`RD-${n}`)!;
    qual.delete(m.itemId);
    protocols.push({ number: 'PRT-2026-0042', masterId: m.itemId, itemCode: m.code, stage: 'pq', step: 'closed', approvedAt: '2026-11-01',
      reportOutcome: 'pass', reportRelease: 'released', statusDecided: 'qualified', nextReviewDueDecided: day(365), reportApprovedAt: '2026-11-10' });
    protocols.push({ number: 'PRT-2026-0043', masterId: m.itemId, itemCode: m.code, stage: 'oq', step: 'executing', approvedAt: '2026-11-02',
      reportOutcome: null, reportRelease: null, statusDecided: null, nextReviewDueDecided: null, reportApprovedAt: null });
    const body = (data: object) => ({ logbookType: 'requalification', activityStart: now(), signature: sig('eng1'),
      data: { source: 'protocol', outcome: 'fail', ...data } });
    expect((await entry('eng1', id, body({ protocolNumber: 'PRT-2026-0043' }))).json().problems[0]).toMatch(/not approved yet/);
    expect((await entry('eng1', id, body({ protocolNumber: 'PRT-9999-0001' }))).json().problems[0]).toMatch(/not a protocol of/);
    const ok = await entry('eng1', id, body({ protocolNumber: 'PRT-2026-0042', stage: 'typed', nextDue: '2030-01-01' }));
    expect(ok.statusCode, ok.body).toBe(201);
    const [v] = (await call(t.app, c.qa!, 'GET', `/api/entries/${ok.json().id}/versions`)).json();
    expect(v.data).toMatchObject({ source: 'protocol', protocolNumber: 'PRT-2026-0042', stage: 'pq', outcome: 'pass', nextDue: day(365), reportRef: 'PRT-2026-0042' });
    expect((await entry('op1', id, body({ protocolNumber: 'PRT-2026-0042' }))).statusCode).toBe(403);   // operators do not record requalification
  });

  it('LB-02: a requalification written by hand needs its report number; once verified it gives the due date when Qualification has none', async () => {
    const id = await item({ requalificationFrequencyMonths: 12 });
    qual.delete(t.master.items_.get(`RD-${n}`)!.itemId);
    const manual = (data: object) => entry('eng1', id, { logbookType: 'requalification', activityStart: now(), signature: sig('eng1'),
      data: { source: 'manual', outcome: 'pass', doneBy: 'vendor', vendorName: 'Acme Validation', ...data } });
    expect((await manual({})).json().problems).toContain('Give the requalification report number.');
    const ok = await manual({ reportRef: 'VR-2026-118', nextDue: day(200) });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await status(id)).dues.some((d: { kind: string }) => d.kind === 'requalification')).toBe(false);   // not verified yet
    await verify(ok.json().id);
    expect((await status(id)).dues).toContainEqual(expect.objectContaining({ kind: 'requalification', due: day(200), frequency: 'every 12 months', soon: false, overdue: false }));
  });
});


describe('Qualification link down (D-70, owner 17 Nov 2026, G15)', () => {
  it('entries go on as if not linked, the status warns and a use is marked; adding an item and requalification wait for it', async () => {
    const id = await item({ requalificationFrequencyMonths: 12 });
    const waiting = masterItem('QD-NEW');
    qualify(waiting);
    qualDown = true;
    try {
      const s = await status(id);
      expect(s.warnings).toContain('Qualification not reachable: qualification not checked.');
      expect(s.qualification).toBeNull();
      // Cleaning, maintenance and use are recorded.
      await clean(id);
      const pm = await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), activityEnd: now(),
        data: { kind: 'preventive', description: 'PM', workDone: 'Done', partsNone: true }, signature: sig('eng1') });
      expect(pm.statusCode, pm.body).toBe(201);
      const use = await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'QD1', data: { stage: 'S' } });
      expect(use.statusCode, use.body).toBe(201);
      const [v] = (await call(t.app, c.qa!, 'GET', `/api/entries/${use.json().id}/versions`)).json();
      expect(v.data).toMatchObject({ qualNotChecked: 'Qualification was not reachable' });
      expect((await call(t.app, c.op1!, 'POST', `/api/entries/${use.json().id}/complete`, { activityEnd: now() })).statusCode).toBe(200);
      const today = day(0);
      expect((await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/period?fromDay=${today}&toDay=${today}`)).json().openItems.typedByHand).toBe(1);
      // Still waiting: adding an item and a requalification (by protocol or by hand).
      const add = await call(t.app, c.admin!, 'POST', '/api/equipment', { itemId: waiting.itemId, reason: 'New line' });
      expect(add.statusCode).toBe(503);
      expect(add.json().message).toBe('Connection to the Qualification system is off. Ask your administrator.');
      for (const data of [{ source: 'protocol', protocolNumber: 'PRT-2026-0042', outcome: 'pass' }, { source: 'manual', outcome: 'pass', reportRef: 'VR-1' }]) {
        const rq = await entry('eng1', id, { logbookType: 'requalification', activityStart: now(), signature: sig('eng1'), data });
        expect(rq.statusCode).toBe(503);
      }
    } finally {
      qualDown = false;
    }
    // Back up: no warning, no mark.
    expect((await status(id)).warnings).not.toContain('Qualification not reachable: qualification not checked.');
  });
});

describe('media fill of a sterile barrier, from Qualification (D-73, suite S8)', () => {
  const fill = (m: MasterItem, number: string, outcome: string, approvedDaysAgo: number, nextDue: string | null) =>
    mediaFills.set(m.itemId, { number, masterId: m.itemId, itemCode: m.code, outcome, approvedAt: new Date(Date.now() - approvedDaysAgo * 86_400_000).toISOString(), nextDue });
  const mfWarnings = (s: { warnings: string[] }) => s.warnings.filter((w: string) => /media fill/i.test(w));

  it('a barrier shows its or its room\'s newest approved media fill; none, failed or overdue is a warning only', async () => {
    const room = masterItem('RM-MF', 'area');
    const id = await item({ decontaminationValidDays: 7, gloveTestEveryDays: 7, location: 'RM-MF' });
    const code = `RD-${n}`;
    const machine = t.master.items_.get(code)!;
    // None approved: a warning naming the machine and its room.
    let s = await status(id);
    expect(s.mediaFill).toBeNull();
    expect(mfWarnings(s)).toEqual([`No approved media fill of ${code} or RM-MF in Qualification: no aseptic filling on this line until one has passed.`]);
    // Passed on the room, due later: shown, no warning, nothing blocked by it.
    fill(room, 'PRT-MF-1', 'pass', 2, day(180));
    s = await status(id);
    expect(s.mediaFill).toMatchObject({ number: 'PRT-MF-1', itemCode: 'RM-MF', outcome: 'pass', nextDue: day(180), overdue: false });
    expect(mfWarnings(s)).toEqual([]);
    expect(s.blockers.filter((b: string) => /media fill/i.test(b))).toEqual([]);
    // A newer one on the machine itself wins; overdue: a warning, still not a blocker.
    fill(machine, 'PRT-MF-2', 'pass', 1, day(-1));
    s = await status(id);
    expect(s.mediaFill).toMatchObject({ number: 'PRT-MF-2', overdue: true });
    expect(mfWarnings(s)).toEqual([expect.stringMatching(/^Media fill overdue since .* \(Qualification PRT-MF-2\): no aseptic filling on this line until it is repeated\.$/)]);
    expect(s.blockers.filter((b: string) => /media fill/i.test(b))).toEqual([]);
    // Failed.
    fill(machine, 'PRT-MF-3', 'fail', 0, day(30));
    expect(mfWarnings(await status(id))).toEqual([`The last media fill of ${code} or RM-MF failed (Qualification PRT-MF-3): no aseptic filling on this line until one has passed.`]);
    // Qualification down: not shown, the usual warning only.
    qualDown = true;
    try {
      s = await status(id);
      expect(s.mediaFill).toBeNull();
      expect(mfWarnings(s)).toEqual([]);
      expect(s.warnings).toContain('Qualification not reachable: qualification not checked.');
    } finally {
      qualDown = false;
    }
  });

  it('an item that is not a barrier shows no media fill, even with one on its room', async () => {
    const room = masterItem('RM-MF2', 'area');
    fill(room, 'PRT-MF-9', 'pass', 1, day(-5));
    const id = await item({ location: 'RM-MF2' });
    const s = await status(id);
    expect(s.mediaFill).toBeNull();
    expect(mfWarnings(s)).toEqual([]);
  });
});
