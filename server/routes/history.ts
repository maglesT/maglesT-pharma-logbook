import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole } from '../auth.js';
import { canonical } from '../signatures.js';
import { PLANT_TZ, statusOf } from '../status.js';
import {
  breakdowns, breakdownStats, checkDetails, detailsSchema, detailsVersions, inServiceSince, locationHistory, registerQuery,
  type Breakdown,
} from '../breakdowns.js';
import { present, type EntryRow } from './entries.js';
import { csvText, plant, sendCopy, tablesPdf, type PdfTable } from './exports.js';
import { periodVersions, plantRange, reviewsFor } from './review.js';

// S9 (D-25): equipment details, the site-wide breakdown register and the equipment history card.
// Everyone may read them; only Admin changes equipment details, with a reason.

// A history card or register may span many years, unlike a review period (S5: 400 days).
const MAX_DAYS = 3660;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const inRange = (p: { fromDay: string; toDay: string }) => p.toDay >= p.fromDay && (Date.parse(p.toDay) - Date.parse(p.fromDay)) / 86_400_000 < MAX_DAYS;
const historyQuery = z.object({ fromDay: isoDay, toDay: isoDay, types: z.string().max(400).optional() }).refine(inRange, 'invalid period');
const registerPeriod = registerQuery.refine(inRange, 'invalid period');
const detailsBody = z.object({ details: detailsSchema, reason: z.string().trim().min(1).max(500), expectedVersion: z.number().int().min(0) });
const fmt = z.enum(['csv', 'pdf']);

const STATUS_LABEL: Record<string, string> = {
  open: 'Open (repair not finished)', awaiting_verification: 'Awaiting verification', awaiting_release: 'Awaiting QA release', released: 'Released',
};
export const downtimeText = (b: Pick<Breakdown, 'downtimeMinutes' | 'downtimeFinal'>) =>
  `${Math.floor(b.downtimeMinutes / 60)} h ${b.downtimeMinutes % 60} min${b.downtimeFinal ? '' : ' (so far)'}`;

async function today(sql: Sql): Promise<string> {
  const [r] = await sql<{ d: string }[]>`select to_char((now() at time zone ${PLANT_TZ})::date, 'YYYY-MM-DD') as d`;
  return r!.d;
}

async function register(sql: Sql, q: z.infer<typeof registerQuery>) {
  const { from, to } = await plantRange(sql, q.fromDay, q.toDay);
  const now = new Date();
  const items = await breakdowns(sql, from, to, q, now);
  const stats = breakdownStats(items, from, to, now, await inServiceSince(sql, [...new Set(items.map((b) => b.equipmentId))]));
  return { from, to, items, stats };
}

type Event =
  | { kind: 'entry'; at: Date; entry: Awaited<ReturnType<typeof present>>[number] & { latest: boolean }; breakdown?: { downtime: string; parts: string; status: string } }
  | { kind: 'review'; at: Date; review: Awaited<ReturnType<typeof reviewsFor>>[number] }
  | { kind: 'masterdata'; at: Date; actor: string | null; action: string; old: unknown; new: unknown; reason: string | null };

