import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requirePermission } from '../auth.js';
import { logbookItems, type LogbookItem } from '../master.js';
import { LOGBOOK_TYPES } from '../logbook-types.js';

// Owner 2026-11-13 (D-41): the home dashboard.
//  1. Compliance: share of scheduled activities (cleaning, PM, calibration, requalification) done before their deadline.
//  2. Pending review and approval: what waits for me, and (for senior people) what waits with others, by department and age.
// D-68: the third part (exceptions and abnormalities from Batchwright's batch records) went with Batchwright.

export const COMPLIANCE_DAYS = 30;
export const LATE_AFTER_HOURS = 8;          // one shift: a pending review older than this is "getting late"
type Group = 'cleaning' | 'pm' | 'calibration' | 'requalification';
const GROUPS: Group[] = ['cleaning', 'pm', 'calibration', 'requalification'];
const MISSED_GROUP: Record<string, Group> = { dirty_hold: 'cleaning', clean_hold: 'cleaning', frequency: 'cleaning', pm: 'pm', calibration: 'calibration', requalification: 'requalification' };
// The entries that complete each kind of scheduled activity (latest versions).
const DONE_SQL = `case when e.logbook_type in ('equipment_cleaning', 'area_cleaning') then 'cleaning'
  when e.logbook_type = 'maintenance' and e.data->>'kind' = 'preventive' then 'pm'
  when e.logbook_type = 'calibration' then 'calibration' when e.logbook_type = 'requalification' then 'requalification' end`;
const TYPE_LABEL: Record<string, string> = Object.fromEntries(LOGBOOK_TYPES.map((t) => [t.key, t.label]));

/** The department of an item: the area of its room (master data), or the room's own area. */
function departments(items: LogbookItem[]) {
  const roomArea = new Map(items.filter((i) => i.kind === 'area').map((i) => [i.code, i.area ?? null]));
  return new Map(items.map((i) => [i.id, (i.kind === 'area' ? i.area : roomArea.get(i.room ?? '')) ?? 'Other']));
}

