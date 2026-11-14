import type { Sql, Tx } from './db.js';
import { audit } from './audit.js';
import { contentHash } from './signatures.js';
import { OVERDUE_LABEL, type OverdueKind } from './overdue.js';
import { PLANT_TZ } from './status.js';

// Owner 2026-11-14 (D-43): two routes for a problem. A missed limit (D-37) or a problem someone reports on an item
// waits for a QA decision: (1) send it to Deviations (published in report.overdue_v1, filed there as before), or
// (2) handle it here as a Logbook exception EXC-YYYY-NNNN, approved with an e-signature, optionally allowing continued
// use of the item until a date (at most 7 days) when an overdue PM, calibration or requalification blocks it. A cleaning
// limit is never waived; a critical problem always goes to Deviations.

export const SEVERITIES = ['minor', 'major', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const USE_ALLOWED_MAX_DAYS = 7;
// The lifecycle dues whose block an approved exception may lift for a while. Cleaning is still required.
export const WAIVABLE: OverdueKind[] = ['pm', 'calibration', 'requalification'];
export const isWaivable = (kind: string | null) => WAIVABLE.includes(kind as OverdueKind);

export interface ProblemRow {
  id: number;
  equipment_id: number;
  source: 'overdue' | 'reported';
  overdue_event_id: number | null;
  due_kind: OverdueKind | null;
  what_happened: string | null;
  impact: string | null;
  severity: Severity | null;
  reported_by: number | null;
  code: string;
  name: string;
  item_kind: string;
  location: string;
  title: string;
  created_at: Date;
}
export interface DecisionRow {
  id: number;
  problem_id: number;
  route: 'deviation' | 'exception';
  exception_number: string | null;
  justification: string | null;
  impact_assessment: string | null;
  action: string | null;
  use_allowed_until: Date | null;
  decided_by: number;
  decided_at: Date;
}
export const PROBLEM_COLS = `p.id::int, p.equipment_id::int, p.source, p.overdue_event_id::int, p.due_kind, p.what_happened, p.impact, p.severity,
  p.reported_by::int, p.code, p.name, p.item_kind, p.location, p.title, p.created_at`;
export const DECISION_COLS = `d.id::int, d.problem_id::int, d.route, d.exception_number, d.justification, d.impact_assessment, d.action,
  d.use_allowed_until, d.decided_by::int, d.decided_at`;

// What QA is shown and signs against (LB-19): the problem as recorded, and the decision as stored.
export const problemContent = (p: ProblemRow) => ({
  equipmentId: p.equipment_id, source: p.source, overdueEventId: p.overdue_event_id, dueKind: p.due_kind, whatHappened: p.what_happened,
  impact: p.impact, severity: p.severity, reportedBy: p.reported_by, code: p.code, name: p.name, title: p.title, createdAt: p.created_at,
});
export const problemHash = (p: ProblemRow) => contentHash('problem', p.id, problemContent(p));
export const decisionContent = (d: DecisionRow) => ({
  problemId: d.problem_id, route: d.route, exceptionNumber: d.exception_number, justification: d.justification,
  impactAssessment: d.impact_assessment, action: d.action, useAllowedUntil: d.use_allowed_until, decidedBy: d.decided_by, decidedAt: d.decided_at,
});
export const decisionHash = (d: DecisionRow) => contentHash('problem_decision', d.id, decisionContent(d));

/** Every missed limit becomes a problem waiting for QA's route decision, in the transaction that records the event. */
export async function recordOverdueProblem(tx: Tx, e: { id: number; equipmentId: number; kind: OverdueKind; code: string; name: string; itemKind: string; location: string; title: string }): Promise<number> {
  const [p] = await tx<{ id: number }[]>`
    insert into problems (equipment_id, source, overdue_event_id, due_kind, code, name, item_kind, location, title)
    values (${e.equipmentId}, 'overdue', ${e.id}, ${e.kind}, ${e.code}, ${e.name}, ${e.itemKind}, ${e.location}, ${e.title}) returning id::int`;
  await audit(tx, { actorId: null, action: 'problem.recorded', objectType: 'problem', objectId: p!.id,
    new: { equipmentId: e.equipmentId, source: 'overdue', overdueEventId: e.id, kind: e.kind, title: e.title } });
  return p!.id;
}

/** EXC-YYYY-NNNN, gapless per plant year: the next number after the highest one given, under a lock on the year. */
export async function nextExceptionNumber(tx: Tx): Promise<string> {
  const [y] = await tx<{ year: string }[]>`select to_char(now() at time zone ${PLANT_TZ}, 'YYYY') as year`;
  const year = y!.year;
  await tx`select pg_advisory_xact_lock(hashtext(${'exception:' + year}))`;
  const [n] = await tx<{ next: number }[]>`
    select coalesce(max(substring(exception_number from 10)::int), 0) + 1 as next from problem_decisions where exception_number like ${`EXC-${year}-%`}`;
  return `EXC-${year}-${String(n!.next).padStart(4, '0')}`;
}

/** The end of a plant day (YYYY-MM-DD): the moment until which use is allowed. */
export const endOfPlantDay = async (q: Sql | Tx, day: string) =>
  (await q<{ at: Date }[]>`select ((${day}::date + 1)::timestamp at time zone ${PLANT_TZ}) as at`)[0]!.at;
export const plantToday = async (q: Sql | Tx) => (await q<{ d: string }[]>`select to_char((now() at time zone ${PLANT_TZ})::date, 'YYYY-MM-DD') as d`)[0]!.d;

export const SEVERITY_LABEL: Record<Severity, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };
export const problemLabel = (p: ProblemRow) => (p.source === 'overdue' ? OVERDUE_LABEL[p.due_kind!] : `Reported problem (${SEVERITY_LABEL[p.severity!]})`);
