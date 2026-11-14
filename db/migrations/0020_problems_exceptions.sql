-- Owner 2026-11-14 (D-43): two routes for a problem. A missed limit (D-37) or a problem a person reports on an item
-- no longer goes to Deviations on its own: it waits for a QA decision. QA either sends it to Deviations (then it is
-- published in report.overdue_v1 as before) or handles it here as a Logbook exception EXC-YYYY-NNNN: justification,
-- impact assessment and action, approved with an e-signature; for an overdue PM, calibration or requalification QA may
-- allow continued use until a date (at most 7 days). A cleaning limit is never waived; a critical problem always goes
-- to Deviations. Problems and decisions are facts: insert-only, audited, the decision signed.

-- One id space for everything published to Deviations: legacy overdue events keep their ids, problems take the next
-- ones, so a source_ref 'logbook:overdue:<id>' in Deviations is never reused for something else.
create sequence deviation_source_ids;
select setval('deviation_source_ids', coalesce((select max(id) from overdue_events), 0) + 1, false);

create table problems (
  id bigint primary key default nextval('deviation_source_ids'),
  equipment_id bigint not null references equipment(id),
  source text not null check (source in ('overdue', 'reported')),
  -- A missed limit: the overdue event it comes from, and the kind of limit.
  overdue_event_id bigint unique references overdue_events(id),
  due_kind text check (due_kind in ('dirty_hold', 'clean_hold', 'frequency', 'pm', 'calibration', 'requalification')),
  -- A reported problem: what happened, its impact and severity, who reported it.
  what_happened text,
  impact text,
  severity text check (severity in ('minor', 'major', 'critical')),
  reported_by bigint references users(id),
  -- The item as master data named it.
  code text not null,
  name text not null,
  item_kind text not null,
  location text not null default '',
  title text not null check (length(trim(title)) > 0),
  created_at timestamptz not null default now(),
  check ((source = 'overdue') = (overdue_event_id is not null and due_kind is not null)),
  check (source <> 'overdue' or (reported_by is null and what_happened is null and impact is null and severity is null)),
  check (source <> 'reported' or (reported_by is not null and severity is not null and due_kind is null
                                  and length(trim(what_happened)) > 0 and length(trim(impact)) > 0))
);
create index problems_equipment on problems (equipment_id, created_at desc);
revoke all on problems from logbook_app;   -- the platform's default grants (0000)
grant select on problems to logbook_app;
grant insert (equipment_id, source, overdue_event_id, due_kind, what_happened, impact, severity, reported_by, code, name, item_kind, location, title)
  on problems to logbook_app;
revoke all on sequence deviation_source_ids from logbook_app;
grant usage on sequence deviation_source_ids to logbook_app;

create table problem_decisions (
  id bigint generated always as identity primary key,
  problem_id bigint not null unique references problems(id),
  route text not null check (route in ('deviation', 'exception')),
  -- A Logbook exception: its number (gapless per year, given by the app under a lock), QA's record, and until when the
  -- item may still be used (null: use stays blocked until the due is met).
  exception_number text unique check (exception_number ~ '^EXC-[0-9]{4}-[0-9]{4}$'),
  justification text,
  impact_assessment text,
  action text,
  use_allowed_until timestamptz,
  decided_by bigint not null references users(id),
  decided_at timestamptz not null default now(),
  check ((route = 'exception') = (exception_number is not null)),
  check (route <> 'exception' or (length(trim(justification)) > 0 and length(trim(impact_assessment)) > 0 and length(trim(action)) > 0)),
  check (route = 'exception' or (justification is null and impact_assessment is null and action is null and use_allowed_until is null)),
  check (use_allowed_until is null or (use_allowed_until > decided_at and use_allowed_until <= decided_at + interval '8 days'))
);
revoke all on problem_decisions from logbook_app;
grant select on problem_decisions to logbook_app;
grant insert (problem_id, route, exception_number, justification, impact_assessment, action, use_allowed_until, decided_by) on problem_decisions to logbook_app;
revoke all on sequence problem_decisions_id_seq from logbook_app;

-- The database enforces the rules of a decision as well as the app does.
create function check_problem_decision() returns trigger language plpgsql as $$
declare p problems%rowtype;
begin
  select * into p from problems where id = new.problem_id;
  if not found then raise exception 'no such problem' using errcode = 'P0001'; end if;
  if new.route = 'exception' and p.severity = 'critical' then
    raise exception 'a critical problem cannot be handled as a Logbook exception: send it to Deviations' using errcode = 'P0001';
  end if;
  if new.use_allowed_until is not null and coalesce(p.due_kind, '') not in ('pm', 'calibration', 'requalification') then
    raise exception 'continued use can only be allowed for an overdue preventive maintenance, calibration or requalification' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger problem_decisions_rules before insert on problem_decisions for each row execute function check_problem_decision();

-- The decision is signed (LB-19): "decided" when sent to Deviations, "approved" for a Logbook exception.
alter table signatures drop constraint signatures_object_type_check;
alter table signatures add constraint signatures_object_type_check check (object_type in ('entry', 'settings', 'review', 'voice_note', 'problem_decision'));
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check
  check (meaning in ('performed', 'verified', 'released', 'reviewed', 'approved', 'corrected', 'voice_confirmed', 'decided'));

-- report.overdue_v1 (0018) now publishes: the overdue events recorded before this change (no problem row: Deviations
-- files them as before), and every problem QA sent to Deviations (its id is the published event_id). The columns stay;
-- new ones are added at the end only.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view overdue_v1 with (security_barrier) as
select o.id as event_id, o.code as equipment_code, o.name as equipment_name, o.item_kind as equipment_kind, o.location,
  o.kind, o.due_at, o.detected_at, o.title, o.description, o.immediate_action, o.impact_notes,
  now() as read_at, o.detected_at as data_as_of,
  'overdue'::text as source, null::text as severity, null::timestamptz as decided_at, null::text as decided_by
from overdue_events o
where not exists (select 1 from problems p where p.overdue_event_id = o.id)
union all
select p.id as event_id, p.code as equipment_code, p.name as equipment_name, p.item_kind as equipment_kind, p.location,
  coalesce(o.kind, 'reported') as kind, coalesce(o.due_at, p.created_at) as due_at, p.created_at as detected_at, p.title,
  coalesce(o.description, p.what_happened || E'\n\nImpact: ' || p.impact || E'\nSeverity: ' || p.severity
    || E'\nReported in the Logbook by ' || r.full_name || ' on ' || to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.') as description,
  coalesce(o.immediate_action, 'QA (' || q.full_name || ') sent this problem to Deviations on ' || to_char(d.decided_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
    || ' UTC. No further action is recorded in the Logbook.') as immediate_action,
  coalesce(o.impact_notes, 'Impact as reported: ' || p.impact) as impact_notes,
  now() as read_at, d.decided_at as data_as_of,
  p.source, p.severity, d.decided_at, q.full_name as decided_by
from problems p
join problem_decisions d on d.problem_id = p.id and d.route = 'deviation'
join users q on q.id = d.decided_by
left join users r on r.id = p.reported_by
left join overdue_events o on o.id = p.overdue_event_id;

revoke all on overdue_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'logbook_report') then grant select on overdue_v1 to logbook_report; end if;
end $$;

reset search_path;
