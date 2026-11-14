import type { Sql } from './db.js';
import { audit } from './audit.js';
import { logbookItems, type LogbookItem, type Master } from './master.js';
import { QualificationOff, type Qualification } from './qualification.js';
import { allStatuses, PLANT_TZ, statusContext, type EquipmentStatus } from './status.js';
import { recordOverdueProblem } from './problems.js';

// Owner 2026-11-12 (D-37): a missed limit raises a deviation on its own. The Logbook records each overdue cleaning
// (dirty hold, clean hold, scheduled cleaning), preventive maintenance, calibration and requalification once, with the
// report Deviations files for it (report.overdue_v1). Deviations reads the records through its platform link and files
// each one; the Logbook reads the deviation numbers back from Deviations' report.deviation_v1 (source_ref).
// Owner 2026-11-14 (D-43): a new record first waits for QA's route decision (server/problems.ts); it is published to
// Deviations only when QA sends it there. Records made before D-43 (no problem row) stay published as they were.

export type OverdueKind = 'dirty_hold' | 'clean_hold' | 'frequency' | 'pm' | 'calibration' | 'requalification';
export const OVERDUE_LABEL: Record<OverdueKind, string> = {
  dirty_hold: 'Dirty hold expired', clean_hold: 'Clean hold expired', frequency: 'Scheduled cleaning missed',
  pm: 'Preventive maintenance overdue', calibration: 'Calibration overdue', requalification: 'Requalification overdue',
};

interface Report { title: string; description: string; immediateAction: string; impactNotes: string }

const plant = (d: Date) => `${d.toLocaleString('en-IN', { timeZone: PLANT_TZ, dateStyle: 'medium', timeStyle: 'short' })} IST`;
const what = (i: LogbookItem) => (i.kind === 'area' ? 'Room' : i.kind === 'instrument' ? 'Instrument' : 'Equipment');
const named = (i: LogbookItem) => `${what(i)} ${i.code} (${i.name}${i.room ? `, ${i.room}` : ''})`;
const AUTO = 'Raised automatically by the Logbook.';

/** The end of a plant day (YYYY-MM-DD): the moment a date due is passed. */
const endOfPlantDay = async (sql: Sql, day: string) =>
  (await sql<{ at: Date }[]>`select ((${day}::date + 1)::timestamp at time zone ${PLANT_TZ}) as at`)[0]!.at;

async function lastUse(sql: Sql, equipmentId: number) {
  const [u] = await sql<{ batch: string | null; product: string | null; ended: Date | null }[]>`
    select e.batch, pr.code || ' ' || pr.name as product, e.activity_end as ended
    from entries e left join products pr on pr.id = e.product_id
    where e.equipment_id = ${equipmentId} and e.logbook_type = 'equipment_use' and e.activity_end is not null
      and not exists (select 1 from entries x where x.supersedes = e.id)
    order by e.activity_end desc limit 1`;
  return u;
}

