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
import { runIntegrityCheck } from '../server/integrity.js';
import { DEMO_USERS } from './demo-seed.js';

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
  password_changed_at: Date; failed_attempts: number; locked_at: Date | null; active: boolean; roles: Role[] }
interface Item { id: number; code: string; name: string; kind: 'equipment' | 'instrument' | 'area'; location: string; active: boolean;
  needs_calibration: boolean; make: string | null; model: string | null; serial: string | null }
interface Product { id: number; code: string; name: string; active: boolean }

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
async function checksum(q: Sql | Tx, table: string, cols: string[]) {
  const list = cols.map(ident).join(', ');
  const [r] = await q.unsafe<{ n: number; sum: string }[]>(
    `select count(*)::int as n, coalesce(md5(string_agg(h, '' order by h)), '') as sum from (select md5(row(${list})::text) as h from ${ident(table)}) x`);
  return `${r!.n} ${r!.sum}`;
}

export async function moveToPlatform(o: MoveOptions): Promise<MoveResult> {
  const problems: string[] = [];
  const rows: MoveRow[] = [];
  return o.source.begin('isolation level repeatable read read only', async (src) => {
    await src`set local datestyle = 'ISO, YMD'`;
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
      select u.id::int, u.username, u.full_name, u.password_hash, u.must_change_password, u.password_changed_at, u.failed_attempts,
        u.locked_at, u.active, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
      from users u left join user_roles r on r.user_id = u.id group by u.id order by u.id`;
    const known = new Set((await o.identity<{ login: string }[]>`select login from employee`).map((r) => r.login));
    const codes = new Set((await o.identity<{ code: string }[]>`select code from current_permission`).map((r) => r.code));
    const movers: (User & { codes: string[]; hash: string })[] = [];
    for (const u of users) {
      const refuse = !CORE_LOGIN.test(u.username) ? 'login does not fit core\'s rule (a letter first, 2 to 40 characters)'
        : known.has(u.username) ? 'login already exists in core'
        : !u.password_hash.startsWith('scrypt$') && !o.demoPassword ? 'no password hash'
        : null;
      if (refuse) { rows.push({ type: 'user', localId: String(u.id), code: u.username, masterId: '', note: `refused: ${refuse}` }); continue; }
      // A demo database signed its people on through a stand-in (no local roles): their roles are the demo's own list.
      if (o.demoPassword && !u.roles.length) u.roles = DEMO_USERS.filter(([l]) => l === u.username).map(([, , r]) => r);
      const want = [...new Set(u.roles.flatMap((r) => [...ROLE_PERMISSIONS[r], ...(r === 'admin' ? ADMIN_CORE : [])]))].sort();
      for (const c of want) if (!codes.has(c)) problems.push(`permission ${c} is not in core's catalogue (is the Logbook licensed?)`);
      movers.push({ ...u, codes: want, hash: u.password_hash });
    }

    const items = await src<Item[]>`
      select e.id::int, e.code, e.name, e.kind, e.location, e.active, e.needs_calibration,
        nullif(btrim(d.details->>'manufacturer'), '') as make, nullif(btrim(d.details->>'model'), '') as model,
        nullif(btrim(d.details->>'serialNumber'), '') as serial
      from equipment e left join lateral (select details from equipment_details x where x.equipment_id = e.id order by version desc limit 1) d on true
      order by e.id`;
    const products = await src<Product[]>`select id::int, code, name, active from products order by id`;
    const masterKind = (k: Item['kind']) => (k === 'area' ? 'room' : k);
    const existing = new Map((await o.masterData<{ id: string; kind: string; code: string }[]>`select id, kind, code from item`)
      .map((r) => [`${r.kind}/${r.code}`, r.id]));
    for (const i of items) if (!MASTER_CODE.test(i.code)) problems.push(`item ${i.code} cannot be a master data code`);
    for (const p of products) if (!MASTER_CODE.test(p.code)) problems.push(`product ${p.code} cannot be a master data code`);
    // Free-text location -> the room it names (code or name of an area), where one matches.
    const rooms = items.filter((i) => i.kind === 'area');
    const roomOf = (loc: string) => rooms.find((r) => [r.code, r.name].some((x) => x.trim().toLowerCase() === loc.trim().toLowerCase()));

    if (problems.length || o.dryRun) return { rows, problems, moved: false };

    // --- 1. Rows, data only, checked in the same transaction (PL-13) ---
    const before = new Map<string, string>();
    for (const [t, cols] of copy) before.set(t, await checksum(src, t, cols));
    await o.logbook.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;   // as pg_restore --disable-triggers: insert-only triggers stay quiet
      await tx`set local datestyle = 'ISO, YMD'`;
      for (const [t, cols] of copy) {
        const list = cols.map(ident).join(', ');
        const cursor = src.unsafe<{ r: unknown }[]>(`select row_to_json(x) as r from ${ident(t)} x`).cursor(500);
        for await (const batch of cursor) {
          await tx.unsafe(`insert into ${ident(t)} (${list}) overriding system value select ${list} from json_populate_recordset(null::${ident(t)}, $1::text::json)`,
            [JSON.stringify(batch.map((b) => b.r))]);
        }
        const after = await checksum(tx, t, cols);
        if (after !== before.get(t)) throw new Error(`PL-13: table ${t} differs after the copy (before ${before.get(t)}, after ${after}); nothing was moved`);
        rows.push({ type: 'table', localId: t, code: before.get(t)!, masterId: '', note: 'copied, count and checksum equal' });
      }
      // Every sequence (identity columns and entry numbers) continues where the source stopped.
      for (const { s } of await src<{ s: string }[]>`select relname as s from pg_class where relkind = 'S' and relnamespace = current_schema()::regnamespace`) {
        const [v] = (await src.unsafe(`select last_value::text as v, is_called as c from ${ident(s)}`)) as unknown as [{ v: string; c: boolean }];
        await tx`select setval(${ident(s)}::regclass, ${v.v}::bigint, ${v.c})`;
      }
    });

    // --- 2. People and permissions in core ---
    const temp = o.demoPassword ? scryptHash(o.demoPassword) : null;
    const employee = new Map<number, string>();
    await o.identity.begin(async (tx) => {
      for (const u of movers) {
        const [e] = await tx<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
          values (${u.username}, ${o.verifiedBy}, ${o.verifiedHow}) returning id`;
        await tx`insert into employee_version (employee_id, version, full_name, email, active, changed_by, changed_by_name, reason)
          values (${e!.id}, 1, ${u.full_name}, null, ${u.active}, ${me!.id}, ${me!.full_name}, ${REASON})`;
        const usable = u.hash.startsWith('scrypt$');
        await tx`insert into credential (employee_id, password_hash, must_change, changed_at, failed_count, locked_at)
          values (${e!.id}, ${usable ? u.hash : temp!}, ${usable ? u.must_change_password : true}, ${usable ? u.password_changed_at : new Date()},
                  ${u.failed_attempts}, ${u.locked_at})`;
        for (const code of u.codes)
          await tx`insert into permission_grant (employee_id, product, code, granted, by_id, by_name, reason)
            values (${e!.id}, ${code.split('.')[0]!}, ${code}, true, ${me!.id}, ${me!.full_name}, ${`${REASON}: roles ${u.roles.join(', ')}`})`;
        employee.set(u.id, e!.id);
        rows.push({ type: 'user', localId: String(u.id), code: u.username, masterId: e!.id, note: u.codes.join(' ') + (usable ? '' : ' (demo password)') });
      }
    });

    // --- 3. Items and products in master data ---
    const master = new Map<string, string>();   // 'item/<id>' | 'product/<id>' -> master id
    await o.masterData.begin(async (tx) => {
      const add = async (kind: string, code: string, name: string, active: boolean, fields: object) => {
        const id = existing.get(`${kind}/${code}`);
        if (id) return { id, note: 'already in master data' };
        const [i] = await tx<{ id: string }[]>`insert into item (kind, code) values (${kind}, ${code}) returning id`;
        await tx`insert into item_version (item_id, version, name, fields, active, changed_by, changed_by_name, reason)
          values (${i!.id}, 1, ${name}, ${tx.json(fields as never)}, ${active}, ${me!.id}, ${me!.full_name}, ${REASON})`;
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
            await tx`insert into link_event (from_item, to_item, type, active, changed_by, changed_by_name, reason)
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
    });

    // --- 4. The id maps ---
    await o.logbook.begin(async (tx) => {
      for (const [id, e] of employee) await tx`update users set employee_id = ${e} where id = ${id}`;
      for (const i of items) await tx`update equipment set item_id = ${master.get(`item/${i.id}`)!} where id = ${i.id}`;
      for (const p of products) await tx`update products set item_id = ${master.get(`product/${p.id}`)!} where id = ${p.id}`;
    });

    // --- 5. Checks after the move (PL-13) ---
    for (const [t, cols] of copy) {
      const after = await checksum(o.logbook, t, cols);
      if (after !== before.get(t)) problems.push(`table ${t} differs from the source after the move (${before.get(t)} / ${after})`);
    }
    const unmapped = await o.logbook<{ what: string }[]>`
      select 'item ' || code as what from equipment where item_id is null
      union all select 'product ' || code from products where item_id is null
      union all select 'user ' || username from users where employee_id is null and not (id = any(${users.filter((u) => !employee.has(u.id)).map((u) => u.id)}::bigint[]))`;
    problems.push(...unmapped.map((u) => `${u.what} is not mapped`));
    const mc = new Map((await o.masterData<{ id: string; kind: string; code: string; name: string }[]>`select id, kind, code, name from item_current`).map((r) => [r.id, r]));
    for (const i of items) {
      const m = mc.get(master.get(`item/${i.id}`)!);
      if (!m || m.code !== i.code || m.name !== i.name || m.kind !== masterKind(i.kind)) problems.push(`item ${i.code}: master data has ${m ? `${m.kind} ${m.code} "${m.name}"` : 'nothing'}`);
    }
    for (const p of products) {
      const m = mc.get(master.get(`product/${p.id}`)!);
      if (!m || m.code !== p.code || m.name !== p.name) problems.push(`product ${p.code}: master data has ${m ? `${m.code} "${m.name}"` : 'nothing'}`);
    }
    const held = await o.identity<{ employee_id: string; code: string }[]>`
      select employee_id, code from current_permission_grant where employee_id = any(${[...employee.values()]}::uuid[])`;
    for (const u of movers) {
      const got = held.filter((h) => h.employee_id === employee.get(u.id)).map((h) => h.code).sort();
      if (got.join() !== u.codes.join()) problems.push(`user ${u.username}: core holds ${got.join(' ') || 'nothing'}, expected ${u.codes.join(' ')}`);
    }
    const integrity = await runIntegrityCheck(o.logbook);
    problems.push(...integrity.problems.map((p) => `integrity: ${p}`));
    return { rows, problems, moved: true };
  });
}

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
