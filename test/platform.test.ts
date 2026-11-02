import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { loadConfig } from '../server/config.js';
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
    expect(views.map((v) => v.viewname)).toEqual(['calibration_v1', 'entry_v1', 'equipment_v1', 'logbook_sop_v1']);
    expect(new Set(views.map((v) => v.viewowner))).toEqual(new Set([OWNER]));
  });

  it('LB-18 on the platform the app reads its own database from LOGBOOK_DATABASE_URL, as the restricted login', () => {
    const url = 'postgres://logbook_app:pw@db:5432/logbook';
    const env = { LOGBOOK_DATABASE_URL: url, OIDC_ISSUER: 'https://site.test/oidc', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URI: 'https://logbook.site.test/cb' };
    expect(loadConfig(env).DATABASE_URL).toBe(url);
    expect(loadConfig(env).DB_APP_ROLE).toBeUndefined();
  });
});
