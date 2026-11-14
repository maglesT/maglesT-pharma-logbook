import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { addToLogbook, needsCalibrationOf, logbookItem, logbookItems, logbookProducts, type LogbookItem, type MasterItem } from '../master.js';
import { classify } from '../../shared/taxonomy.js';

const siteBody = z.object({ name: z.string().trim().min(1).max(120), code: z.string().trim().min(1).max(20), reason: z.string().trim().min(1).max(500) });

// The Logbook's own settings of an item (D-29 3): only whether it is sterile and in a classified room. Its ID, name,
// location, hold times, frequencies and calibration are master data's (platform D-24); its qualification is the
// Qualification product's. The Logbook keeps no copy.
const itemSettings = z.object({
  sterile: z.boolean().optional(),
  classified: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});
// Owner 2026-11-12 (point 4): an item is added by choosing its ID; everything else is pulled.
const addBody = z.object({
  itemId: z.string().uuid(),
  sterile: z.boolean().default(false),
  classified: z.boolean().default(false),
  reason: z.string().trim().min(1).max(500),
});
const QUALIFIED = ['qualified', 'qualified_conditions'];

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
  // Owner 2026-11-14 (D-42): `type`, `paths`, `facilities` and `grade` place the item in the classification
  // (shared/taxonomy.ts) for the Logbooks page's filter; a bench instrument stands where its room is and an item takes
  // its room's facility, so the rooms (area, name) are passed along.
  type Rooms = Map<string, { area: string | null; name: string }>;
  const roomsOf = (all: MasterItem[]): Rooms => new Map(all.filter((m) => m.kind === 'area').map((m) => [m.code, { area: m.area ?? null, name: m.name }]));
  const view = (i: LogbookItem, rooms: Rooms = new Map()) => {
    const room = i.room ? rooms.get(i.room) : undefined;
    return { id: i.id, itemId: i.itemId, code: i.code, name: i.name, kind: i.kind, location: i.room ?? '',
      make: i.make, model: i.model, serial: i.serial, version: i.version, active: i.active, sterile: i.sterile, classified: i.classified,
      ...i.care, needsCalibration: needsCalibrationOf(i),
      ...classify({ kind: i.kind, type: i.type, name: i.name, grade: i.grade, roomArea: room?.area ?? null, roomName: room?.name ?? null }) };
  };
  app.get('/api/equipment', anyUser, async () => {
    const all = await app.master.items();
    const rooms = roomsOf(all);
    return (await logbookItems(sql, app.master, all)).map((i) => view(i, rooms));
  });

  // The master items that can be added: not in the Logbook yet, active, and (with the Qualification link) qualified.
  app.get('/api/equipment/candidates', admin, async () => {
    const [items, inLogbook] = await Promise.all([app.master.items(),
      sql<{ item_id: string }[]>`select item_id::text from equipment where item_id is not null`]);
    const have = new Set(inLogbook.map((r) => r.item_id));
    const qual = app.qualification ? await app.qualification.statuses() : null;
    return {
      qualificationLinked: qual !== null,
      items: items.filter((m) => m.active && !have.has(m.itemId)).map((m) => {
        const q = qual?.get(m.itemId);
        return { itemId: m.itemId, code: m.code, name: m.name, kind: m.kind, location: m.room ?? '', make: m.make, model: m.model, serial: m.serial,
          ...m.care, qualification: q?.status ?? (qual ? 'not_in_qualification' : null), nextReviewDue: q?.nextReviewDue ?? null,
          selectable: !qual || QUALIFIED.includes(q?.status ?? '') };
      }).sort((a, b) => a.code.localeCompare(b.code)),
    };
  });

  app.post('/api/equipment', admin, async (req, reply) => {
    const body = addBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose the item and give the reason.' });
    const m = (await app.master.items()).find((x) => x.itemId === body.data.itemId);
    if (!m) return reply.code(404).send({ error: 'not_found', message: 'This item is not in master data.' });
    if (!m.active) return reply.code(409).send({ error: 'inactive_item', message: `${m.code} is not active in master data.` });
    if (app.qualification) {
      const q = (await app.qualification.statuses()).get(m.itemId);
      if (!q || !QUALIFIED.includes(q.status)) {
        return reply.code(409).send({ error: 'not_qualified', message: `${m.code} is not qualified in the Qualification system${q ? ` (${q.status.replaceAll('_', ' ')})` : ''}: it cannot be added.` });
      }
    }
    if (m.kind === 'area' && body.data.sterile) return reply.code(400).send({ error: 'invalid_request', message: 'A room is not a steriliser.' });
    const id = await sql.begin(async (tx) => {
      const added = await addToLogbook(tx, m, { sterile: body.data.sterile, classified: body.data.classified });
      if (added === null) return null;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.added', objectType: 'equipment', objectId: added,
        new: { itemId: m.itemId, code: m.code, sterile: body.data.sterile, classified: body.data.classified }, reason: body.data.reason });
      return added;
    });
    if (id === null) return reply.code(409).send({ error: 'code_taken', message: `${m.code} is in the Logbook already.` });
    return reply.code(201).send(view((await logbookItem(sql, app.master, id))!));
  });

  // Owner 2026-11-12: the item's protocols in the Qualification system, for a requalification entry pulled from one.
  app.get<{ Params: { id: string } }>('/api/equipment/:id/protocols', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const item = await logbookItem(sql, app.master, id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (!app.qualification) return { linked: false, protocols: [] };
    return { linked: true, protocols: await app.qualification.protocols(item.itemId) };
  });

  app.patch<{ Params: { id: string } }>('/api/equipment/:id', admin, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = itemSettings.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const item = await logbookItem(sql, app.master, id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const { reason, ...changes } = body.data;
    const updated = await sql.begin(async (tx) => {
      const [before] = await tx<{ sterile: boolean; classified: boolean }[]>`select sterile, classified from equipment where id = ${id} for update`;
      const next = { ...before!, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
      const [after] = await tx<{ sterile: boolean; classified: boolean }[]>`
        update equipment set sterile = ${next.sterile}, classified = ${next.classified} where id = ${id} returning sterile, classified`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.updated', objectType: 'equipment', objectId: id, old: before, new: after, reason });
      return after!;
    });
    return view({ ...item, ...updated });
  });

  app.get('/api/products', anyUser, async () =>
    (await logbookProducts(sql, app.master)).map((p) => ({ id: p.id, itemId: p.itemId, code: p.code, name: p.name, active: p.active })));
}
