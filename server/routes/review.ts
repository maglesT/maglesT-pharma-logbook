import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole } from '../auth.js';
import { SignError, authenticateSigner, canonical, contentHash, sign, signBody } from '../signatures.js';
import { ENTRY_COLS, hashOf, present, type EntryRow } from './entries.js';

const periodQuery = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((p) => p.to > p.from, 'to must be after from');

export interface AuditRow {
  id: number;
  at: Date;
  actor: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}

const AUDIT_SELECT = (q: Sql | Tx) => q`
  select a.id::int, a.at, u.full_name as actor, a.action, a.object_type as "objectType", a.object_id as "objectId",
    a.old_value as "oldValue", a.new_value as "newValue", a.reason
  from audit_log a left join users u on u.id = a.actor_id`;

// Every version of the entries whose latest version starts in the period, oldest entry first.
export async function periodVersions(q: Sql | Tx, equipmentId: number, from: Date, to: Date): Promise<EntryRow[]> {
  return q.unsafe<EntryRow[]>(
    `select ${ENTRY_COLS} from entries where entry_id in (
       select l.entry_id from entries l
       where l.equipment_id = $1 and l.activity_start >= $2 and l.activity_start < $3
         and not exists (select 1 from entries x where x.supersedes = l.id))
     order by activity_start, entry_id, version`,
    [equipmentId, from, to] as never[],
  );
}

// Every version of every entry that ever carried this batch number.
export async function batchVersions(q: Sql | Tx, batch: string): Promise<EntryRow[]> {
  return q.unsafe<EntryRow[]>(
    `select ${ENTRY_COLS} from entries where entry_id in (select entry_id from entries where lower(batch) = lower($1))
     order by activity_start, entry_id, version`,
    [batch] as never[],
  );
}

export async function auditFor(q: Sql | Tx, versions: EntryRow[]): Promise<AuditRow[]> {
  if (!versions.length) return [];
  const ids = versions.map((v) => String(v.id));
  return q<AuditRow[]>`${AUDIT_SELECT(q)} where a.object_type = 'entry' and a.object_id = any(${ids}) order by a.at, a.id`;
}

const isLatest = (v: EntryRow, all: EntryRow[]) => !all.some((x) => x.supersedes === v.id);

// What a review signature covers: the latest versions in the period, by id and content hash (LB-25).
function reviewContent(equipmentId: number, from: Date, to: Date, versions: EntryRow[]) {
  return {
    equipmentId,
    from,
    to,
    versions: versions.filter((v) => isLatest(v, versions)).map((v) => ({ id: v.id, hash: hashOf(v) })).sort((a, b) => a.id - b.id),
  };
}

