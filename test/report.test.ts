import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, asReport, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S15 (D-28): read-only report views for the Deviations & CAPA system, read through logbook_report.

let t: TestApp;
let base: string;
const c: Record<string, string> = {};
let product: number;

const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const plantDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const view = async (name: string, where = 'true') => {
  const r = await asReport(t.owner, `select * from ${t.reportSchema}.${name} where ${where}`);
  if (r.error) throw new Error(`${name}: ${r.error}`);
  return r.rows!;
};

async function approve(type: string, sopRef: string, approveIt = true) {
  const settings = { enabled: true, sopRef, checklist: [], verificationRequired: false };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: now() })).json().id;
  if (!approveIt) return;
  const versions = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions);
  const res = await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: versions.find((v: { id: number }) => v.id === id).contentHash });
  expect(res.statusCode).toBe(200);
}
const newItem = async (code: string, kind: 'equipment' | 'instrument' = 'equipment') =>
  (await call(t.app, c.admin!, 'POST', '/api/equipment', { code, name: `Item ${code}`, kind, location: 'Room 7' })).json().id as number;
const entry = async (who: string, id: number, body: object) => {
  const res = await call(t.app, c[who]!, 'POST', `/api/equipment/${id}/entries`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; entryId: number };
};
const verify = async (who: string, versionId: number) => {
  const v = (await call(t.app, c.qa!, 'GET', `/api/entries/${versionId}/versions`)).json().find((x: { id: number }) => x.id === versionId);
  expect((await call(t.app, c[who]!, 'POST', `/api/entries/${versionId}/verify`, { ...sig(who === 'qa' ? 'qa1' : who), contentHash: v.contentHash })).statusCode).toBe(200);
};

beforeAll(async () => {
  t = await freshApp();
  base = t.reportSchema.replace(/_report$/, '');
  // On a site the tables are in the schema public, which every role may look into; the tests use
  // their own schema, so give the report role the same look-in: what stops it is the table rights.
  await t.owner.unsafe(`grant usage on schema ${base} to logbook_report`);
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']]] as const) {
    await seedUser(t.owner, u, [...roles]);
  }
  for (const u of ['admin', 'qa1', 'op1', 'sup1', 'eng1']) c[u === 'qa1' ? 'qa' : u] = (await login(t.app, u)).cookie;
  product = (await call(t.app, c.admin!, 'POST', '/api/products', { code: 'PCM500', name: 'Paracetamol 500 mg Tablets' })).json().id;
  await approve('equipment_use', '');
  await approve('equipment_cleaning', '');
  await approve('maintenance', 'SOP-ENG-010');
  await approve('calibration', 'SOP-QC-005; SOP-QC-006');
});
afterAll(async () => {
  await t.owner.unsafe(`revoke usage on schema ${base} from logbook_report`);
  await t.close();
});

