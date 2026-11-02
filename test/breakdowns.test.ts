import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, seedUser, type TestApp, proofFor } from './helpers.js';
import { breakdownStats, type Breakdown } from '../server/breakdowns.js';
import { changeLines } from '../server/changes.js';
import { runIntegrityCheck } from '../server/integrity.js';

// S9 (D-25): richer breakdown entries, equipment details, breakdown register and history card.

let t: TestApp;
const c: Record<string, string> = {};
let product: number;
let n = 0;

const sig = (username: string) => ({ proof: proofFor(username) });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const now = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const period = () => `fromDay=${new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}&toDay=${today()}`;

async function approve(type: string) {
  const settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: now() })).json().id;
  const versions = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions);
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: versions.find((v: { id: number }) => v.id === id).contentHash });
}
const newItem = async (body: object = {}) =>
  (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `BD-${++n}`, name: `Machine ${n}`, kind: 'equipment', location: 'Block A', ...body })).json().id as number;
const entry = (who: string, id: number, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${id}/entries`, body);
const status = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/status`)).json();
const latestOf = async (versionId: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${versionId}/versions`)).json().at(-1);
const signEntry = async (who: string, action: 'verify' | 'release', versionId: number) =>
  call(t.app, c[who]!, 'POST', `/api/entries/${versionId}/${action}`, { ...sig(who === 'qa' ? 'qa1' : who), contentHash: (await latestOf(versionId)).contentHash });
const register = async (query = '') => (await call(t.app, c.op1!, 'GET', `/api/breakdowns?${period()}${query}`)).json();

async function cleanAndVerify(id: number) {
  const e = (await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
  expect((await signEntry('sup1', 'verify', e)).statusCode).toBe(200);
}

const report = (extra: object = {}) => ({ kind: 'breakdown', description: 'Motor trips on start', occurredAt: ago(120), reportedBy: 'Shift A operator', failureCategory: 'electrical', ...extra });
const repairData = (extra: object = {}) => ({
  ...report(), rootCause: 'Worn contactor', workDone: 'Contactor replaced', parts: [{ name: 'Contactor', partNumber: 'LC1D18', quantity: 1, lotSerial: 'SN-4471' }],
  toolsUsed: 'Multimeter', doneBy: 'in_house', workOrderRef: 'WO-2026-118', postRepairChecks: 'Test run 10 min, no trips', ...extra,
});

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']], ['eng2', ['engineering']]] as const) {
    await seedUser(t.owner, u, [...roles]);
  }
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1'], ['eng2', 'eng2']] as const) c[key] = (await login(t.app, u)).cookie;
  await call(t.app, c.admin!, 'PUT', '/api/site', { name: 'Plant One', code: 'P1', reason: 'setup' });
  product = (await call(t.app, c.admin!, 'POST', '/api/products', { code: 'P1', name: 'Product 1' })).json().id;
  for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration']) await approve(type);
});
afterAll(() => t.close());

describe('breakdown entry (LB-02, LB-06)', () => {
  it('LB-02: a new breakdown needs when it occurred and the failure category', async () => {
    const id = await newItem();
    const res = await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'breakdown', description: 'Noise' }, signature: sig('eng1') });
    expect(res.json().problems).toEqual(['Give the date and time the breakdown occurred.', 'Choose the failure category.']);
  });

  it('LB-02: a finished repair states the parts used (or none) and who did it; a vendor is named', async () => {
    const id = await newItem();
    const base = { logbookType: 'maintenance', activityStart: ago(60), activityEnd: ago(10), signature: sig('eng1'), lateReason: 'after the repair' };
    expect((await entry('eng1', id, { ...base, data: report() })).json().problems).toEqual([
      'List the parts used, or tick "No parts used".', 'State who did the repair (in-house or external vendor).']);
    expect((await entry('eng1', id, { ...base, data: repairData({ partsNone: true }) })).json().problems).toContain('Either list the parts used or tick "No parts used", not both.');
    expect((await entry('eng1', id, { ...base, data: repairData({ doneBy: 'vendor' }) })).json().problems).toEqual(['Give the vendor name.']);
    expect((await entry('eng1', id, { ...base, data: repairData({ parts: [], partsNone: true, doneBy: 'vendor', vendorName: 'ACME Drives', serviceReportRef: 'SR-9' }) })).statusCode).toBe(201);
  });

  it('LB-02: parts rows are typed and limited', async () => {
    const id = await newItem();
    const base = { logbookType: 'maintenance', activityStart: ago(5), activityEnd: now(), signature: sig('eng1') };
    expect((await entry('eng1', id, { ...base, data: repairData({ parts: [{ name: 'Seal', quantity: 0 }] }) })).json().error).toBe('invalid_data');
    expect((await entry('eng1', id, { ...base, data: repairData({ parts: [{ name: '', quantity: 1 }] }) })).json().error).toBe('invalid_data');
    expect((await entry('eng1', id, { ...base, data: repairData({ failureCategory: 'gremlins' }) })).json().error).toBe('invalid_data');
    expect((await entry('eng1', id, { ...base, data: repairData({ parts: Array.from({ length: 51 }, () => ({ name: 'Bolt', quantity: 1 })) }) })).json().error).toBe('invalid_data');
  });

  it('LB-10: occurred <= repair start <= repair end <= now', async () => {
    const id = await newItem();
    const sign = sig('eng1');
    const after = await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(10), activityEnd: now(), data: repairData({ occurredAt: ago(5) }), signature: sign });
    expect(after.json().problems).toEqual(['The breakdown cannot have occurred after the repair started.']);
    const backwards = await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(5), activityEnd: ago(10), data: repairData(), signature: sign });
    expect(backwards.json().problems).toEqual(['The end cannot be before the start.']);
    const future = await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(5), activityEnd: new Date(Date.now() + 3_600_000).toISOString(), data: repairData(), signature: sign });
    expect(future.json().error).toBe('future_time');
  });

  it('LB-06: a reported breakdown is open until its repair is completed, signed by the performer', async () => {
    const id = await newItem();
    await cleanAndVerify(id);
    const bd = (await entry('op1', id, { logbookType: 'maintenance', activityStart: now(), data: report({ occurredAt: ago(3) }), signature: sig('op1') })).json().id;
    expect((await status(id)).state).toBe('out_of_service');
    expect((await signEntry('sup1', 'verify', bd)).json().error).toBe('not_finished');
    expect((await register(`&equipmentId=${id}`)).items[0].status).toBe('open');

    // Completing needs the performer's signature and cannot change what was reported.
    const complete = (data: object, signature?: object) => call(t.app, c.eng1!, 'POST', `/api/entries/${bd}/complete`, { activityEnd: now(), data, signature });
    expect((await complete(repairData({ occurredAt: ago(3) }))).json().error).toBe('signature_required');
    expect((await complete({ ...repairData({ occurredAt: ago(3) }), failureCategory: 'mechanical' }, sig('eng1'))).json().problems[0]).toMatch(/cannot change what was reported/);
    const reported = (await latestOf(bd)).data;
    const done = await complete({ ...repairData(), occurredAt: reported.occurredAt }, sig('eng1'));
    expect(done.statusCode).toBe(200);
    const v2 = await latestOf(bd);
    expect(v2.change).toBe('completed');
    expect(v2.signatures.map((s: { meaning: string }) => s.meaning)).toEqual(['performed']);
    expect(v2.data.parts[0]).toMatchObject({ name: 'Contactor', partNumber: 'LC1D18', quantity: 1 });
    expect((await status(id)).state).toBe('out_of_service');

    // The repairer cannot verify; a supervisor does, then QA releases.
    expect((await signEntry('eng1', 'verify', v2.id)).statusCode).toBe(403);
    expect((await signEntry('sup1', 'verify', v2.id)).statusCode).toBe(200);
    expect((await register(`&equipmentId=${id}`)).items[0].status).toBe('awaiting_release');
    expect((await signEntry('qa', 'release', v2.id)).statusCode).toBe(200);
    expect((await status(id)).state).toBe('clean');
  });

  it('LB-17: an open repair is completed, not ended by a correction', async () => {
    const id = await newItem();
    const bd = (await entry('op1', id, { logbookType: 'maintenance', activityStart: now(), data: report({ occurredAt: ago(3) }), signature: sig('op1') })).json().id;
    const v = await latestOf(bd);
    const res = await call(t.app, c.op1!, 'POST', `/api/entries/${bd}/correct`, { activityStart: v.activityStart, activityEnd: now(), data: v.data, reason: 'x', signature: sig('op1') });
    expect(res.json().problems).toEqual(['Complete the repair with "Complete repair", not by a correction.']);
  });

  it('LB-05: a repair that needs re-calibration blocks use until a verified passed calibration after it', async () => {
    const id = await newItem({ needsCalibration: true });
    await cleanAndVerify(id);
    await signEntry('qa', 'verify', (await entry('eng2', id, { logbookType: 'calibration', activityStart: ago(30), lateReason: 'x', data: { result: 'pass', nextDue: '2099-01-01' }, signature: sig('eng2') })).json().id);
    expect((await status(id)).blockers).toEqual([]);
    const bd = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(20), activityEnd: ago(1), data: repairData({ recalibrationNeeded: true }), signature: sig('eng1') })).json().id;
    await signEntry('sup1', 'verify', bd);
    await signEntry('qa', 'release', bd);
    const s = await status(id);
    expect(s.blockers).toEqual([expect.stringMatching(/^Re-calibration needed after the repair of \d{4}-\d{2}-\d{2}/)]);
    const cal = (await entry('eng2', id, { logbookType: 'calibration', activityStart: now(), data: { result: 'pass', nextDue: '2099-01-01' }, signature: sig('eng2') })).json().id;
    expect((await status(id)).blockers).toHaveLength(1);
    await signEntry('qa', 'verify', cal);
    expect((await status(id)).blockers).toEqual([]);
  });

  it('LB-05: on an item not calibrated in the logbook, a re-calibration request is a warning, not a block that cannot be cleared', async () => {
    const id = await newItem({ needsCalibration: false });
    await cleanAndVerify(id);
    const bd = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(20), activityEnd: ago(1), data: repairData({ recalibrationNeeded: true }), signature: sig('eng1') })).json().id;
    await signEntry('sup1', 'verify', bd);
    await signEntry('qa', 'release', bd);
    const s = await status(id);
    expect(s.blockers).toEqual([]);
    expect(s.warnings).toEqual([expect.stringMatching(/asked for re-calibration/)]);
  });

  it('LB-10: only an open repair can be completed, and that is checked before the password', async () => {
    const id = await newItem();
    const done = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(5), activityEnd: now(), data: repairData(), signature: sig('eng1') })).json().id;
    const res = await call(t.app, c.eng1!, 'POST', `/api/entries/${done}/complete`, { activityEnd: now(), data: repairData(), signature: { proof: 'not-a-proof' } });
    expect(res.json().error).toBe('not_open');
    expect(await t.owner`select 1 from audit_log where action = 'signature.failed' and object_id = ${String(done)}`).toHaveLength(0);
  });

  it('LB-05: areas cannot ask for re-calibration', async () => {
    const id = await newItem({ kind: 'area' });
    const res = await entry('eng1', id, { logbookType: 'maintenance', activityStart: ago(5), activityEnd: now(), data: repairData({ recalibrationNeeded: true }), signature: sig('eng1') });
    expect(res.json().problems).toContain('Areas are not calibrated: untick "Re-calibration needed".');
  });

  it('LB-02: a breakdown recorded before S9 stays valid, shows in the register and can be corrected without the new fields', async () => {
    const id = await newItem();
    const [s] = await t.owner`select settings_id from entries where logbook_type = 'maintenance' limit 1`;
    const [eng] = await t.owner`select id from users where username = 'eng1'`;
    const [row] = await t.sql`insert into entries (equipment_id, logbook_type, settings_id, version, change, activity_start, activity_end, data, entered_by)
      values (${id}, 'maintenance', ${s!.settings_id}, 1, 'created', now() - interval '2 hours', now() - interval '1 hour',
              ${t.sql.json({ kind: 'breakdown', description: 'Old style', workDone: 'Fixed', impactAssessment: '' })}, ${eng!.id}) returning id::int`;
    await t.owner`insert into audit_log (actor_id, action, object_type, object_id) values (${eng!.id}, 'entry.created', 'entry', ${String(row!.id)})`;
    const item = (await register(`&equipmentId=${id}`)).items[0];
    expect(item).toMatchObject({ description: 'Old style', failureCategory: null, partsText: '', status: 'awaiting_verification' });
    expect(item.occurredAt).toBe(item.repairStart);
    const v = await latestOf(row!.id);
    const res = await call(t.app, c.eng1!, 'POST', `/api/entries/${row!.id}/correct`, {
      activityStart: v.activityStart, activityEnd: v.activityEnd, data: { ...v.data, workDone: 'Fixed the belt' }, reason: 'clarified', signature: sig('eng1'), lateReason: 'old record' });
    expect(res.statusCode).toBe(200);
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([]);
  });
});

describe('breakdown register (LB-02, LB-22)', () => {
  it('LB-02: one row per breakdown with downtime from occurrence to QA release, filters and sort', async () => {
    const a = await newItem({ location: 'Block B' });
    const b = await newItem({ location: 'Block B' });
    const bdA = (await entry('eng1', a, { logbookType: 'maintenance', activityStart: ago(100), activityEnd: ago(10), lateReason: 'after repair', data: repairData({ occurredAt: ago(180) }), signature: sig('eng1') })).json().id;
    await signEntry('sup1', 'verify', bdA);
    await signEntry('qa', 'release', bdA);
    await entry('eng1', b, { logbookType: 'maintenance', activityStart: ago(20), activityEnd: ago(5), data: repairData({ occurredAt: ago(30), failureCategory: 'utility' }), signature: sig('eng1') });

    const all = await register('&location=Block%20B&sort=downtime');
    expect(all.items.map((i: { code: string }) => i.code)).toEqual([`BD-${n - 1}`, `BD-${n}`]);
    const first = all.items[0];
    expect(first.status).toBe('released');
    expect(first.downtimeFinal).toBe(true);
    expect(first.downtimeMinutes).toBeGreaterThanOrEqual(179);
    expect(first.downtimeMinutes).toBeLessThanOrEqual(181);
    expect(first.partsText).toBe('1 × Contactor (P/N LC1D18), lot/SN SN-4471');
    expect(first.workDone).toBe('Contactor replaced');
    expect(first.doneBy).toBe('In-house');
    expect(first.workOrderRef).toBe('WO-2026-118');
    expect(all.items[1]).toMatchObject({ status: 'awaiting_verification', downtimeFinal: false, failureCategory: 'utility' });
    expect((await register('&location=Block%20B&category=utility')).items).toHaveLength(1);
    expect((await register('&location=Block%20B&status=released')).items).toHaveLength(1);
    expect((await register(`&equipmentId=${b}`)).items).toHaveLength(1);
    expect(all.stats.categories).toEqual([{ category: 'electrical', failures: 1 }, { category: 'utility', failures: 1 }]);
    // The status filter narrows the rows, not the statistics (review S9).
    expect((await register('&location=Block%20B&status=released')).stats).toEqual(all.stats);
    const statsA = all.stats.machines.find((m: { equipmentId: number }) => m.equipmentId === a);
    expect(statsA.failures).toBe(1);
    expect(statsA.mttrHours).toBe(3);
  });

  it('LB-02: MTTR and MTBF are computed from the records', () => {
    const h = 3_600_000;
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-11T00:00:00Z');
    const bd = (occurred: number, released: number | null): Breakdown => ({
      equipmentId: 1, code: 'M1', name: 'M', occurredAt: new Date(from.getTime() + occurred * h), releasedAt: released === null ? null : new Date(from.getTime() + released * h),
      downtimeMinutes: released === null ? 0 : (released - occurred) * 60, downtimeFinal: released !== null, failureCategory: 'mechanical',
    }) as Breakdown;
    // 240 h window, two failures: 4 h and 8 h down.
    const { machines } = breakdownStats([bd(10, 14), bd(100, 108)], from, to, new Date('2027-01-01'), new Map());
    expect(machines[0]).toMatchObject({ failures: 2, downtimeHours: 12, mttrHours: 6, mtbfHours: 114 });
    // Installed on day 5: the window is 144 h.
    const late = breakdownStats([bd(100, 108)], from, to, new Date('2027-01-01'), new Map([[1, new Date(from.getTime() + 96 * h)]]));
    expect(late.machines[0]).toMatchObject({ failures: 1, mtbfHours: 136 });
    // Overlapping breakdowns count their downtime once: 10–20 h and 15–30 h are 20 h down.
    const overlap = breakdownStats([bd(10, 20), bd(15, 30)], from, to, new Date('2027-01-01'), new Map());
    expect(overlap.machines[0]).toMatchObject({ downtimeHours: 20, mtbfHours: 110 });
    // An unreleased breakdown counts as down until now and has no MTTR yet.
    const open = breakdownStats([bd(230, null)], from, to, new Date(from.getTime() + 235 * h), new Map());
    expect(open.machines[0]).toMatchObject({ downtimeHours: 5, mttrHours: null, mtbfHours: 230 });
  });

  it('LB-22: the register exports as CSV and PDF', async () => {
    const csv = await call(t.app, c.op1!, 'GET', `/api/export/breakdowns.csv?${period()}&location=Block%20B`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toContain('"1 × Contactor (P/N LC1D18), lot/SN SN-4471"');
    expect(csv.body.split('\r\n')[0]).toContain('"downtime_minutes"');
    const pdf = await call(t.app, c.op1!, 'GET', `/api/export/breakdowns.pdf?${period()}`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('equipment details (LB-18)', () => {
  const details = (extra: object = {}) => ({ assetNumber: 'AST-001', manufacturer: 'Glatt', model: 'GPCG 60', serialNumber: 'G-7781', capacity: '60 kg',
    installationDate: '2024-03-01', supplier: 'Glatt India', qualificationStatus: 'qualified', iq: { date: '2024-03-10', ref: 'IQ-11' },
    oq: { date: '2024-03-20', ref: 'OQ-11' }, pq: { date: '2024-04-05', ref: 'PQ-11' }, lastRequalification: null, productContactMoc: 'SS316L', sopRefs: 'SOP-FBD-01', ...extra });
  const put = (who: string, id: number, body: object) => call(t.app, c[who]!, 'PUT', `/api/equipment/${id}/details`, body);

  it('LB-18: only Admin edits details, every change needs a reason and keeps the old version', async () => {
    const id = await newItem();
    expect((await put('qa', id, { details: details(), reason: 'x', expectedVersion: 0 })).statusCode).toBe(403);
    expect((await put('admin', id, { details: details(), expectedVersion: 0 })).statusCode).toBe(400);
    expect((await put('admin', id, { details: details(), reason: 'Initial record', expectedVersion: 0 })).json()).toEqual({ version: 1 });
    expect((await put('admin', id, { details: details(), reason: 'again', expectedVersion: 1 })).json().error).toBe('no_change');
    expect((await put('admin', id, { details: details({ serialNumber: 'G-7782' }), reason: 'Typo', expectedVersion: 0 })).json().error).toBe('changed_meanwhile');
    expect((await put('admin', id, { details: details({ serialNumber: 'G-7782' }), reason: 'Serial plate re-read', expectedVersion: 1 })).json()).toEqual({ version: 2 });
    const card = (await call(t.app, c.op1!, 'GET', `/api/equipment/${id}/details`)).json();
    expect(card.details).toMatchObject({ version: 2, reason: 'Serial plate re-read', changedBy: 'ADMIN' });
    expect(card.detailsVersions.map((v: { details: { serialNumber: string } }) => v.details.serialNumber)).toEqual(['G-7781', 'G-7782']);
    const [a] = await t.owner`select old_value, new_value, reason from audit_log where action = 'equipment.details_updated' and object_id = ${String(id)} order by id desc limit 1`;
    expect(a!.old_value.details.serialNumber).toBe('G-7781');
    expect(a!.new_value.details.serialNumber).toBe('G-7782');
    await expect(t.sql`update equipment_details set reason = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from equipment_details`).rejects.toThrow(/permission denied/);
  });

  it('LB-18: details are checked: dates not in the future, IQ before OQ before PQ, unknown fields refused', async () => {
    const id = await newItem();
    expect((await put('admin', id, { details: details({ installationDate: '2999-01-01' }), reason: 'x', expectedVersion: 0 })).json().problems).toEqual(['Installation date cannot be in the future.']);
    expect((await put('admin', id, { details: details({ oq: { date: '2024-03-01', ref: '' } }), reason: 'x', expectedVersion: 0 })).json().problems).toEqual(['OQ cannot be dated before IQ.']);
    expect((await put('admin', id, { details: details({ pq: { date: null, ref: '' } }), reason: 'x', expectedVersion: 0 })).json().problems).toEqual(['Qualified equipment needs a PQ date.']);
    expect((await put('admin', id, { details: { ...details(), cost: 100 }, reason: 'x', expectedVersion: 0 })).statusCode).toBe(400);
  });

  it('LB-18: moves are recorded as location history', async () => {
    const id = await newItem({ location: 'Block A' });
    await call(t.app, c.admin!, 'PATCH', `/api/equipment/${id}`, { location: 'Block C', reason: 'Moved for line 3' });
    await call(t.app, c.admin!, 'PATCH', `/api/equipment/${id}`, { name: 'Renamed', reason: 'name' });
    const card = (await call(t.app, c.op1!, 'GET', `/api/equipment/${id}/details`)).json();
    expect(card.locationHistory.map((l: { from: string | null; to: string; reason: string | null }) => [l.from, l.to, l.reason])).toEqual([
      [null, 'Block A', null], ['Block A', 'Block C', 'Moved for line 3']]);
  });

  it('LB-23: the integrity check covers details versions and their audit rows', async () => {
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([]);
    const id = await newItem();
    const [admin] = await t.owner`select id from users where username = 'admin'`;
    await t.owner`insert into equipment_details (equipment_id, version, details, reason, changed_by) values (${id}, 1, '{}', 'behind the back', ${admin!.id})`;
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([`Equipment ${id}: details version 1 has no audit row.`]);
    await t.owner`delete from equipment_details where equipment_id = ${id}`;
  });
});

describe('history card (LB-01, LB-22)', () => {
  it('LB-01: the history card shows the whole past of an item in order, with breakdowns, master data and filters', async () => {
    const id = await newItem();
    await call(t.app, c.admin!, 'PUT', `/api/equipment/${id}/details`, { details: { assetNumber: 'AST-9' }, reason: 'Initial record', expectedVersion: 0 });
    await cleanAndVerify(id);
    const use = (await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-HC-1', data: { stage: 'Mixing' } })).json().id;
    await call(t.app, c.op1!, 'POST', `/api/entries/${use}/complete`, { activityEnd: now() });
    const bd = (await entry('eng1', id, { logbookType: 'maintenance', activityStart: now(), activityEnd: now(), data: repairData({ occurredAt: ago(1) }), signature: sig('eng1') })).json().id;
    await signEntry('sup1', 'verify', bd);
    await signEntry('qa', 'release', bd);

    const h = (await call(t.app, c.op1!, 'GET', `/api/equipment/${id}/history?${period()}`)).json();
    expect(h.details.details.assetNumber).toBe('AST-9');
    expect(h.status.state).toBe('dirty');
    const kinds = h.events.map((e: { kind: string; entry?: { logbookType: string; version: number } }) => (e.entry ? `${e.entry.logbookType} v${e.entry.version}` : e.kind));
    expect(kinds).toEqual(expect.arrayContaining(['masterdata', 'equipment_cleaning v1', 'equipment_use v1', 'equipment_use v2', 'maintenance v1']));
    const times = h.events.map((e: { at: string }) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const breakdown = h.events.find((e: { breakdown?: unknown }) => e.breakdown).breakdown;
    expect(breakdown).toMatchObject({ parts: '1 × Contactor (P/N LC1D18), lot/SN SN-4471', status: 'Released' });
    expect(breakdown.downtime).toMatch(/^0 h [0-9]+ min$/);

    const only = (await call(t.app, c.op1!, 'GET', `/api/equipment/${id}/history?${period()}&types=maintenance`)).json();
    expect(only.events.map((e: { kind: string }) => e.kind)).toEqual(['entry']);
  });

  it('LB-22: the history card exports as CSV and PDF', async () => {
    const id = n;
    const csv = await call(t.app, c.op1!, 'GET', `/api/export/history.csv?equipmentId=${id}&${period()}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('"maintenance"');
    expect(csv.body).toContain('Downtime 0 h');
    const pdf = await call(t.app, c.op1!, 'GET', `/api/export/history.pdf?equipmentId=${id}&${period()}`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('master-data changes in words (S11)', () => {
  it('LB-18: the history card lists what changed, not the stored JSON', () => {
    expect(changeLines(null, { id: 5, code: 'CAP-A-CFM', name: 'Capsule filler', kind: 'equipment', location: 'Line A', sterile: false, cleanHoldHours: 72 }))
      .toEqual(['ID: CAP-A-CFM', 'Name: Capsule filler', 'Type: equipment', 'Location: Line A', 'Sterile: no', 'Clean-hold (hours): 72']);
    expect(changeLines({ code: 'X', location: 'Line A', sterile: false }, { code: 'X', location: 'Line B', sterile: true }))
      .toEqual(['Location: Line A → Line B', 'Sterile: no → yes']);
    expect(changeLines({ version: 1, details: { model: 'VC-200', iq: { date: '2019-06-12', ref: 'IQ-1' }, qualificationStatus: 'qualified' } },
      { id: 9, version: 2, details: { model: 'VC-250', iq: { date: '2019-06-12', ref: 'IQ-1' }, qualificationStatus: 'requalification_due' } }))
      .toEqual(['Model: VC-200 → VC-250', 'Qualification: qualified → requalification due']);
    expect(changeLines(null, { id: 9, version: 1, details: { model: 'VC-200', serialNumber: '', pq: { date: '2019-07-15', ref: 'PQ-1' } } }))
      .toEqual(['Model: VC-200', 'PQ: 2019-07-15, PQ-1']);
  });
});

describe('printed records (S13)', () => {
  it('LB-22: stored values print as labelled lines, identifiers exactly as stored, no JSON', async () => {
    const { recordLines } = await import('../server/changes.js');
    const lines = recordLines({ contentHash: 'ab_cd', requestIds: { transcribe: '20261030_1b0c' }, data: { workDone: 'Seal replaced', partsNone: true }, cleaningType: 'product_change' });
    expect(lines).toEqual(['Content fingerprint (SHA-256): ab_cd', 'Service request IDs:', '  Transcription: 20261030_1b0c', 'Entry data:', '  Work done: Seal replaced', '  No parts used: yes', 'Cleaning: product change']);
  });
});
