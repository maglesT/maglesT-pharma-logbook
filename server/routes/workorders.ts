import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { logbookItem, logbookItems } from '../master.js';
import { MEANING_LABEL, WO_KIND_LABEL, WO_STATUS_LABEL, auditActionText } from '../labels.js';
import { authenticateSigner, contentHash, sign, signBody, SignError } from '../signatures.js';
import { PLANT_TZ } from '../status.js';
import { csvText, plant, sendCopy, tablesPdf, type PdfTable } from './exports.js';
import { dayText } from '../dates.js';

// Engineering work orders (owner decision, 22 Nov 2026). Raised for an item (from a breakdown, a due preventive
// maintenance or calibration, or by hand), assigned to a person, started, given its work done (text, spare parts, time
// spent), marked Done (the doer's e-signature "Performed") and Closed (a second person's e-signature "Closed", never the
// doer). Permissions per employee: logbook.workorder.raise / .do / .close. A work order raised from a breakdown must be
// closed before the breakdown can be released. Every change is in the audit trail (object type work_order).

const RAISE = 'logbook.workorder.raise' as const;
const DO = 'logbook.workorder.do' as const;
const CLOSE = 'logbook.workorder.close' as const;
const KINDS = ['breakdown', 'preventive', 'calibration', 'other'] as const;
const STATUSES = ['open', 'in_progress', 'done', 'closed'] as const;

const raiseBody = z.object({
  equipmentId: z.number().int().positive(),
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignedTo: z.number().int().positive().nullable().optional(),
  entryId: z.number().int().positive().nullable().optional(),
});
const assignBody = z.object({ userId: z.number().int().positive() });
const part = z.object({ name: z.string().trim().min(1).max(120), partNumber: z.string().trim().max(60).default(''), quantity: z.number().positive().max(100000) });
const workBody = z.object({ workDone: z.string().trim().min(1).max(4000), parts: z.array(part).max(30).default([]), timeMinutes: z.number().int().min(0).max(100000) });

interface Row {
  id: number; number: string; equipment_id: number; code: string; kind: string; title: string; description: string; status: string;
  entry_id: number | null; assigned_to: number | null; assigned_to_name: string | null; target_date: string | null; raised_by_name: string; raised_at: Date;
  started_at: Date | null; work_done: string; parts: { name: string; partNumber: string; quantity: number }[]; time_minutes: number | null;
  done_by: number | null; done_by_name: string | null; done_at: Date | null; closed_by_name: string | null; closed_at: Date | null; overdue: boolean;
}
const COLS = (q: Sql | Tx) => q`w.id::int, w.number, w.equipment_id::int, e.code, w.kind, w.title, w.description, w.status, w.entry_id::int, w.assigned_to::int,
  w.assigned_to_name, w.target_date::text, w.raised_by_name, w.raised_at, w.started_at, w.work_done, w.parts, w.time_minutes, w.done_by::int, w.done_by_name,
  w.done_at, w.closed_by_name, w.closed_at,
  (w.target_date is not null and w.status in ('open', 'in_progress') and w.target_date < (now() at time zone ${PLANT_TZ})::date) as overdue`;
