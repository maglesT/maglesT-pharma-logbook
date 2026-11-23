// The built web UI answers page addresses with the app; anything that looks like a file (dotfiles, *.map, *.js) or a
// hidden path is a plain 404, never the app page. The public health answer carries no version.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { fakeMaster, fakeSignOn, freshDb, TEST_PROOF_KEY, type TestDb } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('static files', () => {
  let db: TestDb;
  let app: FastifyInstance;
  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(path.join(root, 'x.js.map'), '{}');
    db = await freshDb();
    app = await buildApp({ sql: db.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master: fakeMaster(), webRoot: root });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('serves the app page for a page address', async () => {
    for (const url of ['/', '/batches/12', '/some/page?x=1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain('<title>app</title>');
    }
  });
  it('answers 404 for dotfiles, source maps and missing files', async () => {
    for (const url of ['/.env', '/.git/config', '/x.js.map', '/assets/missing.js', '/nope.map']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain('<title>app</title>');
    }
  });
  it('shows no version on the public health answer', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty('version');
  });
});
