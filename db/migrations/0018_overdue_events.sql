-- Owner 2026-11-12 (D-37): an overdue cleaning (dirty hold, clean hold, scheduled cleaning), preventive maintenance,
-- calibration or requalification raises a deviation in the Deviations product on its own. The Logbook records each
-- missed limit once, here, when it first finds it overdue, together with the report text Deviations files for it, and
-- publishes the records in report.overdue_v1. Deviations reads that view through its platform link and files each
-- record once (its deviation_v1 carries source_ref 'logbook:overdue:<event_id>', which the Logbook reads back to show
-- the deviation number). Nothing is written across databases. A record is a fact: insert-only.
create table overdue_events (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  kind text not null check (kind in ('dirty_hold', 'clean_hold', 'frequency', 'pm', 'calibration', 'requalification')),
  -- When the limit ran out (a date due is the end of that plant day).
  due_at timestamptz not null,
  -- The item as master data named it when the limit ran out.
  code text not null,
  name text not null,
  item_kind text not null,
  location text not null default '',
  -- The report Deviations files.
  title text not null check (length(trim(title)) > 0),
  description text not null check (length(trim(description)) > 0),
  immediate_action text not null check (length(trim(immediate_action)) > 0),
  impact_notes text not null check (length(trim(impact_notes)) > 0),
  detected_at timestamptz not null default now(),
  unique (equipment_id, kind, due_at)
);
revoke all on overdue_events from logbook_app;   -- the platform's default grants (0000)
grant select, insert on overdue_events to logbook_app;
revoke all on sequence overdue_events_id_seq from logbook_app;   -- identity columns need no sequence right

-- Published to the linked Deviations product (same rules as migration 0013: read-only, versioned, security barrier).
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create view overdue_v1 with (security_barrier) as
select o.id as event_id, o.code as equipment_code, o.name as equipment_name, o.item_kind as equipment_kind, o.location,
  o.kind, o.due_at, o.detected_at, o.title, o.description, o.immediate_action, o.impact_notes,
  now() as read_at, o.detected_at as data_as_of
from overdue_events o;

revoke all on overdue_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'logbook_report') then grant select on overdue_v1 to logbook_report; end if;
end $$;

reset search_path;