describe('report views (D-28)', () => {
  it('equipment_v1 lists every item with the SOP references of its latest details version', async () => {
    const id = await newItem('PRESS-1');
    const put = (sopRefs: string, expectedVersion: number) =>
      call(t.app, c.admin!, 'PUT', `/api/equipment/${id}/details`, { details: { sopRefs }, reason: 'SOPs', expectedVersion });
    expect((await put('SOP-A, SOP-B', 0)).statusCode).toBe(200);
    expect((await put('SOP-B;\nSOP-C', 1)).statusCode).toBe(200);
    await newItem('BAL-1', 'instrument');
    const rows = await view('equipment_v1', `code in ('PRESS-1', 'BAL-1') order by code`);
    expect(rows.map((r) => [r.code, r.kind, r.location, r.active, r.needs_calibration, r.sop_refs])).toEqual([
      ['BAL-1', 'instrument', 'Room 7', true, true, []],
      ['PRESS-1', 'equipment', 'Room 7', true, false, ['SOP-B', 'SOP-C']],
    ]);
    expect(Object.keys(rows[0]!)).toEqual(['id', 'code', 'name', 'kind', 'location', 'active', 'needs_calibration', 'sop_refs', 'read_at', 'data_as_of']);
    expect(rows[1]!.data_as_of).toBeInstanceOf(Date);
  });

  it('LB-17: entry_v1 shows only the latest version of each entry, with the signatures on that version', async () => {
    const id = await newItem('MIX-1');
    const cleaning = await entry('op1', id, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    await verify('sup1', cleaning.id);
    const use = await entry('op1', id, { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'PCM-2610-014', data: { stage: 'Mixing' } });
    expect((await call(t.app, c.op1!, 'POST', `/api/entries/${use.id}/complete`, { activityEnd: now() })).statusCode).toBe(200);
    // A correction of the cleaning: version 2 replaces version 1 and needs its verification again.
    const corrected = await call(t.app, c.op1!, 'POST', `/api/entries/${cleaning.id}/correct`, {
      activityStart: (await call(t.app, c.qa!, 'GET', `/api/entries/${cleaning.id}/versions`)).json()[0].activityStart,
      data: { cleaningType: 'major', checklist: {}, remarks: 'Rinse water clear' }, reason: 'Remark missing', signature: sig('op1') });
    expect(corrected.statusCode).toBe(200);

    const rows = await view('entry_v1', `equipment_code = 'MIX-1' order by entry_id`);
    expect(rows.map((r) => [r.type, r.version, r.change, r.signed])).toEqual([
      ['equipment_cleaning', 2, 'corrected', ['corrected']],
      ['equipment_use', 2, 'completed', []],
    ]);
    expect(rows[0]!.data).toMatchObject({ remarks: 'Rinse water clear' });
    expect(rows[1]).toMatchObject({ entry_id: String(use.entryId), equipment_kind: 'equipment', product_code: 'PCM500', batch: 'PCM-2610-014', entered_by: 'OP1', late: false });
    expect(rows[1]!.activity_end).toBeInstanceOf(Date);
    expect(Object.keys(rows[0]!)).toEqual(['entry_id', 'version', 'equipment_code', 'equipment_kind', 'type', 'change', 'activity_start', 'activity_end',
      'product_code', 'batch', 'data', 'entered_by', 'entered_at', 'late', 'signed', 'read_at', 'data_as_of']);

    // Verifying the corrected version adds its signature; data_as_of moves to the signature time.
    await verify('sup1', corrected.json().id);
    const [after] = await view('entry_v1', `equipment_code = 'MIX-1' and type = 'equipment_cleaning'`);
    expect(after!.signed).toEqual(['corrected', 'verified']);
    expect((after!.data_as_of as Date).getTime()).toBeGreaterThan((rows[0]!.data_as_of as Date).getTime());
  });

  it('LB-05: calibration_v1 gives each calibration with its result, next due date and certificate (latest version)', async () => {
    const id = await newItem('HT-9', 'instrument');
    const due = (days: number) => plantDay(new Date(Date.now() + days * 86_400_000).toISOString());
    const cal = await entry('eng1', id, { logbookType: 'calibration', activityStart: ago(90), activityEnd: ago(60), lateReason: 'Written up after the check',
      data: { result: 'pass', certificateRef: 'CERT-1', nextDue: due(30) }, signature: sig('eng1') });
    // Corrected next due date: only the corrected version is reported.
    const fix = await call(t.app, c.eng1!, 'POST', `/api/entries/${cal.id}/correct`, { activityStart: ago(90), data: { result: 'pass', certificateRef: '', nextDue: due(20) },
      reason: 'Wrong interval', signature: sig('eng1') });
    expect(fix.statusCode, fix.body).toBe(200);
    await verify('qa', fix.json().id);
    const rows = await view('calibration_v1', `equipment_code = 'HT-9'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'pass', certificate_ref: null });
    expect((rows[0]!.next_due as Date).toISOString().slice(0, 10)).toBe(due(20));
    // Performed at = the activity end.
    expect(Math.abs((rows[0]!.performed_at as Date).getTime() - Date.parse(ago(60)))).toBeLessThan(5_000);
    expect(Object.keys(rows[0]!)).toEqual(['equipment_code', 'performed_at', 'result', 'next_due', 'certificate_ref', 'read_at', 'data_as_of']);
  });

  it('LB-11: a next due date that is not a real date is refused; one stored anyway reads as null, not as an error', async () => {
    const id = await newItem('HT-10', 'instrument');
    const res = await call(t.app, c.eng1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'calibration', activityStart: now(),
      data: { result: 'pass', nextDue: '2027-02-30' }, signature: sig('eng1') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_data');
    // A row written past the app (e.g. before this check existed) must not break every read.
    await t.owner.unsafe(`insert into ${base}.entries (equipment_id, logbook_type, settings_id, version, change, activity_start, activity_end, data, entered_by)
      select ${id}, 'calibration', (select max(id) from ${base}.logbook_settings where logbook_type = 'calibration'), 1, 'created', now(), now(),
        '{"result": "pass", "nextDue": "2027-02-30", "certificateRef": "OLD"}', (select id from ${base}.users where username = 'eng1')`);
    const rows = await view('calibration_v1', `equipment_code = 'HT-10'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ certificate_ref: 'OLD', next_due: null });
  });

  it('LB-24: logbook_sop_v1 gives the SOP references of the approved settings in force only', async () => {
    // A newer draft is not in force until QA approves it.
    await approve('maintenance', 'SOP-ENG-099', false);
    const rows = await view('logbook_sop_v1', 'true order by type, sop_ref');
    expect(rows.map((r) => [r.type, r.sop_ref])).toEqual([
      ['calibration', 'SOP-QC-005'], ['calibration', 'SOP-QC-006'], ['maintenance', 'SOP-ENG-010'],
    ]);
    expect(Object.keys(rows[0]!)).toEqual(['type', 'sop_ref', 'read_at', 'data_as_of']);
  });
});

