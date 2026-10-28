import type { Sql, Tx } from './db.js';

// Plant time zone: calibration due dates are plant-local dates (D-19).
export const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';

// Equipment and area status (LB-05–08), computed from the latest entry versions. Nothing is stored:
// the log is the single source of truth.

export type StatusCode = 'in_use' | 'dirty' | 'clean' | 'clean_expired' | 'out_of_service' | 'calibration_overdue' | 'calibration_failed' | 'not_calibrated' | 'available';

export interface EquipmentStatus {
  equipmentId: number;
  // The headline state shown on screens.
  state: StatusCode;
  // Why a new use is refused; empty when the item is fit for use.
  blockers: string[];
  warnings: string[];
  inUse: { entryId: number; productId: number | null; batch: string | null; stage: string; since: Date } | null;
  lastUseEnd: Date | null;
  cleanUntil: Date | null;
  // Plant-local date (YYYY-MM-DD).
  calibrationDue: string | null;
}

interface Facts {
  id: number;
  kind: 'equipment' | 'instrument' | 'area';
  clean_hold_hours: number | null;
  needs_calibration: boolean;
  tracks_cleaning: boolean;
  open_use_id: number | null;
  open_use_product: number | null;
  open_use_batch: string | null;
  open_use_stage: string | null;
  open_use_since: Date | null;
  last_use_end: Date | null;
  last_clean_end: Date | null;
  unverified_cleanings: number;
  open_breakdowns: number;
  calibrations_enabled: boolean;
  // Newest calibration (latest version), verified or not.
  cal_result: string | null;
  cal_due: string | null;
  cal_verified: boolean;
  // Newest verified calibration.
  vcal_result: string | null;
  vcal_due: string | null;
  today: string;
  now: Date;
}

const DUE_SOON_DAYS = 7;

// One query for any number of items: the facts status is derived from. The entry scan is limited
// to the requested items (review S4-4).
async function facts(q: Sql | Tx, ids: number[] | null): Promise<Facts[]> {
  const scope = ids === null ? q`true` : q`e.equipment_id = any(${ids}::bigint[])`;
  return q<Facts[]>`
    with latest as (
      select e.*,
        exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified') as verified
      from entries e
      where ${scope} and not exists (select 1 from entries x where x.supersedes = e.id)
    ),
    enabled as (
      select distinct on (s.logbook_type) s.logbook_type, (s.settings->>'enabled')::boolean as on
      from logbook_settings s
      join signatures g on g.object_type = 'settings' and g.object_id = s.id and g.meaning = 'approved'
      where s.effective_from <= now()
      order by s.logbook_type, s.version desc
    ),
    uses as (
      select equipment_id, max(activity_end) as last_use_end from latest where logbook_type = 'equipment_use' group by equipment_id
    )
    select q.id::int, q.kind, q.clean_hold_hours, q.needs_calibration,
      coalesce((select en.on from enabled en
                where en.logbook_type = case when q.kind = 'area' then 'area_cleaning' else 'equipment_cleaning' end), false) as tracks_cleaning,
      coalesce((select en.on from enabled en where en.logbook_type = 'calibration'), false) as calibrations_enabled,
      u.id::int as open_use_id, u.product_id::int as open_use_product, u.batch as open_use_batch,
      u.data->>'stage' as open_use_stage, u.activity_start as open_use_since,
      us.last_use_end,
      -- A cleaning counts only if it started after the last use ended (review S4-3).
      (select max(l.activity_end) from latest l where l.equipment_id = q.id and l.verified
         and l.logbook_type in ('equipment_cleaning', 'area_cleaning')
         and (us.last_use_end is null or l.activity_start >= us.last_use_end)) as last_clean_end,
      (select count(*)::int from latest l where l.equipment_id = q.id and not l.verified
         and l.logbook_type in ('equipment_cleaning', 'area_cleaning')) as unverified_cleanings,
      (select count(*)::int from latest l where l.equipment_id = q.id and l.logbook_type = 'maintenance' and l.data->>'kind' = 'breakdown'
         and not exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = l.id and g.meaning = 'released')) as open_breakdowns,
      c.data->>'result' as cal_result, c.data->>'nextDue' as cal_due, coalesce(c.verified, false) as cal_verified,
      vc.data->>'result' as vcal_result, vc.data->>'nextDue' as vcal_due,
      to_char((now() at time zone ${PLANT_TZ})::date, 'YYYY-MM-DD') as today,
      now() as now
    from equipment q
    left join uses us on us.equipment_id = q.id
    left join lateral (
      select l.* from latest l where l.equipment_id = q.id and l.logbook_type = 'equipment_use' and l.activity_end is null
      order by l.activity_start desc limit 1
    ) u on true
    left join lateral (
      select l.* from latest l where l.equipment_id = q.id and l.logbook_type = 'calibration' order by l.activity_start desc limit 1
    ) c on true
    left join lateral (
      select l.* from latest l where l.equipment_id = q.id and l.logbook_type = 'calibration' and l.verified
      order by l.activity_start desc limit 1
    ) vc on true
    where ${ids === null ? q`true` : q`q.id = any(${ids}::bigint[])`}`;
}

