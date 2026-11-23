import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import type { LogbookItem } from './master.js';
import { FAILURE_CATEGORIES } from './entries.js';

// S9 breakdown register and equipment details (D-25). Everything here is computed from the log and
// the master data; nothing is stored twice.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).default('');
const qualificationStep = z.object({ date: day.nullable().default(null), ref: text(80) }).prefault({});

// Equipment details (versioned). Admin edits; each change needs a reason. Make, model and serial are master data
// (D-29 3): new versions leave them out; versions recorded before keep them.
export const detailsSchema = z
  .object({
    assetNumber: text(40),
    capacity: text(80),
    installationDate: day.nullable().default(null),
    supplier: text(120),
    qualificationStatus: z.enum(['not_qualified', 'in_qualification', 'qualified', 'requalification_due']).default('not_qualified'),
    iq: qualificationStep,
    oq: qualificationStep,
    pq: qualificationStep,
    lastRequalification: day.nullable().default(null),
    productContactMoc: text(1000),
    sopRefs: text(500),
  })
  .strict();
export type Details = z.infer<typeof detailsSchema>;

export function checkDetails(d: Details, today: string): string[] {
  const problems: string[] = [];
  for (const [label, v] of [['Installation date', d.installationDate], ['IQ date', d.iq.date], ['OQ date', d.oq.date], ['PQ date', d.pq.date], ['Last requalification', d.lastRequalification]] as const) {
    if (v && v > today) problems.push(`${label} cannot be in the future.`);
  }
  const steps = [['IQ', d.iq.date], ['OQ', d.oq.date], ['PQ', d.pq.date]] as const;
  for (let i = 1; i < steps.length; i++) {
    const [prevLabel, prev] = steps[i - 1]!;
    const [label, at] = steps[i]!;
    if (prev && at && at < prev) problems.push(`${label} cannot be dated before ${prevLabel}.`);
  }
  if (d.qualificationStatus === 'qualified' && !d.pq.date) problems.push('Qualified equipment needs a PQ date.');
  return problems;
}

export interface DetailsVersion {
  id: number;
  version: number;
  details: Details;
  reason: string;
  changedBy: string;
  changedAt: Date;
}

export async function detailsVersions(q: Sql | Tx, equipmentId: number): Promise<DetailsVersion[]> {
  return q<DetailsVersion[]>`
    select d.id::int, d.version, d.details, d.reason, u.full_name as "changedBy", d.changed_at as "changedAt"
    from equipment_details d join users u on u.id = d.changed_by
    where d.equipment_id = ${equipmentId} order by d.version`;
}

// Where an item has been: its first location and every recorded move, from the audit trail (LB-18).
export async function locationHistory(q: Sql | Tx, equipmentId: number) {
  const rows = await q<{ at: Date; actor: string | null; action: string; old_value: { location?: string } | null; new_value: { location?: string } | null; reason: string | null }[]>`
    select a.at, u.full_name as actor, a.action, a.old_value, a.new_value, a.reason
    from audit_log a left join users u on u.id = a.actor_id
    where a.object_type = 'equipment' and a.object_id = ${String(equipmentId)} and a.action in ('equipment.created', 'equipment.updated')
    order by a.at, a.id`;
  return rows
    .filter((r) => r.action === 'equipment.created' || (r.old_value?.location ?? '') !== (r.new_value?.location ?? ''))
    .map((r) => ({ at: r.at, by: r.actor, from: r.action === 'equipment.created' ? null : (r.old_value?.location ?? ''), to: r.new_value?.location ?? '', reason: r.reason }));
}

export type BreakdownStatus = 'open' | 'awaiting_verification' | 'awaiting_release' | 'released';
export const BREAKDOWN_STATUSES: BreakdownStatus[] = ['open', 'awaiting_verification', 'awaiting_release', 'released'];

export interface Part { name: string; partNumber: string; quantity: number; lotSerial: string }

export interface Breakdown {
  versionId: number;
  entryId: number;
  equipmentId: number;
  code: string;
  name: string;
  location: string;
  occurredAt: Date;
  repairStart: Date;
  repairEnd: Date | null;
  verifiedAt: Date | null;
  releasedAt: Date | null;
  // Occurred to QA release, or to now while not yet released (then `downtimeFinal` is false). D-58: a breakdown
  // first recorded after its repair had ended (a past breakdown) is down from occurrence to its own repair end.
  downtimeEnd: Date;
  downtimeMinutes: number;
  downtimeFinal: boolean;
  failureCategory: string | null;
  description: string;
  rootCause: string;
  workDone: string;
  postRepairChecks: string;
  parts: Part[];
  partsNone: boolean;
  partsText: string;
  doneBy: string;
  workOrderRef: string;
  // The work order raised from this breakdown (D: engineering work orders), if any.
  workOrder: { id: number; number: string; status: string } | null;
  deviationRef: string;
  status: BreakdownStatus;
}