const partsLine = (parts: Row['parts']) => parts.map((p) => `${p.quantity} × ${p.name}${p.partNumber ? ` (P/N ${p.partNumber})` : ''}`).join('; ');
export const timeLine = (m: number | null) => (m === null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

// What a signature covers: the work as it stands (the closer also sees who did it and when).
const doneContent = (r: Row) => ({ number: r.number, equipmentId: r.equipment_id, title: r.title, workDone: r.work_done, parts: r.parts, timeMinutes: r.time_minutes });
const closeContent = (r: Row) => ({ ...doneContent(r), doneBy: r.done_by_name, doneAt: r.done_at?.toISOString() ?? null });

export function workOrderRoutes(app: FastifyInstance, sql: Sql) {
  const refuse = (reply: FastifyReply, problems: string[], code = 409) => reply.code(code).send({ error: 'check_failed', problems });
  const invalid = (reply: FastifyReply, what = 'Some information is missing or not valid.') => reply.code(400).send({ error: 'invalid_request', problems: [what] });
  const one = async (q: Sql | Tx, id: number, lock = false): Promise<Row | undefined> =>
    (await q<Row[]>`select ${COLS(q)} from work_orders w join equipment e on e.id = w.equipment_id where w.id = ${id} ${lock ? q`for update of w` : q``}`)[0];

  const present = (r: Row, mine: { id: number; permissions: readonly string[] }, extra: object = {}) => ({
    id: r.id, number: r.number, equipmentId: r.equipment_id, code: r.code, kind: r.kind, kindLabel: WO_KIND_LABEL[r.kind], title: r.title, description: r.description,
    status: r.status, statusLabel: WO_STATUS_LABEL[r.status], overdue: r.overdue, entryId: r.entry_id, assignedTo: r.assigned_to, assignedToName: r.assigned_to_name,
    targetDate: r.target_date, raisedBy: r.raised_by_name, raisedAt: r.raised_at, startedAt: r.started_at, workDone: r.work_done, parts: r.parts, partsText: partsLine(r.parts),
    timeMinutes: r.time_minutes, timeText: timeLine(r.time_minutes), doneBy: r.done_by_name, doneAt: r.done_at, closedBy: r.closed_by_name, closedAt: r.closed_at,
    mayDo: mine.permissions.includes(DO) && (r.assigned_to === null || r.assigned_to === mine.id),
    mayClose: mine.permissions.includes(CLOSE) && r.done_by !== mine.id,
    ...extra,
  });

  const names = async (q: Sql | Tx, rows: Row[]) => {
    const eq = new Map((await logbookItems(q, app.master)).map((i) => [i.id, i.name]));
    return (id: number) => eq.get(id) ?? '';
  };

  // The people who can be given a work order: the active people of this Logbook.
  app.get('/api/workorders/people', { preHandler: requirePermission() }, async () =>
    (await sql<{ id: number; name: string }[]>`select id::int, full_name as name from users where active order by full_name`));

  app.get<{ Querystring: { status?: string; equipmentId?: string; overdue?: string } }>('/api/workorders', { preHandler: requirePermission() }, async (req, reply) => {
    const status = req.query.status ? z.enum(STATUSES).safeParse(req.query.status) : null;
    if (status && !status.success) return invalid(reply);
    const eqId = req.query.equipmentId ? parseId(req.query.equipmentId) : null;
    const rows = await sql<Row[]>`select ${COLS(sql)} from work_orders w join equipment e on e.id = w.equipment_id
      where ${status ? sql`w.status = ${status.data}` : sql`true`} and ${eqId ? sql`w.equipment_id = ${eqId}` : sql`true`}
      order by w.raised_at desc, w.id desc limit 500`;
    const nameOf = await names(sql, rows);
    const list = req.query.overdue === '1' ? rows.filter((r) => r.overdue) : rows;
    return { mayRaise: req.user!.permissions.includes(RAISE), items: list.map((r) => present(r, req.user!, { name: nameOf(r.equipment_id) })) };
  });

  const detail = async (id: number) => {
    const r = await one(sql, id);
    if (!r) return null;
    const sigs = await sql<{ meaning: string; printed_name: string; signed_at: Date }[]>`
      select meaning, printed_name, signed_at from signatures where object_type = 'work_order' and object_id = ${id} order by signed_at`;
    const log = await sql<{ at: Date; actor: string | null; action: string; new_value: Record<string, unknown> | null; reason: string | null }[]>`
      select a.at, u.full_name as actor, a.action, a.new_value, a.reason from audit_log a left join users u on u.id = a.actor_id
      where a.object_type = 'work_order' and a.object_id = ${String(id)} order by a.at, a.id`;
    return { r, sigs, log };
  };
  const auditLine = (a: { action: string; new_value: Record<string, unknown> | null; reason: string | null }) => {
    const v = a.new_value ?? {};
    const bits = [typeof v.assignedTo === 'string' ? `Assigned to ${v.assignedTo}` : '', typeof v.title === 'string' ? String(v.title) : '',
      typeof v.timeMinutes === 'number' ? `Time spent ${timeLine(v.timeMinutes)}` : '', a.reason ? `Reason: ${a.reason}` : ''].filter(Boolean);
    return `${auditActionText(a.action)}${bits.length ? `: ${bits.join(' · ')}` : ''}`;
  };

  app.get<{ Params: { id: string } }>('/api/workorders/:id', { preHandler: requirePermission() }, async (req, reply) => {
    const id = parseId(req.params.id);
    const d = id === null ? null : await detail(id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const item = await logbookItem(sql, app.master, d.r.equipment_id);
    return present(d.r, req.user!, {
      name: item?.name ?? '', mayRaise: req.user!.permissions.includes(RAISE),
      signatures: d.sigs.map((s) => ({ meaning: MEANING_LABEL[s.meaning] ?? s.meaning, by: s.printed_name, at: s.signed_at })),
      history: d.log.map((a) => ({ at: a.at, by: a.actor ?? 'system', text: auditLine(a) })),
      doneHash: contentHash('work_order', d.r.id, doneContent(d.r)), closeHash: contentHash('work_order', d.r.id, closeContent(d.r)),
    });
  });

  app.post('/api/workorders', { preHandler: requirePermission(RAISE) }, async (req, reply) => {
    const body = raiseBody.safeParse(req.body);
    if (!body.success) return invalid(reply, 'Give the item, the kind and a title.');
    const b = body.data;
    const item = await logbookItem(sql, app.master, b.equipmentId);
    if (!item) return refuse(reply, ['No such item in the Logbook.'], 404);
    if (!item.active) return refuse(reply, [`${item.code} is not active in master data.`]);
    const user = req.user!;
    try {
      const id = await sql.begin(async (tx) => {
        let assignee: { id: number; name: string } | null = null;
        if (b.assignedTo) {
          const [u] = await tx<{ id: number; name: string }[]>`select id::int, full_name as name from users where id = ${b.assignedTo} and active`;
          if (!u) throw Object.assign(new Error('x'), { problems: ['Pick a person from the list.'] });
          assignee = u;
        }
        if (b.entryId) {
          const [br] = await tx`select 1 from entries where entry_id = ${b.entryId} and equipment_id = ${b.equipmentId} and logbook_type = 'maintenance' and data->>'kind' = 'breakdown' limit 1`;
          if (!br) throw Object.assign(new Error('x'), { problems: ['That breakdown is not an entry of this item.'] });
          const [has] = await tx<{ number: string }[]>`select number from work_orders where entry_id = ${b.entryId}`;
          if (has) throw Object.assign(new Error('x'), { problems: [`This breakdown has work order ${has.number} already.`] });
        }
        await tx`select pg_advisory_xact_lock(7301)`;
        const [yn] = await tx<{ year: number; n: number }[]>`
          select y::int as year, (coalesce((select max(seq) from work_orders where year = y), 0) + 1)::int as n
          from (select extract(year from now() at time zone ${PLANT_TZ})::int as y) t`;
        const { year, n } = yn!;
        const number = `WO-${String(year % 100).padStart(2, '0')}-${String(n).padStart(4, '0')}`;
        const [row] = await tx<{ id: number }[]>`
          insert into work_orders (year, seq, number, equipment_id, kind, title, description, entry_id, assigned_to, assigned_to_name, target_date, raised_by, raised_by_name)
          values (${year}, ${n}, ${number}, ${b.equipmentId}, ${b.kind}, ${b.title}, ${b.description}, ${b.entryId ?? null}, ${assignee?.id ?? null}, ${assignee?.name ?? null},
            ${b.targetDate ?? null}, ${user.id}, ${user.fullName}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'workorder.raised', objectType: 'work_order', objectId: row!.id, new: { number, title: b.title, ...(assignee ? { assignedTo: assignee.name } : {}) } });
        return row!.id;
      });
      return reply.code(201).send({ id, number: (await one(sql, id))!.number });
    } catch (e) {
      const p = (e as { problems?: string[] }).problems;
      if (p) return refuse(reply, p, 400);
      throw e;
    }
  });

  // Reassign (or assign) until the work is done.
  app.post<{ Params: { id: string } }>('/api/workorders/:id/assign', { preHandler: requirePermission(RAISE) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = assignBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, 'Pick a person from the list.');
    const user = req.user!;
    return sql.begin(async (tx) => {
      const r = await one(tx, id, true);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      if (r.status === 'done' || r.status === 'closed') return refuse(reply, [`${r.number} is ${WO_STATUS_LABEL[r.status]!.toLowerCase()}: it cannot be given to someone else.`]);
      const [u] = await tx<{ id: number; name: string }[]>`select id::int, full_name as name from users where id = ${body.data.userId} and active`;
      if (!u) return refuse(reply, ['Pick a person from the list.'], 400);
      await tx`update work_orders set assigned_to = ${u.id}, assigned_to_name = ${u.name} where id = ${id}`;
      await audit(tx, { actorId: user.id, action: 'workorder.assigned', objectType: 'work_order', objectId: id, new: { assignedTo: u.name } });
      return { ok: true };
    });
  });

  // The doer's steps all need the work order assigned to them (or to nobody: starting takes it).
  const doerOnly = (r: Row, user: { id: number }) =>
    r.assigned_to !== null && r.assigned_to !== user.id ? [`${r.number} is assigned to ${r.assigned_to_name}: ask for it to be given to you.`] : [];

  app.post<{ Params: { id: string } }>('/api/workorders/:id/start', { preHandler: requirePermission(DO) }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return invalid(reply);
    const user = req.user!;
    return sql.begin(async (tx) => {
      const r = await one(tx, id, true);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      if (r.status !== 'open') return refuse(reply, [`${r.number} is ${WO_STATUS_LABEL[r.status]!.toLowerCase()}, not open.`]);
      const wrong = doerOnly(r, user);
      if (wrong.length) return refuse(reply, wrong, 403);
      await tx`update work_orders set status = 'in_progress', started_at = now(), assigned_to = ${user.id}, assigned_to_name = ${user.fullName} where id = ${id}`;
      await audit(tx, { actorId: user.id, action: 'workorder.started', objectType: 'work_order', objectId: id });
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/api/workorders/:id/work', { preHandler: requirePermission(DO) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = workBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, 'Give the work done, the spare parts (if any) and the time spent.');
    const user = req.user!;
    return sql.begin(async (tx) => {
      const r = await one(tx, id, true);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      if (r.status !== 'in_progress') return refuse(reply, [`Start ${r.number} before recording the work.`]);
      const wrong = doerOnly(r, user);
      if (wrong.length) return refuse(reply, wrong, 403);
      await tx`update work_orders set work_done = ${body.data.workDone}, parts = ${tx.json(body.data.parts as never)}, time_minutes = ${body.data.timeMinutes} where id = ${id}`;
      await audit(tx, { actorId: user.id, action: 'workorder.work_recorded', objectType: 'work_order', objectId: id, new: { timeMinutes: body.data.timeMinutes } });
      return { ok: true };
    });
  });

  const signed = async (req: { user?: Parameters<typeof authenticateSigner>[2] }, reply: FastifyReply, id: number, body: z.infer<typeof signBody>,
    meaning: 'performed' | 'closed', needs: 'logbook.workorder.do' | 'logbook.workorder.close', step: (tx: Tx, r: Row) => Promise<string[] | null>) => {
    try {
      const signer = await authenticateSigner(sql, app.proofKey, req.user!, body, { objectType: 'work_order', objectId: id, meaning, needs: [needs] });
      const problems = await sql.begin(async (tx) => {
        const r = await one(tx, id, true);
        if (!r) return ['No such work order.'];
        const p = await step(tx, r);
        if (p) return p;
        await sign(tx, { signer, objectType: 'work_order', objectId: id, meaning, content: meaning === 'performed' ? doneContent(r) : closeContent(r), shownHash: body.contentHash });
        return null;
      });
      return problems ? refuse(reply, problems) : { ok: true };
    } catch (err) {
      if (err instanceof SignError) return reply.code(err.code === 'wrong_credentials' ? 401 : err.code === 'not_allowed' ? 403 : 409).send({ error: err.code });
      throw err;
    }
  };

  // Done: the doer signs "Performed" for the work as recorded.
  app.post<{ Params: { id: string } }>('/api/workorders/:id/done', { preHandler: requirePermission(DO) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply);
    const user = req.user!;
    return signed(req, reply, id, body.data, 'performed', DO, async (tx, r) => {
      if (r.status !== 'in_progress') return [`${r.number} is ${WO_STATUS_LABEL[r.status]!.toLowerCase()}: only work in progress is marked done.`];
      const wrong = doerOnly(r, user);
      if (wrong.length) return wrong;
      if (!r.work_done.trim() || r.time_minutes === null) return ['Record the work done and the time spent first.'];
      await tx`update work_orders set status = 'done', done_by = ${user.id}, done_by_name = ${user.fullName}, done_at = now() where id = ${r.id}`;
      await audit(tx, { actorId: user.id, action: 'workorder.done', objectType: 'work_order', objectId: r.id });
      return null;
    });
  });

  // Close: a second person signs "Closed"; never the person who did the work.
  app.post<{ Params: { id: string } }>('/api/workorders/:id/close', { preHandler: requirePermission(CLOSE) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply);
    const user = req.user!;
    return signed(req, reply, id, body.data, 'closed', CLOSE, async (tx, r) => {
      if (r.status !== 'done') return [`${r.number} is ${WO_STATUS_LABEL[r.status]!.toLowerCase()}: only work that is done is closed.`];
      if (r.done_by === user.id) return ['A second person closes the work order: not the person who did the work.'];
      await tx`update work_orders set status = 'closed', closed_by = ${user.id}, closed_by_name = ${user.fullName}, closed_at = now() where id = ${r.id}`;
      await audit(tx, { actorId: user.id, action: 'workorder.closed', objectType: 'work_order', objectId: r.id });
      return null;
    });
  });

  // The PDF copy (dates with the year, words, the audit trail in words) and the list as CSV.
  app.get<{ Params: { id: string } }>('/api/workorders/:id/export.pdf', { preHandler: requirePermission() }, async (req, reply) => {
    const id = parseId(req.params.id);
    const d = id === null ? null : await detail(id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const { r } = d;
    const item = await logbookItem(sql, app.master, r.equipment_id);
    const day = (v: string | null) => (v ? dayText(v) : '');
    const fields: [string, string][] = [
      ['Work order', r.number], ['Item', `${r.code}${item ? ` · ${item.name}` : ''}`], ['Kind', WO_KIND_LABEL[r.kind]!], ['Title', r.title], ['Description', r.description],
      ['Status', WO_STATUS_LABEL[r.status]!], ['Raised', `${plant(r.raised_at)} by ${r.raised_by_name}`], ['Assigned to', r.assigned_to_name ?? 'Nobody yet'],
      ['Target date', day(r.target_date)], ['Started', r.started_at ? plant(r.started_at) : ''], ['Work done', r.work_done], ['Spare parts used', partsLine(r.parts) || (r.work_done ? 'None' : '')],
      ['Time spent', timeLine(r.time_minutes)], ['Done', r.done_at ? `${plant(r.done_at)} by ${r.done_by_name}` : ''], ['Closed', r.closed_at ? `${plant(r.closed_at)} by ${r.closed_by_name}` : ''],
    ];
    const tables: PdfTable[] = [
      { heading: 'Work order', columns: ['Field', 'Value'], widths: [110, '*'], rows: fields.filter(([, v]) => v).map((f) => ({ cells: f })) },
      { heading: 'Signatures', columns: ['Meaning', 'Signed by', 'When'], widths: [110, 150, '*'], rows: d.sigs.map((s) => ({ cells: [MEANING_LABEL[s.meaning] ?? s.meaning, s.printed_name, plant(s.signed_at)] })) },
      { heading: 'Audit trail', columns: ['When', 'Who', 'What'], widths: [110, 110, '*'], rows: d.log.map((a) => ({ cells: [plant(a.at), a.actor ?? 'system', auditLine(a)] })) },
    ];
    return sendCopy(reply, 'pdf', `work-order-${r.number}`, await tablesPdf(sql, `Work order ${r.number} · ${r.code}`, `${WO_STATUS_LABEL[r.status]!}. All times plant time.`, tables, req.user!.fullName));
  });

  app.get('/api/workorders.csv', { preHandler: requirePermission() }, async (_req, reply) => {
    const rows = await sql<Row[]>`select ${COLS(sql)} from work_orders w join equipment e on e.id = w.equipment_id order by w.raised_at desc, w.id desc limit 5000`;
    return sendCopy(reply, 'csv', 'work-orders', csvText(['number', 'item', 'kind', 'title', 'status', 'assigned_to', 'raised_by', 'raised_at_utc', 'target_date', 'done_at_utc', 'closed_at_utc'],
      rows.map((r) => [r.number, r.code, r.kind, r.title, r.status, r.assigned_to_name, r.raised_by_name, r.raised_at, r.target_date, r.done_at, r.closed_at])));
  });
}
