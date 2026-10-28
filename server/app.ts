import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from './db.js';

export const VERSION = '0.1.0';

export interface AppOptions {
  sql: Sql;
  logger?: boolean;
  webRoot?: string;
}

export async function buildApp({ sql, logger = false, webRoot }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.get('/api/health', async (_req, reply) => {
    try {
      const [row] = await sql<{ now: Date }[]>`select now() as now`;
      return { status: 'ok', version: VERSION, db: 'ok', serverTime: row!.now.toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', version: VERSION, db: 'unreachable' });
    }
  });

  // In production the built web UI is served from the same process.
  const root = webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  if (existsSync(path.join(root, 'index.html'))) {
    await app.register(fastifyStatic, { root });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
