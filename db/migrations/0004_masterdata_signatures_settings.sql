-- S2: site, equipment/areas, products, e-signatures, logbook settings (LB-19, LB-20, LB-24).

-- One site per installation (D-11).
create table site (
  id smallint primary key default 1 check (id = 1),
  name text not null check (length(trim(name)) > 0),
  code text not null check (length(trim(code)) > 0)
);

-- Equipment, instruments and areas in one table. The code is the unique ID shown on
-- screens and exports; it can never be changed or reused.
create table equipment (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name text not null check (length(trim(name)) > 0),
  kind text not null check (kind in ('equipment', 'instrument', 'area')),
  location text not null default '',
  sterile boolean not null default false,
  classified boolean not null default false,
  -- SchM 18.4.4: maximum time clean equipment may wait before use.
  clean_hold_hours integer check (clean_hold_hours > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table products (
  id bigint generated always as identity primary key,
  code text not null unique check (length(trim(code)) > 0),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true
);

-- Versioned settings per built-in logbook type. A version is in force once it carries a QA
-- "approved" signature and its effective date has passed (LB-24).
create table logbook_settings (
  id bigint generated always as identity primary key,
  logbook_type text not null,
  version integer not null,
  settings jsonb not null,
  effective_from timestamptz not null,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  unique (logbook_type, version)
);

-- LB-19/LB-20: each signature names its signer, meaning and server time, and holds a hash of
-- exactly what was signed, so it cannot be moved to other content.
create table signatures (
  id bigint generated always as identity primary key,
  object_type text not null check (object_type in ('entry', 'settings')),
  object_id bigint not null,
  user_id bigint not null references users(id),
  printed_name text not null,
  meaning text not null check (meaning in ('performed', 'verified', 'released', 'reviewed', 'approved', 'corrected')),
  signed_at timestamptz not null default now(),
  content_hash text not null,
  unique (object_type, object_id, meaning)
);

grant select, insert on site to logbook_app;
grant update (name, code) on site to logbook_app;
grant select, insert on equipment to logbook_app;
grant update (name, location, sterile, classified, clean_hold_hours, active) on equipment to logbook_app;
grant select, insert on products to logbook_app;
grant update (name, active) on products to logbook_app;
grant select, insert on logbook_settings to logbook_app;
-- Drafts are editable; the server refuses edits once a version is approved, and the
-- signature hash would expose any later change.
grant update (settings, effective_from) on logbook_settings to logbook_app;
-- Signature time comes only from the database.
grant select on signatures to logbook_app;
grant insert (object_type, object_id, user_id, printed_name, meaning, content_hash) on signatures to logbook_app;