export function deriveStatus(f: Facts): EquipmentStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const now = f.now.getTime();

  // LB-06 / SchM 18.4.3: defective equipment is withdrawn until released.
  if (f.open_breakdowns > 0) blockers.push('Out of service: a breakdown has not been released by QA.');

  // LB-05: calibration status, for items that need calibration. The newest calibration decides:
  // a failed result blocks at once, verified or not; a newer pass awaiting verification falls back
  // to the previous verified one only if that passed and is in date (review S4-1/2).
  let calibrationDue: string | null = null;
  let calState: StatusCode | null = null;
  const dueOk = (due: string | null) => !due || due.slice(0, 10) >= f.today;
  if (f.needs_calibration) {
    if (!f.calibrations_enabled) {
      blockers.push('Not calibrated: the calibration logbook is not switched on at this site.');
      calState = 'not_calibrated';
    } else if (f.cal_result === 'fail') {
      blockers.push('Calibration failed: do not use until a passed calibration is verified.');
      calState = 'calibration_failed';
    } else {
      const usable = f.cal_verified ? { result: f.cal_result, due: f.cal_due } : f.vcal_result === 'pass' ? { result: 'pass', due: f.vcal_due } : null;
      if (!f.cal_verified && f.cal_result) warnings.push('A newer calibration is awaiting verification.');
      if (!usable) {
        blockers.push(f.cal_result ? 'Not calibrated: the calibration is awaiting verification.' : 'Not calibrated: no verified calibration on record.');
        calState = 'not_calibrated';
      } else {
        calibrationDue = usable.due ? usable.due.slice(0, 10) : null;
        if (!dueOk(usable.due)) {
          blockers.push(`Calibration overdue since ${calibrationDue}.`);
          calState = 'calibration_overdue';
        } else if (calibrationDue && Date.parse(calibrationDue) - Date.parse(f.today) < DUE_SOON_DAYS * 86_400_000) {
          warnings.push(`Calibration due on ${calibrationDue}.`);
        }
      }
    }
  }

  // LB-07: cleaning status, where the site tracks cleaning for this kind of item.
  let cleanUntil: Date | null = null;
  let cleanState: StatusCode | null = null;
  if (f.tracks_cleaning && !f.open_use_id) {
    const cleanedAfterUse = f.last_clean_end && (!f.last_use_end || f.last_clean_end >= f.last_use_end);
    if (!cleanedAfterUse) {
      blockers.push(f.unverified_cleanings > 0 ? 'Dirty: the cleaning is awaiting verification.' : 'Dirty: clean and verify before the next use.');
      cleanState = 'dirty';
    } else if (f.clean_hold_hours) {
      cleanUntil = new Date(f.last_clean_end!.getTime() + f.clean_hold_hours * 3_600_000);
      if (cleanUntil.getTime() < now) {
        blockers.push(`Clean-hold time expired at ${cleanUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC: clean again before use.`);
        cleanState = 'clean_expired';
      } else cleanState = 'clean';
    } else cleanState = 'clean';
  }

  // LB-08: the item in use shows what is in it.
  if (f.open_use_id) blockers.push('In use: end the current use first.');

  const state: StatusCode = f.open_use_id
    ? 'in_use'
    : f.open_breakdowns > 0
      ? 'out_of_service'
      : (calState ?? cleanState ?? 'available');

  return {
    equipmentId: f.id,
    state,
    blockers,
    warnings,
    inUse: f.open_use_id
      ? { entryId: f.open_use_id, productId: f.open_use_product, batch: f.open_use_batch, stage: f.open_use_stage ?? '', since: f.open_use_since! }
      : null,
    lastUseEnd: f.last_use_end,
    cleanUntil,
    calibrationDue,
  };
}

export async function statusOf(q: Sql | Tx, equipmentId: number): Promise<EquipmentStatus | null> {
  const [f] = await facts(q, [equipmentId]);
  return f ? deriveStatus(f) : null;
}

export async function allStatuses(q: Sql | Tx): Promise<EquipmentStatus[]> {
  return (await facts(q, null)).map(deriveStatus);
}