export const partsText = (data: Record<string, unknown>) => {
  const parts = (data.parts ?? []) as Part[];
  if (parts.length) return parts.map((p) => `${p.quantity} × ${p.name}${p.partNumber ? ` (P/N ${p.partNumber})` : ''}${p.lotSerial ? `, lot/SN ${p.lotSerial}` : ''}`).join('; ');
  return data.partsNone ? 'None' : '';
};
export const doneByText = (data: Record<string, unknown>) =>
  data.doneBy === 'vendor' ? `Vendor: ${String(data.vendorName ?? '')}${data.serviceReportRef ? ` (report ${String(data.serviceReportRef)})` : ''}` : data.doneBy === 'in_house' ? 'In-house' : '';

export const registerQuery = z.object({
  fromDay: day,
  toDay: day,
  equipmentId: z.coerce.number().int().positive().optional(),
  location: z.string().trim().max(120).optional(),
  category: z.enum(FAILURE_CATEGORIES).optional(),
  status: z.enum(BREAKDOWN_STATUSES as [BreakdownStatus, ...BreakdownStatus[]]).optional(),
  sort: z.enum(['occurred', 'downtime']).default('occurred'),
});
export type RegisterQuery = z.infer<typeof registerQuery>;

// Latest version of every breakdown that occurred in [from, to), with its verification and release.
// An entry made before S9 has no occurrence time: its repair start stands in (D-25). Status filter and
// sort are applied by the caller, so statistics can use the whole list (review S9).
// Names and locations are master data, read live (D-29): `items` from logbookItems().
export async function breakdowns(q: Sql | Tx, items: LogbookItem[], from: Date, to: Date, f: Partial<RegisterQuery> & { entryIds?: number[] } = {}): Promise<Breakdown[]> {
  const byId = new Map(items.map((i) => [i.id, i]));
  // Occurrence and end of downtime (D-25, D-58) come from the view breakdown_downtime (migration 0027, D-77): the same
  // definition the published MTBF and MTTR use.
  const rows = await q<{ id: number; entry_id: number; equipment_id: number; code: string; activity_start: Date; activity_end: Date | null; data: Record<string, unknown>; occurred_at: Date; down_until: Date; verified_at: Date | null; released_at: Date | null }[]>`
    select e.id::int, e.entry_id::int, e.equipment_id::int, q.code, e.activity_start, e.activity_end, e.data, b.occurred_at, b.down_until,
      (select g.signed_at from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified') as verified_at,
      (select g.signed_at from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'released') as released_at
    from breakdown_downtime b join entries e on e.id = b.version_id join equipment q on q.id = e.equipment_id
    where b.occurred_at >= ${from} and b.occurred_at < ${to}
      and ${f.equipmentId ? q`e.equipment_id = ${f.equipmentId}` : q`true`}
      and ${f.category ? q`e.data->>'failureCategory' = ${f.category}` : q`true`}
      and ${f.entryIds ? q`e.entry_id = any(${f.entryIds}::bigint[])` : q`true`}
    order by occurred_at desc, e.entry_id desc`;
  const located = f.location ? rows.filter((r) => (byId.get(r.equipment_id)?.room ?? '').toLowerCase() === f.location!.toLowerCase()) : rows;
  const wos = new Map((located.length ? await q<{ id: number; number: string; status: string; entry_id: number }[]>`
    select id::int, number, status, entry_id::int from work_orders where entry_id = any(${located.map((r) => r.entry_id)}::bigint[])` : []).map((w) => [w.entry_id, w]));
  const list = located.map((r): Breakdown => {
    const status: BreakdownStatus = !r.activity_end ? 'open' : !r.verified_at ? 'awaiting_verification' : !r.released_at ? 'awaiting_release' : 'released';
    // D-58: first recorded more than the late-entry time after its repair had ended: a past breakdown, down until its repair end.
    const end = r.down_until;
    return {
      versionId: r.id,
      entryId: r.entry_id,
      equipmentId: r.equipment_id,
      code: r.code,
      name: byId.get(r.equipment_id)?.name ?? r.code,
      location: byId.get(r.equipment_id)?.room ?? '',
      occurredAt: r.occurred_at,
      repairStart: r.activity_start,
      repairEnd: r.activity_end,
      verifiedAt: r.verified_at,
      releasedAt: r.released_at,
      downtimeEnd: end,
      downtimeMinutes: Math.max(0, Math.round((end.getTime() - r.occurred_at.getTime()) / 60_000)),
      downtimeFinal: Boolean(r.released_at),
      failureCategory: (r.data.failureCategory as string | undefined) ?? null,
      description: String(r.data.description ?? ''),
      rootCause: String(r.data.rootCause ?? ''),
      workDone: String(r.data.workDone ?? ''),
      postRepairChecks: String(r.data.postRepairChecks ?? ''),
      parts: (r.data.parts ?? []) as Part[],
      partsNone: Boolean(r.data.partsNone),
      partsText: partsText(r.data),
      doneBy: doneByText(r.data),
      workOrderRef: wos.get(r.entry_id)?.number ?? String(r.data.workOrderRef ?? ''),
      workOrder: wos.has(r.entry_id) ? { id: wos.get(r.entry_id)!.id, number: wos.get(r.entry_id)!.number, status: wos.get(r.entry_id)!.status } : null,
      deviationRef: String(r.data.deviationRef ?? ''),
      status,
    };
  });
  return list;
}

