import type { FastifyInstance } from 'fastify';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp, type AppOptions } from '../server/app.js';
import type { Identity, SignOn } from '../server/signon.js';
import { MEANINGS, makeProof } from '../server/signatures.js';
import { addToLogbook, ConnectionOff, logbookProducts, NO_CARE, type Care, type Kind, type Master, type MasterItem, type MasterProduct } from '../server/master.js';
import { randomUUID } from 'node:crypto';
import { permissionsOf, type Role } from '../server/auth.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://logbook_owner:dev@localhost:5432/logbook_test';

export interface TestDb {
  // Owner connection: migrations and test setup only.
  owner: Sql;
  // Restricted application connection, as the app uses it in production.
  sql: Sql;
  // Where this schema's report views are (S15): `report` on a site, <schema>_report in tests.
  reportSchema: string;
  close: () => Promise<void>;
}

// A fresh schema per test file keeps files independent when Vitest runs them in parallel.
export async function freshDb(): Promise<TestDb> {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const owner = connect(TEST_DATABASE_URL, { searchPath: schema });
  await owner.unsafe(`create schema ${schema}`);
  await migrate(owner);
  const sql = connect(TEST_DATABASE_URL, { role: 'logbook_app', searchPath: schema });
  return {
    owner,
    sql,
    reportSchema: `${schema}_report`,
    close: async () => {
      await sql.end();
      await owner.unsafe(`drop schema ${schema} cascade`);
      await owner.unsafe(`drop schema if exists ${schema}_report cascade`);
      await owner.end();
    },
  };
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
  master: FakeMaster;
}

// Stand-in for master_data's views (D-29): tests add, rename, retire items and cut the link.
export interface FakeMaster extends Master {
  items_: Map<string, MasterItem>;
  products_: Map<string, MasterProduct>;
  cut: boolean;
}
export function fakeMaster(): FakeMaster {
  const m: FakeMaster = {
    items_: new Map(), products_: new Map(), cut: false,
    items: async () => { if (m.cut) throw new ConnectionOff(); return [...m.items_.values()].map((i) => ({ ...i })); },
    products: async () => { if (m.cut) throw new ConnectionOff(); return [...m.products_.values()].map((p) => ({ ...p })); },
  };
  return m;
}

export interface ItemBody extends Partial<Care> {
  code: string; name?: string; kind?: Kind; location?: string; make?: string; model?: string; serial?: string;
  sterile?: boolean; classified?: boolean; needsCalibration?: boolean;
}
// Adds an item to master data as core would (with its parameters, platform D-24), then to the Logbook; returns its local id.
export async function addItem(t: TestApp, b: ItemBody): Promise<number> {
  const kind = b.kind ?? 'equipment';
  const care: Care = { ...NO_CARE, cleaningBasis: kind === 'area' ? 'operation' : null };
  for (const k of Object.keys(NO_CARE) as (keyof Care)[]) if (b[k] !== undefined) (care as unknown as Record<string, unknown>)[k] = b[k];
  const m: MasterItem = { itemId: randomUUID(), code: b.code, name: b.name ?? `Item ${b.code}`, version: 1, active: true, kind,
    room: kind === 'area' ? null : (b.location || null), make: b.make ?? null, model: b.model ?? null, serial: b.serial ?? null,
    needsCalibration: b.needsCalibration ?? kind === 'instrument', care };
  t.master.items_.set(b.code, m);
  return (await addToLogbook(t.sql, m, { sterile: b.sterile ?? false, classified: b.classified ?? false }))!;
}
// Changes an item in master data (a new version), e.g. a rename or retirement.
export function changeItem(t: TestApp, code: string, change: Partial<Pick<MasterItem, 'name' | 'active' | 'room'>>) {
  const i = t.master.items_.get(code)!;
  t.master.items_.set(code, { ...i, ...change, version: i.version + 1 });
}
// Adds a product to master data; returns its local id.
export async function addProduct(t: TestApp, code: string, name: string, active = true): Promise<number> {
  t.master.products_.set(code, { itemId: randomUUID(), code, name, version: 1, active });
  return (await logbookProducts(t.sql, t.master)).find((p) => p.code === code)!.id;
}

