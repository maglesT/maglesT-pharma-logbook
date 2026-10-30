-- S9: equipment details as insert-only versions (D-25). Each change is a new version with a reason;
-- old versions stay readable. The audit trail records every change with its old and new values.
create table equipment_details (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  version integer not null check (version > 0),
  details jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  changed_by bigint not null references users(id),
  changed_at timestamptz not null default now(),
  unique (equipment_id, version)
);
grant select on equipment_details to logbook_app;
grant insert (equipment_id, version, details, reason, changed_by) on equipment_details to logbook_app;
