import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from './db.js';
import { BACKGROUND_HEADER, SESSION_COOKIE, loadSession } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { alertRoutes } from './routes/alerts.js';
import { masterDataRoutes } from './routes/masterdata.js';
import { settingsRoutes } from './routes/settings.js';
import { entryRoutes } from './routes/entries.js';
import { reviewRoutes } from './routes/review.js';
import { exportRoutes } from './routes/exports.js';
import { integrityRoutes } from './routes/integrity.js';
import { historyRoutes } from './routes/history.js';

export const VERSION = '0.2.0';

export interface AppOptions {
  // Connection running as the restricted application role.
  sql: Sql;
  logger?: boolean;
  webRoot?: string;
  // Secure flag on the session cookie; off only for plain-HTTP development.
  cookieSecure?: boolean;
}

export async function buildApp({ sql, logger = false, webRoot, cookieSecure = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true });
  app.decorate('cookieSecure', cookieSecure);
  await app.register(fastifyCookie);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Writes must be JSON: together with SameSite=Strict cookies this blocks cross-site form posts.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_required' });
    }
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) req.user = (await loadSession(sql, sid, !req.headers[BACKGROUND_HEADER])) ?? undefined;
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      const [row] = await sql<{ now: Date }[]>`select now() as now`;
      return { status: 'ok', version: VERSION, db: 'ok', serverTime: row!.now.toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', version: VERSION, db: 'unreachable' });
    }
  });

  authRoutes(app, sql);
  userRoutes(app, sql);
  alertRoutes(app, sql);
  masterDataRoutes(app, sql);
  settingsRoutes(app, sql);
  entryRoutes(app, sql);
  reviewRoutes(app, sql);
  exportRoutes(app, sql);
  integrityRoutes(app, sql);
  historyRoutes(app, sql);

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

declare module 'fastify' {
  interface FastifyInstance {
    cookieSecure: boolean;
  }
}
