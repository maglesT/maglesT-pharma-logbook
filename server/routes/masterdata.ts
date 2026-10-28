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
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});
const productCreate = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(160) });
const productUpdate = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});


export function masterDataRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requireRole() };
  const admin = { preHandler: requireRole('admin') };
  const cols = () => sql`id::int, code, name, kind, location, sterile, classified, clean_hold_hours as "cleanHoldHours", active`;

  app.get('/api/site', anyUser, async () => (await sql`select name, code from site where id = 1`)[0] ?? null);

  app.put('/api/site', admin, async (req, reply) => {
    const body = siteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { name, code, reason } = body.data;
    await sql.begin(async (tx) => {
      const [before] = await tx`select name, code from site where id = 1 for update`;
      if (before) await tx`update site set name = ${name}, code = ${code} where id = 1`;
      else await tx`insert into site (id, name, code) values (1, ${name}, ${code})`;
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
    const created = await sql.begin(async (tx) => {
      // Equipment IDs are never reused, including those of retired items.
      const [taken] = await tx`select 1 from equipment where lower(code) = lower(${e.code})`;
      if (taken) return null;
      const [row] = await tx`
        insert into equipment (code, name, kind, location, sterile, classified, clean_hold_hours)
        values (${e.code}, ${e.name}, ${e.kind}, ${e.location}, ${e.sterile}, ${e.classified}, ${e.cleanHoldHours})
        returning ${cols()}`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.created', objectType: 'equipment', objectId: row!.id, new: row });
      return row;
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
      const [after] = await tx`
        update equipment set name = ${next.name}, location = ${next.location}, sterile = ${next.sterile},
          classified = ${next.classified}, clean_hold_hours = ${next.cleanHoldHours}, active = ${next.active}
        where id = ${id} returning ${cols()}`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.updated', objectType: 'equipment', objectId: id, old: before, new: after, reason });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
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