async function report(sql: Sql, kind: OverdueKind, i: LogbookItem, s: EquipmentStatus, at: Date, due: string | null): Promise<Report> {
  const blocks = `The Logbook blocks any use of ${i.code} until`;
  const c = i.care;
  switch (kind) {
    case 'dirty_hold': {
      const u = await lastUse(sql, i.id);
      return {
        title: `Dirty hold expired: ${i.code} not cleaned within ${c.dirtyHoldHours ?? '?'} h of use`,
        description: `${named(i)} was not cleaned within its dirty hold of ${c.dirtyHoldHours ?? '?'} hours after use. `
          + `The use ended ${u?.ended ? plant(u.ended) : '(not recorded)'}${u?.batch ? `, batch ${u.batch}${u.product ? ` of ${u.product}` : ''}` : ''}. `
          + `The dirty hold ran out ${plant(at)} with no verified cleaning on record. ${AUTO}`,
        immediateAction: `${blocks} a cleaning is recorded and verified. No action recorded yet: this report was raised when the dirty hold ran out.`,
        impactNotes: 'Automatic report from the Logbook: QA to assess the impact (cleaning validation of the dirty hold time, residue and microbial risk, the batch last made).',
      };
    }
    case 'clean_hold':
      return {
        title: `Clean hold expired: ${i.code} not used within ${c.cleanHoldHours ?? '?'} h of cleaning`,
        description: `${named(i)} was cleaned but not used within its clean hold of ${c.cleanHoldHours ?? '?'} hours. `
          + `The clean hold ran out ${plant(at)}. ${AUTO}`,
        immediateAction: `${blocks} it is cleaned again and the cleaning verified. No action recorded yet: this report was raised when the clean hold ran out.`,
        impactNotes: 'Automatic report from the Logbook: QA to assess the impact (validated clean hold time, microbial risk, whether the item was used after the clean hold ran out).',
      };
    case 'frequency':
      return {
        title: `Scheduled cleaning missed: ${i.code} (every ${c.cleaningFrequencyHours ?? '?'} h)`,
        description: `${named(i)} is cleaned on a schedule, every ${c.cleaningFrequencyHours ?? '?'} hours. `
          + `Its next cleaning was due ${plant(at)} and no verified cleaning was recorded by then. ${AUTO}`,
        immediateAction: `${blocks} a cleaning is recorded and verified. No action recorded yet: this report was raised when the cleaning became overdue.`,
        impactNotes: 'Automatic report from the Logbook: QA to assess the impact of the missed scheduled cleaning (area status, activities in the room since).',
      };
    case 'pm':
      return {
        title: `Preventive maintenance overdue: ${i.code} (due ${due})`,
        description: `${named(i)} has preventive maintenance every ${c.pmFrequencyDays ?? '?'} days. It was due ${due} and no verified preventive maintenance was recorded by then. ${AUTO}`,
        immediateAction: `${blocks} its preventive maintenance is recorded and verified. No action recorded yet: this report was raised when the preventive maintenance became overdue.`,
        impactNotes: 'Automatic report from the Logbook: QA and engineering to assess the impact (condition of the item, batches made since the due date).',
      };
    case 'calibration':
      return {
        title: `Calibration overdue: ${i.code} (due ${due})`,
        description: `${named(i)} needs calibration${c.calibrationFrequencyDays ? ` every ${c.calibrationFrequencyDays} days` : ''}. It was due ${due} and no passed calibration was recorded by then. ${AUTO}`,
        immediateAction: `${blocks} a passed calibration is recorded and verified. No action recorded yet: this report was raised when the calibration became overdue.`,
        impactNotes: 'Automatic report from the Logbook: QA to assess the impact (results and batches that relied on the instrument after the due date).',
      };
    case 'requalification':
      return {
        title: `Requalification overdue: ${i.code} (due ${due})`,
        description: `${named(i)} is requalified${c.requalificationFrequencyMonths ? ` every ${c.requalificationFrequencyMonths} months` : ''}. Its requalification was due ${due} and none was completed by then. ${AUTO}`,
        immediateAction: `${blocks} it is requalified. No action recorded yet: this report was raised when the requalification became overdue.`,
        impactNotes: 'Automatic report from the Logbook: QA to assess the impact (qualified state of the item, batches made since the due date).',
      };
  }
}

