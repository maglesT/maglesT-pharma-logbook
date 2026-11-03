import { mkdtempSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { migrate, MIGRATIONS_DIR } from '../db/migrate.js';
import { audit } from '../server/audit.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../server/auth.js';
import { moveToPlatform, reportCsv, type MoveOptions } from '../db/move-to-platform.js';
import { seedDemo } from '../db/demo-seed.js';
import { TEST_DATABASE_URL } from './helpers.js';

// B1-5 (D-29, platform PL-13): the move of a standalone Logbook onto the platform. The platform side is built as on a
// server: the logbook database by the platform init (test/platform/database.sql) and the Logbook's migrations as the
// owner role; core's identity and master_data databases from copies of their migrations (test/platform/identity,
// test/platform/master_data: maglesT/databsee 539eae6).

const fixtures = path.join(import.meta.dirname, 'platform');
const url = (db: string) => TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${db}`);
let admin: Sql;
const open: Sql[] = [];
const dbs: string[] = [];
const conn = (db: string, opts = {}) => { const s = connect(url(db), opts); open.push(s); return s; };

const hash = (pw: string, salt = randomBytes(16)) =>
  ['scrypt', 16384, 8, 1, salt.toString('base64'), scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')].join('$');
const verify = (pw: string, stored: string) => {
  const [, , , , salt] = stored.split('$');
  return hash(pw, Buffer.from(salt!, 'base64')) === stored;
};

async function createDb(name: string, owner: string) {
  await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = '${owner}') then create role ${owner} nologin; end if; end $$`);
  await admin.unsafe(`drop database if exists ${name}`);
  await admin.unsafe(`create database ${name} owner ${owner}`);
  dbs.push(name);
}