export const filterAndSort = (list: Breakdown[], f: Partial<RegisterQuery>) => {
  const filtered = f.status ? list.filter((b) => b.status === f.status) : list;
  return f.sort === 'downtime' ? [...filtered].sort((a, b) => b.downtimeMinutes - a.downtimeMinutes) : filtered;
};

export interface MachineStats {
  equipmentId: number;
  code: string;
  name: string;
  failures: number;
  // Operating time in the period: in service, minus downtime (D-77).
  inServiceHours: number;
  downtimeHours: number;
  // Downtime in the period per breakdown that started in it; null without breakdowns (D-77).
  mttrHours: number | null;
  // Operating time in the period per breakdown that started in it; null without breakdowns (D-77).
  mtbfHours: number | null;
}

export interface Reliability { equipmentId: number; inServiceHours: number; breakdowns: number; downtimeHours: number }

// D-77: MTBF and MTTR of a period, one row per item in service in it, worked out exactly as report.reliability_v1 does
// for a calendar month (migration 0027; test/breakdowns.test.ts checks both give the same numbers):
//   window = [from, to) cut to the item's in-service start (D-59) and to now; downtime = the item's merged downtime in the
//   window (D-25, D-58); in service = window − downtime; breakdowns = those that occurred in [from, to).
//   MTBF = in service / breakdowns, MTTR = downtime / breakdowns.
export async function reliability(q: Sql | Tx, from: Date, to: Date, ids: number[]): Promise<Map<number, Reliability>> {
  const rows = await q<{ equipmentId: number; spanHours: string; downtimeHours: string; breakdowns: number }[]>`
    select s.equipment_id::int as "equipmentId",
      round((select coalesce(sum(extract(epoch from upper(r) - lower(r))), 0) from unnest(p.span) r) / 3600, 4) as "spanHours",
      round((select coalesce(sum(extract(epoch from upper(r) - lower(r))), 0) from unnest(s.down * p.span) r) / 3600, 4) as "downtimeHours",
      (select count(*) from breakdown_downtime b where b.equipment_id = s.equipment_id and b.occurred_at >= ${from} and b.occurred_at < ${to})::int as breakdowns
    from equipment_in_service s
    cross join lateral (select greatest(${from}::timestamptz, s.in_service_from) as starts, least(${to}::timestamptz, now()) as ends) c
    cross join lateral (select tstzmultirange(case when c.starts < c.ends then tstzrange(c.starts, c.ends) else 'empty' end) as span) p
    where c.starts < c.ends and s.equipment_id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [r.equipmentId, {
    equipmentId: r.equipmentId, inServiceHours: Number(r.spanHours) - Number(r.downtimeHours), breakdowns: r.breakdowns, downtimeHours: Number(r.downtimeHours),
  }]));
}

const tenth = (h: number) => Math.round(h * 10) / 10;

// Counts per machine and per category, MTTR and MTBF per machine (D-25, D-77). A machine's figures cover all its
// breakdowns of the period, whatever filter narrowed the list (`figures` from reliability()).
export function breakdownStats(list: Breakdown[], figures: Map<number, Reliability>) {
  const seen = new Map<number, Breakdown>();
  for (const b of list) if (!seen.has(b.equipmentId)) seen.set(b.equipmentId, b);
  const machines: MachineStats[] = [...seen.values()].map((b) => {
    const r = figures.get(b.equipmentId) ?? { inServiceHours: 0, breakdowns: 0, downtimeHours: 0 };
    return {
      equipmentId: b.equipmentId,
      code: b.code,
      name: b.name,
      failures: r.breakdowns,
      inServiceHours: tenth(r.inServiceHours),
      downtimeHours: tenth(r.downtimeHours),
      mttrHours: r.breakdowns ? tenth(r.downtimeHours / r.breakdowns) : null,
      mtbfHours: r.breakdowns ? tenth(r.inServiceHours / r.breakdowns) : null,
    };
  }).sort((a, b) => b.failures - a.failures || a.code.localeCompare(b.code));
  const categories = [...FAILURE_CATEGORIES, null]
    .map((c) => ({ category: c ?? 'not recorded', failures: list.filter((b) => b.failureCategory === c).length }))
    .filter((c) => c.failures > 0);
  return { machines, categories };
}