/** Records every limit now overdue that is not on record yet. Returns the number of new records. */
export async function recordOverdue(sql: Sql, master: Master, qualification: Qualification | null): Promise<number> {
  // Without the Qualification product the requalification due date is not known for sure: no requalification records.
  let ctx;
  let qualKnown = qualification !== null;
  try {
    ctx = await statusContext(sql, master, qualification);
  } catch (e) {
    if (!(e instanceof QualificationOff)) throw e;
    ctx = await statusContext(sql, master, null);
    qualKnown = false;
  }
  const items = new Map((await logbookItems(sql, master)).filter((i) => i.active).map((i) => [i.id, i]));
  const statuses = await allStatuses(sql, ctx);
  // Only limits that ran out after the feature was installed (migration 0019).
  const since = (await sql<{ since: Date }[]>`select since from overdue_since`)[0]?.since ?? new Date();
  let added = 0;
  for (const s of statuses) {
    const i = items.get(s.equipmentId);
    if (!i) continue;
    const found: { kind: OverdueKind; at: Date; due: string | null }[] = [];
    if (s.deadline?.overdue) found.push({ kind: s.deadline.kind, at: s.deadline.at, due: null });
    for (const d of s.dues) {
      if (!d.overdue || (d.kind === 'requalification' && !qualKnown)) continue;
      found.push({ kind: d.kind, at: await endOfPlantDay(sql, d.due), due: d.due });
    }
    for (const f of found) {
      if (f.at < since) continue;
      const [exists] = await sql`select 1 from overdue_events where equipment_id = ${i.id} and kind = ${f.kind} and due_at = ${f.at}`;
      if (exists) continue;
      const r = await report(sql, f.kind, i, s, f.at, f.due);
      const row = await sql.begin(async (tx) => {
        const [e] = await tx<{ id: number }[]>`
          insert into overdue_events (equipment_id, kind, due_at, code, name, item_kind, location, title, description, immediate_action, impact_notes)
          values (${i.id}, ${f.kind}, ${f.at}, ${i.code}, ${i.name}, ${i.kind}, ${i.room ?? ''}, ${r.title}, ${r.description}, ${r.immediateAction}, ${r.impactNotes})
          on conflict (equipment_id, kind, due_at) do nothing returning id::int`;
        if (e) {
          await audit(tx, { actorId: null, action: 'overdue.recorded', objectType: 'equipment', objectId: i.id,
            new: { event: e.id, kind: f.kind, dueAt: f.at.toISOString() } });
          await recordOverdueProblem(tx, { id: e.id, equipmentId: i.id, kind: f.kind, code: i.code, name: i.name, itemKind: i.kind, location: i.room ?? '', title: r.title });
        }
        return e;
      });
      if (row) added++;
    }
  }
  return added;
}

/** Checks every minute inside the server process (as the daily integrity check does). */
export function scheduleOverdue(sql: Sql, master: Master, qualification: Qualification | null, log: (msg: string) => void, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await recordOverdue(sql, master, qualification);
      if (n) log(`overdue: ${n} new missed limit(s) recorded; waiting for a QA route decision`);
    } catch (e) {
      log(`overdue check could not run: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, everyMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---- The deviation numbers, read back from Deviations (report.deviation_v1, platform link).

export interface RaisedDeviation { number: string; status: string }
export interface Deviations {
  bySource(prefix: string): Promise<Map<string, RaisedDeviation>>;
  /** Owner 2026-11-14: the deviations that name a batch (deviation_v1.batch). */
  byBatch?(batch: string): Promise<{ number: string; status: string; title: string | null; openedAt: string | null; closedAt: string | null }[]>;
}

export function sqlDeviations(q: Sql): Deviations {
  return {
    async bySource(prefix) {
      const rows = await q<{ source_ref: string; number: string; status: string }[]>`
        select distinct on (source_ref) source_ref, number, status from report.deviation_v1
        where source_ref like ${prefix + '%'} order by source_ref, number`;
      return new Map(rows.map((r) => [r.source_ref, { number: r.number, status: r.status }]));
    },
    async byBatch(batch) {
      return (await q<{ number: string; status: string; title: string | null; opened_at: string | null; closed_at: string | null }[]>`
        select distinct on (number) number, status, title, opened_at::text, closed_at::text from report.deviation_v1
        where batch = ${batch} order by number`).map((r) => ({ number: r.number, status: r.status, title: r.title, openedAt: r.opened_at, closedAt: r.closed_at }));
    },
  };
}

export const SOURCE_PREFIX = 'logbook:overdue:';
