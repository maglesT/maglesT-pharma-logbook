import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import type { LogbookItem } from './master.js';
import { FAILURE_CATEGORIES } from './entries.js';
import { PLANT_TZ } from './status.js';

// S9 breakdown register and equipment details (D-25). Everything here is computed from the log and
// the master data; nothing is stored twice.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).default('');
const qualificationStep = z.object({ date: day.nullable().default(null), ref: text(80) }).default({});

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
  // Occurred to QA release, or to now while not yet released (then `downtimeFinal` is false).
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
export async function breakdowns(q: Sql | Tx, items: LogbookItem[], from: Date, to: Date, f: Partial<RegisterQuery> & { entryIds?: number[] } = {}, now = new Date()): Promise<Breakdown[]> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = await q<{ id: number; entry_id: number; equipment_id: number; code: string; activity_start: Date; activity_end: Date | null; data: Record<string, unknown>; occurred_at: Date; verified_at: Date | null; released_at: Date | null }[]>`
    select e.id::int, e.entry_id::int, e.equipment_id::int, q.code, e.activity_start, e.activity_end, e.data,
      coalesce((e.data->>'occurredAt')::timestamptz, e.activity_start) as occurred_at,
      (select g.signed_at from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified') as verified_at,
      (select g.signed_at from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'released') as released_at
    from entries e join equipment q on q.id = e.equipment_id
    where e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown'
      and not exists (select 1 from entries x where x.supersedes = e.id)
      and coalesce((e.data->>'occurredAt')::timestamptz, e.activity_start) >= ${from}
      and coalesce((e.data->>'occurredAt')::timestamptz, e.activity_start) < ${to}
      and ${f.equipmentId ? q`e.equipment_id = ${f.equipmentId}` : q`true`}
      and ${f.category ? q`e.data->>'failureCategory' = ${f.category}` : q`true`}
      and ${f.entryIds ? q`e.entry_id = any(${f.entryIds}::bigint[])` : q`true`}
    order by occurred_at desc, e.entry_id desc`;
  const located = f.location ? rows.filter((r) => (byId.get(r.equipment_id)?.room ?? '').toLowerCase() === f.location!.toLowerCase()) : rows;
  const list = located.map((r): Breakdown => {
    const status: BreakdownStatus = !r.activity_end ? 'open' : !r.verified_at ? 'awaiting_verification' : !r.released_at ? 'awaiting_release' : 'released';
    const end = r.released_at ?? now;
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
      workOrderRef: String(r.data.workOrderRef ?? ''),
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
  downtimeHours: number;
  // Mean downtime (occurred to QA release) of the released breakdowns; null when none is released.
  mttrHours: number | null;
  // Operating time in the window (window minus downtime) per failure; null without failures.
  mtbfHours: number | null;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

// Counts per machine and per category, MTTR and MTBF per machine (D-25). The window for a machine is
// the period, cut to what has already passed and to when the machine was installed (or created).
export function breakdownStats(list: Breakdown[], from: Date, to: Date, now: Date, inServiceSince: Map<number, Date>) {
  const byMachine = new Map<number, Breakdown[]>();
  for (const b of list) byMachine.set(b.equipmentId, [...(byMachine.get(b.equipmentId) ?? []), b]);
  const windowEnd = Math.min(to.getTime(), now.getTime());
  const machines: MachineStats[] = [...byMachine.entries()].map(([id, items]) => {
    const start = Math.max(from.getTime(), inServiceSince.get(id)?.getTime() ?? from.getTime());
    const window = Math.max(0, windowEnd - start);
    // Overlapping breakdowns are down only once (review S9).
    const spans = items
      .map((b) => [Math.max(b.occurredAt.getTime(), start), Math.min((b.releasedAt ?? now).getTime(), windowEnd)] as const)
      .filter(([s, e]) => e > s)
      .sort((x, y) => x[0] - y[0]);
    let down = 0;
    let reach = -Infinity;
    for (const [s, e] of spans) {
      if (e <= reach) continue;
      down += e - Math.max(s, reach);
      reach = e;
    }
    const released = items.filter((b) => b.downtimeFinal);
    return {
      equipmentId: id,
      code: items[0]!.code,
      name: items[0]!.name,
      failures: items.length,
      downtimeHours: hours(down),
      mttrHours: released.length ? hours((released.reduce((s, b) => s + b.downtimeMinutes, 0) / released.length) * 60_000) : null,
      mtbfHours: items.length ? hours(Math.max(0, window - down) / items.length) : null,
    };
  }).sort((a, b) => b.failures - a.failures || a.code.localeCompare(b.code));
  const categories = [...FAILURE_CATEGORIES, null]
    .map((c) => ({ category: c ?? 'not recorded', failures: list.filter((b) => b.failureCategory === c).length }))
    .filter((c) => c.failures > 0);
  return { machines, categories };
}

// When each machine entered service, for the MTBF window: installation date, else when it was created.
export async function inServiceSince(q: Sql | Tx, ids: number[]): Promise<Map<number, Date>> {
  const rows = await q<{ id: number; since: Date }[]>`
    select q.id::int, coalesce((
      select (d.details->>'installationDate')::date::timestamp at time zone ${PLANT_TZ} from equipment_details d
      where d.equipment_id = q.id order by d.version desc limit 1), q.created_at) as since
    from equipment q where q.id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [r.id, r.since]));
}
