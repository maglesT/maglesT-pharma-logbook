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
  // Blockers other than cleaning: these also stop a sterilisation cycle (S6).
  cycleBlockers: string[];
  warnings: string[];
  inUse: { entryId: number; productId: number | null; batch: string | null; stage: string; since: Date } | null;
  lastUseEnd: Date | null;
  hasPassedSterilizerTest: boolean;
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
  // End of the latest repair that asked for re-calibration, when no verified pass followed it (D-25).
  recalibration_due_since: Date | null;
  calibrations_enabled: boolean;
  // Newest calibration (latest version), verified or not.
  cal_result: string | null;
  cal_due: string | null;
  cal_verified: boolean;
  // Newest verified calibration.
  vcal_result: string | null;
  vcal_due: string | null;
  failed_steriliser_tests: string[] | null;
  has_passed_steriliser_test: boolean;
  failed_glove_ports: string[] | null;
  last_cycle_result: string | null;
  pressure_out_of_limit: string[] | null;
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
      -- When the end of use was first recorded; a later correction of the use does not move it (S8 review).
      select distinct on (equipment_id) equipment_id, activity_end as last_use_end,
        (select min(x.entered_at) from entries x where x.entry_id = latest.entry_id and x.activity_end is not null) as last_use_entered_at
      from latest where logbook_type = 'equipment_use' and activity_end is not null
      order by equipment_id, activity_end desc
    )
    select q.id::int, q.kind, q.clean_hold_hours, q.needs_calibration,
      coalesce((select en.on from enabled en
                where en.logbook_type = case when q.kind = 'area' then 'area_cleaning' else 'equipment_cleaning' end), false) as tracks_cleaning,
      coalesce((select en.on from enabled en where en.logbook_type = 'calibration'), false) as calibrations_enabled,
      u.id::int as open_use_id, u.product_id::int as open_use_product, u.batch as open_use_batch,
      u.data->>'stage' as open_use_stage, u.activity_start as open_use_since,
      us.last_use_end,
      -- A cleaning counts only if it started after the last use ended (review S4-3). Forms enter whole
      -- minutes, so one in the minute the use ended counts if it was first entered after the use ended (S8).
      (select max(l.activity_end) from latest l where l.equipment_id = q.id and l.verified
         and l.logbook_type in ('equipment_cleaning', 'area_cleaning')
         and (us.last_use_end is null or l.activity_start >= us.last_use_end
              or (l.activity_start >= date_trunc('minute', us.last_use_end)
                  and (select min(x.entered_at) from entries x where x.entry_id = l.entry_id) > us.last_use_entered_at))) as last_clean_end,
      (select count(*)::int from latest l where l.equipment_id = q.id and not l.verified
         and l.logbook_type in ('equipment_cleaning', 'area_cleaning')) as unverified_cleanings,
      (select count(*)::int from latest l where l.equipment_id = q.id and l.logbook_type = 'maintenance' and l.data->>'kind' = 'breakdown'
         and not exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = l.id and g.meaning = 'released')) as open_breakdowns,
      (select max(l.activity_end) from latest l where l.equipment_id = q.id and l.logbook_type = 'maintenance'
         and coalesce((l.data->>'recalibrationNeeded')::boolean, false)
         and not exists (select 1 from latest k where k.equipment_id = q.id and k.logbook_type = 'calibration' and k.verified
                         and k.data->>'result' = 'pass' and k.activity_start >= date_trunc('minute', l.activity_end))) as recalibration_due_since,
      c.data->>'result' as cal_result, c.data->>'nextDue' as cal_due, coalesce(c.verified, false) as cal_verified,
      vc.data->>'result' as vcal_result, vc.data->>'nextDue' as vcal_due,
      -- S6: the latest result per steriliser test type and per glove port, the latest cycle, and
      -- the latest reading per pressure point.
      -- A failed steriliser test blocks at once; only a verified pass clears it (review S6-2): per test
      -- type, the latest result, and the latest verified result when the latest is an unverified pass.
      (select array_agg(t.test) from (
         select distinct on (l.data->>'test') l.data->>'test' as test, l.data->>'result' as result, l.verified,
           (select v.data->>'result' from latest v where v.equipment_id = q.id and v.logbook_type = 'steriliser_test'
              and v.data->>'test' = l.data->>'test' and v.verified order by v.activity_start desc limit 1) as verified_result
         from latest l where l.equipment_id = q.id and l.logbook_type = 'steriliser_test'
         order by l.data->>'test', l.activity_start desc) t
       where t.result = 'fail' or (not t.verified and coalesce(t.verified_result, 'none') <> 'pass')) as failed_steriliser_tests,
      exists (select 1 from latest l where l.equipment_id = q.id and l.logbook_type = 'steriliser_test'
              and l.verified and l.data->>'result' = 'pass') as has_passed_steriliser_test,
      (select array_agg(g.port) from (
         select distinct on (l.data->>'port') l.data->>'port' as port, l.data->>'result' as result
         from latest l where l.equipment_id = q.id and l.logbook_type = 'glove_integrity'
         order by l.data->>'port', l.activity_start desc) g where g.result = 'fail') as failed_glove_ports,
      (select l.data->>'result' from latest l where l.equipment_id = q.id and l.logbook_type = 'steriliser_cycle'
         order by l.activity_start desc limit 1) as last_cycle_result,
      (select array_agg(p.point) from (
         select distinct on (l.data->>'point') l.data->>'point' as point, (l.data->>'outOfLimit')::boolean as oos
         from latest l where l.equipment_id = q.id and l.logbook_type = 'pressure_reading'
         order by l.data->>'point', l.activity_start desc) p where p.oos) as pressure_out_of_limit,
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

  // D-25: a repair that needs re-calibration blocks use until a verified passed calibration after it.
  // Where the item is not calibrated in this system, it is a warning (review S9).
  if (f.recalibration_due_since) {
    const day = f.recalibration_due_since.toLocaleDateString('en-CA', { timeZone: PLANT_TZ });
    if (f.needs_calibration && f.calibrations_enabled) {
      blockers.push(`Re-calibration needed after the repair of ${day}: record and verify a passed calibration.`);
      calState ??= 'not_calibrated';
    } else warnings.push(`The repair of ${day} asked for re-calibration; this item is not calibrated in the logbook.`);
  }

  // S6 (Annex 1): sterile checks.
  const TEST_LABEL: Record<string, string> = { leak: 'leak test', air_removal: 'air-removal (Bowie-Dick) test' };
  for (const test of f.failed_steriliser_tests ?? []) blockers.push(`Steriliser ${TEST_LABEL[test] ?? test} failed or awaiting verification: a verified pass is needed before use.`);
  for (const port of f.failed_glove_ports ?? []) blockers.push(`Glove integrity failed on port ${port}: replace and pass before use.`);
  if (f.last_cycle_result === 'fail') warnings.push('The last sterilisation cycle failed: see its deviation.');
  for (const point of f.pressure_out_of_limit ?? []) warnings.push(`Last pressure reading out of limits: ${point}.`);

  // LB-07: cleaning status, where the site tracks cleaning for this kind of item.
  let cleanUntil: Date | null = null;
  let cleanState: StatusCode | null = null;
  if (f.tracks_cleaning && !f.open_use_id) {
    // The query only returns cleanings that followed the last use.
    const cleanedAfterUse = Boolean(f.last_clean_end);
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
  // Cycles are stopped by everything except the cleaning status (review S6-1: including use).
  const cycleBlockers = blockers.filter((b) => !/^(Dirty|Clean-hold)/.test(b));

  const state: StatusCode = f.open_use_id
    ? 'in_use'
    : f.open_breakdowns > 0 || (f.failed_steriliser_tests?.length ?? 0) > 0 || (f.failed_glove_ports?.length ?? 0) > 0
      ? 'out_of_service'
      : (calState ?? cleanState ?? 'available');

  return {
    equipmentId: f.id,
    state,
    blockers,
    cycleBlockers,
    warnings,
    inUse: f.open_use_id
      ? { entryId: f.open_use_id, productId: f.open_use_product, batch: f.open_use_batch, stage: f.open_use_stage ?? '', since: f.open_use_since! }
      : null,
    lastUseEnd: f.last_use_end,
    hasPassedSterilizerTest: f.has_passed_steriliser_test,
    cleanUntil,
    calibrationDue,
  };
}

export async function statusOf(q: Sql | Tx, equipmentId: number): Promise<EquipmentStatus | null> {
  const [f] = await facts(q, [equipmentId]);
  return f ? deriveStatus(f) : null;
}

// In groups: each group's lookups scan only its own entries, not every entry once per item
// (S11: 317 items in one query took over 2 s on the trial server).
const GROUP = 25;

export async function allStatuses(q: Sql | Tx): Promise<EquipmentStatus[]> {
  const ids = (await q<{ id: number }[]>`select id::int from equipment order by id`).map((r) => r.id);
  const out: Facts[] = [];
  for (let i = 0; i < ids.length; i += GROUP) out.push(...(await facts(q, ids.slice(i, i + GROUP))));
  return out.map(deriveStatus);
}
