import type { Sql, Tx } from './db.js';
import { careByLocalId, type Care, type Master } from './master.js';
import type { Qualification, QualStatus } from './qualification.js';

// Plant time zone: calibration due dates are plant-local dates (D-19).
export const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';

// Equipment and area status (LB-05–08), computed from the latest entry versions. Nothing is stored:
// the log is the single source of truth.

export type StatusCode = 'in_use' | 'in_change_over' | 'dirty' | 'dirty_expired' | 'clean' | 'clean_expired' | 'cleaning_due' | 'pm_overdue' | 'requalification_overdue' | 'not_qualified' | 'out_of_service' | 'calibration_overdue' | 'calibration_failed' | 'not_calibrated' | 'available';

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
  // Owner 2026-11-12: how the cleaning is scheduled and the next cleaning deadline (dirty hold, clean hold, frequency).
  schedule: 'hold' | 'frequency' | null;
  dirtyUntil: Date | null;
  deadline: CleaningDeadline | null;
  // Dates due in days (PM, calibration, requalification): soon within DUES_WARN_DAYS, overdue once passed.
  dues: Due[];
  qualification: QualStatus['status'] | null;
}

// The next time by which the item must be cleaned. soon: in the last quarter of the hold or frequency (at least 1 hour).
export interface CleaningDeadline {
  kind: 'dirty_hold' | 'clean_hold' | 'frequency';
  at: Date;
  hours: number;
  soon: boolean;
  overdue: boolean;
}
export interface Due {
  kind: 'pm' | 'calibration' | 'requalification';
  due: string;                      // plant date
  frequency: string;                // in words, e.g. "every 90 days"
  soon: boolean;
  overdue: boolean;
  dueFrom: string;                  // plant date from which it counts as due (85 % of the allowed time, D-41)
}
// Owner (point 8): pending activities show from 15 days before they are due (where no start is known; D-41: 85 %).
export const DUES_WARN_DAYS = 15;
// D-41: a cleaning is due once 85 % of its hold or interval has passed.
export const WARN_FRACTION = 1 - 0.85;
export const WARN_MIN_HOURS = 0;
export function deadline(kind: CleaningDeadline['kind'], from: Date, hours: number, now: number): CleaningDeadline {
  const at = new Date(from.getTime() + hours * 3_600_000);
  const left = at.getTime() - now;
  const window = Math.max(WARN_MIN_HOURS, hours * WARN_FRACTION) * 3_600_000;
  return { kind, at, hours, overdue: left < 0, soon: left >= 0 && left <= window };
}
const plantTime = (d: Date) => d.toLocaleString('sv-SE', { timeZone: PLANT_TZ }).slice(0, 16);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const plantDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: PLANT_TZ });
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
// Owner 2026-11-13 (D-41): an activity is due once 85 % of its allowed time has passed (PM, calibration, requalification:
// from the last one to the next due date). Without a known start, DUES_WARN_DAYS before the due date.
export const DUE_AT_FRACTION = 0.85;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
function dueOf(kind: Due['kind'], due: string, today: string, frequency: string, start: string | null = null): Due {
  const span = start ? daysBetween(start, due) : 0;
  const window = span > 0 ? Math.ceil(span * (1 - DUE_AT_FRACTION)) : DUES_WARN_DAYS;
  return { kind, due, frequency, overdue: due < today, soon: due >= today && due <= addDays(today, window), dueFrom: addDays(due, -window) };
}

/** What the status needs from master data and the Qualification product, by local item id (platform D-24). */
export interface StatusContext {
  care: Map<number, Care & { needsCalibration: boolean; addedAt: Date }>;
  qual: Map<number, QualStatus> | null;           // null: no Qualification link
}
export async function statusContext(sql: Sql | Tx, master: Master, qualification: Qualification | null): Promise<StatusContext> {
  const care = await careByLocalId(sql, master);
  if (!qualification) return { care, qual: null };
  const byMaster = await qualification.statuses();
  const ids = await sql<{ id: number; item_id: string }[]>`select id::int, item_id::text from equipment where item_id is not null`;
  return { care, qual: new Map(ids.flatMap((r) => (byMaster.has(r.item_id) ? [[r.id, byMaster.get(r.item_id)!] as const] : []))) };
}