export function reviewRoutes(app: FastifyInstance, sql: Sql) {
  const reviewers = { preHandler: requireRole('qa', 'supervisor') };

  // A logbook period as QA reviews it: entries with history, open items, audit trail, earlier reviews.
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/equipment/:id/period', reviewers, async (req, reply) => {
    const id = parseId(req.params.id);
    const q = periodQuery.safeParse(req.query);
    if (id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { from, to } = q.data;
    const versions = await periodVersions(sql, id, from, to);
    const latest = versions.filter((v) => isLatest(v, versions));
    const open = await sql<{ id: number }[]>`
      select e.id::int from entries e join logbook_settings s on s.id = e.settings_id
      where e.id = any(${latest.map((v) => v.id)}::bigint[])
        and ((e.logbook_type = 'equipment_use' and e.activity_end is null)
          or ((e.logbook_type in ('equipment_cleaning', 'maintenance', 'calibration', 'area_cleaning', 'steriliser_cycle', 'steriliser_test')
               or coalesce((s.settings->>'verificationRequired')::boolean, false))
              and not exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified')))`;
    const openIds = new Set(open.map((o) => o.id));
    const presented = await present(sql, versions);
    const content = reviewContent(id, from, to, versions);
    const reviews = await reviewsFor(sql, id);
    return {
      from,
      to,
      entries: presented.map((p) => ({
        ...p,
        latest: latest.some((l) => l.id === p.id),
        open: openIds.has(p.id),
      })),
      // LB-25 / C4 4.27: the things QA must look at.
      openItems: {
        notFinishedOrNotVerified: openIds.size,
        late: latest.filter((v) => v.late).length,
        corrected: versions.filter((v) => v.change === 'corrected').length,
        failedCalibrations: latest.filter((v) => v.logbook_type === 'calibration' && v.data.result === 'fail').length,
      },
      audit: await auditFor(sql, versions),
      contentHash: contentHash('review', 0, content),
      reviews: reviews.filter((r) => r.periodFrom < to && r.periodTo > from),
    };
  });

  // LB-25: QA signs "Reviewed" for exactly the versions shown.
  app.post<{ Params: { id: string } }>('/api/equipment/:id/reviews', { preHandler: requireRole('qa') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.and(periodQuery).safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { from, to } = body.data;
    try {
      const signer = await authenticateSigner(sql, req.user!, body.data, { objectType: 'review', objectId: 0, meaning: 'reviewed' });
      const reviewId = await sql.begin(async (tx) => {
        // Lock the logbook so no entry lands between reading and signing.
        const [eq] = await tx`select 1 from equipment where id = ${id} for update`;
        if (!eq) throw new SignError('not_allowed');
        const content = reviewContent(id, from, to, await periodVersions(tx, id, from, to));
        if (contentHash('review', 0, content) !== body.data.contentHash) throw new SignError('content_changed');
        const [r] = await tx<{ id: number }[]>`
          insert into reviews (equipment_id, period_from, period_to, content, created_by)
          values (${id}, ${from}, ${to}, ${tx.json(content as never)}, ${req.user!.id}) returning id::int`;
        await audit(tx, { actorId: req.user!.id, action: 'review.created', objectType: 'review', objectId: r!.id, new: content });
        await sign(tx, { signer, objectType: 'review', objectId: r!.id, meaning: 'reviewed', content, shownHash: contentHash('review', r!.id, content) });
        return r!.id;
      });
      return reply.code(201).send({ id: reviewId });
    } catch (e) {
      if (e instanceof SignError) {
        const status = e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409;
        return reply.code(status).send({ error: e.code });
      }
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/api/equipment/:id/reviews', reviewers, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return reviewsFor(sql, id);
  });

  // Batch view (LB-22, CP-05): every entry that references a batch, all versions, with its audit trail.
  app.get<{ Params: { batch: string } }>('/api/batches/:batch', reviewers, async (req) => {
    const versions = await batchVersions(sql, req.params.batch);
    const codes = await sql<{ id: number; code: string }[]>`
      select id::int, code from equipment where id = any(${[...new Set(versions.map((v) => v.equipment_id))]}::bigint[])`;
    const presented = await present(sql, versions);
    return {
      batch: req.params.batch,
      entries: presented.map((p) => ({ ...p, equipmentCode: codes.find((c) => c.id === p.equipmentId)?.code, latest: isLatest(versions.find((v) => v.id === p.id)!, versions) })),
      audit: await auditFor(sql, versions),
    };
  });

  // Audit-trail viewer (LB-18, A11 9): filter by object, user and time.
  app.get<{ Querystring: Record<string, string> }>('/api/audit', { preHandler: requireRole('qa', 'admin') }, async (req, reply) => {
    const f = z
      .object({
        objectType: z.string().max(40).optional(),
        objectId: z.string().max(60).optional(),
        user: z.string().max(40).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .safeParse(req.query);
    if (!f.success) return reply.code(400).send({ error: 'invalid_request' });
    const { objectType, objectId, user, from, to } = f.data;
    return sql<AuditRow[]>`${AUDIT_SELECT(sql)}
      where ${objectType ? sql`a.object_type = ${objectType}` : sql`true`}
        and ${objectId ? sql`a.object_id = ${objectId}` : sql`true`}
        and ${user ? sql`a.actor_id = (select id from users where username = ${user.toLowerCase()})` : sql`true`}
        and ${from ? sql`a.at >= ${from}` : sql`true`}
        and ${to ? sql`a.at < ${to}` : sql`true`}
      order by a.at desc, a.id desc limit 1000`;
  });
}

// Reviews of a logbook; a review is superseded when the versions in its period changed after signing.
export async function reviewsFor(q: Sql | Tx, equipmentId: number) {
  const rows = await q<{ id: number; period_from: Date; period_to: Date; content: { versions: { id: number; hash: string }[] }; printed_name: string | null; signed_at: Date | null }[]>`
    select r.id::int, r.period_from, r.period_to, r.content, g.printed_name, g.signed_at
    from reviews r left join signatures g on g.object_type = 'review' and g.object_id = r.id and g.meaning = 'reviewed'
    where r.equipment_id = ${equipmentId} order by r.period_from desc`;
  return Promise.all(
    rows.map(async (r) => {
      const now = reviewContent(equipmentId, r.period_from, r.period_to, await periodVersions(q, equipmentId, r.period_from, r.period_to));
      return {
        id: r.id,
        periodFrom: r.period_from,
        periodTo: r.period_to,
        reviewedBy: r.printed_name,
        reviewedAt: r.signed_at,
        superseded: canonical(now.versions) !== canonical(r.content.versions),
      };
    }),
  );
}