// The life history of one item: every entry version, QA reviews and master-data changes, oldest first.
async function history(sql: Sql, id: number, fromDay: string, toDay: string, types: Set<string> | null) {
  const { from, to } = await plantRange(sql, fromDay, toDay);
  const versions: EntryRow[] = (await periodVersions(sql, id, from, to)).filter((v) => !types || types.has(v.logbook_type));
  const latestIds = new Set(versions.filter((v) => !versions.some((x) => x.supersedes === v.id)).map((v) => v.id));
  const bds = new Map((await breakdowns(sql, new Date(0), new Date('9999-01-01'), { equipmentId: id })).map((b) => [b.entryId, b]));
  const events: Event[] = (await present(sql, versions)).map((e) => {
    const b = e.logbookType === 'maintenance' && e.data.kind === 'breakdown' ? bds.get(e.entryId) : undefined;
    return {
      kind: 'entry' as const,
      at: e.activityStart,
      entry: { ...e, latest: latestIds.has(e.id) },
      ...(b ? { breakdown: { downtime: downtimeText(b), parts: b.partsText, status: STATUS_LABEL[b.status]! } } : {}),
    };
  });
  if (!types || types.has('review')) {
    for (const r of await reviewsFor(sql, id, from, to)) events.push({ kind: 'review', at: r.reviewedAt ?? r.periodTo, review: r });
  }
  if (!types || types.has('masterdata')) {
    const rows = await sql<{ at: Date; actor: string | null; action: string; old_value: unknown; new_value: unknown; reason: string | null }[]>`
      select a.at, u.full_name as actor, a.action, a.old_value, a.new_value, a.reason
      from audit_log a left join users u on u.id = a.actor_id
      where a.object_type = 'equipment' and a.object_id = ${String(id)} and a.at >= ${from} and a.at < ${to}
      order by a.at, a.id`;
    for (const r of rows) events.push({ kind: 'masterdata', at: r.at, actor: r.actor, action: r.action, old: r.old_value, new: r.new_value, reason: r.reason });
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { from, to, events };
}

async function card(sql: Sql, id: number) {
  const [equipment] = await sql`
    select id::int, code, name, kind, location, sterile, classified, clean_hold_hours as "cleanHoldHours",
      needs_calibration as "needsCalibration", active, created_at as "createdAt"
    from equipment where id = ${id}`;
  if (!equipment) return null;
  const versions = await detailsVersions(sql, id);
  return { equipment, details: versions.at(-1) ?? null, detailsVersions: versions, locationHistory: await locationHistory(sql, id), status: await statusOf(sql, id) };
}

const flat = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? canonical(v) : String(v));
const sigText = (e: { signatures: { meaning: string; printedName: string; signedAt: Date | string; valid: boolean }[] }) =>
  e.signatures.map((s) => `${s.meaning}: ${s.printedName}, ${plant(s.signedAt)}${s.valid ? '' : ' [INVALID]'}`).join('; ');

function eventRow(ev: Event): { at: Date; kind: string; what: string; detail: string; who: string; signatures: string; breakdown: string; highlight: boolean; grey: boolean } {
  if (ev.kind === 'entry') {
    const e = ev.entry;
    return {
      at: ev.at,
      kind: e.logbookType,
      what: `#${e.entryId} v${e.version} · ${e.change}${e.latest ? '' : ' (superseded)'}${e.correctionReason ? ` · reason: ${e.correctionReason}` : ''}`,
      detail: `${e.batch ? `Batch ${e.batch} · ` : ''}${flat(e.data)}${e.activityEnd ? ` · until ${plant(e.activityEnd)}` : ''}`,
      who: `${e.enteredBy ?? ''}, ${plant(e.enteredAt)}`,
      signatures: sigText(e),
      breakdown: ev.breakdown ? `Downtime ${ev.breakdown.downtime} · parts: ${ev.breakdown.parts || '—'} · ${ev.breakdown.status}` : '',
      highlight: Boolean(ev.breakdown),
      grey: !e.latest,
    };
  }
  if (ev.kind === 'review') {
    const r = ev.review;
    return { at: ev.at, kind: 'review', what: `QA review ${plant(r.periodFrom)} to ${plant(r.periodTo)}${r.superseded ? ' (superseded)' : ''}`, detail: '', who: r.reviewedBy ?? '', signatures: `reviewed: ${r.reviewedBy ?? ''}, ${plant(r.reviewedAt)}${r.valid ? '' : ' [INVALID]'}`, breakdown: '', highlight: false, grey: false };
  }
  return { at: ev.at, kind: 'master data', what: ev.action, detail: `${ev.reason ? `Reason: ${ev.reason} · ` : ''}${ev.old ? `Old: ${flat(ev.old)} · ` : ''}New: ${flat(ev.new)}`, who: ev.actor ?? 'system', signatures: '', breakdown: '', highlight: false, grey: false };
}

