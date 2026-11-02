import type { FastifyInstance } from 'fastify';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp, type AppOptions } from '../server/app.js';
import type { Identity, SignOn } from '../server/signon.js';
import { makeProof } from '../server/signatures.js';
import { randomUUID } from 'node:crypto';
import type { Role } from '../server/auth.js';

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
}

// Stand-in for Medhanta core (D-29): the people core knows, by login, with their Logbook roles. Tests change an
// entry to revoke a role or deactivate someone (`active: false`); renewals then see it, as core's would.
export const directory = new Map<string, Omit<Identity, 'login' | 'refreshToken' | 'idToken'> & { active: boolean }>();

export function fakeSignOn(people = directory): SignOn {
  const who = (login: string): Identity => {
    const p = people.get(login);
    if (!p?.active) throw new Error('sign-on refused');
    return { ...p, login, roles: [...p.roles], refreshToken: login, idToken: `id-${login}` };
  };
  return {
    // Core would ask for the password; the stand-in signs in whoever login_hint names.
    authUrl: ({ state, loginHint }) => `/cb?${new URLSearchParams({ state, code: loginHint ?? '' })}`,
    exchange: async (code) => who(code),
    refresh: async (token) => who(token),
    // Core's end-session page; here a page of the app itself, so browser tests stay on the test server.
    logoutUrl: (idToken) => `/?signed-out=${idToken ?? ''}`,
  };
}

// Signing proofs (B1-4): what /cb makes after core re-authenticated the person, for the stand-in's people.
export const TEST_PROOF_KEY = Buffer.alloc(32, 7);
export function proofFor(username: string, at?: number): string {
  const p = directory.get(username);
  return makeProof(TEST_PROOF_KEY, { sub: p?.sub ?? '00000000-0000-0000-0000-000000000000', roles: p?.roles ?? [] }, at);
}
export const sig = (username: string) => ({ proof: proofFor(username) });

export async function freshApp(opts: Pick<AppOptions, 'speech' | 'advisor'> = {}): Promise<TestApp> {
  const db = await freshDb();
  const app = await buildApp({ sql: db.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, webRoot: '/nonexistent', ...opts });
  return {
    ...db,
    app,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}


// Seeds a person as core knows them (directory) and their id-map row (D-29: no local password).
export async function seedUser(owner: Sql, username: string, roles: Role[]): Promise<number> {
  const sub = randomUUID();
  directory.set(username, { sub, name: username.toUpperCase(), roles: [...roles], active: true });
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
