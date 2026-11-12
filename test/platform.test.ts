import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { loadConfig } from '../server/config.js';
import { ConnectionOff, sqlMaster } from '../server/master.js';
import { freshDb, TEST_DATABASE_URL, type TestDb } from './helpers.js';

// D-29 (B1-1): the Logbook's migrations on a Medhanta platform database. test/platform/database.sql is a copy of the
// platform's db/server/database.sql (maglesT/databsee 2be3a6f). As on the platform, each migration
// runs in its own transaction as the database's owner role (NOLOGIN, no superuser), and init runs again before
// later migrations, so its default grants are back by then.

const DB = `lbplat_${process.pid}`;
const OWNER = `${DB}_owner`;
// database.sql has its own begin/commit; the test runs its body in one transaction instead.
const init = () => su.begin((tx) => tx.unsafe(fixture('database.sql').replace(/^(begin|commit);$/gm, '')));
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'platform', name), 'utf8')
    .replaceAll(':"owner"', `"${OWNER}"`).replaceAll(":'owner'", `'${OWNER}'`)
    .replaceAll(':"app"', '"logbook_app"').replaceAll(":'app'", "'logbook_app'")
    .replaceAll(':"db"', `"${DB}"`).replaceAll(":'db'", `'${DB}'`);

const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
const FIRST_INSTALL = files.filter((f) => f <= '0013');   // what a platform install of the current Logbook runs at once

let admin: Sql;
let su: Sql;
let standalone: TestDb;

async function migrateAsOwner(names: string[]) {
  for (const f of names)
    await su.begin(async (tx) => {
      await tx.unsafe(`set local role ${OWNER}`);
      await tx.unsafe(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    });
}

/** Every right logbook_app holds on the tables, columns and sequences of one schema, by object name. */
async function appRights(q: Sql, schema: string) {
  const rows = await q<{ r: string }[]>`
    select c.relname || ' ' || a.privilege_type as r
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
    where n.nspname = ${schema} and c.relkind in ('r', 'S') and a.grantee = 'logbook_app'::regrole
    union all
    select c.relname || '.' || t.attname || ' ' || a.privilege_type
    from pg_attribute t join pg_class c on c.oid = t.attrelid join pg_namespace n on n.oid = c.relnamespace, aclexplode(t.attacl) a
    where n.nspname = ${schema} and t.attacl is not null and a.grantee = 'logbook_app'::regrole
    order by 1`;
  return rows.map((x) => x.r).filter((r) => !r.startsWith('schema_migrations '));
}

beforeAll(async () => {
  admin = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres'));
  await admin.unsafe(`drop database if exists ${DB}`);
  await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = 'logbook_app') then create role logbook_app nologin; end if; end $$`);
  // What the platform's db/server/cluster.sql does for one database.
  await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = '${OWNER}') then create role ${OWNER} nologin; end if; end $$`);
  await admin.unsafe(`create database ${DB} owner ${OWNER}`);
  await admin.unsafe(`revoke all on database ${DB} from public`);
  await admin.unsafe(`grant connect, temporary on database ${DB} to logbook_app`);
  su = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${DB}`));
  await init();
  await migrateAsOwner(FIRST_INSTALL);
  await init();                // a later apply runs init again
  await migrateAsOwner(files.filter((f) => !FIRST_INSTALL.includes(f)));
  standalone = await freshDb();
}, 60_000);

afterAll(async () => {
  await standalone?.close();
  await su?.end();
  await admin?.unsafe(`drop database if exists ${DB}`);
  await admin?.unsafe(`drop role if exists ${OWNER}`);
  await admin?.end();
});

describe('Logbook on a platform database (D-29)', () => {
  it('LB-18 the app login has exactly the rights of a standalone installation, so signed and audited tables stay insert-only', async () => {
    const schema = (await standalone.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const platform = await appRights(su, 'public');
    expect(platform.length).toBeGreaterThan(20);
    expect(platform).toEqual(await appRights(standalone.owner, schema));
    expect(platform).not.toContain('audit_log UPDATE');
    expect(platform).not.toContain('signatures DELETE');
  });

  it('LB-18 the app login cannot change an audit row on the platform database', async () => {
    const app = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${DB}`), { role: 'logbook_app' });
    const r = await app`update audit_log set reason = 'x'`.then(() => 'ok', (e: { code?: string }) => e.code);
    await app.end();
    expect(r).toBe('42501');
  });

  it('LB-21 the report views are published in the platform schema report, owned by the database owner', async () => {
    const views = await su<{ viewname: string; viewowner: string }[]>`
      select viewname, viewowner from pg_views where schemaname = 'report' order by 1`;
    expect(views.map((v) => v.viewname)).toEqual(['calibration_v1', 'entry_v1', 'equipment_v1', 'logbook_sop_v1', 'overdue_v1']);
    expect(new Set(views.map((v) => v.viewowner))).toEqual(new Set([OWNER]));
  });

  it('LB-18 on the platform the app reads its own database from LOGBOOK_DATABASE_URL, as the restricted login', () => {
    const url = 'postgres://logbook_app:pw@db:5432/logbook';
    const env = { LOGBOOK_DATABASE_URL: url, MASTER_DATA_DATABASE_URL: 'postgres://logbook_app:pw@db:5432/master_data', OIDC_ISSUER: 'https://site.test/oidc', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URI: 'https://logbook.site.test/cb' };
    expect(loadConfig(env).DATABASE_URL).toBe(url);
    expect(loadConfig(env).DB_APP_ROLE).toBeUndefined();
  });
});

