import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { LIMS, UsesOff, useOf, type BatchRecords, type TrueBatchUse, type TrueBatchUses } from '../batches.js';
import { audit } from '../audit.js';
import { CyclesOff, cycleLines, cyclesOffHistoryNote, type SterileCycle, type SterileCycles } from '../cycles.js';
import { needsCalibrationOf, logbookItem, logbookItems, type Master } from '../master.js';
import { parseId, requirePermission } from '../auth.js';
import { changeLines, entryLines } from '../changes.js';
import { FAILURE_CATEGORY_LABEL, ITEM_ACTION_LABEL, STATE_NAME, TYPE_LABEL } from '../labels.js';
import { canonical } from '../signatures.js';
import { SOPS_OFF, pullSops, sopRefsOf } from '../sops.js';
import { PLANT_TZ, plantDay, statusOf, type StatusContext } from '../status.js';
import {
  breakdowns, filterAndSort, breakdownStats, checkDetails, detailsSchema, detailsVersions, locationHistory, registerQuery, reliability,
  type Breakdown,
} from '../breakdowns.js';
import { present, type EntryRow } from './entries.js';
import { exceptionsOf, type Exception } from './overdue.js';
import { csvText, plant, sendCopy, tablesPdf, voiceNoteText, type PdfTable } from './exports.js';
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
// Exports are built in memory: same guard as the period and batch exports (review S5-6, S9).
const MAX_ROWS = 20_000;

const STATUS_LABEL: Record<string, string> = {
  open: 'Open (repair not finished)', awaiting_verification: 'Awaiting verification', awaiting_release: 'Awaiting QA release', released: 'Released',
};
export const downtimeText = (b: Pick<Breakdown, 'downtimeMinutes' | 'downtimeFinal'>) =>
  `${Math.floor(b.downtimeMinutes / 60)} h ${b.downtimeMinutes % 60} min${b.downtimeFinal ? '' : ' (so far)'}`;

async function today(sql: Sql): Promise<string> {
  const [r] = await sql<{ d: string }[]>`select to_char((now() at time zone ${PLANT_TZ})::date, 'YYYY-MM-DD') as d`;
  return r!.d;
}

async function register(sql: Sql, master: Master, q: z.infer<typeof registerQuery>) {
  const { from, to } = await plantRange(sql, q.fromDay, q.toDay);
  const all = await breakdowns(sql, await logbookItems(sql, master), from, to, q);
  // Counts, MTTR and MTBF cover every breakdown of the period, whatever the status filter (review S9); a machine's
  // MTBF and MTTR all its breakdowns of the period, worked out as report.reliability_v1 does (D-77).
  const stats = breakdownStats(all, await reliability(sql, from, to, [...new Set(all.map((b) => b.equipmentId))]));
  return { from, to, items: filterAndSort(all, q), stats };
}

type Event =
  | { kind: 'entry'; at: Date; entry: Awaited<ReturnType<typeof present>>[number] & { latest: boolean }; breakdown?: { downtime: string; parts: string; status: string } }
  | { kind: 'review'; at: Date; review: Awaited<ReturnType<typeof reviewsFor>>[number] }
  | { kind: 'masterdata'; at: Date; actor: string | null; action: string; old: unknown; new: unknown; reason: string | null; lines: string[] }
  | { kind: 'truebatch'; at: Date; use: { batch: string; productCode: string | null; step: string; startedAt: Date; endedAt: Date | null; source: TrueBatchUse['source'] } }
  // D-78: a sterilisation cycle recorded in TrueBatch Injectables for one of its batches, read only.
  | { kind: 'cycle'; at: Date; cycle: SterileCycle & { lines: string[] } }
  // D-80: a missed limit (exception) of the item, with its decision: closed here (reason, signature) or sent to Deviations.
  | { kind: 'exception'; at: Date; exception: Exception };

/** D-72: what a TrueBatch product that does not answer leaves out of the history card. */
export const usesOffHistoryNote = (source: string) => `Connection to ${source} is off: its uses of this item are not shown.`;

