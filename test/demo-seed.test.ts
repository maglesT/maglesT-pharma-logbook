import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asReport, freshDb, type TestDb } from './helpers.js';
import { EVENT_AT, SeedError, demoDatabaseName, seedDemo, seedRefusals } from '../db/demo-seed.js';

// S15 (D-28): the demo seed builds the shared investigation scenario through the API; the report
// views, read as logbook_report, show what the Deviations system needs.

let t: TestDb;
let base: string;
type Row = Record<string, unknown>;
const view = async (name: string, where = 'true'): Promise<Row[]> => {
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.${name} where ${where}`);
  if (r.error) throw new Error(`${name}: ${r.error}`);
  return r.rows!;
};
const at = (v: unknown) => (v as Date).getTime();
const event = Date.parse(EVENT_AT);

beforeAll(async () => {
  t = await freshDb();
  base = t.reportSchema.replace(/_report$/, '');
  await t.owner.unsafe(`grant usage on schema ${base} to logbook_report`);
  await seedDemo(t.sql);
}, 60_000);
afterAll(async () => {
  await t.owner.unsafe(`revoke usage on schema ${base} from logbook_report`);
  await t.close();
});

describe('demo seed (D-28)', () => {
  it('creates the items, rooms and SOP references of the shared scenario', async () => {
    const items = await view('equipment_v1', 'true order by code');
    expect(items.map((r) => [r.code, r.kind, r.location, r.needs_calibration, r.sop_refs])).toEqual([
      ['COMP-1', 'area', '', false, []],
      ['FBD-01', 'equipment', 'GRAN-1', false, ['SOP-PRD-014']],
      ['GRAN-1', 'area', '', false, []],
      ['HT-01', 'instrument', 'COMP-1', true, ['SOP-QC-005']],
      ['PRESS-01', 'equipment', 'COMP-1', false, ['SOP-PRD-021', 'SOP-ENG-010']],
    ]);
    expect((await view('logbook_sop_v1', 'true order by type')).map((r) => [r.type, r.sop_ref])).toEqual([
      ['calibration', 'SOP-QC-005'], ['maintenance', 'SOP-ENG-010'],
    ]);
  });

  it('LB-05: HT-01 was calibrated with next due the day before the event, so it was overdue at the event', async () => {
    const cals = await view('calibration_v1', `equipment_code = 'HT-01'`);
    expect(cals).toHaveLength(1);
    expect(cals[0]).toMatchObject({ result: 'pass', certificate_ref: 'CAL-HT01-2607' });
    expect((cals[0]!.next_due as Date).toISOString().slice(0, 10)).toBe('2026-10-30');
    const eventDay = new Date(event).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    expect((cals[0]!.next_due as Date).toISOString().slice(0, 10) < eventDay).toBe(true);
    const [entry] = await view('entry_v1', `equipment_code = 'HT-01'`);
    expect(entry!.signed).toEqual(['performed', 'verified']);
  });

  it('LB-02: PRESS-01 had its last preventive maintenance 40 days before the event, a released breakdown 2 days before, and cleaning between the batches', async () => {
    const rows = await view('entry_v1', `equipment_code = 'PRESS-01' order by activity_start`);
    const pm = rows.filter((r) => r.type === 'maintenance' && (r.data as Row).kind === 'preventive');
    expect(pm).toHaveLength(1);
    expect(event - at(pm[0]!.activity_end)).toBe(40 * 86_400_000);
    expect(pm[0]!.signed).toEqual(['performed', 'verified']);

    const bd = rows.filter((r) => r.type === 'maintenance' && (r.data as Row).kind === 'breakdown');
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ version: 2, change: 'completed', signed: ['performed', 'verified', 'released'] });
    expect(bd[0]!.data).toMatchObject({ description: 'Upper punch sticking', failureCategory: 'mechanical', doneBy: 'in_house' });
    const daysBefore = (event - at(bd[0]!.activity_end)) / 86_400_000;
    expect(daysBefore).toBeGreaterThan(1.5);
    expect(daysBefore).toBeLessThan(2.5);

    const uses = rows.filter((r) => r.type === 'equipment_use');
    expect(uses.map((r) => [r.product_code, r.batch, (r.data as Row).stage])).toEqual([
      ['RAB-GR-20', 'RAB26002', 'Compression'], ['RAB-GR-20', 'RAB26004', 'Compression'],
    ]);
    // Batch RAB26004 was running at the event, from about 19:00 IST.
    expect(at(uses[1]!.activity_start)).toBe(Date.parse('2026-10-31T19:00:00+05:30'));
    expect(at(uses[1]!.activity_start)).toBeLessThan(event);
    expect(at(uses[1]!.activity_end)).toBeGreaterThan(event);
    const between = rows.filter((r) => r.type === 'equipment_cleaning' && at(r.activity_start) >= at(uses[0]!.activity_end) && at(r.activity_end) <= at(uses[1]!.activity_start));
    expect(between).toHaveLength(1);
    expect(between[0]!.signed).toEqual(['performed', 'verified']);
  });

  it('LB-04: FBD-01 has both batches and its cleanings; every demo entry is a late entry with its reason', async () => {
    const fbd = await view('entry_v1', `equipment_code = 'FBD-01' order by activity_start`);
    expect(fbd.map((r) => [r.type, r.batch])).toEqual([
      ['equipment_cleaning', null], ['equipment_use', 'RAB26002'], ['equipment_cleaning', null],
      ['equipment_use', 'RAB26004'], ['equipment_cleaning', null],
    ]);
    const all = await view('entry_v1');
    expect(all.length).toBe(13);
    expect(all.every((r) => r.late === true)).toBe(true);
    const reasons = await t.owner<{ late_reason: string }[]>`select distinct late_reason from entries`;
    expect(reasons.map((r) => r.late_reason)).toEqual(['Demo data']);
  });

  it('refuses a database that is not fresh, and --force does not skip the users and settings checks', async () => {
    await expect(seedDemo(t.sql)).rejects.toThrow(/already has logbook entries/);
    const forced = (await seedRefusals(t.sql, { force: true })).join(' ');
    expect(forced).toMatch(/user accounts other than one initial admin/);
    expect(forced).toMatch(/approved logbook settings/);
    expect(forced).not.toMatch(/entries/);
    await expect(seedDemo(t.sql, { force: true })).rejects.toBeInstanceOf(SeedError);
  });

  it('refuses a database not named as demo or test, and never uses the published password there', async () => {
    expect(['logbook_demo', 'logbook_test', 'DEMO1'].every(demoDatabaseName)).toBe(true);
    expect(['logbook', 'plant_prod'].some(demoDatabaseName)).toBe(false);
    expect(await seedRefusals(t.sql, { force: true, notProduction: true })).toContain('Set DEMO_PASSWORD: the default demo password is only used on demo and test databases.');
  });
});
