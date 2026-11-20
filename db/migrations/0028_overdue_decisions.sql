-- Owner decision 20 Nov 2026 (D-80; replaces the automatic deviation of D-37): a missed limit is an EXCEPTION in the
-- Logbook. A person who holds logbook.exception.decide (per employee, in the platform permission register) either
-- closes it here, with a reason and an e-signature ("Closed"), or sends it to Deviations. Deviations files only the
-- ones sent. One decision per missed limit, insert-only like the missed limits themselves.
create table overdue_decisions (
  id bigint generated always as identity primary key,
  event_id bigint not null unique references overdue_events(id),
  decision text not null check (decision in ('closed', 'sent')),
  -- Why it is closed here; a closure always has one.
  reason text check (decision = 'sent' or length(trim(reason)) > 0),
  decided_by bigint references users(id),   -- null for this migration's rows
  decided_by_name text not null,
  decided_at timestamptz not null default now()
);
revoke all on overdue_decisions from logbook_app;   -- the platform's default grants (0000)
grant select, insert on overdue_decisions to logbook_app;
revoke all on sequence overdue_decisions_id_seq from logbook_app;   -- identity columns need no sequence right

-- The closure is signed: object 'exception' (the missed limit), meaning 'closed'.
alter table signatures drop constraint signatures_object_type_check;
alter table signatures add constraint signatures_object_type_check check (object_type in ('entry', 'settings', 'review', 'voice_note', 'exception'));
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check
  check (meaning in ('performed', 'verified', 'released', 'reviewed', 'approved', 'corrected', 'voice_confirmed', 'closed'));

-- Missed limits recorded before this decision were sent to Deviations on their own (D-37): they are recorded as sent,
-- at the time they were found, so Deviations keeps what it filed and the Logbook shows them as sent.
insert into overdue_decisions (event_id, decision, decided_by_name, decided_at)
select id, 'sent', 'Logbook (sent automatically before D-80)', detected_at from overdue_events order by id;

-- report.overdue_v1 gets two columns at the END (readers of the named columns read it unchanged):
-- decision: open (waiting for a decision), closed (closed in the Logbook) or sent (sent to Deviations);
-- sent_at: when it was sent to Deviations, null otherwise. Deviations files only rows with sent_at.
do $$
declare
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, current_schema()), true);
end $$;

create or replace view overdue_v1 with (security_barrier) as
select o.id as event_id, o.code as equipment_code, o.name as equipment_name, o.item_kind as equipment_kind, o.location,
  o.kind, o.due_at, o.detected_at, o.title, o.description, o.immediate_action, o.impact_notes,
  now() as read_at, greatest(o.detected_at, d.decided_at) as data_as_of,
  coalesce(d.decision, 'open') as decision, case when d.decision = 'sent' then d.decided_at end as sent_at
from overdue_events o
left join overdue_decisions d on d.event_id = o.id;

reset search_path;
