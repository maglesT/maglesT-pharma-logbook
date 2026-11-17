import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, changeItem, freshApp, login, seedUser, type TestApp, proofFor, addItem , addProduct } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
let autoclave: number;
let isolator: number;
let room: number;
let nonSterile: number;
let n = 0;

const sig = (username: string) => ({ proof: proofFor(username) });
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

// A verified passed steriliser test, needed before steam cycles (D-22).
async function passedTest(eq: number, kind: 'leak' | 'air_removal' = 'air_removal') {
  const id = (await test(eq, kind, 'pass')).json().id;
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json()[0];
  expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
}

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  const eq = async (body: object) => (await addItem(t, { code: `S-${++n}`, name: 'Item', ...body })) as number;
  autoclave = await eq({ kind: 'equipment', sterile: true });
  isolator = await eq({ kind: 'equipment', sterile: true, decontaminationValidDays: 7, gloveTestEveryDays: 7 });
  room = await eq({ kind: 'area', sterile: true, classified: true });
  nonSterile = await eq({ kind: 'equipment' });
  for (const type of ['steriliser_cycle', 'steriliser_test', 'glove_integrity']) await approve(type);
  await approve('pressure_reading', { pressurePoints: [{ name: 'Filling B / corridor', critical: false, ccsRef: 'CCS-4.2', min: 10, max: 30, unit: 'Pa' }] });
  await passedTest(autoclave);
  await passedTest(isolator);
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
    const ac = (await addItem(t, { code: `AC-${++n}`, name: 'Autoclave 2', kind: 'equipment', sterile: true }));
    expect((await test(ac, 'leak', 'fail')).statusCode).toBe(201);
    const s = await status(ac);
    expect(s.state).toBe('out_of_service');
    expect(s.blockers[0]).toMatch(/leak test failed/);
    expect((await cycle(ac, 'C-1')).json().error).toBe('not_fit_for_use');
    // An unverified pass does not clear the failure (review S6-2); a verified one does.
    await test(ac, 'leak', 'pass');
    expect((await status(ac)).blockers.some((b: string) => /leak/.test(b))).toBe(true);
    expect((await cycle(ac, 'C-1')).statusCode).toBe(409);
    const [latest] = (await call(t.app, c.qa!, 'GET', `/api/equipment/${ac}/entries`)).json();
    await call(t.app, c.sup1!, 'POST', `/api/entries/${latest.id}/verify`, { ...sig('sup1'), contentHash: latest.contentHash });
    expect((await status(ac)).blockers.some((b: string) => /leak/.test(b))).toBe(false);
    expect((await cycle(ac, 'C-1')).statusCode).toBe(201);
  });

  it('LB-12: each test type is judged on its own latest result', async () => {
    const ac = (await addItem(t, { code: `AC-${++n}`, name: 'Autoclave 3', kind: 'equipment', sterile: true }));
    await test(ac, 'air_removal', 'fail');
    await passedTest(ac, 'leak');
    const s = await status(ac);
    expect(s.blockers).toHaveLength(1);
    expect(s.blockers[0]).toMatch(/air-removal/);
  });
});

describe('glove integrity (LB-15)', () => {
  it('LB-15: a failed glove test on a port blocks the isolator until that port passes', async () => {
    const res = await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'P3', method: 'pressure decay', result: 'fail', comment: 'Pinhole', deviationRef: 'DV-5' } });
    expect(res.statusCode).toBe(201);
    expect((await status(isolator)).blockers).toContain('Glove integrity failed on port P3: replace and pass before use.');
    await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'P4', result: 'pass' } });
    expect((await status(isolator)).blockers.some((b: string) => /P3/.test(b))).toBe(true);
    await entry('op1', isolator, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'P3', result: 'pass' } });
    expect((await status(isolator)).blockers.some((b: string) => /Glove/.test(b))).toBe(false);
  });
});

