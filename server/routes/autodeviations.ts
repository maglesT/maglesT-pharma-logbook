import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requireRole } from '../auth.js';

// S16b (D-34): the deviations raised automatically for missed cleaning limits (last 90 days), for the dashboard.
export function autoDeviationRoutes(app: FastifyInstance, sql: Sql, deviationsUrl: string | null) {
  app.get('/api/auto-deviations', { preHandler: requireRole() }, async () => ({
    enabled: deviationsUrl !== null,
    deviationsUrl,
    items: await sql`
      select a.id::int, a.equipment_id::int as "equipmentId", q.code, a.kind, a.deadline_at as "deadlineAt", a.detected_at as "detectedAt",
        a.deviation_number as "deviationNumber", a.raised_at as "raisedAt", a.attempts, a.last_error as "lastError"
      from auto_deviations a join equipment q on q.id = a.equipment_id
      where a.detected_at > now() - interval '90 days' order by a.detected_at desc`,
  }));
}
