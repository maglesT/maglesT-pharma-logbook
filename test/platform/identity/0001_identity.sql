-- Identity: employees, credentials, the permission register and lockout alerts (slice A2).
-- Runs as identity_owner; the default privileges from init.sh give core_app SELECT/INSERT/UPDATE/DELETE on new tables,
-- which this file narrows: version and event tables are insert-only (PL-02, PL-06).

-- PL-03: a login ID belongs to one person for all time: never renamed, never deleted, never reused.
-- PL-03 (11.100(b)): who verified the person's identity, and how, before the login was issued.
create table employee (
  id uuid primary key default gen_random_uuid(),
  login text not null unique check (login ~ '^[a-z][a-z0-9._-]{1,39}$'),
  identity_verified_by text not null check (btrim(identity_verified_by) <> ''),
  identity_verified_how text not null check (btrim(identity_verified_how) <> ''),
  created_at timestamptz not null default now()
);

-- PL-06: every change of name, email or active state is a new version with who, when and why.
create table employee_version (
  employee_id uuid not null references employee,
  version int not null check (version > 0),
  full_name text not null check (btrim(full_name) <> ''),
  email text,
  active boolean not null,
  changed_by uuid references employee,           -- null only for the first administrator (bootstrap)
  changed_by_name text not null,
  changed_at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  primary key (employee_id, version)
);

create view employee_current as
select e.id, e.login, v.full_name, v.email, v.active, v.version, v.changed_at, e.created_at,
       e.identity_verified_by, e.identity_verified_how
from employee e
join lateral (select * from employee_version x where x.employee_id = e.id order by x.version desc limit 1) v on true;

-- Password and lockout state (current state only; every change is also a credential_event).
create table credential (
  employee_id uuid primary key references employee,
  password_hash text not null,
  must_change boolean not null default true,      -- temporary password: changed at first use (PL-04)
  changed_at timestamptz not null default now(),
  failed_count int not null default 0,
  locked_at timestamptz
);

-- Sign-ons, failures, resets, changes and locks: insert-only.
create table credential_event (
  id bigint generated always as identity primary key,
  employee_id uuid references employee,           -- null for an unknown login
  login text not null,
  kind text not null check (kind in ('signon_ok', 'signon_failed', 'locked', 'reset', 'changed')),
  product text not null default 'core',
  by_id uuid references employee,
  by_name text,
  reason text,
  at timestamptz not null default now()
);

-- Roles each product offers (loaded from product manifests; core's own roles below).
create table product_role (
  product text not null check (product ~ '^[a-z][a-z0-9_]*$'),
  role text not null check (role ~ '^[a-z][a-z0-9_]*$'),
  description text not null,
  primary key (product, role)
);
insert into product_role values
  ('core', 'identity_admin', 'Manage employees and their permissions'),
  ('core', 'master_data_editor', 'Edit master data'),
  ('core', 'viewer', 'Read master data');

-- PL-01/PL-02: the permission register. Insert-only grant and revoke events; current rights are a view.
create table grant_event (
  id bigint generated always as identity primary key,
  employee_id uuid not null references employee,
  product text not null,
  role text not null,
  granted boolean not null,
  by_id uuid references employee,
  by_name text not null,
  at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  foreign key (product, role) references product_role
);

create view current_grant as
select g.employee_id, g.product, g.role, g.by_name as granted_by, g.at as granted_at
from (select distinct on (employee_id, product, role) * from grant_event order by employee_id, product, role, id desc) g
where g.granted;

-- PL-04: lockout alerts, shown to identity admins until acknowledged, and emailed to the site security contact.
create table alert (
  id bigint generated always as identity primary key,
  kind text not null,
  employee_id uuid references employee,
  message text not null,
  at timestamptz not null default now(),
  emailed_at timestamptz,
  email_error text,
  acknowledged_by_name text,
  acknowledged_at timestamptz
);

-- Sessions of the core screens (only a hash of the session id is stored).
create table session (
  id text primary key,
  employee_id uuid not null references employee,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Insert-only enforcement: neither the app nor anyone else may change or remove history.
create function refuse_change() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is insert-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger employee_fixed before update or delete or truncate on employee for each statement execute function refuse_change();
create trigger employee_version_insert_only before update or delete or truncate on employee_version for each statement execute function refuse_change();
create trigger credential_event_insert_only before update or delete or truncate on credential_event for each statement execute function refuse_change();
create trigger grant_event_insert_only before update or delete or truncate on grant_event for each statement execute function refuse_change();
revoke update, delete, truncate on employee, employee_version, credential_event, grant_event from core_app;
revoke delete, truncate on credential, alert from core_app;

-- Published view: the employee directory, for products that show names of other people.
create view report.employee_v1 with (security_barrier) as
select id, login, full_name, active, now() as read_at, changed_at as data_as_of from employee_current;
revoke all on report.employee_v1 from public;
