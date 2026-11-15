-- D-45 (owner 15 Nov 2026): the status the Logbook works out for each item (LB-05 to LB-08: cleaning, calibration,
-- qualification, PM, breakdown, in use) is published for TrueBatch Tablets in report.equipment_status_v1, so a batch
-- record checks a machine or room against the Logbook instead of asking the operator. The status depends on master
-- data and the Qualification product (other databases), so it cannot be a plain view: the Logbook writes it here, one
-- row per item, in its minute check and right after each entry is written. This is current state, not a record (the
-- log stays the single source, D-18): the app may update a row (platform D-17: an explicit grant for current state).
-- A row is only ever replaced by a newer check (checked_at); a reader refuses a status older than a few minutes.
create table item_status (
  equipment_id bigint primary key references equipment(id),
  state text not null,
  -- Nothing but a use in progress may stop a new use (in_use_batch says which batch holds the item).
  fit_for_use boolean not null,
  blockers text[] not null,
  warnings text[] not null,
  in_use_batch text,
  -- The verified cleaning in force (after the last use) and who performed it.
  cleaned_at timestamptz,
  cleaned_by text,
  clean_until timestamptz,
  calibration_due date,
  qualification text,
  checked_at timestamptz not null
);
revoke all on item_status from logbook_app;   -- the platform's default grants (0000)
grant select, insert, update on item_status to logbook_app;

-- Published to linked products (same rules as migration 0013: read-only, versioned, security barrier).
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- One row per item of the Logbook with a master-data id. master_id: the master item (uuid); code and kind as the
-- Logbook holds them (the code never changes). data_as_of: when the status was worked out (= checked_at).
create view equipment_status_v1 with (security_barrier) as
select q.item_id as master_id, q.code, q.kind, s.state, s.fit_for_use, s.blockers, s.warnings, s.in_use_batch, s.cleaned_at,
  s.cleaned_by, s.clean_until, s.calibration_due, s.qualification, s.checked_at, now() as read_at, s.checked_at as data_as_of
from item_status s
join equipment q on q.id = s.equipment_id
where q.item_id is not null;

revoke all on equipment_status_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'logbook_report') then grant select on equipment_status_v1 to logbook_report; end if;
end $$;

reset search_path;