// Stand-in for Medhanta core (D-29): the people core knows, by login, with their Logbook permissions. Tests change an
// entry to revoke a permission or deactivate someone (`active: false`); renewals then see it, as core's would.
export const directory = new Map<string, Omit<Identity, 'login' | 'refreshToken' | 'idToken'> & { active: boolean }>();

export function fakeSignOn(people = directory): SignOn {
  const who = (login: string): Identity => {
    const p = people.get(login);
    if (!p?.active) throw new Error('sign-on refused');
    return { ...p, login, permissions: [...p.permissions], refreshToken: login, idToken: `id-${login}`, authTime: Math.floor(Date.now() / 1000) };
  };
  return {
    // Core would ask for the password; the stand-in signs in whoever login_hint names.
    authUrl: ({ state, loginHint }) => `/cb?${new URLSearchParams({ state, code: loginHint ?? '' })}`,
    exchange: async (code) => who(code),
    refresh: async (token) => who(token),
    // Core's end-session page; here a page of the app itself, so browser tests stay on the test server.
    logoutUrl: (idToken) => `/?signed-out=${idToken ?? ''}`,
    // Core's signed logout token; the stand-in's is "logout:<sub>" (the real check is in test/backchannel.test.ts).
    verifyLogoutToken: async (token) => {
      if (!token.startsWith('logout:') || token.length <= 7) throw new Error('logout token: invalid');
      return { sub: token.slice(7) };
    },
  };
}

// Signing proofs (B1-4): what /cb makes after core re-authenticated the person, for the stand-in's people.
export const TEST_PROOF_KEY = Buffer.alloc(32, 7);
export function proofFor(username: string, at?: number, meanings: string[] = [...MEANINGS]): string {
  const p = directory.get(username);
  return makeProof(TEST_PROOF_KEY, { sub: p?.sub ?? '00000000-0000-0000-0000-000000000000', permissions: p?.permissions ?? [] }, meanings, at);
}
export const sig = (username: string) => ({ proof: proofFor(username) });

export async function freshApp(opts: Pick<AppOptions, 'speech' | 'advisor' | 'qualification'> = {}): Promise<TestApp> {
  const db = await freshDb();
  const master = fakeMaster();
  const app = await buildApp({ sql: db.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master, webRoot: '/nonexistent', ...opts });
  return {
    ...db,
    app,
    master,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}


// Seeds a person as core knows them (directory), with the permissions of the old roles (D-30), and their id-map row
// (D-29: no local password).
export async function seedUser(owner: Sql, username: string, roles: Role[]): Promise<number> {
  const sub = randomUUID();
  directory.set(username, { sub, name: username.toUpperCase(), permissions: permissionsOf(roles), active: true });
  const [u] = await owner<{ id: number }[]>`
    insert into users (employee_id, username, full_name, password_hash, must_change_password)
    values (${sub}, ${username}, ${username.toUpperCase()}, '-', false) returning id::int`;
  return u!.id;
}

// Signs on through the stand-in for core: /login, then /cb.
export async function login(app: FastifyInstance, username: string) {
  const start = await app.inject({ method: 'GET', url: `/login?login_hint=${encodeURIComponent(username)}` });
  const pending = start.cookies.find((c) => c.name === 'signon');
  const res = await app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie: `signon=${pending?.value ?? ''}` } });
  const cookie = res.cookies.find((c) => c.name === 'sid');
  return { res, cookie: cookie ? `sid=${cookie.value}` : '' };
}

// JSON request helper carrying the session cookie.
export function call(app: FastifyInstance, cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
}

// Runs one statement as the report role, in its own transaction; returns the rows or the SQLSTATE.
export async function asReport(owner: Sql, statement: string): Promise<{ rows?: Record<string, unknown>[]; error?: string }> {
  try {
    const rows = await owner.begin(async (tx) => {
      await tx.unsafe('set local role logbook_report');
      return tx.unsafe(statement);
    });
    return { rows: [...rows] as Record<string, unknown>[] };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? String(e) };
  }
}
