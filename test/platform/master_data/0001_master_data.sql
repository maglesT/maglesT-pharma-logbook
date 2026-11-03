-- Master data (slice A4): machines/instruments/rooms, materials/suppliers, products, and the links between them
-- (decision D-07). The single source of truth; edited only in the core master-data screen; products read it live
-- through the report.*_v1 views below (link grants, PL-08). Runs as master_data_owner.

-- An item's kind and code never change and a code is never reused within its kind.
create table item (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('equipment', 'instrument', 'room', 'material', 'supplier', 'product')),
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  created_at timestamptz not null default now(),
  unique (kind, code)
);

-- PL-06: every change is a new version with who, when and why. fields: the kind's own fields (checked by the app).
create table item_version (
  item_id uuid not null references item,
  version int not null check (version > 0),
  name text not null check (btrim(name) <> ''),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  active boolean not null,
  changed_by uuid not null,                         -- identity employee id
  changed_by_name text not null,
  changed_at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  primary key (item_id, version)
);

create view item_current as
select i.id, i.kind, i.code, v.name, v.fields, v.active, v.version, v.changed_at, v.changed_by_name
from item i join lateral (select * from item_version x where x.item_id = i.id order by x.version desc limit 1) v on true;

-- Links between items (equipment located_in room, material supplied_by supplier, product uses material):
-- insert-only on/off events; the current links are a view.
create table link_event (
  id bigint generated always as identity primary key,
  from_item uuid not null references item,
  to_item uuid not null references item,
  type text not null check (type in ('located_in', 'supplied_by', 'uses')),
  active boolean not null,
  changed_by uuid not null,
  changed_by_name text not null,
  changed_at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  check (from_item <> to_item)
);

create view item_link_current as
select l.from_item, l.to_item, l.type, l.changed_at, l.changed_by_name
from (select distinct on (from_item, to_item, type) * from link_event order by from_item, to_item, type, id desc) l
where l.active;

create function refuse_change() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is insert-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger item_fixed before update or delete or truncate on item for each statement execute function refuse_change();
create trigger item_version_insert_only before update or delete or truncate on item_version for each statement execute function refuse_change();
create trigger link_event_insert_only before update or delete or truncate on link_event for each statement execute function refuse_change();
revoke update, delete, truncate on item, item_version, link_event from core_app;

-- Published views (PL-08). Current version of every item, inactive ones included (active = false), so a product can
-- tell "retired" from "unknown". Columns may be added to a _v1 view, never removed or renamed (a change is _v2).
create view report.equipment_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'type' as type, c.fields->>'make' as make,
  c.fields->>'model' as model, c.fields->>'serial' as serial,
  (select r.code from item_link_current l join item r on r.id = l.to_item where l.from_item = c.id and l.type = 'located_in' limit 1) as room_code,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'equipment';

create view report.instrument_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'type' as type, c.fields->>'make' as make,
  c.fields->>'model' as model, c.fields->>'serial' as serial, coalesce((c.fields->>'needsCalibration')::boolean, false) as needs_calibration,
  (select r.code from item_link_current l join item r on r.id = l.to_item where l.from_item = c.id and l.type = 'located_in' limit 1) as room_code,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'instrument';

create view report.room_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'area' as area, c.fields->>'grade' as grade,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'room';

create view report.material_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'category' as category, c.fields->>'unit' as unit,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'material';

create view report.supplier_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'address' as address,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'supplier';

create view report.product_v1 with (security_barrier) as
select c.id, c.code, c.name, c.version, c.active, c.fields->>'strength' as strength, c.fields->>'dosageForm' as dosage_form,
  now() as read_at, c.changed_at as data_as_of
from item_current c where c.kind = 'product';

create view report.item_link_v1 with (security_barrier) as
select l.type, f.id as from_id, f.kind as from_kind, f.code as from_code, t.id as to_id, t.kind as to_kind, t.code as to_code,
  now() as read_at, l.changed_at as data_as_of
from item_link_current l join item f on f.id = l.from_item join item t on t.id = l.to_item;

revoke all on all tables in schema report from public;