describe('sterile status for TrueBatch Injectables (D-50)', () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  async function verify(id: number) {
    const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json()[0];
    expect((await call(t.app, c.sup1!, 'POST', `/api/entries/${id}/verify`, { ...sig('sup1'), contentHash: v.contentHash })).statusCode).toBe(200);
  }
  const late = { lateReason: 'entered from the paper record' };

  it('LB-12: a steriliser is fit only with a verified passed test within its validity (default: today)', async () => {
    const ac = await addItem(t, { code: `AC-${++n}`, name: 'Autoclave D-50', kind: 'equipment', sterile: true });
    const old = await entry('op1', ac, { logbookType: 'steriliser_test', activityStart: daysAgo(2), data: { test: 'air_removal', result: 'pass' }, signature: sig('op1'), ...late });
    expect(old.statusCode, old.body).toBe(201);
    await verify(old.json().id);
    let s = await status(ac);
    expect(s.state).toBe('sterile_expired');
    expect(s.blockers.some((b: string) => /^Steriliser test overdue since .*: pass a leak or air-removal test before use\.$/.test(b))).toBe(true);
    // The test is how it is renewed: not a cycle blocker.
    expect(s.cycleBlockers.some((b: string) => /Steriliser test/.test(b))).toBe(false);
    await passedTest(ac);
    s = await status(ac);
    expect(s.blockers).toEqual([]);
    expect(s.sterileValidUntil).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
    expect(s.sterileDues).toEqual([{ kind: 'steriliser_test', until: s.sterileValidUntil, overdue: false }]);
  });

  it('LB-15: an isolator is fit only with a verified passed VHP decontamination and every glove port tested within the days its qualification set in master data (D-51)', async () => {
    const code = `IS-${++n}`;
    const iso = await addItem(t, { code, name: 'Isolator D-51', kind: 'equipment', sterile: true, decontaminationValidDays: 7, gloveTestEveryDays: 7 });
    const vhp = (start: string, id: string, extra: object = {}) => entry('op1', iso, { logbookType: 'steriliser_cycle', activityStart: start, activityEnd: start,
      data: { cycleType: 'vhp', cycleId: id, programme: 'VHP-2', load: 'Empty chamber', result: 'pass', controllerRecordRef: `ISO-${id}` }, signature: sig('op1'), ...extra });
    const old = await vhp(daysAgo(8), 'V-1', late);
    expect(old.statusCode, old.body).toBe(201);
    await verify(old.json().id);
    expect((await entry('op1', iso, { logbookType: 'glove_integrity', activityStart: daysAgo(8), signature: sig('op1'), data: { port: 'G1', result: 'pass' }, ...late })).statusCode).toBe(201);
    expect((await entry('op1', iso, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'G2', result: 'pass' } })).statusCode).toBe(201);
    let s = await status(iso);
    expect(s.state).toBe('sterile_expired');
    expect(s.blockers.filter((b: string) => /^(Decontamination \(VHP\)|Glove test) overdue since/.test(b))).toHaveLength(2);
    expect(s.sterileDues.map((d: { kind: string; overdue: boolean }) => [d.kind, d.overdue])).toEqual([['decontamination', true], ['glove_test', true]]);
    // A new decontamination counts only once verified.
    const fresh = await vhp(now(), 'V-2');
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect((await status(iso)).blockers.some((b: string) => /Decontamination/.test(b))).toBe(true);
    await verify(fresh.json().id);
    s = await status(iso);
    expect(s.blockers.some((b: string) => /Decontamination/.test(b))).toBe(false);
    expect(s.blockers.some((b: string) => /Glove test overdue/.test(b))).toBe(true);
    // A new qualification sets a longer glove-test interval in master data (a new version): read at once.
    changeItem(t, code, { care: { ...t.master.items_.get(code)!.care, gloveTestEveryDays: 10 } });
    s = await status(iso);
    expect(s.blockers).toEqual([]);
    // D-64: each check's last valid day, shown on the item page while fit.
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    expect(s.sterileDues).toEqual([{ kind: 'decontamination', until: day(6), overdue: false }, { kind: 'glove_test', until: day(1), overdue: false }]);
    expect(new Date(s.lastDecontamination).getTime()).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it('D-65: an isolator with timings in master data and no decontamination or glove test ever recorded is not fit until its first verified pass', async () => {
    const iso = await addItem(t, { code: `IS-${++n}`, name: 'Isolator, never decontaminated', kind: 'equipment', sterile: true, decontaminationValidDays: 7, gloveTestEveryDays: 7 });
    const s = await status(iso);
    expect(s.state).toBe('sterile_expired');
    expect(s.blockers).toEqual([
      'Decontamination (VHP): no verified pass on record: decontaminate before first use.',
      'Glove test: no glove test on record: test every glove port before first use.']);
    // An unverified decontamination does not count; a verified one and a passed glove test make it fit.
    const vhp = await entry('op1', iso, { logbookType: 'steriliser_cycle', activityStart: now(), activityEnd: now(),
      data: { cycleType: 'vhp', cycleId: 'V-65', programme: 'VHP-2', load: 'Empty chamber', result: 'pass', controllerRecordRef: 'ISO-V-65' }, signature: sig('op1') });
    expect(vhp.statusCode, vhp.body).toBe(201);
    expect((await status(iso)).blockers).toContain('Decontamination (VHP): no verified pass on record: decontaminate before first use.');
    await verify(vhp.json().id);
    expect((await entry('op1', iso, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'G1', result: 'pass' } })).statusCode).toBe(201);
    expect((await status(iso)).blockers).toEqual([]);
    // An item without those timings is unchanged: fit with no sterile record.
    const plain = await addItem(t, { code: `IS-${++n}`, name: 'Sterile item, no timings', kind: 'equipment', sterile: true });
    expect((await status(plain)).blockers.filter((b: string) => /Decontamination|Glove/.test(b))).toEqual([]);
  });

  it('LB-15: an isolator whose timings are not set in master data is not fit; nothing is assumed (D-51)', async () => {
    const iso = await addItem(t, { code: `IS-${++n}`, name: 'Isolator, timings not set', kind: 'equipment', sterile: true });
    expect((await entry('op1', iso, { logbookType: 'glove_integrity', activityStart: now(), signature: sig('op1'), data: { port: 'G1', result: 'pass' } })).statusCode).toBe(201);
    const s = await status(iso);
    expect(s.state).toBe('sterile_expired');
    expect(s.blockers).toEqual(['Glove test: its validity is not set in master data ("Glove test every (days)", from the qualification): not fit for use until it is.']);
  });
});