/** A platform server's three databases, as after install and apply with the Logbook licensed. */
async function platform(tag: string): Promise<Pick<MoveOptions, 'logbook' | 'identity' | 'masterData'>> {
  const lb = `lbmv_${process.pid}_${tag}`;
  await createDb(lb, `${lb}_owner`);
  await admin.unsafe(`revoke all on database ${lb} from public`);
  await admin.unsafe(`grant connect, temporary on database ${lb} to logbook_app`);
  const logbook = conn(lb);
  const init = readFileSync(path.join(fixtures, 'database.sql'), 'utf8').replace(/^(begin|commit);$/gm, '')
    .replaceAll(':"owner"', `"${lb}_owner"`).replaceAll(":'owner'", `'${lb}_owner'`).replaceAll(':"app"', '"logbook_app"')
    .replaceAll(":'app'", "'logbook_app'").replaceAll(':"db"', `"${lb}"`).replaceAll(":'db'", `'${lb}'`);
  await logbook.begin((tx) => tx.unsafe(init));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort())
    await logbook.begin(async (tx) => { await tx.unsafe(`set local role ${lb}_owner`); await tx.unsafe(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')); });

  await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = 'core_app') then create role core_app nologin; end if; end $$`);
  const core = async (kind: 'identity' | 'master_data') => {
    const name = `${lb}_${kind}`;
    await createDb(name, `${lb}_owner`);
    const s = conn(name);
    await s`create schema report`;
    for (const f of readdirSync(path.join(fixtures, kind)).sort()) await s.unsafe(readFileSync(path.join(fixtures, kind, f), 'utf8'));
    return s;
  };
  const identity = await core('identity');
  const masterData = await core('master_data');
  // The installer's first administrator, and apply loading the Logbook's permission list from its manifest.
  const [me] = await identity<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
    values ('platform.admin', 'Installer', 'Passport seen') returning id`;
  await identity`insert into employee_version (employee_id, version, full_name, active, changed_by_name, reason)
    values (${me!.id}, 1, 'Platform Admin', true, 'installer', 'first administrator')`;
  for (const [code, label] of Object.entries(PERMISSIONS))
    await identity`insert into permission_event (product, code, label, active, by_name, reason) values ('logbook', ${code}, ${label}, true, 'apply', 'licence')`;
  return { logbook, identity, masterData };
}

const opts = { by: 'platform.admin', verifiedBy: 'Site HR (Anita Rao)', verifiedHow: 'Employee ID card checked at hiring (SOP-HR-003)' };

beforeAll(() => { admin = connect(url('postgres')); });
afterAll(async () => {
  await Promise.all(open.map((s) => s.end()));
  const test = connect(TEST_DATABASE_URL);
  for (const s of [`mvsrc_${process.pid}`, `mvdemo_${process.pid}`]) await test.unsafe(`drop schema if exists ${s} cascade; drop schema if exists ${s}_report cascade`);
  await test.end();
  for (const d of dbs.reverse()) await admin.unsafe(`drop database if exists ${d}`);
  await admin.unsafe(`drop role if exists lbmv_${process.pid}_live_owner`);
  await admin.unsafe(`drop role if exists lbmv_${process.pid}_demo_owner`);
  await admin.end();
});

describe('the move of a standalone Logbook (B1-5)', () => {
  let source: Sql;
  let target: Awaited<ReturnType<typeof platform>>;
  const schema = `mvsrc_${process.pid}`;

  beforeAll(async () => {
    // The live site's database: the standalone release ran migrations up to 0013 and had local accounts.
    const owner = connect(TEST_DATABASE_URL);
    await owner.unsafe(`drop schema if exists ${schema} cascade; create schema ${schema}`);
    await owner.end();
    source = conn('logbook_test', { searchPath: schema });
    const dir = mkdtempSync(path.join(tmpdir(), 'lb-0013-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x <= '0013_~')) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    await migrate(source, dir);
    const user = async (login: string, roles: string[], extra: { active?: boolean; pw?: string } = {}) => {
      const [u] = await source<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password, active)
        values (${login}, ${login.toUpperCase()}, ${hash(extra.pw ?? 'Old-Password-1')}, false, ${extra.active ?? true}) returning id::int`;
      for (const r of roles) await source`insert into user_roles (user_id, role) values (${u!.id}, ${r})`;
      return u!.id;
    };
    const adminId = await user('admin1', ['admin']);
    await user('op1', ['operator'], { pw: 'Op1-Secret-pass' });
    await user('sup1', ['supervisor', 'operator']);
    await user('qa.old', ['qa'], { active: false });
    await user('9shift', ['operator']);   // core logins start with a letter
    const item = async (code: string, name: string, kind: string, location = '') =>
      (await source<{ id: number }[]>`insert into equipment (code, name, kind, location) values (${code}, ${name}, ${kind}, ${location}) returning id::int`)[0]!.id;
    await item('GRAN-1', 'Granulation room 1', 'area');
    const fbd = await item('FBD-01', 'Fluid bed dryer', 'equipment', 'Granulation room 1');
    await item('HT-01', 'Hardness tester', 'instrument', 'QC lab bench 3');
    const details = { manufacturer: 'Glatt', model: 'GPCG 60', serialNumber: 'G-7781', sopRefs: 'SOP-1' };
    const [d] = await source<{ id: number }[]>`insert into equipment_details (equipment_id, version, details, reason, changed_by)
      values (${fbd}, 1, ${source.json(details)}, 'IQ report', ${adminId}) returning id::int`;
    await audit(source, { actorId: adminId, action: 'equipment.details_updated', objectType: 'equipment', objectId: fbd,
      new: { id: d!.id, version: 1, details }, reason: 'IQ report' });
    await source`insert into products (code, name) values ('RAB-20', 'Rabeprazole 20 mg')`;
    await audit(source, { actorId: adminId, action: 'site.created', objectType: 'site', objectId: 1, new: { name: 'Plant 1' } });
    target = await platform('live');
  }, 120_000);

  it('PL-13: a dry run checks everything and writes nothing', async () => {
    const r = await moveToPlatform({ source, ...target, ...opts, dryRun: true });
    expect(r).toMatchObject({ moved: false, problems: [] });
    expect(r.rows).toEqual([expect.objectContaining({ type: 'user', code: '9shift', note: expect.stringMatching(/^refused: login does not fit/) })]);
    expect((await target.identity`select 1 from employee`).length).toBe(1);
    expect((await target.logbook`select 1 from users`).length).toBe(0);
  });

  it('PL-13: rows are copied with equal counts and checksums; people, items and products are mapped; the integrity check passes', async () => {
    const r = await moveToPlatform({ source, ...target, ...opts });
    expect(r.problems).toEqual([]);
    expect(r.moved).toBe(true);
    expect(r.rows.filter((x) => x.type === 'table').map((x) => x.localId)).toEqual(expect.arrayContaining(['users', 'equipment', 'audit_log', 'equipment_details']));
    expect((await target.logbook`select count(*)::int as n from audit_log where action = 'site.created'`)[0]!.n).toBe(1);
    expect(await target.logbook`select username from users where employee_id is null`).toEqual([{ username: '9shift' }]);
    expect(await target.logbook`select code from equipment where item_id is null union all select code from products where item_id is null`).toEqual([]);
    expect(reportCsv(r)).toContain('"user","5","9shift","","refused: login does not fit');
  });

  it('PL-03 / D-29 5: each person keeps their login and password, with the site\'s identity verification; inactive stays inactive', async () => {
    const [op] = await target.identity<{ password_hash: string; identity_verified_how: string; active: boolean }[]>`
      select c.password_hash, e.identity_verified_how, e.active from employee_current e join credential c on c.employee_id = e.id where e.login = 'op1'`;
    expect(verify('Op1-Secret-pass', op!.password_hash)).toBe(true);
    expect(op!.identity_verified_how).toBe(opts.verifiedHow);
    expect((await target.identity`select active from employee_current where login = 'qa.old'`)[0]!.active).toBe(false);
    expect((await target.logbook`select u.employee_id::text = e from users u, (values (${(await target.identity`select id::text from employee where login = 'op1'`)[0]!.id})) v(e) where u.username = 'op1'`)[0]).toBeTruthy();
  });

  it('D-30 / D-29 6: each person gets the permissions of their old roles; admins also manage people and master data in core', async () => {
    const codes = async (login: string) => (await target.identity<{ code: string }[]>`
      select g.code from current_permission_grant g join employee e on e.id = g.employee_id where e.login = ${login} order by 1`).map((x) => x.code);
    expect(await codes('op1')).toEqual([...ROLE_PERMISSIONS.operator].sort());
    expect(await codes('sup1')).toEqual([...new Set([...ROLE_PERMISSIONS.supervisor, ...ROLE_PERMISSIONS.operator])].sort());
    expect(await codes('admin1')).toEqual([...ROLE_PERMISSIONS.admin, 'core.masterdata.edit', 'core.people.manage'].sort());
    expect((await target.identity`select reason from permission_grant g join employee e on e.id = g.employee_id where e.login = 'op1' limit 1`)[0]!.reason)
      .toBe('Moved from the standalone Pharma Logbook (B1-5): roles operator');
  });

  it('D-29 3: items, rooms and products are in master data with their codes and names; make, model and serial come along; locations become room links where they match', async () => {
    const items = await target.masterData<{ kind: string; code: string; name: string; fields: Record<string, unknown> }[]>`
      select kind, code, name, fields from item_current order by code`;
    expect(items).toEqual([
      { kind: 'equipment', code: 'FBD-01', name: 'Fluid bed dryer', fields: { make: 'Glatt', model: 'GPCG 60', serial: 'G-7781' } },
      { kind: 'room', code: 'GRAN-1', name: 'Granulation room 1', fields: {} },
      { kind: 'instrument', code: 'HT-01', name: 'Hardness tester', fields: { needsCalibration: false } },
      { kind: 'product', code: 'RAB-20', name: 'Rabeprazole 20 mg', fields: {} },
    ]);
    expect(await target.masterData`select f.code as item, t.code as room from item_link_current l join item f on f.id = l.from_item join item t on t.id = l.to_item`)
      .toEqual([{ item: 'FBD-01', room: 'GRAN-1' }]);
  });

  it('PL-13: a second run is refused: the platform database is no longer empty', async () => {
    const r = await moveToPlatform({ source, ...target, ...opts, by: 'nobody' });
    expect(r.moved).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(['no active core employee with login nobody (--by)', expect.stringMatching(/^table users on the platform is not empty/)]));
  });
});

describe('the platform demo (D-28, B1-5)', () => {
  it('PL-13: a seeded demo database moves with its signed entries; the integrity check passes and demo people sign on with the demo password', async () => {
    const schema = `mvdemo_${process.pid}`;
    const owner = connect(TEST_DATABASE_URL);
    await owner.unsafe(`drop schema if exists ${schema} cascade; create schema ${schema}`);
    await owner.end();
    const ownerSql = conn('logbook_test', { searchPath: schema });
    await migrate(ownerSql);
    await seedDemo(conn('logbook_test', { role: 'logbook_app', searchPath: schema }));
    const target = await platform('demo');
    const r = await moveToPlatform({ source: ownerSql, ...target, ...opts, demoPassword: 'Demo-Logbook-2026' });
    expect(r.problems).toEqual([]);
    expect((await target.logbook`select count(*)::int as n from signatures`)[0]!.n).toBeGreaterThan(5);
    // New entry numbers and ids continue after the moved ones.
    const seq = async (q: Sql) => q`select (select last_value from entry_ids) as e, (select last_value from entries_id_seq) as i`;
    expect(await seq(target.logbook)).toEqual(await seq(ownerSql));
    expect(Number((await target.logbook`select nextval('entry_ids') as n`)[0]!.n)).toBeGreaterThan(Number((await ownerSql`select max(entry_id) as m from entries`)[0]!.m));
    const [qa] = await target.identity<{ password_hash: string; must_change: boolean }[]>`
      select c.password_hash, c.must_change from credential c join employee e on e.id = c.employee_id where e.login = 'qa.priya'`;
    expect(verify('Demo-Logbook-2026', qa!.password_hash)).toBe(true);
    expect(qa!.must_change).toBe(true);
    expect((await target.identity`select count(*)::int as n from current_permission_grant g join employee e on e.id = g.employee_id where e.login = 'qa.priya'`)[0]!.n)
      .toBe(ROLE_PERMISSIONS.qa.length);
  }, 120_000);
});