// D-72 (suite finding S30): the item's uses recorded in the TrueBatch products (equipment_use_v1), read live, as read-only
// rows of the history. A product that does not answer is left out and named in a note. A packing use's product (its view
// has none) comes from the batch records, when they answer.
async function trueBatchHistory(sql: Sql, uses: TrueBatchUses[], batches: BatchRecords | null, id: number, from: Date, to: Date) {
  const [row] = await sql<{ code: string }[]>`select code from equipment where id = ${id}`;
  if (!row || !uses.length) return { events: [] as Event[], notes: [] as string[] };
  const read = await Promise.all(uses.map((u) => u.inPeriod(row.code, from, to).catch((e) => {
    if (e instanceof UsesOff) return null;
    throw e;
  })));
  const notes = uses.filter((_, i) => read[i] === null).map((u) => usesOffHistoryNote(u.source));
  const all = read.flatMap((r) => r ?? []);
  const products = new Map<string, string | null>();
  // D-76: a LIMS use is for an analysis, not a batch: no product looked up.
  for (const b of new Set(all.filter((u) => !u.productCode && u.source !== LIMS).map((u) => u.batchNumber))) {
    products.set(b, batches ? await batches.get(b).then((r) => r.batch?.productCode ?? null, () => null) : null);
  }
  const events: Event[] = all.map((u) => ({ kind: 'truebatch' as const, at: u.startedAt, use: { batch: u.batchNumber,
    productCode: u.productCode ?? products.get(u.batchNumber) ?? null, step: u.step, startedAt: u.startedAt, endedAt: u.endedAt, source: u.source } }));
  return { events, notes };
}

// D-78: the item's sterilisation cycles recorded in TrueBatch Injectables for its batches (steriliser_cycle_v1), read live,
// as read-only rows of the history. Not answering: left out, and named in a note.
async function cycleHistory(sql: Sql, cycles: SterileCycles | null, id: number, from: Date, to: Date) {
  const [row] = await sql<{ code: string }[]>`select code from equipment where id = ${id}`;
  if (!row || !cycles) return { events: [] as Event[], notes: [] as string[] };
  try {
    const events: Event[] = (await cycles.inPeriod(row.code, from, to)).map((c) => ({ kind: 'cycle' as const, at: c.startedAt, cycle: { ...c, lines: cycleLines(c) } }));
    return { events, notes: [] as string[] };
  } catch (e) {
    if (e instanceof CyclesOff) return { events: [] as Event[], notes: [cyclesOffHistoryNote(cycles.source)] };
    throw e;
  }
}

