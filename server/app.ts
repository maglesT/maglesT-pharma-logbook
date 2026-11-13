import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql, Tx } from './db.js';
import { BACKGROUND_HEADER, SESSION_COOKIE, loadSession } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { masterDataRoutes } from './routes/masterdata.js';
import { settingsRoutes } from './routes/settings.js';
import { entryRoutes } from './routes/entries.js';
import { reviewRoutes } from './routes/review.js';
import { exportRoutes } from './routes/exports.js';
import { integrityRoutes } from './routes/integrity.js';
import { historyRoutes } from './routes/history.js';
import { voiceRoutes } from './routes/voice.js';
import { adviceRoutes } from './routes/advice.js';
import type { SpeechProvider } from './voice.js';
import type { AdviceProvider } from './advice.js';
import type { SignOn } from './signon.js';
import { ConnectionOff, type Master } from './master.js';
import type { Qualification } from './qualification.js';
import type { Deviations } from './overdue.js';
import type { Batches } from './batches.js';
import { batchRoutes } from './routes/batches.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { overdueRoutes } from './routes/overdue.js';
import { statusContext, type StatusContext } from './status.js';

export const VERSION = '0.5.0';

export interface AppOptions {
  // Connection running as the restricted application role.
  sql: Sql;
  // Sign-on through Medhanta core (D-29); tests pass a stand-in.
  signOn: SignOn;
  // Key for the short signing proofs made after core's re-authentication (B1-4); random per process by default.
  proofKey?: Buffer;
  // Master data read live from master_data's views (D-29); tests pass a stand-in.
  master: Master;
  // Owner 2026-11-12: the Qualification product's views (status, requalification due, protocols); null without the link.
  qualification?: Qualification | null;
  // D-37: the Deviations product's deviation_v1 (numbers of the deviations raised for missed limits); null without the link.
  deviations?: Deviations | null;
  // Owner 2026-11-12: Batchwright's batch records (batch_fact_v1, equipment_use_v1); null without the link (batch typed).
  batches?: Batches | null;
  logger?: boolean;
  webRoot?: string;
  // Secure flag on the session cookie; off only for plain-HTTP development.
  cookieSecure?: boolean;
  // Speech service for voice notes (D-26); null when no API key is configured.
  speech?: SpeechProvider | null;
  // Language model for breakdown suggestions (D-27); null when no API key is configured.
  advisor?: AdviceProvider | null;
}

export async function buildApp({ sql, signOn, master, qualification = null, deviations = null, batches = null, proofKey = randomBytes(32), logger = false, webRoot, cookieSecure = true, speech = null, advisor = null }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true });
  app.decorate('cookieSecure', cookieSecure);
  app.decorate('proofKey', proofKey);
  app.decorate('master', master);
  app.decorate('qualification', qualification);
  app.decorate('deviations', deviations);
  app.decorate('batches', batches);
  app.decorate('statusContext', (q: Sql | Tx = sql) => statusContext(q, master, qualification));
  // A cut master-data link stops the feature with one message (platform D-02, PL-08).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConnectionOff) return reply.code(503).send({ error: 'connection_off', message: err.message });
    return reply.send(err);
  });
  await app.register(fastifyCookie);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Writes must be JSON: together with SameSite=Strict cookies this blocks cross-site form posts.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_required' });
    }
    const sid = req.cookies[SESSION_COOKIE];
    // Logout reads the stored session itself: an idle or refused session still yields core's logout hint.
    if (sid && req.url !== '/api/logout') req.user = (await loadSession(sql, signOn, sid, !req.headers[BACKGROUND_HEADER])) ?? undefined;
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      const [row] = await sql<{ now: Date }[]>`select now() as now`;
      return { status: 'ok', version: VERSION, db: 'ok', serverTime: row!.now.toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', version: VERSION, db: 'unreachable' });
    }
  });

  authRoutes(app, sql, signOn);
  masterDataRoutes(app, sql);
  settingsRoutes(app, sql);
  entryRoutes(app, sql);
  reviewRoutes(app, sql);
  exportRoutes(app, sql);
  integrityRoutes(app, sql);
  historyRoutes(app, sql);
  voiceRoutes(app, sql, speech);
  adviceRoutes(app, sql, advisor);
  overdueRoutes(app, sql);
  batchRoutes(app, sql);
  dashboardRoutes(app, sql);

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
    proofKey: Buffer;
    master: Master;
    qualification: Qualification | null;
    deviations: Deviations | null;
    batches: Batches | null;
    // What every status needs from master data and the Qualification product (platform D-24).
    statusContext: (q?: Sql | Tx) => Promise<StatusContext>;
  }
}
