import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { logbookItem } from '../master.js';
import { batchesOffNote } from '../batches.js';
import { plantTime } from '../status.js';

// D-85 (fix round 21 Nov 2026): an item is reserved (booked) for a batch or for dates: from when to when, who and why.
// Simple planning, not a GMP record: no e-signature; every reservation and cancellation is in the audit trail and on the
// item's history card. Insert-only: a cancellation is its own row with its reason. A reservation in force shows on the
// item's status (a warning) and in report.equipment_status_v1; while it names a batch, the Logbook records a use of the
// item for that batch only. Who may reserve or cancel: logbook.equipment.reserve (per employee).

const createBody = z.object({
  from: z.coerce.date(),
  until: z.coerce.date(),
  // The batch from the batch records (pulled); typed by hand only when no linked product lists it (D-69).
  batch: z.string().trim().min(1).max(60).optional(),
  batchTyped: z.boolean().default(false),
  purpose: z.string().trim().min(1).max(500),
});
const cancelBody = z.object({ reason: z.string().trim().min(1).max(500) });

interface Row { id: number; from: Date; until: Date; batch: string | null; purpose: string; by: string; created_at: Date;
  cancelled_at: Date | null; cancelled_by: string | null; cancel_reason: string | null }

export function reservationRoutes(app: FastifyInstance, sql: Sql) {
  const reserve = { preHandler: requirePermission('logbook.equipment.reserve') };
  const refuse = (problems: string[], code = 409) => Object.assign(new Error(problems[0]), { statusCode: code, problems });

  // The item's reservations not ended more than 30 days ago, newest start first, with any cancellation.
  app.get<{ Params: { id: string } }>('/api/equipment/:id/reservations', { preHandler: requirePermission() }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await sql<Row[]>`
      select r.id::int, r.starts_at as from, r.ends_at as until, r.batch, r.purpose, r.reserved_by_name as by, r.created_at,
        c.cancelled_at, c.cancelled_by_name as cancelled_by, c.reason as cancel_reason
      from reservations r left join reservation_cancellations c on c.reservation_id = r.id
      where r.equipment_id = ${id} and r.ends_at > now() - interval '30 days'
      order by r.starts_at desc, r.id desc`;
    return rows.map((r) => ({ id: r.id, from: r.from, until: r.until, batch: r.batch, purpose: r.purpose, by: r.by, createdAt: r.created_at,
      cancelled: r.cancelled_at ? { at: r.cancelled_at, by: r.cancelled_by, reason: r.cancel_reason } : null }));
  });

  app.post<{ Params: { id: string } }>('/api/equipment/:id/reservations', reserve, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = createBody.safeParse(req.body);
    if (id === null || !body.success) {
      return reply.code(400).send({ error: 'invalid_request', problems: ['Give the start, the end and why it is reserved.'] });
    }
    const b = body.data;
    const user = req.user!;
    try {
      const item = await logbookItem(sql, app.master, id);
      if (!item) throw refuse(['No such item in the Logbook.'], 404);
      if (!item.active) throw refuse([`${item.code} is not active in master data.`]);
      if (b.until <= b.from) throw refuse(['The end must be after the start.'], 400);
      // D-69: with batch records linked, the batch is one of theirs (in production); typed by hand only when none lists it.
      let batch = b.batch ?? null;
      if (batch && app.batches) {
        const { batch: found, down } = await app.batches.get(batch);
        if (found && !found.inProduction) throw refuse([`Batch ${batch} is not in production in ${found.source} (${found.status}).`]);
        if (found) batch = found.batchNumber;
        else if (!b.batchTyped) {
          throw refuse([`Batch ${batch} is not in the batch records (${app.batches.source}): choose it from the list or type it by hand.`, ...down.map(batchesOffNote)], 400);
        }
      }
      const created = await sql.begin(async (tx) => {
        // One writer per item at a time, so two overlapping reservations cannot both be made.
        await tx`select 1 from equipment where id = ${id} for update`;
        const [clock] = await tx<{ now: Date }[]>`select now() as now`;
        if (b.until <= clock!.now) throw refuse(['The end is in the past: a reservation is for now or later.'], 400);
        const [clash] = await tx<{ from: Date; until: Date; by: string; batch: string | null }[]>`
          select r.starts_at as from, r.ends_at as until, r.reserved_by_name as by, r.batch from reservations r
          where r.equipment_id = ${id} and not exists (select 1 from reservation_cancellations c where c.reservation_id = r.id)
            and r.starts_at < ${b.until} and ${b.from} < r.ends_at
          order by r.starts_at limit 1`;
        if (clash) {
          throw refuse([`${item.code} is already reserved${clash.batch ? ` for batch ${clash.batch}` : ''} from ${plantTime(clash.from)} to ${plantTime(clash.until)} by ${clash.by}.`]);
        }
        const [row] = await tx<{ id: number }[]>`
          insert into reservations (equipment_id, starts_at, ends_at, batch, purpose, reserved_by, reserved_by_name)
          values (${id}, ${b.from}, ${b.until}, ${batch}, ${b.purpose}, ${user.id}, ${user.fullName}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'reservation.created', objectType: 'equipment', objectId: id,
          new: { id: row!.id, from: b.from.toISOString(), until: b.until.toISOString(), batch, purpose: b.purpose, ...(batch && b.batchTyped ? { batchTyped: true } : {}) } });
        return row!.id;
      });
      return reply.code(201).send({ id: created });
    } catch (e) {
      const err = e as { statusCode?: number; problems?: string[] };
      if (err.problems) return reply.code(err.statusCode ?? 409).send({ error: 'check_failed', problems: err.problems });
      throw e;
    }
  });

  app.post<{ Params: { id: string; rid: string } }>('/api/equipment/:id/reservations/:rid/cancel', reserve, async (req, reply) => {
    const id = parseId(req.params.id);
    const rid = parseId(req.params.rid);
    const body = cancelBody.safeParse(req.body);
    if (id === null || rid === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: ['Give the reason for the cancellation.'] });
    const user = req.user!;
    const result = await sql.begin(async (tx) => {
      await tx`select 1 from equipment where id = ${id} for update`;
      const [r] = await tx<{ id: number; from: Date; until: Date; batch: string | null; purpose: string; ended: boolean; cancelled: boolean }[]>`
        select r.id::int, r.starts_at as from, r.ends_at as until, r.batch, r.purpose, r.ends_at <= now() as ended,
          exists (select 1 from reservation_cancellations c where c.reservation_id = r.id) as cancelled
        from reservations r where r.id = ${rid} and r.equipment_id = ${id}`;
      if (!r) return { code: 404, problems: ['No such reservation of this item.'] };
      if (r.cancelled) return { code: 409, problems: ['This reservation is cancelled already.'] };
      if (r.ended) return { code: 409, problems: ['This reservation has ended.'] };
      await tx`insert into reservation_cancellations (reservation_id, reason, cancelled_by, cancelled_by_name)
        values (${rid}, ${body.data.reason}, ${user.id}, ${user.fullName})`;
      await audit(tx, { actorId: user.id, action: 'reservation.cancelled', objectType: 'equipment', objectId: id,
        old: { id: r.id, from: r.from.toISOString(), until: r.until.toISOString(), batch: r.batch, purpose: r.purpose }, reason: body.data.reason });
      return null;
    });
    if (result) return reply.code(result.code).send({ error: 'check_failed', problems: result.problems });
    return { ok: true };
  });
}
