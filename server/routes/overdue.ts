import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requirePermission } from '../auth.js';
import { OVERDUE_LABEL, SOURCE_PREFIX, type OverdueKind } from '../overdue.js';

// Owner 2026-11-12 (D-37): the missed limits recorded, with the deviation number once Deviations has filed it (read
// live from Deviations' report.deviation_v1; "waiting" until then, "not linked" without the link).
// D-43: a record made since then carries its route: waiting for QA, sent to Deviations (published under its problem id),
// or a Logbook exception. Records made before D-43 were published under the event id.
const DAYS = 90;

export function overdueRoutes(app: FastifyInstance, sql: Sql) {
  app.get('/api/overdue', { preHandler: requirePermission() }, async () => {
    const rows = await sql<{ id: number; equipment_id: number; code: string; name: string; kind: OverdueKind; due_at: Date; detected_at: Date; title: string;
      problem_id: number | null; route: 'deviation' | 'exception' | null; exception_number: string | null }[]>`
      select o.id::int, o.equipment_id::int, o.code, o.name, o.kind, o.due_at, o.detected_at, o.title, p.id::int as problem_id, d.route, d.exception_number
      from overdue_events o left join problems p on p.overdue_event_id = o.id left join problem_decisions d on d.problem_id = p.id
      where o.detected_at > now() - make_interval(days => ${DAYS}) order by o.detected_at desc, o.id desc limit 200`;
    let raised: Map<string, { number: string; status: string }> | null = null;
    let linkError = false;
    if (app.deviations) {
      try { raised = await app.deviations.bySource(SOURCE_PREFIX); } catch { linkError = true; }
    }
    return {
      linked: app.deviations !== null && !linkError,
      events: rows.map((r) => {
        const route = r.problem_id === null ? 'deviation' : r.route ?? 'waiting';
        const d = route === 'deviation' ? raised?.get(`${SOURCE_PREFIX}${r.problem_id ?? r.id}`) ?? null : null;
        return { id: r.id, equipmentId: r.equipment_id, code: r.code, name: r.name, kind: r.kind, label: OVERDUE_LABEL[r.kind],
          dueAt: r.due_at, detectedAt: r.detected_at, title: r.title, problemId: r.problem_id, route, exceptionNumber: r.exception_number, deviation: d };
      }),
    };
  });
}