export function historyRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requireRole() };

  app.get<{ Params: { id: string } }>('/api/equipment/:id/details', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return (await card(sql, id)) ?? reply.code(404).send({ error: 'not_found' });
  });

  // A new details version; the old one stays (D-25). expectedVersion guards against overwriting a
  // change made meanwhile.
  app.put<{ Params: { id: string } }>('/api/equipment/:id/details', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = detailsBody.safeParse(req.body);
    if (id === null || !body.success) {
      return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const problems = checkDetails(body.data.details, await today(sql));
    if (problems.length) return reply.code(400).send({ error: 'check_failed', problems });
    const result = await sql.begin(async (tx) => {
      const [eq] = await tx`select 1 from equipment where id = ${id} for update`;
      if (!eq) return { status: 404, error: 'not_found' } as const;
      const [last] = await tx<{ version: number; details: unknown }[]>`
        select version, details from equipment_details where equipment_id = ${id} order by version desc limit 1`;
      if ((last?.version ?? 0) !== body.data.expectedVersion) return { status: 409, error: 'changed_meanwhile' } as const;
      if (last && canonical(last.details) === canonical(body.data.details)) return { status: 400, error: 'no_change' } as const;
      const version = (last?.version ?? 0) + 1;
      const [row] = await tx<{ id: number }[]>`
        insert into equipment_details (equipment_id, version, details, reason, changed_by)
        values (${id}, ${version}, ${tx.json(body.data.details as never)}, ${body.data.reason}, ${req.user!.id}) returning id::int`;
      await audit(tx, { actorId: req.user!.id, action: 'equipment.details_updated', objectType: 'equipment', objectId: id,
        old: last ? { version: last.version, details: last.details } : undefined, new: { id: row!.id, version, details: body.data.details }, reason: body.data.reason });
      return { status: 200, version } as const;
    });
    if (result.status !== 200) return reply.code(result.status).send({ error: result.error });
    return { version: result.version };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/breakdowns', anyUser, async (req, reply) => {
    const q = registerPeriod.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    return register(sql, q.data);
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/breakdowns.:format', anyUser, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const q = registerPeriod.safeParse(req.query);
    if (!format.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { items, stats } = await register(sql, q.data);
    const name = `breakdowns-${q.data.fromDay}-${q.data.toDay}`;
    if (format.data === 'csv') {
      return sendCopy(reply, 'csv', name, csvText(
        ['equipment', 'name', 'location', 'entry_id', 'occurred_utc', 'repair_start_utc', 'repair_end_utc', 'released_utc', 'downtime_minutes', 'downtime_final',
          'category', 'failure', 'root_cause', 'parts', 'done_by', 'work_order', 'deviation', 'status'],
        items.map((b) => [b.code, b.name, b.location, b.entryId, b.occurredAt, b.repairStart, b.repairEnd, b.releasedAt, b.downtimeMinutes, b.downtimeFinal,
          b.failureCategory, b.description, b.rootCause, b.partsText, b.doneBy, b.workOrderRef, b.deviationRef, b.status]),
      ));
    }
    const filters = [q.data.equipmentId && `machine ${items[0]?.code ?? q.data.equipmentId}`, q.data.location && `location ${q.data.location}`,
      q.data.category && `category ${q.data.category}`, q.data.status && `status ${STATUS_LABEL[q.data.status]}`].filter(Boolean).join(', ');
    const tables: PdfTable[] = [
      { heading: `Breakdowns (${items.length})`, columns: ['Machine', 'Occurred', 'Repair end', 'QA released', 'Downtime', 'Category', 'Failure / root cause', 'Parts used', 'Done by / WO', 'Status'],
        widths: [55, 55, 55, 55, 45, 50, '*', 90, 70, 55],
        rows: items.map((b) => ({ cells: [`${b.code}\n${b.name}\n${b.location}`, plant(b.occurredAt), plant(b.repairEnd), plant(b.releasedAt), downtimeText(b),
          b.failureCategory ?? '', `${b.description}${b.rootCause ? `\nRoot cause: ${b.rootCause}` : ''}`, b.partsText, `${b.doneBy}${b.workOrderRef ? `\nWO ${b.workOrderRef}` : ''}`, STATUS_LABEL[b.status]!] })) },
      { heading: 'Per machine', columns: ['Machine', 'Failures', 'Downtime (h)', 'MTTR (h)', 'MTBF (h)'], widths: ['*', 60, 70, 60, 60],
        rows: stats.machines.map((m) => ({ cells: [`${m.code} · ${m.name}`, String(m.failures), String(m.downtimeHours), m.mttrHours === null ? '—' : String(m.mttrHours), m.mtbfHours === null ? '—' : String(m.mtbfHours)] })) },
      { heading: 'Per failure category', columns: ['Category', 'Failures'], widths: ['*', 60], rows: stats.categories.map((c) => ({ cells: [c.category, String(c.failures)] })) },
    ];
    return sendCopy(reply, 'pdf', name, await tablesPdf(sql, 'Breakdown register',
      `Breakdowns that occurred ${q.data.fromDay} to ${q.data.toDay} (plant time)${filters ? ` · ${filters}` : ''}. Downtime runs from occurrence to QA release. MTTR: mean downtime of released breakdowns. MTBF: operating time in the period per failure.`,
      tables, req.user!.fullName));
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/equipment/:id/history', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const q = historyQuery.safeParse(req.query);
    if (id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const head = await card(sql, id);
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const types = q.data.types ? new Set(q.data.types.split(',').filter(Boolean)) : null;
    return { ...head, ...(await history(sql, id, q.data.fromDay, q.data.toDay, types)) };
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/history.:format', anyUser, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const id = parseId(req.query.equipmentId ?? '');
    const q = historyQuery.safeParse(req.query);
    if (!format.success || id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const head = await card(sql, id);
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const types = q.data.types ? new Set(q.data.types.split(',').filter(Boolean)) : null;
    const { events } = await history(sql, id, q.data.fromDay, q.data.toDay, types);
    const rows = events.map(eventRow);
    const eq = head.equipment as { code: string; name: string; kind: string; location: string };
    const name = `history-${eq.code}-${q.data.fromDay}`;
    if (format.data === 'csv') {
      return sendCopy(reply, 'csv', name, csvText(['equipment', 'at_utc', 'kind', 'record', 'details', 'by', 'signatures', 'breakdown'],
        rows.map((r) => [eq.code, r.at, r.kind, r.what, r.detail, r.who, r.signatures, r.breakdown])));
    }
    const d = head.details?.details;
    const detailRows: [string, string][] = [
      ['Equipment', `${eq.code} · ${eq.name} (${eq.kind})`], ['Location', eq.location], ['Status', head.status?.state.replaceAll('_', ' ') ?? ''],
      ...(d ? ([
        ['Asset number', d.assetNumber], ['Manufacturer / model', `${d.manufacturer} ${d.model}`.trim()], ['Serial number', d.serialNumber], ['Capacity / size', d.capacity],
        ['Installed / supplier', `${d.installationDate ?? ''} ${d.supplier}`.trim()], ['Qualification', `${d.qualificationStatus.replaceAll('_', ' ')} · IQ ${d.iq.date ?? '—'} ${d.iq.ref} · OQ ${d.oq.date ?? '—'} ${d.oq.ref} · PQ ${d.pq.date ?? '—'} ${d.pq.ref} · last requalification ${d.lastRequalification ?? '—'}`],
        ['Product contact / MOC', d.productContactMoc], ['SOPs', d.sopRefs], ['Details version', `${head.details!.version}, ${head.details!.changedBy}, ${plant(head.details!.changedAt)}`],
      ] as [string, string][]) : [['Details', 'not recorded']] as [string, string][]),
    ];
    return sendCopy(reply, 'pdf', name, await tablesPdf(sql, `Equipment history card ${eq.code} · ${eq.name}`, `Period ${q.data.fromDay} to ${q.data.toDay} (plant time). All versions; superseded versions grey, breakdowns shaded.`, [
      { heading: 'Equipment', columns: ['Field', 'Value'], widths: [120, '*'], rows: detailRows.map((r) => ({ cells: r })) },
      { heading: 'Location history', columns: ['When', 'By', 'From', 'To', 'Reason'], widths: [90, 90, 120, 120, '*'],
        rows: head.locationHistory.map((l) => ({ cells: [plant(l.at), l.by ?? '', l.from ?? '(created)', l.to, l.reason ?? ''] })) },
      { heading: `History (${rows.length})`, columns: ['When', 'Type', 'Record', 'Details', 'By', 'Signatures'], widths: [70, 70, 90, '*', 80, 130],
        rows: rows.map((r) => ({ cells: [plant(r.at), r.kind.replaceAll('_', ' '), r.what, `${r.breakdown ? `${r.breakdown}\n` : ''}${r.detail}`, r.who, r.signatures], highlight: r.highlight, grey: r.grey })) },
    ], req.user!.fullName));
  });
}

