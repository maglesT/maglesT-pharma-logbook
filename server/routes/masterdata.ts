import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole } from '../auth.js';

const siteBody = z.object({ name: z.string().trim().min(1).max(120), code: z.string().trim().min(1).max(20), reason: z.string().trim().min(1).max(500) });

const equipmentFields = {
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120).default(''),
  sterile: z.boolean().default(false),
  classified: z.boolean().default(false),
  cleanHoldHours: z.number().int().positive().max(24 * 365).nullable().default(null),
  // S16: cleaning schedule. Dirty hold: hours from the end of a use until the cleaning. Rooms are operation-based
  // (cleaned after use: dirty hold and clean hold) or frequency-based (cleaned every cleaningFrequencyHours).
  dirtyHoldHours: z.number().int().positive().max(24 * 365).nullable().default(null),
  cleaningBasis: z.enum(['operation', 'frequency']).nullable().optional(),
  cleaningFrequencyHours: z.number().int().positive().max(24 * 365).nullable().default(null),
  // Defaults to true for instruments when not given.
  needsCalibration: z.boolean().optional(),
};
const equipmentCreate = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/),
  kind: z.enum(['equipment', 'instrument', 'area']),
  ...equipmentFields,
});
const equipmentUpdate = z.object({
  name: equipmentFields.name.optional(),
  location: z.string().trim().max(120).optional(),
  sterile: z.boolean().optional(),
  classified: z.boolean().optional(),
  cleanHoldHours: z.number().int().positive().max(24 * 365).nullable().optional(),
  dirtyHoldHours: z.number().int().positive().max(24 * 365).nullable().optional(),
  cleaningBasis: z.enum(['operation', 'frequency']).nullable().optional(),
  cleaningFrequencyHours: z.number().int().positive().max(24 * 365).nullable().optional(),
  needsCalibration: z.boolean().optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});
const productCreate = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(160) });
const productUpdate = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});


// A concurrent insert of the same code (any case) hits the unique index: report it as taken.
const uniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

