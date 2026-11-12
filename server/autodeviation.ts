import type { Sql } from './db.js';
import { audit } from './audit.js';
import { allStatuses, PLANT_TZ } from './status.js';

// S16b (D-34, owner request): a cleaning that misses its time limit raises a deviation in the site's Deviations system
// on its own. Which misses: the dirty hold after a use (the cleaning is late) and a frequency-based room's scheduled
// cleaning (a scheduled cleaning was missed). A clean hold that runs out is not a deviation: the item is simply cleaned
// again before its next use, and the status blocks the use until then.
// The report goes in through the Deviations system's own reporting route, as its user for automatic reports, so it is
// numbered, audited and classified by QA there like any other report. Each missed limit is reported once.

export interface DeviationReport {
  title: string;
  description: string;
  equipment: string;
  eventAt: string;
  immediateAction: string;
  impactNotes: string;
}
export interface DeviationSink {
  // Returns the deviation number the Deviations system gave the report.
  raise(report: DeviationReport): Promise<string>;
}

export interface DeviationsSettings { baseUrl: string; username: string; password: string; areaName: string; timeoutMs: number }

/** The Deviations system's API, as its user for automatic reports (sign in, report, sign out). */
export function deviationsClient(s: DeviationsSettings): DeviationSink {
  const url = (p: string) => new URL(p, s.baseUrl.endsWith('/') ? s.baseUrl : `${s.baseUrl}/`).toString();
  const call = async (method: string, path: string, cookie: string, body?: object) => {
    const res = await fetch(url(path.replace(/^\//, '')), {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    return res;
  };
  return {
    async raise(r) {
      const login = await call('POST', '/api/login', '', { username: s.username, password: s.password });
      if (!login.ok) throw new Error(`the Deviations system refused the sign-in (${login.status})`);
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      try {
        const me = await (await call('GET', '/api/me', cookie)).json() as { passwordChangeRequired?: boolean };
        if (me.passwordChangeRequired) throw new Error('the Deviations account for automatic reports must change its password first');
        const areas = await (await call('GET', '/api/areas', cookie)).json() as { id: number; name: string; active: boolean }[];
        const area = areas.find((a) => a.active && a.name.trim().toLowerCase() === s.areaName.trim().toLowerCase());
        if (!area) throw new Error(`the Deviations system has no active area "${s.areaName}"`);
        const res = await call('POST', '/api/deviations', cookie, {
          planned: false, title: r.title, description: r.description, areaId: area.id, equipment: r.equipment, eventAt: r.eventAt,
          products: [], noBatch: true, immediateAction: r.immediateAction, actionTakenAt: null,
          initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: r.impactNotes },
        });
        const out = await res.json().catch(() => ({})) as { number?: string; problems?: string[]; error?: string };
        if (res.status !== 201 || !out.number) throw new Error(`the Deviations system did not accept the report (${res.status}${out.problems ? `: ${out.problems.join(' ')}` : out.error ? `: ${out.error}` : ''})`);
        return out.number;
      } finally {
        await call('POST', '/api/logout', cookie, {}).catch(() => {});
      }
    },
  };
}

const plant = (d: Date) => `${d.toLocaleString('en-IN', { timeZone: PLANT_TZ, dateStyle: 'medium', timeStyle: 'short' })} IST`;
const MAX_ATTEMPTS = 50;

/** The missed limits not yet on record are recorded, and every one not yet reported is reported (with retries). */
export async function raiseOverdueDeviations(sql: Sql, sink: DeviationSink): Promise<{ detected: number; raised: string[]; failed: number }> {
  const statuses = await allStatuses(sql);
  let detected = 0;
  for (const s of statuses) {
    const d = s.deadline;
    if (!d?.overdue || (d.kind !== 'dirty_hold' && d.kind !== 'frequency')) continue;
    const [row] = await sql`
      insert into auto_deviations (equipment_id, kind, deadline_at)
      select ${s.equipmentId}, ${d.kind}, ${d.at} where exists (select 1 from equipment where id = ${s.equipmentId} and active)
      on conflict (equipment_id, kind, deadline_at) do nothing returning id`;
    if (row) detected++;
  }

  const pending = await sql<{ id: number; equipment_id: number; kind: 'dirty_hold' | 'frequency'; deadline_at: Date; code: string; name: string;
    item_kind: string; location: string; dirty_hold_hours: number | null; cleaning_frequency_hours: number | null }[]>`
    select a.id::int, a.equipment_id::int, a.kind, a.deadline_at, q.code, q.name, q.kind as item_kind, q.location,
      q.dirty_hold_hours, q.cleaning_frequency_hours
    from auto_deviations a join equipment q on q.id = a.equipment_id
    where a.deviation_number is null and a.attempts < ${MAX_ATTEMPTS} order by a.id`;
  const raised: string[] = [];
  let failed = 0;
  for (const p of pending) {
    // What the item was last used for: the batch the late cleaning may concern.
    const [use] = await sql<{ batch: string | null; product: string | null; ended: Date | null }[]>`
      select e.batch, pr.code || ' ' || pr.name as product, e.activity_end as ended
      from entries e left join products pr on pr.id = e.product_id
      where e.equipment_id = ${p.equipment_id} and e.logbook_type = 'equipment_use' and e.activity_end is not null
        and not exists (select 1 from entries x where x.supersedes = e.id)
      order by e.activity_end desc limit 1`;
    const what = p.item_kind === 'area' ? 'Room' : p.item_kind === 'instrument' ? 'Instrument' : 'Equipment';
    const report: DeviationReport = p.kind === 'dirty_hold'
      ? {
        title: `Dirty hold expired: ${p.code} not cleaned within ${p.dirty_hold_hours ?? '?'} h of use`,
        description: `${what} ${p.code} (${p.name}${p.location ? `, ${p.location}` : ''}) was not cleaned within its dirty hold of ${p.dirty_hold_hours ?? '?'} hours after use. `
          + `The use ended ${use?.ended ? plant(use.ended) : '(not recorded)'}${use?.batch ? `, batch ${use.batch}${use.product ? ` of ${use.product}` : ''}` : ''}. `
          + `The dirty hold ran out ${plant(p.deadline_at)} with no verified cleaning on record. Raised automatically by the Pharma Logbook.`,
        equipment: p.code,
        eventAt: p.deadline_at.toISOString(),
        immediateAction: `The Logbook blocks any use of ${p.code} until a cleaning is recorded and verified. No action recorded yet: this report was raised automatically when the dirty hold ran out.`,
        impactNotes: 'Automatic report from the Pharma Logbook: QA to assess the impact (cleaning validation of the hold time, residue and microbial risk, the batch last made).',
      }
      : {
        title: `Scheduled cleaning missed: ${p.code} (every ${p.cleaning_frequency_hours ?? '?'} h)`,
        description: `${what} ${p.code} (${p.name}${p.location ? `, ${p.location}` : ''}) is cleaned on a schedule, every ${p.cleaning_frequency_hours ?? '?'} hours. `
          + `Its next cleaning was due ${plant(p.deadline_at)} and no verified cleaning was recorded by then. Raised automatically by the Pharma Logbook.`,
        equipment: p.code,
        eventAt: p.deadline_at.toISOString(),
        immediateAction: `The Logbook blocks any use of ${p.code} until a cleaning is recorded and verified. No action recorded yet: this report was raised automatically when the cleaning became overdue.`,
        impactNotes: 'Automatic report from the Pharma Logbook: QA to assess the impact of the missed scheduled cleaning (area status, activities in the room since).',
      };
    try {
      const number = await sink.raise(report);
      await sql.begin(async (tx) => {
        await tx`update auto_deviations set deviation_number = ${number}, raised_at = now(), attempts = attempts + 1, last_error = null where id = ${p.id}`;
        await audit(tx, { actorId: null, action: 'deviation.raised_automatically', objectType: 'equipment', objectId: p.equipment_id,
          new: { deviation: number, limit: p.kind, ranOutAt: p.deadline_at.toISOString() } });
      });
      raised.push(number);
    } catch (e) {
      failed++;
      await sql`update auto_deviations set attempts = attempts + 1, last_error = ${String((e as Error).message).slice(0, 500)} where id = ${p.id}`;
    }
  }
  return { detected, raised, failed };
}

/** Checks every few minutes inside the server process (as the daily integrity check does). */
export function scheduleAutoDeviations(sql: Sql, sink: DeviationSink, log: (msg: string) => void, everyMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await raiseOverdueDeviations(sql, sink);
      if (r.raised.length || r.failed) log(`automatic deviations: ${r.raised.length} raised (${r.raised.join(', ')}), ${r.failed} could not be reported yet`);
    } catch (e) {
      log(`automatic deviations could not run: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  void tick();
  return () => clearInterval(timer);
}