interface Facts {
  id: number;
  kind: 'equipment' | 'instrument' | 'area';
  // From master data (platform D-24), merged in after the query.
  care: Care & { needsCalibration: boolean; addedAt: Date };
  qual: QualStatus | null;
  hasQual: boolean;
  last_pm_end: Date | null;
  last_cal_pass_at: Date | null;
  open_change_over_since: Date | null;
  // The latest verified requalification written in the Logbook (owner 2026-11-12): its date and next due date.
  last_requal_at: Date | null;
  last_requal_due: string | null;
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
async function facts(q: Sql | Tx, ids: number[] | null, ctx: StatusContext): Promise<Facts[]> {
  const scope = ids === null ? q`true` : q`e.equipment_id = any(${ids}::bigint[])`;
  const rows = await q<Omit<Facts, 'care' | 'qual' | 'hasQual'>[]>`
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
    select q.id::int, q.kind,
      (select max(l.activity_end) from latest l where l.equipment_id = q.id and l.verified and l.logbook_type = 'maintenance'
         and l.data->>'kind' = 'preventive') as last_pm_end,
      (select max(coalesce(l.activity_end, l.activity_start)) from latest l where l.equipment_id = q.id and l.verified
         and l.logbook_type = 'calibration' and l.data->>'result' = 'pass') as last_cal_pass_at,
      (select max(l.activity_start) from latest l where l.equipment_id = q.id and l.logbook_type = 'change_over' and l.activity_end is null) as open_change_over_since,
      rq.at as last_requal_at, rq.due as last_requal_due,
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
      select coalesce(l.activity_end, l.activity_start) as at, nullif(l.data->>'nextDue', '') as due from latest l
      where l.equipment_id = q.id and l.logbook_type = 'requalification' and l.verified and l.data->>'outcome' <> 'fail'
      order by coalesce(l.activity_end, l.activity_start) desc limit 1
    ) rq on true
    left join lateral (
      select l.* from latest l where l.equipment_id = q.id and l.logbook_type = 'calibration' and l.verified
      order by l.activity_start desc limit 1
    ) vc on true
    where ${ids === null ? q`true` : q`q.id = any(${ids}::bigint[])`}`;
  const none = { cleanHoldHours: null, dirtyHoldHours: null, cleaningBasis: null, cleaningFrequencyHours: null, pmFrequencyDays: null,
    calibrationFrequencyDays: null, requalificationFrequencyMonths: null, needsCalibration: false, addedAt: new Date(0) };
  return rows.map((r) => ({ ...r, care: ctx.care.get(r.id) ?? none, qual: ctx.qual?.get(r.id) ?? null, hasQual: ctx.qual !== null }));
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
  if (f.care.needsCalibration) {
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
        // D-24: with a calibration frequency in master data, the next calibration is due that long after the last verified
        // pass, or on the date the certificate gives, whichever comes first.
        if (f.care.calibrationFrequencyDays && f.last_cal_pass_at) {
          const byFrequency = addDays(plantDate(f.last_cal_pass_at), f.care.calibrationFrequencyDays);
          if (!calibrationDue || byFrequency < calibrationDue) calibrationDue = byFrequency;
        }
        if (calibrationDue && calibrationDue < f.today) {
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
    if (f.care.needsCalibration && f.calibrations_enabled) {
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

  // LB-07: cleaning status, where the site tracks cleaning for this kind of item. A frequency-based room is due its
  // cleaning every cleaning_frequency_hours; everything else is cleaned after use, within its dirty hold, and stays clean
  // for its clean hold (master data, D-24).
  let cleanUntil: Date | null = null;
  let dirtyUntil: Date | null = null;
  let due: CleaningDeadline | null = null;
  let cleanState: StatusCode | null = null;
  const c = f.care;
  const schedule: EquipmentStatus['schedule'] = !f.tracks_cleaning ? null
    : f.kind === 'area' && c.cleaningBasis === 'frequency' && c.cleaningFrequencyHours ? 'frequency' : 'hold';
  if (f.tracks_cleaning && !f.open_use_id) {
    // The query only returns cleanings that followed the last use.
    if (!f.last_clean_end) {
      cleanState = 'dirty';
      if (schedule === 'hold' && c.dirtyHoldHours && f.last_use_end) {
        due = deadline('dirty_hold', f.last_use_end, c.dirtyHoldHours, now);
        dirtyUntil = due.at;
        if (due.overdue) cleanState = 'dirty_expired';
      }
      blockers.push(f.unverified_cleanings > 0 ? 'Dirty: the cleaning is awaiting verification.'
        : cleanState === 'dirty_expired' ? `Dirty-hold time expired at ${plantTime(dirtyUntil!)}: the cleaning is late; clean, verify and record why.`
          : 'Dirty: clean and verify before the next use.');
      if (due?.soon) warnings.push(`Dirty hold ends at ${plantTime(due.at)}: clean before then.`);
    } else if (schedule === 'frequency') {
      due = deadline('frequency', f.last_clean_end, c.cleaningFrequencyHours!, now);
      cleanUntil = due.at;
      if (due.overdue) {
        blockers.push(`Cleaning overdue since ${plantTime(due.at)} (every ${c.cleaningFrequencyHours} h): clean and verify.`);
        cleanState = 'cleaning_due';
      } else {
        cleanState = 'clean';
        if (due.soon) warnings.push(`Next cleaning due at ${plantTime(due.at)}.`);
      }
    } else if (c.cleanHoldHours) {
      due = deadline('clean_hold', f.last_clean_end, c.cleanHoldHours, now);
      cleanUntil = due.at;
      if (due.overdue) {
        blockers.push(`Clean-hold time expired at ${plantTime(cleanUntil)}: clean again before use.`);
        cleanState = 'clean_expired';
      } else {
        cleanState = 'clean';
        if (due.soon) warnings.push(`Clean hold ends at ${plantTime(cleanUntil)}: use or clean again before then.`);
      }
    } else cleanState = 'clean';
  }

  // Owner 2026-11-12 (slide 4, point 8): preventive maintenance, calibration and requalification dues, from master data's
  // frequencies and the Qualification product. Overdue blocks use.
  const dues: Due[] = [];
  let duesState: StatusCode | null = null;
  if (c.pmFrequencyDays) {
    const from = f.last_pm_end ?? c.addedAt;
    const d = dueOf('pm', addDays(plantDate(from), c.pmFrequencyDays), f.today, `every ${c.pmFrequencyDays} days`, plantDate(from));
    dues.push(d);
    if (d.overdue) { blockers.push(`Preventive maintenance overdue since ${d.due}: do the PM before use.`); duesState ??= 'pm_overdue'; }
  }
  if (calibrationDue && (c.calibrationFrequencyDays || f.care.needsCalibration)) {
    dues.push(dueOf('calibration', calibrationDue, f.today, c.calibrationFrequencyDays ? `every ${c.calibrationFrequencyDays} days` : 'per certificate',
      f.last_cal_pass_at ? plantDate(f.last_cal_pass_at) : null));
  }
  // A requalification written in the Logbook gives the due date where the Qualification product has none.
  const requalDue = f.qual?.nextReviewDue ?? f.last_requal_due
    ?? (f.last_requal_at && c.requalificationFrequencyMonths ? addMonths(plantDate(f.last_requal_at), c.requalificationFrequencyMonths) : null);
  if (requalDue && !f.qual?.nextReviewDue) {
    const d = dueOf('requalification', requalDue, f.today, c.requalificationFrequencyMonths ? `every ${c.requalificationFrequencyMonths} months` : 'per requalification report',
      f.last_requal_at ? plantDate(f.last_requal_at) : null);
    dues.push(d);
    if (d.overdue) { blockers.push(`Requalification overdue since ${d.due}: requalify before use.`); duesState ??= 'requalification_overdue'; }
  }
  if (f.qual) {
    if (f.qual.nextReviewDue) {
      const d = dueOf('requalification', f.qual.nextReviewDue, f.today,
        c.requalificationFrequencyMonths ? `every ${c.requalificationFrequencyMonths} months` : 'per qualification report',
        c.requalificationFrequencyMonths ? addMonths(f.qual.nextReviewDue, -c.requalificationFrequencyMonths) : (f.last_requal_at ? plantDate(f.last_requal_at) : null));
      dues.push(d);
      if (d.overdue) { blockers.push(`Requalification overdue since ${d.due}: requalify before use.`); duesState ??= 'requalification_overdue'; }
    }
    if (f.qual.status === 'not_qualified' || f.qual.status === 'requalification_needed') {
      blockers.push(f.qual.status === 'not_qualified' ? 'Not qualified: see the Qualification system.' : 'Requalification needed: see the Qualification system.');
      duesState ??= 'not_qualified';
    }
  }

  // Owner 2026-11-12: one activity at a time; a change over in progress occupies the item like a use.
  if (f.open_change_over_since) blockers.push(`Change over in progress since ${plantTime(f.open_change_over_since)}: end it first.`);
  // LB-08: the item in use shows what is in it.
  if (f.open_use_id) blockers.push('In use: end the current use first.');
  // Cycles are stopped by everything except the cleaning status (review S6-1: including use).
  const cycleBlockers = blockers.filter((b) => !/^(Dirty|Clean-hold|Cleaning overdue)/.test(b));

  const state: StatusCode = f.open_use_id
    ? 'in_use'
    : f.open_change_over_since ? 'in_change_over'
    : f.open_breakdowns > 0 || (f.failed_steriliser_tests?.length ?? 0) > 0 || (f.failed_glove_ports?.length ?? 0) > 0
      ? 'out_of_service'
      : (calState ?? duesState ?? cleanState ?? 'available');

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
    schedule,
    dirtyUntil,
    deadline: due,
    dues,
    qualification: f.qual?.status ?? null,
  };
}

export async function statusOf(q: Sql | Tx, equipmentId: number, ctx: StatusContext): Promise<EquipmentStatus | null> {
  const [f] = await facts(q, [equipmentId], ctx);
  return f ? deriveStatus(f) : null;
}

// In groups: each group's lookups scan only its own entries, not every entry once per item
// (S11: 317 items in one query took over 2 s on the trial server).
const GROUP = 25;

export async function allStatuses(q: Sql | Tx, ctx: StatusContext): Promise<EquipmentStatus[]> {
  const ids = (await q<{ id: number }[]>`select id::int from equipment order by id`).map((r) => r.id);
  const out: Facts[] = [];
  for (let i = 0; i < ids.length; i += GROUP) out.push(...(await facts(q, ids.slice(i, i + GROUP), ctx)));
  return out.map(deriveStatus);
}