export function masterDataRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requireRole() };
  const admin = { preHandler: requireRole('admin') };
  const cols = () => sql`id::int, code, name, kind, location, sterile, classified, clean_hold_hours as "cleanHoldHours", dirty_hold_hours as "dirtyHoldHours",
    cleaning_basis as "cleaningBasis", cleaning_frequency_hours as "cleaningFrequencyHours", needs_calibration as "needsCalibration", active`;
  // S16: what the schedule fields allow for each kind of item (the database checks the same).
  const scheduleProblem = (n: { kind: string; cleaningBasis?: string | null; cleaningFrequencyHours: number | null }) =>
    n.kind !== 'area' && (n.cleaningBasis || n.cleaningFrequencyHours) ? 'Only rooms (areas) are operation-based or frequency-based.'
      : n.kind === 'area' && n.cleaningBasis === 'frequency' && !n.cleaningFrequencyHours ? 'A frequency-based room needs its cleaning frequency (hours).'
        : n.kind === 'area' && n.cleaningBasis !== 'frequency' && n.cleaningFrequencyHours ? 'Only a frequency-based room has a cleaning frequency.' : null;

  app.get('/api/site', anyUser, async () => (await sql`select name, code from site where id = 1`)[0] ?? null);

  app.put('/api/site', admin, async (req, reply) => {
    const body = siteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { name, code, reason } = body.data;
    await sql.begin(async (tx) => {
      const [before] = await tx`select name, code from site where id = 1 for update`;
      await tx`insert into site (id, name, code) values (1, ${name}, ${code})
               on conflict (id) do update set name = excluded.name, code = excluded.code`;
      await audit(tx, { actorId: req.user!.id, action: before ? 'site.updated' : 'site.created', objectType: 'site', objectId: 1,
        old: before ?? undefined, new: { name, code }, reason });
    });
    return { name, code };
  });

  app.get('/api/equipment', anyUser, async () => sql`select ${cols()} from equipment order by code`);

  app.post('/api/equipment', admin, async (req, reply) => {
    const body = equipmentCreate.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const e = body.data;
    // Areas cannot be calibrated (review S4-6).
    if (e.kind === 'area' && e.needsCalibration) return reply.code(400).send({ error: 'invalid_request', message: 'Areas cannot need calibration.' });
    // Rooms are operation-based unless the site says otherwise.
    if (e.kind === 'area') e.cleaningBasis ??= 'operation';
    const problem = scheduleProblem(e);
    if (problem) return reply.code(400).send({ error: 'invalid_request', message: problem });
    const created = await sql.begin(async (tx) => {
      // Equipment IDs are never reused, including those of retired items.
      const [taken] = await tx`select 1 from equipment where lower(code) = lower(${e.code})`;
      if (taken) return null;
      const [row] = await tx`
        insert into equipment (code, name, kind, location, sterile, classified, clean_hold_hours, needs_calibration,
                               dirty_hold_hours, cleaning_basis, cleaning_frequency_hours)
        values (${e.code}, ${e.name}, ${e.kind}, ${e.location}, ${e.sterile}, ${e.classified}, ${e.cleanHoldHours},
                ${e.needsCalibration ?? e.kind === 'instrument'}, ${e.dirtyHoldHours}, ${e.cleaningBasis ?? null}, ${e.cleaningFrequencyHours})
        returning ${cols()}`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.created', objectType: 'equipment', objectId: row!.id, new: row });
      return row;
    }).catch((err) => {
      if (uniqueViolation(err)) return null;
      throw err;
    });
    if (!created) return reply.code(409).send({ error: 'code_taken' });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>('/api/equipment/:id', admin, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = equipmentUpdate.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { reason, ...changes } = body.data;
    const updated = await sql.begin(async (tx) => {
      const [before] = await tx`select ${cols()} from equipment where id = ${id} for update`;
      if (!before) return null;
      const next = { ...before, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
      if (next.kind === 'area' && next.needsCalibration) return 'area_calibration' as const;
      const problem = scheduleProblem(next as { kind: string; cleaningBasis: string | null; cleaningFrequencyHours: number | null });
      if (problem) return { problem };
      const [after] = await tx`
        update equipment set name = ${next.name}, location = ${next.location}, sterile = ${next.sterile},
          classified = ${next.classified}, clean_hold_hours = ${next.cleanHoldHours},
          needs_calibration = ${next.needsCalibration}, active = ${next.active},
          dirty_hold_hours = ${next.dirtyHoldHours}, cleaning_basis = ${next.cleaningBasis}, cleaning_frequency_hours = ${next.cleaningFrequencyHours}
        where id = ${id} returning ${cols()}`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.updated', objectType: 'equipment', objectId: id, old: before, new: after, reason });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    if (typeof updated === 'object' && 'problem' in updated) return reply.code(400).send({ error: 'invalid_request', message: updated.problem });
    if (updated === 'area_calibration') return reply.code(400).send({ error: 'invalid_request', message: 'Areas cannot need calibration.' });
    return updated;
  });

  app.get('/api/products', anyUser, async () => sql`select id::int, code, name, active from products order by code`);

  app.post('/api/products', admin, async (req, reply) => {
    const body = productCreate.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const created = await sql.begin(async (tx) => {
      const [taken] = await tx`select 1 from products where lower(code) = lower(${body.data.code})`;
      if (taken) return null;
      const [row] = await tx`insert into products (code, name) values (${body.data.code}, ${body.data.name})
                             returning id::int, code, name, active`;
      await audit(tx, { actorId: req.user!.id, action: 'product.created', objectType: 'product', objectId: row!.id, new: row });
      return row;
    }).catch((err) => {
      if (uniqueViolation(err)) return null;
      throw err;
    });
    if (!created) return reply.code(409).send({ error: 'code_taken' });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>('/api/products/:id', admin, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = productUpdate.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const updated = await sql.begin(async (tx) => {
      const [before] = await tx`select id::int, code, name, active from products where id = ${id} for update`;
      if (!before) return null;
      const [after] = await tx`update products set name = ${body.data.name ?? before.name}, active = ${body.data.active ?? before.active}
                               where id = ${id} returning id::int, code, name, active`;
      await audit(tx, { actorId: req.user!.id, action: 'product.updated', objectType: 'product', objectId: id, old: before, new: after, reason: body.data.reason });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return updated;
  });
}
