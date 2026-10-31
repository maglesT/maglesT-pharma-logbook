import type { FastifyInstance } from 'fastify';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp, type AppOptions } from '../server/app.js';
import { hashPassword } from '../server/passwords.js';
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

export async function freshApp(opts: Pick<AppOptions, 'speech' | 'advisor'> = {}): Promise<TestApp> {
  const db = await freshDb();
  const app = await buildApp({ sql: db.sql, webRoot: '/nonexistent', ...opts });
  return {
    ...db,
    app,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const PASSWORD = 'Correct-Horse-9';

// Seeds an active user with a known, already-changed password.
export async function seedUser(owner: Sql, username: string, roles: Role[], password = PASSWORD): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await owner<{ id: number }[]>`
    insert into users (username, full_name, password_hash, must_change_password)
    values (${username}, ${username.toUpperCase()}, ${hash}, false) returning id::int`;
  for (const r of roles) await owner`insert into user_roles (user_id, role) values (${u!.id}, ${r})`;
  return u!.id;
}

export async function login(app: FastifyInstance, username: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
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
