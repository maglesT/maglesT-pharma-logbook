-- S16b (owner request): a cleaning that misses its time limit raises a deviation in the site's Deviations system
-- automatically. One row per missed limit: the item, which limit (dirty hold after use, or a frequency-based room's
-- scheduled cleaning) and the time it ran out. The row is made once (unique), then the deviation number is filled in
-- when the Deviations system has accepted the report; until then the last error is kept and the report is retried.
create table auto_deviations (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  kind text not null check (kind in ('dirty_hold', 'frequency')),
  deadline_at timestamptz not null,
  detected_at timestamptz not null default now(),
  deviation_number text check (deviation_number ~ '^[A-Z0-9-]{1,40}$'),
  raised_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  unique (equipment_id, kind, deadline_at),
  check ((deviation_number is null) = (raised_at is null))
);
grant select, insert on auto_deviations to logbook_app;
grant update (deviation_number, raised_at, attempts, last_error) on auto_deviations to logbook_app;
