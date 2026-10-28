import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { freshApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await freshApp();
});
afterAll(() => t.close());

describe('skeleton', () => {
  it('health reports ok with database and UTC server time', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(res.json().serverTime).toMatch(/Z$/);
  });

  it('migrations are recorded and re-running applies nothing', async () => {
    const rows = await t.owner`select name from schema_migrations`;
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
    expect(await migrate(t.owner)).toEqual([]);
  });

  it('unknown API routes return 404', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
