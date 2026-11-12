-- D-37: limits are recorded for Deviations from the moment this feature is installed. A limit that ran out before then
-- (on an installation with history) is not raised: it was missed before the rule existed, and QA would otherwise get
-- every old miss at once. One row, written here; the app reads it only. A move to the platform keeps the platform's
-- own row (db/move-to-platform.ts: written by the migration, not moved).
create table overdue_since (
  one boolean primary key default true check (one),
  since timestamptz not null default now()
);
insert into overdue_since default values;
revoke all on overdue_since from logbook_app;   -- the platform's default grants (0000)
grant select on overdue_since to logbook_app;
