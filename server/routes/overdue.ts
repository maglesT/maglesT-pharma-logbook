import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { authenticateSigner, contentHash, sign, signBody, SignError } from '../signatures.js';
import { DECISION_LABEL, exceptionContent, OVERDUE_LABEL, SOURCE_PREFIX, type Decision, type ExceptionRow } from '../overdue.js';

// Owner 2026-11-12 (D-37): the missed limits, with the deviation number once Deviations has filed one (read live from
// Deviations' report.deviation_v1; "not linked" without the link).
// D-80 (owner decision, 20 Nov 2026): each missed limit is an exception. A person holding logbook.exception.decide closes
// it here (reason and e-signature, meaning "Closed") or sends it to Deviations; Deviations files only the ones sent.
const DAYS = 90;
const DECIDE = 'logbook.exception.decide' as const;
const closeBody = signBody.extend({ reason: z.string().trim().min(1).max(1000) });

interface Row extends ExceptionRow { detected_at: Date; decision: Decision | null; reason: string | null; decided_by_name: string | null; decided_at: Date | null; signed_by: string | null }

const ROWS = `select o.id::int, o.equipment_id::int, o.code, o.name, o.kind, o.due_at, o.detected_at, o.title,
    d.decision, d.reason, d.decided_by_name, d.decided_at, g.printed_name as signed_by
  from overdue_events o left join overdue_decisions d on d.event_id = o.id
  left join signatures g on g.object_type = 'exception' and g.object_id = o.id and g.meaning = 'closed'`;

export type Exception = ReturnType<typeof present>;
function present(r: Row) {
  return {
    id: r.id, equipmentId: r.equipment_id, code: r.code, name: r.name, kind: r.kind, label: OVERDUE_LABEL[r.kind], dueAt: r.due_at, detectedAt: r.detected_at,
    title: r.title, contentHash: contentHash('exception', r.id, exceptionContent(r)),
    decision: r.decision ? { kind: r.decision, label: DECISION_LABEL[r.decision], reason: r.reason, by: r.decided_by_name?.replace(' before D-80)', ', before missed limits were decided here)') ?? null, at: r.decided_at, signedBy: r.signed_by } : null,
  };
}

/** The missed limits of one item that ran out in a period, with their decision, for the history card (D-80). */
export async function exceptionsOf(sql: Sql, equipmentId: number, from: Date, to: Date): Promise<Exception[]> {
  return (await sql.unsafe<Row[]>(`${ROWS} where o.equipment_id = $1 and o.due_at >= $2 and o.due_at < $3 order by o.due_at, o.id`, [equipmentId, from, to])).map(present);
}

export function overdueRoutes(app: FastifyInstance, sql: Sql) {
  // The last 90 days, and every one still waiting for a decision whatever its age (those first).
  app.get('/api/overdue', { preHandler: requirePermission() }, async (req) => {
    const rows = await sql.unsafe<Row[]>(`${ROWS} where o.detected_at > now() - make_interval(days => $1) or d.id is null
      order by (d.id is null) desc, o.detected_at desc, o.id desc limit 200`, [DAYS]);
    let raised: Map<string, { number: string; status: string }> | null = null;
    let linkError = false;
    if (app.deviations) {
      try { raised = await app.deviations.bySource(SOURCE_PREFIX); } catch { linkError = true; }
    }
    return {
      linked: app.deviations !== null && !linkError,
      mayDecide: req.user!.permissions.includes(DECIDE),
      events: rows.map((r) => ({ ...present(r), deviation: raised?.get(`${SOURCE_PREFIX}${r.id}`) ?? null })),
    };
  });

  const event = async (id: number) => (await sql.unsafe<Row[]>(`${ROWS} where o.id = $1`, [id]))[0];
  const taken = (reply: FastifyReply) => reply.code(409).send({ error: 'already_decided', problems: ['This missed limit has been decided already.'] });
  const unique = (e: unknown) => (e as { code?: string }).code === '23505';

  // Close here: a reason and an e-signature (meaning "Closed").
  app.post<{ Params: { id: string } }>('/api/overdue/:id/close', { preHandler: requirePermission(DECIDE) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = closeBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => i.message) ?? [] });
    const e = await event(id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    if (e.decision) return taken(reply);
    try {
      const signer = await authenticateSigner(sql, app.proofKey, req.user!, body.data, { objectType: 'exception', objectId: id, meaning: 'closed', needs: [DECIDE] });
      await sql.begin(async (tx) => {
        await tx`insert into overdue_decisions (event_id, decision, reason, decided_by, decided_by_name)
          values (${id}, 'closed', ${body.data.reason}, ${req.user!.id}, ${req.user!.fullName})`;
        await sign(tx, { signer, objectType: 'exception', objectId: id, meaning: 'closed', content: exceptionContent(e), shownHash: body.data.contentHash });
        await audit(tx, { actorId: req.user!.id, action: 'exception.closed', objectType: 'equipment', objectId: e.equipment_id,
          new: { event: id, kind: e.kind, dueAt: new Date(e.due_at).toISOString() }, reason: body.data.reason });
      });
      return { ok: true };
    } catch (err) {
      if (unique(err) || (err instanceof SignError && err.code === 'already_signed')) return taken(reply);
      if (err instanceof SignError) return reply.code(err.code === 'wrong_credentials' ? 401 : err.code === 'not_allowed' ? 403 : 409).send({ error: err.code });
      throw err;
    }
  });

  // Send to Deviations, which files it (it reads overdue_v1.sent_at). Only while Deviations is linked.
  app.post<{ Params: { id: string } }>('/api/overdue/:id/send', { preHandler: requirePermission(DECIDE) }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const e = await event(id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    if (e.decision) return taken(reply);
    if (!app.deviations) return reply.code(409).send({ error: 'not_linked', problems: ['Deviations is not linked: close it here.'] });
    try {
      await sql.begin(async (tx) => {
        await tx`insert into overdue_decisions (event_id, decision, decided_by, decided_by_name) values (${id}, 'sent', ${req.user!.id}, ${req.user!.fullName})`;
        await audit(tx, { actorId: req.user!.id, action: 'exception.sent', objectType: 'equipment', objectId: e.equipment_id,
          new: { event: id, kind: e.kind, dueAt: new Date(e.due_at).toISOString() } });
      });
      return { ok: true };
    } catch (err) {
      if (unique(err)) return taken(reply);
      throw err;
    }
  });
}