export function dashboardRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  app.get('/api/dashboard/compliance', anyUser, async () => {
    const since = new Date(Date.now() - COMPLIANCE_DAYS * 86_400_000);
    const done = await sql<{ g: Group; n: number }[]>`
      select ${sql.unsafe(DONE_SQL)} as g, count(*)::int as n from entries e
      where not exists (select 1 from entries x where x.supersedes = e.id)
        and coalesce(e.activity_end, e.activity_start) >= ${since} and ${sql.unsafe(DONE_SQL)} is not null
      group by 1`;
    // Limits missed in the period, and whether the activity was done afterwards (late) or is still open.
    const missed = await sql<{ kind: string; late_done: boolean }[]>`
      select o.kind, exists (select 1 from entries e where e.equipment_id = o.equipment_id
        and not exists (select 1 from entries x where x.supersedes = e.id)
        and ${sql.unsafe(DONE_SQL)} = (case when o.kind in ('dirty_hold', 'clean_hold', 'frequency') then 'cleaning' else o.kind end)
        and coalesce(e.activity_end, e.activity_start) > o.due_at) as late_done
      from overdue_events o where o.due_at >= ${since}`;
    const by = Object.fromEntries(GROUPS.map((g) => {
      const d = done.find((r) => r.g === g)?.n ?? 0;
      const m = missed.filter((r) => MISSED_GROUP[r.kind] === g);
      const lateDone = m.filter((r) => r.late_done).length;
      const total = d + (m.length - lateDone);
      const onTime = d - lateDone;
      return [g, { total, onTime, missed: m.length, percent: total ? Math.round((onTime / total) * 1000) / 10 : null }];
    })) as Record<Group, { total: number; onTime: number; missed: number; percent: number | null }>;
    const total = GROUPS.reduce((a, g) => a + by[g].total, 0), onTime = GROUPS.reduce((a, g) => a + by[g].onTime, 0);
    return { days: COMPLIANCE_DAYS, total, onTime, percent: total ? Math.round((onTime / total) * 1000) / 10 : null, byKind: by };
  });

  app.get('/api/dashboard/pending', anyUser, async (req) => {
    const me = req.user!;
    const has = (c: string) => me.permissions.includes(c as never);
    const items = await logbookItems(sql, app.master);
    const byId = new Map(items.map((i) => [i.id, i]));
    const dept = departments(items);
    const always = LOGBOOK_TYPES.filter((t) => t.alwaysVerified).map((t) => t.key);
    const entries = await sql<{ id: number; equipment_id: number; logbook_type: string; kind: string | null; entered_by: number; by_name: string; entered_at: Date }[]>`
      select e.id::int, e.equipment_id::int, e.logbook_type, e.data->>'kind' as kind, e.entered_by::int, u.full_name as by_name, e.entered_at
      from entries e join users u on u.id = e.entered_by left join logbook_settings s on s.id = e.settings_id
      where not exists (select 1 from entries x where x.supersedes = e.id)
        and (e.logbook_type = any(${always}) or coalesce((s.settings->>'verificationRequired')::boolean, false))
        and not exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified')
        and not (e.logbook_type in ('equipment_use', 'change_over') and e.activity_end is null)
        and not (e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown' and e.activity_end is null)
      order by e.entered_at`;
    const releases = await sql<{ id: number; equipment_id: number; entered_by: number; by_name: string; since: Date }[]>`
      select e.id::int, e.equipment_id::int, e.entered_by::int, u.full_name as by_name, g.signed_at as since
      from entries e join users u on u.id = e.entered_by
      join signatures g on g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified'
      where not exists (select 1 from entries x where x.supersedes = e.id) and e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown'
        and not exists (select 1 from signatures r where r.object_type = 'entry' and r.object_id = e.id and r.meaning = 'released')`;
    const settings = await sql<{ id: number; logbook_type: string; created_by: number; by_name: string; created_at: Date }[]>`
      select s.id::int, s.logbook_type, s.created_by::int, u.full_name as by_name, s.created_at from logbook_settings s join users u on u.id = s.created_by
      where not exists (select 1 from signatures g where g.object_type = 'settings' and g.object_id = s.id and g.meaning = 'approved')
        and s.version > coalesce((select max(o.version) from logbook_settings o join signatures g on g.object_type = 'settings' and g.object_id = o.id
          and g.meaning = 'approved' where o.logbook_type = s.logbook_type), 0)`;
    const now = Date.now();
    const age = (d: Date) => Math.round(((now - d.getTime()) / 3_600_000) * 10) / 10;
    type Pending = { kind: 'verify' | 'release' | 'approve'; id: number; equipmentId: number | null; code: string; name: string; what: string;
      by: string; byMe: boolean; since: Date; ageHours: number; late: boolean; department: string };
    const all: Pending[] = [
      ...entries.map((e) => ({ kind: 'verify' as const, id: e.id, equipmentId: e.equipment_id, code: byId.get(e.equipment_id)?.code ?? '?',
        name: byId.get(e.equipment_id)?.name ?? '', what: e.logbook_type === 'maintenance' ? (e.kind === 'preventive' ? 'Preventive maintenance' : e.kind === 'breakdown' ? 'Breakdown repair' : 'Maintenance') : TYPE_LABEL[e.logbook_type] ?? e.logbook_type,
        by: e.by_name, byMe: e.entered_by === me.id, since: e.entered_at, ageHours: age(e.entered_at), late: age(e.entered_at) >= LATE_AFTER_HOURS, department: dept.get(e.equipment_id) ?? 'Other' })),
      ...releases.map((r) => ({ kind: 'release' as const, id: r.id, equipmentId: r.equipment_id, code: byId.get(r.equipment_id)?.code ?? '?', name: byId.get(r.equipment_id)?.name ?? '',
        what: 'QA release after breakdown', by: r.by_name, byMe: r.entered_by === me.id, since: r.since, ageHours: age(r.since), late: age(r.since) >= LATE_AFTER_HOURS, department: dept.get(r.equipment_id) ?? 'Other' })),
      ...settings.map((s) => ({ kind: 'approve' as const, id: s.id, equipmentId: null, code: 'Settings', name: TYPE_LABEL[s.logbook_type] ?? s.logbook_type,
        what: 'Logbook settings to approve', by: s.by_name, byMe: s.created_by === me.id, since: s.created_at, ageHours: age(s.created_at), late: age(s.created_at) >= LATE_AFTER_HOURS, department: 'QA' })),
    ].sort((a, b) => a.since.getTime() - b.since.getTime());
    const mayAct = (p: Pending) => !p.byMe && (p.kind === 'verify' ? has('logbook.entry.verify') : p.kind === 'release' ? has('logbook.breakdown.release') : has('logbook.settings.approve'));
    const forMe = all.filter(mayAct);
    const mine = all.filter((p) => p.byMe);
    // Senior people see what waits with others: those who read reviews or the audit trail, approve settings or release.
    const senior = ['logbook.review.read', 'logbook.audit.read', 'logbook.settings.approve', 'logbook.breakdown.release'].some(has);
    const others = senior ? all.filter((p) => !mayAct(p) && !p.byMe) : null;
    const byDepartment = senior ? Object.entries(all.reduce<Record<string, { normal: number; late: number }>>((acc, p) => {
      const d = (acc[p.department] ??= { normal: 0, late: 0 }); if (p.late) d.late++; else d.normal++; return acc;
    }, {})).map(([department, c]) => ({ department, ...c })).sort((a, b) => (b.normal + b.late) - (a.normal + a.late)) : null;
    return { lateAfterHours: LATE_AFTER_HOURS, total: all.length, forMe, mine, others, byDepartment };
  });
}

