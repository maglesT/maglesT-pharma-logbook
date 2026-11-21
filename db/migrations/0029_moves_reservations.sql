-- Fix round 21 Nov 2026 (D-84, D-85). A move to another room is a logbook entry (type room_move: no table). A
-- reservation (booking) holds an item for a batch or for dates: who, from when to when and why. Reservations are
-- insert-only; a cancellation is its own row with the reason. Who may reserve or cancel: logbook.equipment.reserve
-- (per employee, in the platform permission register).
create table reservations (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  batch text check (batch is null or length(trim(batch)) > 0),
  purpose text not null check (length(trim(purpose)) > 0),
  reserved_by bigint not null references users(id),
  reserved_by_name text not null,
  created_at timestamptz not null default now()
);
create index reservations_equipment on reservations (equipment_id, ends_at);
create table reservation_cancellations (
  reservation_id bigint primary key references reservations(id),
  reason text not null check (length(trim(reason)) > 0),
  cancelled_by bigint not null references users(id),
  cancelled_by_name text not null,
  cancelled_at timestamptz not null default now()
);
revoke all on reservations, reservation_cancellations from logbook_app;   -- the platform's default grants (0000)
grant select, insert on reservations, reservation_cancellations to logbook_app;
revoke all on sequence reservations_id_seq from logbook_app;               -- identity columns need no sequence right

-- The published status gets new columns at the END (readers of the named columns read it unchanged; nothing is renamed
-- or removed). room_code: the room the Logbook has the item in now (its last move recorded here, else master data's
-- room; null for a room); moved_at: that move (null: never moved in the Logbook). reserved_*: the reservation in force
-- now, else the next one (null: none).
alter table item_status add column room_code text, add column moved_at timestamptz, add column reserved_from timestamptz,
  add column reserved_until timestamptz, add column reserved_for_batch text, add column reserved_by text, add column reserved_purpose text;

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view equipment_status_v1 with (security_barrier) as
select q.item_id as master_id, q.code, q.kind, s.state, s.fit_for_use, s.blockers, s.warnings, s.in_use_batch, s.cleaned_at,
  s.cleaned_by, s.clean_until, s.calibration_due, s.qualification, s.checked_at, now() as read_at, s.checked_at as data_as_of,
  s.last_decontamination, s.sterile_valid_until, s.last_glove_test, s.only_product,
  s.room_code, s.moved_at, s.reserved_from, s.reserved_until, s.reserved_for_batch, s.reserved_by, s.reserved_purpose
from item_status s
join equipment q on q.id = s.equipment_id
where q.item_id is not null;

reset search_path;
