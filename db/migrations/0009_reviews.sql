-- S5: QA period review of a logbook (LB-25).
create table reviews (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  period_from timestamptz not null,
  period_to timestamptz not null check (period_to > period_from),
  -- The entry versions (id and content hash) QA saw and signed for.
  content jsonb not null,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now()
);
create index reviews_equipment on reviews (equipment_id, period_from);
grant select on reviews to logbook_app;
grant insert (equipment_id, period_from, period_to, content, created_by) on reviews to logbook_app;

alter table signatures drop constraint signatures_object_type_check;
alter table signatures add constraint signatures_object_type_check check (object_type in ('entry', 'settings', 'review'));
