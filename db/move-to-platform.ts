// B1-5 (D-29, platform PL-13): moves a standalone Logbook's records onto the Medhanta platform.
// The platform's migrate has already built the Logbook schema in its `logbook` database (empty). This script copies the
// rows (data only, so the schema and the app login's rights stay exactly as the migrations made them), then creates
// the people in core (same password hashes, D-29 5), their permissions (old role -> codes, D-30; admins also core's
// people and master-data codes, D-29 6) and the items and products in master data, and fills the id maps.
// Checks (PL-13): row counts and checksums of every table equal before and after, every user, item and product mapped,
// codes and names equal in master data, the integrity check passes. Run it with --dry-run first (it writes nothing).
// Usage: SOURCE_DATABASE_URL=... PLATFORM_DATABASE_URL=postgres://<superuser>@<platform db host>:5432 \
//   npx tsx db/move-to-platform.ts --by <core login> --verified-by "<who>" --verified-how "<how>" --report move.csv [--dry-run]
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connect, type Sql, type Tx } from '../server/db.js';
import { ROLE_PERMISSIONS, type Role } from '../server/auth.js';
import { check as checkIntegrity } from '../server/integrity.js';
import { DEMO_USERS, demoDatabaseName } from './demo-seed.js';

// Moved admins also manage people and master data in core (D-29 6, as A10 codes).
const ADMIN_CORE = ['core.people.manage', 'core.masterdata.edit'];
// Core's login rule (identity employee.login).
const CORE_LOGIN = /^[a-z][a-z0-9._-]{1,39}$/;
const MASTER_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
// Not moved: the migration record (the platform keeps its own) and open sessions (everyone signs on again at core).
const SKIP = new Set(['schema_migrations', 'sessions']);
const REASON = 'Moved from the standalone Pharma Logbook (B1-5)';
// The id maps are filled by the move itself (a demo source holds stand-in ids there): not copied, not compared.
const MAPPED: Record<string, string[]> = { users: ['employee_id'], equipment: ['item_id'], products: ['item_id'] };
// Copied, then re-pointed to the new master ids (a demo source's stand-in ids), so not compared.
// users.password_hash is blanked after the copy (the hashes are in core).
const SUM_SKIP: Record<string, string[]> = { entry_master_values: ['item_id', 'product_item_id'], users: ['password_hash'] };
// Core's password hash format (apps/core/server/passwords.ts), for --demo-password only.
const scryptHash = (pw: string, salt = randomBytes(16)) =>
  ['scrypt', 16384, 8, 1, salt.toString('base64'), scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')].join('$');

export interface MoveOptions {
  source: Sql;                 // the standalone Logbook database; read in one snapshot, never written
  logbook: Sql;                // the platform's logbook database as a superuser (triggers stay off while rows are copied)
  identity: Sql;               // core's identity database
  masterData: Sql;             // core's master_data database
  by: string;                  // core login of the person running the move
  verifiedBy: string;          // 21 CFR 11.100(b): who verified each moved person's identity (from the site, D-29 5)
  verifiedHow: string;
  demoPassword?: string;       // demo databases only: people without a password hash get this one, to change at first use
  dryRun?: boolean;
}

export interface MoveRow { type: 'user' | 'item' | 'product' | 'table'; localId: string; code: string; masterId: string; note: string }
export interface MoveResult { rows: MoveRow[]; problems: string[]; moved: boolean }

interface User { id: number; username: string; full_name: string; password_hash: string; must_change_password: boolean;
  password_changed_at: Date; temp_password_expires_at: Date | null; failed_attempts: number; locked_at: Date | null; active: boolean; roles: Role[] }
interface Item { id: number; code: string; name: string; kind: 'equipment' | 'instrument' | 'area'; location: string; active: boolean;
  needs_calibration: boolean; make: string | null; model: string | null; serial: string | null; item_id: string | null }
interface Product { id: number; code: string; name: string; active: boolean; item_id: string | null }

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function tables(q: Sql | Tx): Promise<Map<string, string[]>> {
  const rows = await q<{ t: string; c: string }[]>`
    select c.table_name as t, c.column_name as c from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' order by c.table_name, c.ordinal_position`;
  const m = new Map<string, string[]>();
  for (const r of rows) if (!SKIP.has(r.t) && !MAPPED[r.t]?.includes(r.c)) m.set(r.t, [...(m.get(r.t) ?? []), r.c]);
  return m;
}

// Row count and a checksum over the given columns, independent of row order (PL-13).
async function checksum(q: Sql | Tx, table: string, cols: string[], skip: string[] = []) {
  const list = cols.filter((c) => !skip.includes(c)).map(ident).join(', ');
  const [r] = await q.unsafe<{ n: number; sum: string }[]>(
    `select count(*)::int as n, coalesce(md5(string_agg(h, '' order by h)), '') as sum from (select md5(row(${list})::text) as h from ${ident(table)}) x`);
  return `${r!.n} ${r!.sum}`;
}

// Both ends print values the same way, whatever the database's own settings (the checksums compare text).
const pin = (q: Tx) => q.unsafe(`set local datestyle = 'ISO, YMD'; set local intervalstyle = 'postgres'; set local bytea_output = 'hex';
  set local extra_float_digits = 1; set local timezone = 'UTC'`);

export async function moveToPlatform(o: MoveOptions): Promise<MoveResult> {
  const problems: string[] = [];
  const rows: MoveRow[] = [];
  return o.source.begin('isolation level repeatable read read only', async (src) => {
    await pin(src);
    const employee = new Map<number, string>();
    const master = new Map<string, string>();   // 'item/<id>' | 'product/<id>' -> master id
    if (o.demoPassword && !demoDatabaseName((await src<{ d: string }[]>`select current_database() as d`)[0]!.d))
      problems.push('--demo-password is only for a demo or test database');
    // --- Plan (reads only) ---
    const from = await tables(src);
    const to = await tables(o.logbook);
    const copy: [string, string[]][] = [];
    for (const [t, cols] of from) {
      const target = to.get(t);
      if (!target) { problems.push(`table ${t} is not in the platform's logbook database`); continue; }
      const lost = cols.filter((c) => !target.includes(c));
      if (lost.length) problems.push(`table ${t}: columns ${lost.join(', ')} are not in the platform's logbook database`);
      const [{ n }] = (await o.logbook.unsafe(`select count(*)::int as n from ${ident(t)}`)) as unknown as [{ n: number }];
      if (n) problems.push(`table ${t} on the platform is not empty (${n} rows): the move needs a freshly migrated database`);
      copy.push([t, cols]);
    }

    const [me] = await o.identity<{ id: string; full_name: string }[]>`
      select id, full_name from employee_current where login = ${o.by} and active`;
    if (!me) problems.push(`no active core employee with login ${o.by} (--by)`);
    if (!o.verifiedBy.trim() || !o.verifiedHow.trim()) problems.push('the identity verification (--verified-by, --verified-how) is required (11.100(b))');

    const users = await src<User[]>`
      select u.id::int, u.username, u.full_name, u.password_hash, u.must_change_password, u.password_changed_at, u.temp_password_expires_at, u.failed_attempts,
        u.locked_at, u.active, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
      from users u left join user_roles r on r.user_id = u.id group by u.id order by u.id`;
    const known = new Set((await o.identity<{ login: string }[]>`select login from employee`).map((r) => r.login));
    const codes = new Set((await o.identity<{ code: string }[]>`select code from current_permission`).map((r) => r.code));
    const local = new Set(users.map((u) => u.username));
    const movers: (User & { codes: string[]; login: string })[] = [];
    for (const u of users) {
      // Core logins start with a letter: a login that starts otherwise gets a "u" in front in core (D-31 2:
      // 1ravi -> u1ravi). The Logbook's own records keep the old login; the report lists the change.
      const login = CORE_LOGIN.test(u.username) ? u.username : `u${u.username}`;
      if (login !== u.username && local.has(login)) problems.push(`login ${u.username} would become ${login}, which another person already has`);
      // A login core already has is someone else's or an earlier, half-finished move: never linked silently.
      if (known.has(login)) problems.push(`login ${login} already exists in core`);
      const refuse = !CORE_LOGIN.test(login) ? 'login does not fit core\'s rule (a letter first, 2 to 40 characters)'
        : !u.password_hash.startsWith('scrypt$') && !o.demoPassword ? 'no password hash'
        : null;
      if (refuse) { rows.push({ type: 'user', localId: String(u.id), code: u.username, masterId: '', note: `refused: ${refuse}` }); continue; }
      if (login !== u.username) rows.push({ type: 'user', localId: String(u.id), code: u.username, masterId: '', note: `renamed: login ${u.username} becomes ${login} in core` });
      // A demo database signed its people on through a stand-in (no local roles): their roles are the demo's own list.
      if (o.demoPassword && !u.roles.length) u.roles = DEMO_USERS.filter(([l]) => l === u.username).map(([, , r]) => r);
      // PL-13: someone deactivated or locked in the Logbook is created inactive in core and gets no permissions, so no
      // later reactivation or unlock in core quietly gives back what the Logbook had taken away.
      const off = !u.active || u.locked_at !== null;
      const want = off ? [] : [...new Set(u.roles.flatMap((r) => [...ROLE_PERMISSIONS[r], ...(r === 'admin' ? ADMIN_CORE : [])]))].sort();
      for (const c of want) if (!codes.has(c)) problems.push(`permission ${c} is not in core's catalogue (is the Logbook licensed?)`);
      movers.push({ ...u, active: !off, codes: want, login });
    }

    const items = await src<Item[]>`
      select e.id::int, e.code, e.name, e.kind, e.location, e.active, e.needs_calibration,
        nullif(btrim(d.details->>'manufacturer'), '') as make, nullif(btrim(d.details->>'model'), '') as model,
        nullif(btrim(d.details->>'serialNumber'), '') as serial, to_jsonb(e)->>'item_id' as item_id
      from equipment e left join lateral (select details from equipment_details x where x.equipment_id = e.id order by version desc limit 1) d on true
      order by e.id`;
    const products = await src<Product[]>`select id::int, code, name, active, to_jsonb(p)->>'item_id' as item_id from products p order by id`;
    const masterKind = (k: Item['kind']) => (k === 'area' ? 'room' : k);
    const existing = new Map((await o.masterData<{ id: string; kind: string; code: string }[]>`select id, kind, code from item`)
      .map((r) => [`${r.kind}/${r.code}`, r.id]));
    for (const i of items) if (!MASTER_CODE.test(i.code)) problems.push(`item ${i.code} cannot be a master data code`);
    for (const p of products) if (!MASTER_CODE.test(p.code)) problems.push(`product ${p.code} cannot be a master data code`);
    // Free-text location -> the room it names (code or name of an area), where one matches.
    const rooms = items.filter((i) => i.kind === 'area');
    const roomOf = (loc: string) => rooms.find((r) => [r.code, r.name].some((x) => x.trim().toLowerCase() === loc.trim().toLowerCase()));

    if (problems.length || o.dryRun) return { rows, problems, moved: false };

    // The whole move is one unit: the three platform databases commit only after every check below has passed. The
    // commits follow one another, innermost first: the logbook database first (it can be dropped and migrated again),
    // then master data and core's identity, whose tables are insert-only. So if the logbook commit fails, nothing
    // was written to core and the move can run again.
    const before = new Map<string, string>();
    for (const [t, cols] of copy) before.set(t, await checksum(src, t, cols));
    await o.identity.begin(async (id) => {
      await o.masterData.begin(async (md) => {
        await o.logbook.begin(async (lb) => {
          await pin(lb);
          await lb`set local session_replication_role = replica`;   // as pg_restore --disable-triggers: insert-only triggers stay quiet
          // --- 1. Rows, data only (PL-13). Rows travel as JSON text, never parsed on the way, in small batches. ---
          for (const [t, cols] of copy) {
            const list = cols.map(ident).join(', ');
            const cursor = src.unsafe<{ r: string }[]>(`select row_to_json(x)::text as r from ${ident(t)} x`).cursor(20);
            for await (const batch of cursor)
              await lb.unsafe(`insert into ${ident(t)} (${list}) overriding system value select ${list} from json_populate_recordset(null::${ident(t)}, $1::text::json)`,
                [`[${batch.map((b) => b.r).join(',')}]`]);
            const after = await checksum(lb, t, cols, SUM_SKIP[t]);
            if (after !== await checksum(src, t, cols, SUM_SKIP[t])) throw new Error(`PL-13: table ${t} differs after the copy; nothing was moved`);
            rows.push({ type: 'table', localId: t, code: before.get(t)!, masterId: '', note: 'copied, count and checksum equal' });
          }
          // Every sequence (identity columns and entry numbers) continues where the source stopped.
          for (const { s } of await src<{ s: string }[]>`select relname as s from pg_class where relkind = 'S' and relnamespace = current_schema()::regnamespace`) {
            const [v] = (await src.unsafe(`select last_value::text as v, is_called as c from ${ident(s)}`)) as unknown as [{ v: string; c: boolean }];
            await lb`select setval(${ident(s)}::regclass, ${v.v}::bigint, ${v.c})`;
          }

          // --- 2. People and permissions in core ---
          const temp = o.demoPassword ? scryptHash(o.demoPassword) : null;
          for (const u of movers) {
            const [e] = await id<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
              values (${u.login}, ${o.verifiedBy}, ${o.verifiedHow}) returning id`;
            await id`insert into employee_version (employee_id, version, full_name, email, active, changed_by, changed_by_name, reason)
              values (${e!.id}, 1, ${u.full_name}, null, ${u.active}, ${me!.id}, ${me!.full_name}, ${REASON})`;
            // A temporary password that had expired stays unusable: core's administrator gives a new one.
            const expired = u.must_change_password && u.temp_password_expires_at !== null && u.temp_password_expires_at < new Date();
            const usable = u.password_hash.startsWith('scrypt$');
            const hash = expired ? 'expired-temporary-password' : usable ? u.password_hash : temp!;
            await id`insert into credential (employee_id, password_hash, must_change, changed_at, failed_count, locked_at)
              values (${e!.id}, ${hash}, ${usable && !expired ? u.must_change_password : true}, ${usable ? u.password_changed_at : new Date()},
                      ${u.failed_attempts}, ${u.locked_at})`;
            for (const code of u.codes)
              await id`insert into permission_grant (employee_id, product, code, granted, by_id, by_name, reason)
                values (${e!.id}, ${code.split('.')[0]!}, ${code}, true, ${me!.id}, ${me!.full_name}, ${`${REASON}: roles ${u.roles.join(', ')}`})`;
            employee.set(u.id, e!.id);
            rows.push({ type: 'user', localId: String(u.id), code: u.username, masterId: e!.id,
              note: (u.active ? u.codes.join(' ') : 'inactive (deactivated or locked in the Logbook): no permissions') + (expired ? ' (temporary password had expired: reset it in core)' : usable ? '' : ' (demo password)') });
          }

          // --- 3. Items and products in master data ---
          const add = async (kind: string, code: string, name: string, active: boolean, fields: object) => {
            const found = existing.get(`${kind}/${code}`);
            if (found) return { id: found, note: 'already in master data' };
            const [i] = await md<{ id: string }[]>`insert into item (kind, code) values (${kind}, ${code}) returning id`;
            await md`insert into item_version (item_id, version, name, fields, active, changed_by, changed_by_name, reason)
              values (${i!.id}, 1, ${name}, ${md.json(fields as never)}, ${active}, ${me!.id}, ${me!.full_name}, ${REASON})`;
            return { id: i!.id, note: 'created' };
          };
          for (const i of [...rooms, ...items.filter((x) => x.kind !== 'area')]) {
            const fields = i.kind === 'area' ? {} : {
              ...(i.make ? { make: i.make } : {}), ...(i.model ? { model: i.model } : {}), ...(i.serial ? { serial: i.serial } : {}),
              ...(i.kind === 'instrument' ? { needsCalibration: i.needs_calibration } : {}),
            };
            const r = await add(masterKind(i.kind), i.code, i.name, i.active, fields);
            master.set(`item/${i.id}`, r.id);
            let note = r.note;
            if (i.kind !== 'area' && i.location.trim()) {
              const room = roomOf(i.location);
              if (room && r.note === 'created') {
                await md`insert into link_event (from_item, to_item, type, active, changed_by, changed_by_name, reason)
                  values (${r.id}, ${master.get(`item/${room.id}`)!}, 'located_in', true, ${me!.id}, ${me!.full_name}, ${REASON})`;
                note += `, located in ${room.code}`;
              } else if (!room) note += `, location "${i.location}" matches no room: not linked`;
            }
            rows.push({ type: 'item', localId: String(i.id), code: i.code, masterId: r.id, note });
          }
          for (const p of products) {
            const r = await add('product', p.code, p.name, p.active, {});
            master.set(`product/${p.id}`, r.id);
            rows.push({ type: 'product', localId: String(p.id), code: p.code, masterId: r.id, note: r.note });
          }

          // --- 4. The id maps. A demo source's entries kept its stand-in master ids (PL-07 values): they follow. ---
          for (const [uid, e] of employee) await lb`update users set employee_id = ${e} where id = ${uid}`;
          // Passwords live in core now: no live hash stays in the Logbook's users table, which the app login can read.
          await lb`update users set password_hash = '-' where password_hash <> '-'`;
          for (const i of items) {
            const to = master.get(`item/${i.id}`)!;
            await lb`update equipment set item_id = ${to} where id = ${i.id}`;
            if (i.item_id) await lb`update entry_master_values set item_id = ${to} where item_id = ${i.item_id}`;
          }
          for (const p of products) {
            const to = master.get(`product/${p.id}`)!;
            await lb`update products set item_id = ${to} where id = ${p.id}`;
            if (p.item_id) await lb`update entry_master_values set product_item_id = ${to} where product_item_id = ${p.item_id}`;
          }

          // --- 5. Checks (PL-13); any problem rolls all three databases back ---
          for (const [t, cols] of copy) {
            const after = await checksum(lb, t, cols, SUM_SKIP[t]);
            if (after !== await checksum(src, t, cols, SUM_SKIP[t])) problems.push(`table ${t} differs from the source after the move`);
          }
          const unmapped = await lb<{ what: string }[]>`
            select 'item ' || code as what from equipment where item_id is null
            union all select 'product ' || code from products where item_id is null
            union all select 'user ' || username from users where employee_id is null and not (id = any(${users.filter((u) => !employee.has(u.id)).map((u) => u.id)}::bigint[]))
            union all select 'entry master value ' || entry_version_id from entry_master_values v
              where not exists (select from equipment e where e.item_id = v.item_id)
                 or (v.product_item_id is not null and not exists (select from products p where p.item_id = v.product_item_id))`;
          problems.push(...unmapped.map((u) => `${u.what} is not mapped`));
          const mc = new Map((await md<{ id: string; kind: string; code: string; name: string }[]>`select id, kind, code, name from item_current`).map((r) => [r.id, r]));
          for (const i of items) {
            const m = mc.get(master.get(`item/${i.id}`)!);
            if (!m || m.code !== i.code || m.name !== i.name || m.kind !== masterKind(i.kind)) problems.push(`item ${i.code}: master data has ${m ? `${m.kind} ${m.code} "${m.name}"` : 'nothing'}`);
          }
          for (const p of products) {
            const m = mc.get(master.get(`product/${p.id}`)!);
            if (!m || m.code !== p.code || m.name !== p.name) problems.push(`product ${p.code}: master data has ${m ? `${m.code} "${m.name}"` : 'nothing'}`);
          }
          const held = await id<{ employee_id: string; code: string }[]>`
            select employee_id, code from current_permission_grant where employee_id = any(${[...employee.values()]}::uuid[])`;
          for (const u of movers) {
            const got = held.filter((h) => h.employee_id === employee.get(u.id)).map((h) => h.code).sort();
            if (got.join() !== u.codes.join()) problems.push(`user ${u.username}: core holds ${got.join(' ') || 'nothing'}, expected ${u.codes.join(' ')}`);
          }
          await lb`set local session_replication_role = origin`;
          const integrity = await checkIntegrity(lb as unknown as Sql);
          problems.push(...integrity.problems.map((p) => `integrity: ${p}`));
          if (problems.length) throw new Rollback();
        });
      });
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    // Rolled back: only the planned refusals are true.
    return problems.length ? { rows: rows.filter((r) => /^(refused|renamed):/.test(r.note)), problems, moved: false } : { rows, problems, moved: true };
  });
}

class Rollback extends Error {}

export function reportCsv(r: MoveResult): string {
  const cell = (v: string) => `"${v.replaceAll('"', '""')}"`;
  return [['type', 'local_id', 'code_or_login', 'master_id', 'note'], ...r.rows.map((x) => [x.type, x.localId, x.code, x.masterId, x.note]),
    ...r.problems.map((p) => ['problem', '', '', '', p])].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values: a } = parseArgs({ options: {
    by: { type: 'string' }, 'verified-by': { type: 'string' }, 'verified-how': { type: 'string' }, report: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'demo-password': { type: 'string' },
  } });
  const source = process.env.SOURCE_DATABASE_URL;
  const platform = process.env.PLATFORM_DATABASE_URL?.replace(/\/+$/, '');
  if (!source || !platform || !a.by || !a.report) throw new Error('SOURCE_DATABASE_URL, PLATFORM_DATABASE_URL, --by and --report are required');
  const db = (name: string) => connect(`${platform}/${name}`);
  const o = { source: connect(source), logbook: db('logbook'), identity: db('identity'), masterData: db('master_data') };
  try {
    const r = await moveToPlatform({ ...o, by: a.by, verifiedBy: a['verified-by'] ?? '', verifiedHow: a['verified-how'] ?? '',
      demoPassword: a['demo-password'], dryRun: a['dry-run'] });
    writeFileSync(a.report, reportCsv(r));
    console.log(`${r.moved ? 'moved' : a['dry-run'] ? 'dry run' : 'not moved'}: ${r.rows.length} rows in ${a.report}, ${r.problems.length} problems`);
    for (const p of r.problems) console.log(`  ${p}`);
    process.exitCode = r.problems.length ? 1 : 0;
  } finally {
    await Promise.all(Object.values(o).map((s) => s.end()));
  }
}
