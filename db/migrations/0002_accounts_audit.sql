-- S1: accounts, sessions, misuse alerts, audit trail (register LB-18, LB-20, LB-21).

-- The application connects as logbook_app. Production gives this role LOGIN and a password
-- (see README); migrations run as the database owner.
do $$
begin
  if not exists (select from pg_roles where rolname = 'logbook_app') then
    create role logbook_app nologin;
  end if;
end $$;

create table users (
  id bigint generated always as identity primary key,
  -- LB-20: unique and never reused; the app role cannot change it (no UPDATE grant on the column).
  username text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  full_name text not null check (length(trim(full_name)) > 0),
  password_hash text not null,
  must_change_password boolean not null default true,
  password_changed_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_at timestamptz,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id bigint not null references users(id),
  role text not null check (role in ('operator', 'supervisor', 'engineering', 'qa', 'admin')),
  primary key (user_id, role)
);

create table sessions (
  id text primary key,
  user_id bigint not null references users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table alerts (
  id bigint generated always as identity primary key,
  kind text not null,
  user_id bigint references users(id),
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_by bigint references users(id),
  acknowledged_at timestamptz
);

-- LB-18: one audit trail, written by the server in the same transaction as the change.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id bigint references users(id),
  action text not null,
  object_type text not null,
  object_id text,
  old_value jsonb,
  new_value jsonb,
  reason text
);
create index audit_log_object on audit_log (object_type, object_id);

do $$
begin
  execute format('grant usage on schema %I to logbook_app', current_schema());
end $$;
grant select, insert on users, audit_log, alerts to logbook_app;
grant update (full_name, password_hash, must_change_password, password_changed_at,
              failed_attempts, locked_at, active, last_login_at) on users to logbook_app;
grant update (acknowledged_by, acknowledged_at) on alerts to logbook_app;
grant select, insert, delete on user_roles to logbook_app;
grant select, insert, update, delete on sessions to logbook_app;
