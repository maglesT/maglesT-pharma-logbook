import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { migrate } from '../db/migrate.js';
import { freshDb } from './helpers.js';
import type { Sql } from '../server/db.js';

let sql: Sql;
let close: () => Promise<void>;
let app: FastifyInstance;

beforeAll(async () => {
  ({ sql, close } = await freshDb());
  app = await buildApp({ sql, webRoot: '/nonexistent' });
});
afterAll(async () => {
  await app.close();
  await close();
});

describe('skeleton', () => {
  it('health reports ok with database and UTC server time', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.serverTime).toMatch(/Z$/);
  });

  it('migrations are recorded and re-running applies nothing', async () => {
    const rows = await sql`select name from schema_migrations`;
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
    expect(await migrate(sql)).toEqual([]);
  });

  it('unknown API routes return 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