// The life history of one item: every entry version, QA reviews and master-data changes, oldest first; D-72: with the
// uses recorded in the TrueBatch products (shown with the equipment uses).
async function history(sql: Sql, master: Master, id: number, fromDay: string, toDay: string, types: Set<string> | null,
  uses: TrueBatchUses[] = [], batches: BatchRecords | null = null, cycles: SterileCycles | null = null) {
  const { from, to } = await plantRange(sql, fromDay, toDay);
  const versions: EntryRow[] = (await periodVersions(sql, id, from, to))
    // "breakdown" picks the breakdown entries out of the maintenance logbook (S12).
    .filter((v) => !types || types.has(v.logbook_type) || (types.has('breakdown') && v.logbook_type === 'maintenance' && v.data.kind === 'breakdown'));
  const latestIds = new Set(versions.filter((v) => !versions.some((x) => x.supersedes === v.id)).map((v) => v.id));
  const bdIds = [...new Set(versions.filter((v) => v.logbook_type === 'maintenance').map((v) => v.entry_id))];
  const bds = new Map((bdIds.length ? await breakdowns(sql, await logbookItems(sql, master), new Date(0), new Date('9999-01-01'), { equipmentId: id, entryIds: bdIds }) : []).map((b) => [b.entryId, b]));
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
        and a.action not like 'exception.%'
      order by a.at, a.id`;
    for (const r of rows) {
      events.push({ kind: 'masterdata', at: r.at, actor: r.actor, action: r.action, old: r.old_value, new: r.new_value, reason: r.reason, lines: changeLines(r.old_value, r.new_value, r.action) });
    }
  }
  if (!types || types.has('exception')) {
    for (const x of await exceptionsOf(sql, id, from, to)) events.push({ kind: 'exception', at: x.dueAt, exception: x });
  }
  const notes: string[] = [];
  if (!types || types.has('equipment_use')) {
    const tb = await trueBatchHistory(sql, uses, batches, id, from, to);
    events.push(...tb.events);
    notes.push(...tb.notes);
  }
  if (!types || types.has('steriliser_cycle')) {
    const cy = await cycleHistory(sql, cycles, id, from, to);
    events.push(...cy.events);
    notes.push(...cy.notes);
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { from, to, events, notes };
}

async function card(sql: Sql, master: Master, id: number, ctx: StatusContext) {
  const item = await logbookItem(sql, master, id);
  if (!item) return null;
  const [row] = await sql<{ created_at: Date }[]>`select created_at from equipment where id = ${id}`;
  const createdAt = row!.created_at;
  // Name, kind, room and active state are master data, read live (D-29).
  const equipment = { id, code: item.code, name: item.name, kind: item.kind, location: item.room ?? '', sterile: item.sterile,
    classified: item.classified, ...item.care, needsCalibration: needsCalibrationOf(item), active: item.active,
    make: item.make, model: item.model, serial: item.serial, createdAt };
  const versions = await detailsVersions(sql, id);
  return { equipment, details: versions.at(-1) ?? null, detailsVersions: versions, locationHistory: await locationHistory(sql, id), status: await statusOf(sql, id, ctx) };
}

// D-71: with the signer's training check, when the settings named a training.
const sigText = (e: { signatures: { meaning: string; printedName: string; signedAt: Date | string; valid: boolean; training?: string }[] }) =>
  e.signatures.map((s) => `${s.meaning}: ${s.printedName}, ${plant(s.signedAt)}${s.valid ? '' : ' [INVALID]'}${s.training ? ` (${s.training})` : ''}`).join('; ');

function eventRow(ev: Event): { at: Date; kind: string; type: string; what: string; detail: string; who: string; signatures: string; breakdown: string; highlight: boolean; grey: boolean } {
  if (ev.kind === 'entry') {
    const e = ev.entry;
    return {
      at: ev.at,
      kind: e.logbookType,
      type: TYPE_LABEL[e.logbookType] ?? e.logbookType,
      what: `#${e.entryId} v${e.version} · ${e.change}${e.latest ? '' : ' (superseded)'}${e.correctionReason ? ` · reason: ${e.correctionReason}` : ''}`,
      detail: [e.batch ? `Batch ${e.batch}` : '', ...entryLines(e.data), e.activityEnd ? `Until ${plant(e.activityEnd)}` : '', voiceNoteText(e)].filter(Boolean).join('\n'),
      who: `${e.enteredBy ?? ''}, ${plant(e.enteredAt)}`,
      signatures: sigText(e),
      breakdown: ev.breakdown ? `Downtime ${ev.breakdown.downtime} · parts: ${ev.breakdown.parts || '—'} · ${ev.breakdown.status}` : '',
      highlight: Boolean(ev.breakdown),
      grey: !e.latest,
    };
  }
  if (ev.kind === 'review') {
    const r = ev.review;
    return { at: ev.at, kind: 'review', type: 'QA review', what: `QA review ${plant(r.periodFrom)} to ${plant(r.periodTo)}${r.superseded ? ' (superseded)' : ''}`, detail: '', who: r.reviewedBy ?? '', signatures: `reviewed: ${r.reviewedBy ?? ''}, ${plant(r.reviewedAt)}${r.valid ? '' : ' [INVALID]'}`, breakdown: '', highlight: false, grey: false };
  }
  if (ev.kind === 'truebatch') {
    const u = ev.use;
    return { at: ev.at, kind: 'truebatch', type: `Equipment use (${u.source})`,
      what: `${useOf(u.source) === 'analysis' ? 'Analysis' : 'Batch'} ${u.batch}${u.productCode ? ` · ${u.productCode}` : ''}`,
      detail: [u.step ? `Step: ${u.step}` : '', `Started ${plant(u.startedAt)}`, u.endedAt ? `Ended ${plant(u.endedAt)}` : 'Not ended yet', `From ${u.source}: read only, recorded there`].filter(Boolean).join('\n'),
      who: u.source, signatures: `Signed in ${u.source}`, breakdown: '', highlight: false, grey: false };
  }
  if (ev.kind === 'cycle') {
    const c = ev.cycle;
    return { at: ev.at, kind: 'truebatch cycle', type: `Sterilisation cycle (${c.source})`, what: `From ${c.source}, batch ${c.batchNumber}`,
      detail: [...c.lines, `Started ${plant(c.startedAt)}`, c.endedAt ? `Ended ${plant(c.endedAt)}` : '', `From ${c.source}: read only, recorded there`].filter(Boolean).join('\n'),
      who: c.source, signatures: `Signed in ${c.source} (${c.signed.join(', ') || 'not signed'})`, breakdown: '', highlight: c.result === 'fail', grey: false };
  }
  if (ev.kind === 'exception') {
    const x = ev.exception;
    const d = x.decision;
    return { at: ev.at, kind: 'exception', type: 'Missed limit (exception)', what: `${x.label}: ${x.title}`,
      detail: [d ? `${d.label} by ${d.by ?? ''}, ${plant(d.at)}` : 'Waiting for a decision: close it here or send it to Deviations', d?.reason ? `Reason: ${d.reason}` : ''].filter(Boolean).join('\n'),
      who: d?.by ?? 'Logbook', signatures: d?.signedBy && d.at ? `closed: ${d.signedBy}, ${plant(d.at)}` : '', breakdown: '', highlight: !d, grey: false };
  }
  return { at: ev.at, kind: 'master data', type: 'Master data', what: ITEM_ACTION_LABEL[ev.action] ?? ev.action, detail: [ev.reason ? `Reason: ${ev.reason}` : '', ...ev.lines].filter(Boolean).join('\n'), who: ev.actor ?? 'system', signatures: '', breakdown: '', highlight: false, grey: false };
}