describe('the report role reads the views only (D-28)', () => {
  it('LB-21: logbook_report reads the four views but cannot read or change any table', async () => {
    for (const v of ['equipment_v1', 'entry_v1', 'calibration_v1', 'logbook_sop_v1']) {
      expect((await asReport(t.owner, `select count(*) from ${t.reportSchema}.${v}`)).error).toBeUndefined();
      // Refused either as not permitted or as a view that cannot be written at all.
      expect(['42501', '55000']).toContain((await asReport(t.owner, `delete from ${t.reportSchema}.${v}`)).error);
    }
    // Each table with one ordinary (not generated) column to try an update on.
    const tables = await t.owner<{ name: string; col: string }[]>`
      select c.table_name as name, min(c.column_name) as col from information_schema.columns c
      join pg_tables p on p.schemaname = c.table_schema and p.tablename = c.table_name
      where c.table_schema = ${base} and c.is_identity = 'NO' and c.is_generated = 'NEVER'
      group by c.table_name order by 1`;
    expect(tables.map((x) => x.name)).toEqual(expect.arrayContaining(['entries', 'signatures', 'audit_log', 'users', 'equipment', 'logbook_settings']));
    for (const { name, col } of tables) {
      const q = `${base}.${name}`;
      expect((await asReport(t.owner, `select * from ${q} limit 1`)).error, name).toBe('42501');
      expect((await asReport(t.owner, `insert into ${q} default values`)).error, name).toBe('42501');
      expect((await asReport(t.owner, `update ${q} set ${col} = ${col}`)).error, name).toBe('42501');
      expect((await asReport(t.owner, `delete from ${q}`)).error, name).toBe('42501');
      expect((await asReport(t.owner, `truncate ${q}`)).error, name).toBe('42501');
    }
    expect((await asReport(t.owner, `select nextval('${base}.entry_ids')`)).error).toBe('42501');
    expect((await asReport(t.owner, `create table ${t.reportSchema}.x (a int)`)).error).toBe('42501');
    // No temporary objects either, so no functions of its own (D-28).
    expect((await asReport(t.owner, 'create temporary table x (a int)')).error).toBe('42501');
    expect((await asReport(t.owner, 'create function pg_temp.f() returns int language sql as $$ select 1 $$')).error).toBe('42501');
  });

  it('LB-21: a function in the reader\'s WHERE clause sees only what the views return, never superseded versions or drafts', async () => {
    // A "leaky" function that keeps every value it is shown; the owner makes it, the role may call it.
    await t.owner.unsafe(`create table ${base}.leaked (v text)`);
    await t.owner.unsafe(`create function ${base}.leak(v text) returns boolean language plpgsql volatile security definer cost 0.0001
      set search_path = ${base} as $$ begin insert into leaked values (v); return true; end $$`);
    await t.owner.unsafe(`grant execute on function ${base}.leak(text) to logbook_report`);
    expect((await asReport(t.owner, `select * from ${t.reportSchema}.entry_v1 where ${base}.leak(data::text)`)).error).toBeUndefined();
    expect((await asReport(t.owner, `select * from ${t.reportSchema}.calibration_v1 where ${base}.leak(coalesce(certificate_ref, '-'))`)).error).toBeUndefined();
    expect((await asReport(t.owner, `select * from ${t.reportSchema}.logbook_sop_v1 where ${base}.leak(sop_ref)`)).error).toBeUndefined();
    const seen = (await t.owner.unsafe<{ v: string }[]>(`select v from ${base}.leaked`)).map((r) => r.v);
    expect(seen.some((v) => v.includes('Rinse water clear'))).toBe(true);
    // CERT-1 is only in the superseded first version of the HT-9 calibration; SOP-ENG-099 only in a draft.
    expect(seen.filter((v) => v.includes('CERT-1') || v.includes('SOP-ENG-099'))).toEqual([]);
  });

  it('LB-21: the role cannot log in until the site gives it a password, and is a member of no role', async () => {
    const [r] = await t.owner<{ rolcanlogin: boolean; rolsuper: boolean; member_of: number }[]>`
      select rolcanlogin, rolsuper, (select count(*)::int from pg_auth_members m where m.member = r.oid) as member_of
      from pg_roles r where rolname = 'logbook_report'`;
    // Tests may have granted the test login membership of the role, never the other way round.
    expect(r).toEqual({ rolcanlogin: false, rolsuper: false, member_of: 0 });
  });
});
