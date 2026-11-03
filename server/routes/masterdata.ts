import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { logbookItem, logbookItems, logbookProducts, type LogbookItem } from '../master.js';

const siteBody = z.object({ name: z.string().trim().min(1).max(120), code: z.string().trim().min(1).max(20), reason: z.string().trim().min(1).max(500) });

// The Logbook's own settings of an item (D-29 3); everything else about it is core's master data.
const itemSettings = z.object({
  sterile: z.boolean().optional(),
  classified: z.boolean().optional(),
  // SchM 18.4.4: maximum time clean equipment may wait before use.
  cleanHoldHours: z.number().int().positive().max(24 * 365).nullable().optional(),
  needsCalibration: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});

export function masterDataRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };
  const admin = { preHandler: requirePermission('logbook.site.manage') };
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

  // Items and products are read live from master data (D-29); a cut link answers "connection off".
  const view = (i: LogbookItem) => ({ id: i.id, itemId: i.itemId, code: i.code, name: i.name, kind: i.kind, location: i.room ?? '',
    make: i.make, model: i.model, serial: i.serial, version: i.version, active: i.active,
    sterile: i.sterile, classified: i.classified, cleanHoldHours: i.cleanHoldHours, needsCalibration: i.needsCalibration });
  app.get('/api/equipment', anyUser, async () => (await logbookItems(sql, app.master)).map(view));

  app.patch<{ Params: { id: string } }>('/api/equipment/:id', admin, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = itemSettings.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const item = await logbookItem(sql, app.master, id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const { reason, ...changes } = body.data;
    const cols = (r: { sterile: boolean; classified: boolean; clean_hold_hours: number | null; needs_calibration: boolean }) =>
      ({ sterile: r.sterile, classified: r.classified, cleanHoldHours: r.clean_hold_hours, needsCalibration: r.needs_calibration });
    const updated = await sql.begin(async (tx) => {
      const [before] = await tx`select sterile, classified, clean_hold_hours, needs_calibration from equipment where id = ${id} for update`;
      const next = { ...cols(before as never), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
      // Rooms cannot be calibrated (review S4-6).
      if (item.kind === 'area' && next.needsCalibration) return 'area_calibration' as const;
      const [after] = await tx`
        update equipment set sterile = ${next.sterile}, classified = ${next.classified}, clean_hold_hours = ${next.cleanHoldHours},
          needs_calibration = ${next.needsCalibration}
        where id = ${id} returning sterile, classified, clean_hold_hours, needs_calibration`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.updated', objectType: 'equipment', objectId: id,
        old: cols(before as never), new: cols(after as never), reason });
      return after;
    });
    if (updated === 'area_calibration') return reply.code(400).send({ error: 'invalid_request', message: 'Areas cannot need calibration.' });
    return view({ ...item, ...cols(updated as never) });
  });

  app.get('/api/products', anyUser, async () =>
    (await logbookProducts(sql, app.master)).map((p) => ({ id: p.id, itemId: p.itemId, code: p.code, name: p.name, active: p.active })));
}