export function historyRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  app.get<{ Params: { id: string } }>('/api/equipment/:id/details', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return (await card(sql, app.master, id, await app.statusContext())) ?? reply.code(404).send({ error: 'not_found' });
  });

  // A new details version; the old one stays (D-25). expectedVersion guards against overwriting a
  // change made meanwhile.
  app.put<{ Params: { id: string } }>('/api/equipment/:id/details', { preHandler: requirePermission('logbook.site.manage') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = detailsBody.safeParse(req.body);
    if (id === null || !body.success) {
      return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const problems = checkDetails(body.data.details, await today(sql));
    if (problems.length) return reply.code(400).send({ error: 'check_failed', problems });
    // D-79: with QMS linked, new SOP references are QMS' effective SOPs; those the item already records stay as recorded.
    const [prev] = await sql<{ sop: string | null }[]>`
      select details->>'sopRefs' as sop from equipment_details where equipment_id = ${id} order by version desc limit 1`;
    const sops = await pullSops(app.sops, body.data.details.sopRefs, sopRefsOf(prev?.sop));
    if (sops.off) return reply.code(503).send({ error: 'connection_off', message: SOPS_OFF });
    if (sops.problems.length) return reply.code(400).send({ error: 'check_failed', problems: sops.problems });
    body.data.details.sopRefs = sops.text;
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
    return register(sql, app.master, q.data);
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/breakdowns.:format', anyUser, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const q = registerPeriod.safeParse(req.query);
    if (!format.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { items, stats } = await register(sql, app.master, q.data);
    if (items.length > MAX_ROWS) return reply.code(413).send({ error: 'too_large', message: 'Choose a shorter period.' });
    const name = `breakdowns-${q.data.fromDay}-${q.data.toDay}`;
    if (format.data === 'csv') {
      return sendCopy(reply, 'csv', name, csvText(
        ['equipment', 'name', 'location', 'entry_id', 'occurred_utc', 'repair_start_utc', 'repair_end_utc', 'released_utc', 'downtime_minutes', 'downtime_final',
          'category', 'failure', 'root_cause', 'work_done', 'parts', 'done_by', 'work_order', 'deviation', 'status'],
        items.map((b) => [b.code, b.name, b.location, b.entryId, b.occurredAt, b.repairStart, b.repairEnd, b.releasedAt, b.downtimeMinutes, b.downtimeFinal,
          b.failureCategory, b.description, b.rootCause, b.workDone, b.partsText, b.doneBy, b.workOrderRef, b.deviationRef, b.status]),
      ));
    }
    const filters = [q.data.equipmentId && `machine ${items[0]?.code ?? q.data.equipmentId}`, q.data.location && `location ${q.data.location}`,
      q.data.category && `category ${FAILURE_CATEGORY_LABEL[q.data.category]}`, q.data.status && `status ${STATUS_LABEL[q.data.status]}`].filter(Boolean).join(', ');
    const tables: PdfTable[] = [
      { heading: `Breakdowns (${items.length})`, columns: ['Machine', 'Occurred', 'Repair end', 'QA released', 'Downtime', 'Failure type', 'What happened', 'Root cause', 'Work done', 'Parts used', 'Done by / WO', 'Status'],
        widths: [55, 48, 48, 48, 42, 64, '*', '*', '*', 70, 60, 48],
        rows: items.map((b) => ({ cells: [`${b.code}\n${b.name}\n${b.location}`, plant(b.occurredAt), plant(b.repairEnd), plant(b.releasedAt), downtimeText(b),
          b.failureCategory ? FAILURE_CATEGORY_LABEL[b.failureCategory] ?? b.failureCategory : '', b.description, b.rootCause, b.workDone, b.partsText,
          [b.doneBy, b.workOrderRef].filter(Boolean).join(' · '), STATUS_LABEL[b.status]!] })) },
      { heading: 'Per machine', columns: ['Machine', 'Failures', 'Downtime (h)', 'MTTR (h)', 'MTBF (h)'], widths: ['*', 60, 70, 60, 60],
        rows: stats.machines.map((m) => ({ cells: [`${m.code} · ${m.name}`, String(m.failures), String(m.downtimeHours), m.mttrHours === null ? '—' : String(m.mttrHours), m.mtbfHours === null ? '—' : String(m.mtbfHours)] })) },
      { heading: 'Per failure category', columns: ['Category', 'Failures'], widths: ['*', 60], rows: stats.categories.map((c) => ({ cells: [FAILURE_CATEGORY_LABEL[c.category] ?? c.category, String(c.failures)] })) },
    ];
    return sendCopy(reply, 'pdf', name, await tablesPdf(sql, 'Breakdown register',
      `Breakdowns that occurred ${plantDay(q.data.fromDay)} to ${plantDay(q.data.toDay)} (plant time)${filters ? ` · ${filters}` : ''}. Downtime runs from occurrence to QA release; for a past breakdown recorded after its repair, to the repair end. MTTR: downtime in the period per breakdown. MTBF: operating time in the period (in service, minus downtime) per breakdown.`,
      tables, req.user!.fullName));
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/equipment/:id/history', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const q = historyQuery.safeParse(req.query);
    if (id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const head = await card(sql, app.master, id, await app.statusContext());
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const types = q.data.types ? new Set(q.data.types.split(',').filter(Boolean)) : null;
    return { ...head, ...(await history(sql, app.master, id, q.data.fromDay, q.data.toDay, types, app.trueBatchUses, app.batches, app.cycles)) };
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/history.:format', anyUser, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const id = parseId(req.query.equipmentId ?? '');
    const q = historyQuery.safeParse(req.query);
    if (!format.success || id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const head = await card(sql, app.master, id, await app.statusContext());
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const types = q.data.types ? new Set(q.data.types.split(',').filter(Boolean)) : null;
    const { events, notes } = await history(sql, app.master, id, q.data.fromDay, q.data.toDay, types, app.trueBatchUses, app.batches, app.cycles);
    if (events.length > MAX_ROWS) return reply.code(413).send({ error: 'too_large', message: 'Choose a shorter period.' });
    const rows = events.map(eventRow);
    const eq = head.equipment as { code: string; name: string; kind: string; location: string; make: string | null; model: string | null; serial: string | null };
    const name = `history-${eq.code}-${q.data.fromDay}`;
    if (format.data === 'csv') {
      return sendCopy(reply, 'csv', name, csvText(['equipment', 'at_utc', 'kind', 'record', 'details', 'by', 'signatures', 'breakdown'],
        rows.map((r) => [eq.code, r.at, r.kind, r.what, r.detail.replaceAll('\n', ' · '), r.who, r.signatures, r.breakdown])));
    }
    const d = head.details?.details;
    const detailRows: [string, string][] = [
      ['Equipment', `${eq.code} · ${eq.name}`], ['Location', eq.location], ['Make / model', `${eq.make ?? ''} ${eq.model ?? ''}`.trim()], ['Serial number', eq.serial ?? ''], ['Status', head.status ? STATE_NAME[head.status.state] ?? head.status.state.replaceAll('_', ' ') : ''],
      ...(d ? ([
        ['Asset number', d.assetNumber], ['Capacity / size', d.capacity],
        ['Installed / supplier', `${d.installationDate ? plantDay(d.installationDate) : ''} ${d.supplier}`.trim()], ['Qualification', `${d.qualificationStatus.replaceAll('_', ' ')} · IQ ${plantDay(d.iq.date)} ${d.iq.ref} · OQ ${plantDay(d.oq.date)} ${d.oq.ref} · PQ ${plantDay(d.pq.date)} ${d.pq.ref} · last requalification ${plantDay(d.lastRequalification)}`],
        ['Product contact / MOC', d.productContactMoc], ['SOPs', d.sopRefs], ['Details version', `${head.details!.version}, ${head.details!.changedBy}, ${plant(head.details!.changedAt)}`],
      ] as [string, string][]) : [['Further details', 'asset number, capacity, qualification and SOPs not entered yet']] as [string, string][]),
    ];
    return sendCopy(reply, 'pdf', name, await tablesPdf(sql, `Equipment history card ${eq.code} · ${eq.name}`, `Period ${plantDay(q.data.fromDay)} to ${plantDay(q.data.toDay)} (plant time). All versions; superseded versions grey, breakdowns shaded. Uses recorded in TrueBatch or Medhanta LIMS, and sterilisation cycles recorded in TrueBatch Injectables, are read from there (read only).${notes.length ? ` ${notes.join(' ')}` : ''}`, [
      { heading: 'Equipment', columns: ['Field', 'Value'], widths: [120, '*'], rows: detailRows.map((r) => ({ cells: r })) },
      { heading: 'Location history', columns: ['When', 'By', 'From', 'To', 'Reason'], widths: [90, 90, 120, 120, '*'],
        rows: head.locationHistory.map((l) => ({ cells: [plant(l.at), l.by ?? '', l.from ?? '(created)', l.to, l.reason ?? ''] })) },
      { heading: `History (${rows.length})`, columns: ['When', 'Type', 'Record', 'Details', 'By', 'Signatures'], widths: [70, 70, 90, '*', 80, 130],
        rows: rows.map((r) => ({ cells: [plant(r.at), r.type, r.what, `${r.breakdown ? `${r.breakdown}\n` : ''}${r.detail}`, r.who, r.signatures], highlight: r.highlight, grey: r.grey })) },
    ], req.user!.fullName));
  });
}