describe('pressure readings (LB-16)', () => {
  it('LB-16: readings are taken only at approved non-critical points', async () => {
    const res = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), signature: sig('op1'), data: { point: 'Unknown point', value: 15 } });
    expect(res.json().problems[0]).toMatch(/Unknown pressure point/);
  });

  it('LB-16: an out-of-limit reading is flagged and needs a comment and deviation reference', async () => {
    const bad = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), signature: sig('op1'), data: { point: 'Filling B / corridor', value: 4 } });
    expect(bad.json().problems[0]).toMatch(/outside 10–30 Pa/);
    const ok = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), signature: sig('op1'), data: { point: 'Filling B / corridor', value: 4, comment: 'Door left open', deviationRef: 'DV-12' } });
    expect(ok.statusCode).toBe(201);
    const [v] = (await call(t.app, c.qa!, 'GET', `/api/entries/${ok.json().id}/versions`)).json();
    expect(v.data.outOfLimit).toBe(true);
    expect((await status(room)).warnings).toContain('Last pressure reading out of limits: Filling B / corridor.');
    await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), signature: sig('op1'), data: { point: 'Filling B / corridor', value: 15 } });
    expect((await status(room)).warnings.some((w: string) => /pressure/.test(w))).toBe(false);
  });

  it('LB-16: the client cannot set the out-of-limit flag', async () => {
    const res = await entry('op1', room, { logbookType: 'pressure_reading', activityStart: now(), signature: sig('op1'), data: { point: 'Filling B / corridor', value: 50, outOfLimit: false } });
    expect(res.statusCode).toBe(400);
  });
});

describe('review fixes (S6)', () => {
  it('LB-12: a steam cycle is refused on a steriliser without a verified passed test (D-22)', async () => {
    const ac = (await addItem(t, { code: `AC-${++n}`, name: 'New autoclave', kind: 'equipment', sterile: true }));
    expect((await cycle(ac, 'C-1')).json().problems[0]).toMatch(/No verified passed steriliser test/);
    // Dry heat is not subject to the steam tests.
    expect((await cycle(ac, 'D-1', 'pass', { cycleType: 'dry_heat' })).statusCode).toBe(201);
  });

  it('LB-12: a cycle cannot be recorded while the steriliser is in use', async () => {
    await approve('equipment_use');
    const ac = (await addItem(t, { code: `AC-${++n}`, name: 'Busy autoclave', kind: 'equipment', sterile: true }));
    await passedTest(ac);
    const product = await addProduct(t, `PR-${n}`, 'Vials');
    expect((await entry('op1', ac, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'V1', data: {} })).statusCode).toBe(201);
    expect((await cycle(ac, 'C-9')).json().problems).toContain('In use: end the current use first.');
  });

  it('LB-12: the database refuses a duplicate cycle number on the same steriliser', async () => {
    const [row] = await t.owner`select * from entries where equipment_id = ${autoclave} and logbook_type = 'steriliser_cycle' limit 1`;
    await expect(t.sql`
      insert into entries (equipment_id, logbook_type, settings_id, version, change, activity_start, activity_end, data, entered_by)
      values (${autoclave}, 'steriliser_cycle', ${row!.settings_id}, 1, 'created', now(), now(),
              ${t.sql.json({ ...row!.data, cycleId: ` ${String(row!.data.cycleId).toLowerCase()} ` })}, ${row!.entered_by})`,
    ).rejects.toThrow(/already recorded/);
  });
});
