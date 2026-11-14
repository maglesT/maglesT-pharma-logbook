import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { logbookItem } from '../master.js';
import { SignError, authenticateSigner, proofOnly, sign } from '../signatures.js';
import { SOURCE_PREFIX } from '../overdue.js';
import {
  DECISION_COLS, PROBLEM_COLS, SEVERITIES, SEVERITY_LABEL, USE_ALLOWED_MAX_DAYS, decisionContent, decisionHash, endOfPlantDay, isWaivable,
  nextExceptionNumber, plantToday, problemHash, problemLabel, type DecisionRow, type ProblemRow,
} from '../problems.js';

// Owner 2026-11-14 (D-43): problems and their QA route decision. See server/problems.ts.

const DECIDE: 'logbook.exception.decide' = 'logbook.exception.decide';
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const reportBody = z.object({
  whatHappened: z.string().trim().min(1).max(2000),
  impact: z.string().trim().min(1).max(2000),
  severity: z.enum(SEVERITIES),
});
const decideBody = z.object({
  route: z.enum(['deviation', 'exception']),
  // Hash of the problem as shown to QA (LB-19): the decision is refused if it is not the same record.
  contentHash: hex64,
  signature: proofOnly,
  justification: z.string().trim().max(2000).optional(),
  impactAssessment: z.string().trim().max(2000).optional(),
  action: z.string().trim().max(2000).optional(),
  useAllowedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

class ProblemError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}
function send(reply: FastifyReply, e: unknown) {
  if (e instanceof ProblemError) return reply.code(e.status).send({ error: e.code, problems: e.problems });
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
  throw e;
}

// A problem with its decision (columns d_*, null while it waits) and the names of who reported and who decided.
type Row = ProblemRow & { [K in keyof DecisionRow as `d_${K}`]: DecisionRow[K] | null } & { reported_by_name: string | null; decided_by_name: string | null };
const COLS = `${PROBLEM_COLS}, ${DECISION_COLS.replaceAll(/d\.(\w+)(::int)?/g, 'd.$1$2 as d_$1')},
  r.full_name as reported_by_name, q.full_name as decided_by_name`;
const FROM = `from problems p left join problem_decisions d on d.problem_id = p.id
  left join users r on r.id = p.reported_by left join users q on q.id = d.decided_by`;

function presentRow(r: Row, now: Date, raised: Map<string, { number: string; status: string }> | null) {
  const p: ProblemRow = r;
  const decision: DecisionRow | null = r.d_id === null ? null : {
    id: r.d_id!, problem_id: r.d_problem_id!, route: r.d_route!, exception_number: r.d_exception_number, justification: r.d_justification,
    impact_assessment: r.d_impact_assessment, action: r.d_action, use_allowed_until: r.d_use_allowed_until, decided_by: r.d_decided_by!, decided_at: r.d_decided_at!,
  };
  return {
    id: p.id, equipmentId: p.equipment_id, code: p.code, name: p.name, location: p.location, source: p.source, dueKind: p.due_kind,
    label: problemLabel(p), title: p.title, whatHappened: p.what_happened, impact: p.impact, severity: p.severity,
    severityLabel: p.severity ? SEVERITY_LABEL[p.severity] : null, reportedBy: r.reported_by_name, createdAt: p.created_at,
    // Continued use may be allowed only for an overdue PM, calibration or requalification; never for a cleaning limit.
    mayAllowUse: p.source === 'overdue' && isWaivable(p.due_kind),
    contentHash: problemHash(p),
    decision: decision && {
      route: decision.route, exceptionNumber: decision.exception_number, justification: decision.justification, impactAssessment: decision.impact_assessment,
      action: decision.action, useAllowedUntil: decision.use_allowed_until, decidedBy: r.decided_by_name, decidedAt: decision.decided_at,
      active: decision.use_allowed_until !== null && decision.use_allowed_until > now,
      deviation: decision.route === 'deviation' ? raised?.get(`${SOURCE_PREFIX}${p.id}`) ?? null : null,
    },
  };
}

export function problemRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };
  const mayDecide = (perms: string[]) => perms.includes(DECIDE);
  const raisedDeviations = async () => {
    if (!app.deviations) return { raised: null, linked: false };
    try { return { raised: await app.deviations.bySource(SOURCE_PREFIX), linked: true }; } catch { return { raised: null, linked: false }; }
  };

  // Everything waiting for a QA decision, oldest first (Home: "Waiting for a QA decision").
  app.get('/api/problems', anyUser, async (req) => {
    const rows = await sql.unsafe<Row[]>(`select ${COLS} ${FROM} where d.id is null order by p.created_at, p.id limit 500`);
    return { mayDecide: mayDecide(req.user!.permissions), problems: rows.map((r) => presentRow(r, new Date(), null)) };
  });

  // One item's problems: waiting, approved exceptions (with their validity), problems sent to Deviations (with the number
  // once Deviations has filed them, read live through the link).
  app.get<{ Params: { id: string } }>('/api/equipment/:id/problems', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await sql.unsafe<Row[]>(`select ${COLS} ${FROM} where p.equipment_id = $1 order by p.created_at desc, p.id desc limit 200`, [id]);
    const { raised, linked } = await raisedDeviations();
    const [now] = await sql<{ now: Date }[]>`select now() as now`;
    return { mayDecide: mayDecide(req.user!.permissions), linked, problems: rows.map((r) => presentRow(r, now!.now, raised)) };
  });

  // Anyone signed in may report a problem on an item: what happened, its impact and severity.
  app.post<{ Params: { id: string } }>('/api/equipment/:id/problems', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = reportBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const b = body.data;
    const user = req.user!;
    try {
      const created = await sql.begin(async (tx) => {
        const item = await logbookItem(tx, app.master, id);
        if (!item) throw new ProblemError(404, 'not_found');
        if (!item.active) throw new ProblemError(409, 'equipment_retired');
        const title = `Problem reported on ${item.code}: ${b.whatHappened.length > 80 ? `${b.whatHappened.slice(0, 77)}…` : b.whatHappened}`;
        const [p] = await tx<{ id: number }[]>`
          insert into problems (equipment_id, source, what_happened, impact, severity, reported_by, code, name, item_kind, location, title)
          values (${id}, 'reported', ${b.whatHappened}, ${b.impact}, ${b.severity}, ${user.id}, ${item.code}, ${item.name}, ${item.kind}, ${item.room ?? ''}, ${title})
          returning id::int`;
        await audit(tx, { actorId: user.id, action: 'problem.reported', objectType: 'problem', objectId: p!.id,
          new: { equipmentId: id, whatHappened: b.whatHappened, impact: b.impact, severity: b.severity, title } });
        return { id: p!.id, title };
      });
      return reply.code(201).send(created);
    } catch (e) {
      return send(reply, e);
    }
  });

  // QA decides the route, with an e-signature: "decided" when sent to Deviations, "approved" for a Logbook exception.
  app.post<{ Params: { id: string } }>('/api/problems/:id/decide', { preHandler: requirePermission(DECIDE) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = decideBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const b = body.data;
    const user = req.user!;
    const meaning = b.route === 'deviation' ? 'decided' : 'approved';
    try {
      const [peek] = await sql<{ decided: boolean }[]>`select exists (select 1 from problem_decisions d where d.problem_id = p.id) as decided from problems p where p.id = ${id}`;
      if (!peek) throw new ProblemError(404, 'not_found');
      if (peek.decided) throw new ProblemError(409, 'already_decided', ['This problem has its decision already.']);
      const signer = await authenticateSigner(sql, app.proofKey, user, b.signature, { objectType: 'problem_decision', objectId: id, meaning, needs: [DECIDE] });
      const result = await sql.begin(async (tx) => {
        const [p] = await tx.unsafe<ProblemRow[]>(`select ${PROBLEM_COLS} from problems p where p.id = $1`, [id]);
        if (!p) throw new ProblemError(404, 'not_found');
        // Decisions on one item are serialised on its equipment row (problems are insert-only, so they cannot be locked).
        await tx`select 1 from equipment where id = ${p.equipment_id} for update`;
        if ((await tx`select 1 from problem_decisions where problem_id = ${id}`).length) throw new ProblemError(409, 'already_decided', ['This problem has its decision already.']);
        if (problemHash(p) !== b.contentHash) throw new SignError('content_changed');
        const problems: string[] = [];
        let until: Date | null = null;
        let number: string | null = null;
        if (b.route === 'exception') {
          if (p.severity === 'critical') problems.push('A critical problem cannot be handled as a Logbook exception: send it to Deviations.');
          if (!b.justification) problems.push('Give the justification.');
          if (!b.impactAssessment) problems.push('Give the impact assessment.');
          if (!b.action) problems.push('State the action taken or planned.');
          if (b.useAllowedUntil) {
            if (p.source !== 'overdue' || !isWaivable(p.due_kind)) {
              problems.push(p.source === 'overdue' ? 'Cleaning cannot be waived: the item stays blocked until it is cleaned and the cleaning verified.'
                : 'Continued use is decided for an overdue PM, calibration or requalification only; a reported problem does not block use.');
            } else {
              const today = await plantToday(tx);
              const last = new Date(Date.parse(`${today}T00:00:00Z`) + USE_ALLOWED_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
              if (b.useAllowedUntil < today || b.useAllowedUntil > last) problems.push(`Use may be allowed until a date between today and ${last} (at most ${USE_ALLOWED_MAX_DAYS} days).`);
              else until = await endOfPlantDay(tx, b.useAllowedUntil);
            }
          }
          if (problems.length) throw new ProblemError(400, 'check_failed', problems);
          number = await nextExceptionNumber(tx);
        } else if (b.justification || b.impactAssessment || b.action || b.useAllowedUntil) {
          throw new ProblemError(400, 'check_failed', ['A problem sent to Deviations is assessed there: no justification, impact assessment, action or continued use here.']);
        }
        const [d] = await tx.unsafe<DecisionRow[]>(
          `insert into problem_decisions (problem_id, route, exception_number, justification, impact_assessment, action, use_allowed_until, decided_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${DECISION_COLS.replaceAll('d.', '')}`,
          [id, b.route, number, b.justification ?? null, b.impactAssessment ?? null, b.action ?? null, until, user.id]);
        await audit(tx, { actorId: user.id, action: 'problem.decided', objectType: 'problem_decision', objectId: d!.id, new: decisionContent(d!) });
        await sign(tx, { signer, objectType: 'problem_decision', objectId: d!.id, meaning, content: decisionContent(d!), shownHash: decisionHash(d!) });
        return d!;
      });
      return reply.code(201).send({ id: result.id, route: result.route, exceptionNumber: result.exception_number, useAllowedUntil: result.use_allowed_until });
    } catch (e) {
      return send(reply, e);
    }
  });
}
