-- Slice A10 (D-16): access is permission-based. The permission register is a catalogue of permission codes that
-- each product declares in its manifest, and for every employee the subset of them they hold. No roles.
-- The role tables of 0001 are dropped: they never held customer data.
drop view current_grant;
drop table grant_event;
drop table product_role;

-- Codes are <product>.<thing>.<action>, lower case, dotted, and start with their product's name.
create function permission_code_ok(product text, code text) returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select product ~ '^[a-z][a-z0-9_]*$' and code ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and starts_with(code, product || '.')
$$;

-- The catalogue: insert-only; a new label or a code removed from a manifest is a new event (history kept).
-- Written by apply from the licensed products' manifests (core's own codes below); core_app only reads it.
create table permission_event (
  id bigint generated always as identity primary key,
  product text not null,
  code text not null,
  label text not null check (btrim(label) <> ''),
  active boolean not null,
  by_name text not null check (btrim(by_name) <> ''),
  reason text not null check (btrim(reason) <> ''),
  at timestamptz not null default now(),
  check (permission_code_ok(product, code))
);

create view current_permission as
select p.product, p.code, p.label, p.at
from (select distinct on (code) * from permission_event order by code, id desc) p
where p.active;

insert into permission_event (product, code, label, active, by_name, reason) values
  ('core', 'core.people.manage', 'Manage people and their permissions', true, 'migration 0004', 'core permissions'),
  ('core', 'core.masterdata.edit', 'Edit master data', true, 'migration 0004', 'core permissions'),
  ('core', 'core.masterdata.view', 'Read master data', true, 'migration 0004', 'core permissions');

-- PL-01/PL-02: the register. Insert-only grant and revoke events with who, when and why; current rights are a view.
create table permission_grant (
  id bigint generated always as identity primary key,
  employee_id uuid not null references employee,
  product text not null,
  code text not null,
  granted boolean not null,
  by_id uuid references employee,                 -- null for the installer and for apply
  by_name text not null,
  at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  check (permission_code_ok(product, code))
);
create index permission_grant_employee on permission_grant (employee_id, code, id);

create view current_permission_grant as
select g.employee_id, g.product, g.code, g.by_name as granted_by, g.at as granted_at
from (select distinct on (employee_id, code) * from permission_grant order by employee_id, code, id desc) g
where g.granted and exists (select from current_permission p where p.code = g.code);   -- a withdrawn code grants nothing

create trigger permission_event_insert_only before update or delete or truncate on permission_event for each statement execute function refuse_change();
create trigger permission_grant_insert_only before update or delete or truncate on permission_grant for each statement execute function refuse_change();
revoke insert, update, delete, truncate on permission_event from core_app;
revoke update, delete, truncate on permission_grant from core_app;
