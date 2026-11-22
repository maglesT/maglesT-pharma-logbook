-- Engineering work orders (owner decision 22 Nov 2026). A work order is raised for an item (from a breakdown, a due
-- preventive maintenance or calibration, or by hand), assigned to a person, started, given its work done (text, spare
-- parts, time spent), marked Done (e-signature "Performed" by the doer) and Closed (e-signature "Closed" by a second
-- person). Every change is in the audit trail. Who may: logbook.workorder.raise, .do, .close (per employee, in the
-- platform permission register, given to no old role).
create table work_orders (
  id bigint generated always as identity primary key,
  year integer not null,
  seq integer not null,
  number text not null unique,
  equipment_id bigint not null references equipment(id),
  kind text not null check (kind in ('breakdown', 'preventive', 'calibration', 'other')),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'closed')),
  -- The breakdown (its entry id, stable over corrections) this work order was raised from.
  entry_id bigint,
  assigned_to bigint references users(id),
  assigned_to_name text,
  target_date date,
  raised_by bigint not null references users(id),
  raised_by_name text not null,
  raised_at timestamptz not null default now(),
  started_at timestamptz,
  work_done text not null default '',
  parts jsonb not null default '[]',
  time_minutes integer check (time_minutes is null or time_minutes >= 0),
  done_by bigint references users(id),
  done_by_name text,
  done_at timestamptz,
  closed_by bigint references users(id),
  closed_by_name text,
  closed_at timestamptz,
  unique (year, seq)
);
create unique index work_orders_entry on work_orders (entry_id) where entry_id is not null;
create index work_orders_equipment on work_orders (equipment_id, raised_at desc);
create index work_orders_status on work_orders (status);
revoke all on work_orders from logbook_app;   -- the platform's default grants (0000)
grant select, insert, update on work_orders to logbook_app;
revoke all on sequence work_orders_id_seq from logbook_app;

alter table signatures drop constraint signatures_object_type_check;
alter table signatures add constraint signatures_object_type_check
  check (object_type in ('entry', 'settings', 'review', 'voice_note', 'exception', 'work_order'));