// PL-08 with real PostgreSQL rights: a master_data database whose report views have the columns the Logbook reads
// (the platform's own view contract is tested in maglesT/databsee). The Logbook's login may read the views only.
describe('master data through the platform views (D-29)', () => {
  const MD = `mdplat_${process.pid}`;
  let mdAdmin: Sql;
  let md: Sql;
  beforeAll(async () => {
    await admin.unsafe(`drop database if exists ${MD}`);
    await admin.unsafe(`create database ${MD}`);
    await admin.unsafe(`revoke all on database ${MD} from public`);
    await admin.unsafe(`grant connect on database ${MD} to logbook_app`);
    mdAdmin = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${MD}`));
    await mdAdmin.unsafe(`
      create table item (id uuid primary key default gen_random_uuid(), kind text, code text, name text, version int, active boolean, room_code text);
      insert into item (kind, code, name, version, active, room_code) values
        ('equipment', 'FBD-01', 'Fluid bed dryer', 1, true, 'GRAN-1'), ('room', 'GRAN-1', 'Granulation room 1', 1, true, null),
        ('instrument', 'HT-01', 'Hardness tester', 2, false, 'GRAN-1'), ('product', 'P1', 'Product 1', 1, true, null);
      create schema report;
      create view report.equipment_v1 as select id, code, name, version, active, room_code, null::text as make, null::text as model, null::text as serial from item where kind = 'equipment';
      create view report.instrument_v1 as select id, code, name, version, active, room_code, null::text as make, null::text as model, null::text as serial, true as needs_calibration from item where kind = 'instrument';
      create view report.room_v1 as select id, code, name, version, active from item where kind = 'room';
      create view report.product_v1 as select id, code, name, version, active from item where kind = 'product';
      grant usage on schema report to logbook_app;
      grant select on all tables in schema report to logbook_app;`);
    md = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${MD}`), { role: 'logbook_app' });
  });
  afterAll(async () => {
    await md?.end();
    await mdAdmin?.end();
    await admin?.unsafe(`drop database if exists ${MD}`);
  });

  it('PL-08: the Logbook reads items and products through the views with its own login, never the raw table', async () => {
    const m = sqlMaster(md);
    expect((await m.items()).map((i) => [i.code, i.kind, i.room, i.active]).sort()).toEqual([
      ['FBD-01', 'equipment', 'GRAN-1', true], ['GRAN-1', 'area', null, true], ['HT-01', 'instrument', 'GRAN-1', false]]);
    expect((await m.products()).map((p) => p.code)).toEqual(['P1']);
    await expect(md`select * from item`).rejects.toMatchObject({ code: '42501' });
  });

  it('PL-08: after the link is cut the next read says "connection off", even on an open connection', async () => {
    await mdAdmin.unsafe('revoke select on all tables in schema report from logbook_app');
    try {
      await expect(sqlMaster(md).items()).rejects.toBeInstanceOf(ConnectionOff);
      await expect(sqlMaster(md).products()).rejects.toThrow('Connection to master data is off. Ask your administrator.');
    } finally {
      await mdAdmin.unsafe('grant select on all tables in schema report to logbook_app');
    }
    // master_data unreachable (server down, network): the same message, not an error page.
    const nowhere = connect('postgres://logbook_app:x@127.0.0.1:1/master_data');
    await expect(sqlMaster(nowhere).items()).rejects.toBeInstanceOf(ConnectionOff);
    await nowhere.end();
  });
});
