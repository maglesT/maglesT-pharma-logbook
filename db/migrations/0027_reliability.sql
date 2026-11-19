-- D-77 (owner 19 Nov 2026: "logbook owns it and calculation has to be same"). The Logbook owns MTBF and MTTR per machine.
-- It publishes them per calendar month in report.reliability_v1 for Operations (OEE); its own breakdown register works
-- them out from the same two views below, so the screen and the view give the same numbers. One definition:
--
--   downtime         = time from a breakdown's occurrence to its QA release (D-25), to now while not released; a past
--                      breakdown (first recorded more than 30 minutes, LB-04, after its repair end) to its repair end
--                      (D-58). Overlapping breakdowns are down once. Cut to the window.
--   in service from  = installation date (plant time), else when the item was added to the Logbook; never after the
--                      item's first breakdown (D-59).
--   window           = the period (a calendar month in plant time, Asia/Kolkata), cut to the item's in-service start
--                      and to now.
--   in_service_hours = window − downtime (the operating time; what MTBF divides).
--   breakdowns       = breakdowns that occurred (started) in the period.
--   MTBF             = in_service_hours / breakdowns;  MTTR = downtime_hours / breakdowns;  none without breakdowns.
--
-- Several months add up: MTBF = sum(in_service_hours) / sum(breakdowns), MTTR = sum(downtime_hours) / sum(breakdowns).

-- One row per breakdown (the latest version of each breakdown entry) with the end of its downtime.
create view breakdown_downtime with (security_barrier) as
select e.id as version_id, e.entry_id, e.equipment_id, b.occurred_at, greatest(b.occurred_at, b.down_until) as down_until
from entries e
cross join lateral (
  select coalesce((e.data->>'occurredAt')::timestamptz, e.activity_start) as occurred_at,
    case
      -- D-58: first recorded more than the late-entry time (LATE_MINUTES, 30) after its repair had ended.
      when e.activity_end is not null and coalesce((select x.entered_at > x.activity_end + interval '30 minutes' from entries x
        where x.entry_id = e.entry_id and x.version = 1), false) then e.activity_end
      else coalesce((select g.signed_at from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'released'), now())
    end as down_until
) b
where e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown'
  and not exists (select 1 from entries x where x.supersedes = e.id);

-- One row per item: when it entered service and when it was down (merged, so overlapping breakdowns count once).
create view equipment_in_service with (security_barrier) as
select q.id as equipment_id, q.code,
  least(coalesce((select (d.details->>'installationDate')::date::timestamp at time zone 'Asia/Kolkata' from equipment_details d
                  where d.equipment_id = q.id order by d.version desc limit 1), q.created_at),
        (select min(b.occurred_at) from breakdown_downtime b where b.equipment_id = q.id)) as in_service_from,
  coalesce((select range_agg(tstzrange(b.occurred_at, b.down_until)) from breakdown_downtime b where b.equipment_id = q.id),
           '{}'::tstzmultirange) as down
from equipment q;

revoke all on breakdown_downtime, equipment_in_service from logbook_app;   -- the platform's default grants (0000)
grant select on breakdown_downtime, equipment_in_service to logbook_app;

-- Published to linked products (same rules as migration 0013: read-only, versioned, security barrier).
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- One row per item per calendar month (plant time) of the last 24 months up to the current one, for each month the item
-- was in service. equipment_id is equipment_v1's id. Hours are exact to 4 decimals; MTBF and MTTR rounded to 2.
-- The breakdown register works out a period the same way (server/breakdowns.ts, reliability()).
create view reliability_v1 with (security_barrier) as
with months as (
  select m::date as month, m at time zone 'Asia/Kolkata' as starts, (m + interval '1 month') at time zone 'Asia/Kolkata' as ends
  from generate_series(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '23 months',
                       date_trunc('month', now() at time zone 'Asia/Kolkata'), interval '1 month') m
), figures as (
  select s.equipment_id, s.code, w.month,
    round((select coalesce(sum(extract(epoch from upper(r) - lower(r))), 0) from unnest(p.span) r) / 3600, 4) as span_hours,
    round((select coalesce(sum(extract(epoch from upper(r) - lower(r))), 0) from unnest(s.down * p.span) r) / 3600, 4) as downtime_hours,
    (select count(*) from breakdown_downtime b where b.equipment_id = s.equipment_id and b.occurred_at >= w.starts and b.occurred_at < w.ends)::int as breakdowns
  from equipment_in_service s
  cross join months w
  cross join lateral (select greatest(w.starts, s.in_service_from) as starts, least(w.ends, now()) as ends) c
  cross join lateral (select tstzmultirange(case when c.starts < c.ends then tstzrange(c.starts, c.ends) else 'empty' end) as span) p
  where c.starts < c.ends
)
select f.equipment_id, f.code as equipment_code, f.month, f.span_hours - f.downtime_hours as in_service_hours, f.breakdowns,
  f.downtime_hours,
  round((f.span_hours - f.downtime_hours) / nullif(f.breakdowns, 0), 2) as mtbf_hours,
  round(f.downtime_hours / nullif(f.breakdowns, 0), 2) as mttr_hours,
  now() as data_as_of
from figures f;

revoke all on reliability_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'logbook_report') then grant select on reliability_v1 to logbook_report; end if;
end $$;

reset search_path;
