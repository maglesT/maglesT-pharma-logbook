import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requirePermission } from '../auth.js';
import { OVERDUE_LABEL, SOURCE_PREFIX, type OverdueKind } from '../overdue.js';

// Owner 2026-11-12 (D-37): the missed limits recorded for Deviations, with the deviation number once Deviations has
// filed it (read live from Deviations' report.deviation_v1; "waiting" until then, "not linked" without the link).
const DAYS = 90;

export function overdueRoutes(app: FastifyInstance, sql: Sql) {
  app.get('/api/overdue', { preHandler: requirePermission() }, async () => {
    const rows = await sql<{ id: number; equipment_id: number; code: string; name: string; kind: OverdueKind; due_at: Date; detected_at: Date; title: string }[]>`
      select id::int, equipment_id::int, code, name, kind, due_at, detected_at, title from overdue_events
      where detected_at > now() - make_interval(days => ${DAYS}) order by detected_at desc, id desc limit 200`;
    let raised: Map<string, { number: string; status: string }> | null = null;
    let linkError = false;
    if (app.deviations) {
      try { raised = await app.deviations.bySource(SOURCE_PREFIX); } catch { linkError = true; }
    }
    return {
      linked: app.deviations !== null && !linkError,
      events: rows.map((r) => {
        const d = raised?.get(`${SOURCE_PREFIX}${r.id}`) ?? null;
        return { id: r.id, equipmentId: r.equipment_id, code: r.code, name: r.name, kind: r.kind, label: OVERDUE_LABEL[r.kind],
          dueAt: r.due_at, detectedAt: r.detected_at, title: r.title, deviation: d };
      }),
    };
  });
}
