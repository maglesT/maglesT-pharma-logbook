import type { Sql, Tx } from './db.js';
import { ConnectionOff } from './master.js';
import { IN_USE, statusOf, type EquipmentStatus, type StatusContext } from './status.js';

// D-45 (owner 15 Nov 2026): the status the Logbook works out is published for TrueBatch Tablets
// (report.equipment_status_v1, migration 0023). TrueBatch reads it by master id before a machine or room is used in a
// batch step. fit_for_use leaves out a use in progress: TrueBatch checks in_use_batch itself (its own batch may be the
// one using the item). Written in the minute check (recordOverdue) and right after an entry is written. When the
// status cannot be worked out (master data or Qualification not answering) nothing is written: the row grows old and
// the reader treats the link as off (never stale data, platform D-02).

export const RETIRED = 'Not active in master data: not for use.';

/** Writes these statuses; a row is replaced only by a newer check. */
export async function saveStatuses(q: Sql | Tx, statuses: EquipmentStatus[], ctx: StatusContext): Promise<void> {
  if (!statuses.length) return;
  const ids = statuses.map((s) => s.equipmentId);
  // Who performed the newest verified cleaning (printed name of the Performed signature, else the author).
  const cleaned = new Map((await q<{ id: number; at: Date | null; by: string }[]>`
    select distinct on (e.equipment_id) e.equipment_id::int as id, e.activity_end as at, coalesce(p.printed_name, u.full_name) as by
    from entries e
    join users u on u.id = e.entered_by
    left join signatures p on p.object_type = 'entry' and p.object_id = e.id and p.meaning = 'performed'
    where e.equipment_id = any(${ids}::bigint[]) and e.logbook_type in ('equipment_cleaning', 'area_cleaning')
      and not exists (select 1 from entries x where x.supersedes = e.id)
      and exists (select 1 from signatures v where v.object_type = 'entry' and v.object_id = e.id and v.meaning = 'verified')
    order by e.equipment_id, e.activity_end desc nulls last`).map((r) => [r.id, r]));
  const rows = statuses.map((s) => {
    const blockers = s.blockers.filter((b) => b !== IN_USE);
    if (!ctx.care.get(s.equipmentId)?.active) blockers.unshift(RETIRED);
    const c = cleaned.get(s.equipmentId);
    return {
      equipment_id: s.equipmentId, state: s.state, fit_for_use: blockers.length === 0, blockers, warnings: s.warnings,
      in_use_batch: s.inUse?.batch ?? null, cleaned_at: s.lastCleanEnd,
      cleaned_by: s.lastCleanEnd && c?.at?.getTime() === s.lastCleanEnd.getTime() ? c.by : null,
      clean_until: s.cleanUntil, calibration_due: s.calibrationDue, qualification: s.qualification, checked_at: s.checkedAt,
    };
  });
  await q`
    insert into item_status (equipment_id, state, fit_for_use, blockers, warnings, in_use_batch, cleaned_at, cleaned_by, clean_until,
      calibration_due, qualification, checked_at)
    select r.equipment_id, r.state, r.fit_for_use, r.blockers, r.warnings, r.in_use_batch, r.cleaned_at, r.cleaned_by, r.clean_until,
      r.calibration_due, r.qualification, r.checked_at
    from jsonb_to_recordset(${q.json(rows as never)}) as r(equipment_id bigint, state text, fit_for_use boolean, blockers text[], warnings text[],
      in_use_batch text, cleaned_at timestamptz, cleaned_by text, clean_until timestamptz, calibration_due date, qualification text, checked_at timestamptz)
    on conflict (equipment_id) do update set state = excluded.state, fit_for_use = excluded.fit_for_use, blockers = excluded.blockers,
      warnings = excluded.warnings, in_use_batch = excluded.in_use_batch, cleaned_at = excluded.cleaned_at, cleaned_by = excluded.cleaned_by,
      clean_until = excluded.clean_until, calibration_due = excluded.calibration_due, qualification = excluded.qualification,
      checked_at = excluded.checked_at
    where item_status.checked_at <= excluded.checked_at`;
}

/** Works out and writes one item's status now (after an entry on it was written). Skipped while a link is off. */
export async function refreshStatus(sql: Sql, context: () => Promise<StatusContext>, ref: { equipmentId: number } | { entryId: number }) {
  const id = 'equipmentId' in ref ? ref.equipmentId
    : (await sql<{ id: number }[]>`select equipment_id::int as id from entries where id = ${ref.entryId}`)[0]?.id;
  if (!id) return;
  let ctx: StatusContext;
  try { ctx = await context(); } catch (e) { if (e instanceof ConnectionOff) return; throw e; }
  const s = await statusOf(sql, id, ctx);
  if (s) await saveStatuses(sql, [s], ctx);
}
