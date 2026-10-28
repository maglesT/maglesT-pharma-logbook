-- S3: logbook entries (LB-01–04, LB-10, LB-11, LB-17, LB-26).
-- Insert-only: each change (completing a use, correcting) appends a new version that points
-- to the version it replaces. Nothing is updated or deleted (LB-17).
-- Identifies an entry across its versions.
create sequence entry_ids;

create table entries (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  logbook_type text not null,
  settings_id bigint not null references logbook_settings(id),
  -- Shared by all versions of one entry.
  entry_id bigint not null default nextval('entry_ids'),
  version integer not null check (version >= 1),
  supersedes bigint references entries(id),
  change text not null check (change in ('created', 'completed', 'corrected')),
  activity_start timestamptz not null,
  activity_end timestamptz,
  product_id bigint references products(id),
  batch text,
  data jsonb not null,
  late boolean not null default false,
  late_reason text,
  correction_reason text,
  entered_by bigint not null references users(id),
  entered_at timestamptz not null default now(),
  -- LB-10: an activity cannot end before it starts.
  check (activity_end is null or activity_end >= activity_start),
  check (not late or length(trim(late_reason)) > 0),
  check (change <> 'corrected' or length(trim(correction_reason)) > 0),
  check ((version = 1) = (supersedes is null)),
  -- One successor per version: no branching histories.
  unique (supersedes),
  unique (entry_id, version)
);
create index entries_equipment on entries (equipment_id, activity_start desc);
create index entries_batch on entries (lower(batch)) where batch is not null;

grant select on entries to logbook_app;
grant usage on sequence entry_ids to logbook_app;
-- entered_at (server time) comes only from the database.
grant insert (equipment_id, logbook_type, settings_id, entry_id, version, supersedes, change, activity_start,
              activity_end, product_id, batch, data, late, late_reason, correction_reason, entered_by)
  on entries to logbook_app;
