-- Database-level part of init.sh, run inside <db>. Idempotent.
-- Requirements: PL-08 (read-only, versioned exchange through report.*_v1 views), PL-02 (link grants recorded).
set client_min_messages = warning;
begin;

-- The app writes its own tables (created later by its migrations, owned by <db>_owner); nobody else gets anything.
revoke all on schema public from public;
grant usage on schema public to :"app";
alter default privileges for role :"owner" in schema public grant select, insert, update, delete on tables to :"app";
alter default privileges for role :"owner" in schema public grant usage, select on sequences to :"app";
-- New functions are not executable by PUBLIC (a linked reader must not call the provider's functions).
alter default privileges for role :"owner" revoke execute on routines from public;
alter default privileges for role :"owner" grant execute on routines to :"app";

-- report: the published views. Linked readers get USAGE + SELECT on the views of their link only.
create schema if not exists report authorization :"owner";
revoke all on schema report from public;

-- platform: the link switch and its log. Only the installer (superuser) uses it.
create schema if not exists platform authorization :"owner";
revoke all on schema platform from public;

create table if not exists platform.home (app text not null, one boolean primary key default true check (one));
insert into platform.home (app) values (:'app') on conflict (one) do nothing;

-- PL-02: every link switch, insert-only (A11 12.3).
create table if not exists platform.link_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  consumer text not null,
  views text[] not null,
  switched_on boolean not null,
  change_ref text not null check (btrim(change_ref) <> ''),
  reason text not null check (btrim(reason) <> ''),
  applied_by text not null default session_user
);

create or replace function platform.refuse_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is insert-only (PL-02)', tg_table_name using errcode = 'insufficient_privilege';
end $$;

create or replace trigger link_log_insert_only before update or delete or truncate on platform.link_log
  for each statement execute function platform.refuse_change();

-- Switch a link on or off: the consumer login gets (or loses) SELECT on the listed report views, plus CONNECT and
-- USAGE while it holds any view here. Grant and log entry commit together. PostgreSQL checks rights at every query,
-- so a cut link is refused from the consumer's next query on, even on an open connection.
create or replace function platform.set_link(consumer text, views text[], switched_on boolean, change_ref text, reason text)
returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v text;
begin
  if consumer !~ '^([a-z][a-z0-9_]*_app|ext_[a-z0-9_]+)$' or not exists (select from pg_roles where rolname = consumer) then
    raise exception 'unknown consumer login "%"', consumer;
  end if;
  if consumer = (select h.app from platform.home h) then
    raise exception '"%" is this database''s own app, not a linked reader', consumer;
  end if;
  if coalesce(array_length(views, 1), 0) = 0 then
    raise exception 'a link needs at least one view';
  end if;
  foreach v in array views loop
    if v !~ '^[a-z][a-z0-9_]*_v[0-9]+$' or not exists (select from pg_views w where w.schemaname = 'report' and w.viewname = v) then
      raise exception 'no published view report.%', v;
    end if;
  end loop;

  if switched_on then
    execute format('grant connect on database %I to %I', current_database(), consumer);
    execute format('grant usage on schema report to %I', consumer);
    foreach v in array views loop
      execute format('grant select on report.%I to %I', v, consumer);
    end loop;
  else
    foreach v in array views loop
      execute format('revoke select on report.%I from %I', v, consumer);
    end loop;
    if not exists (select from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'report' and c.relkind = 'v' and has_table_privilege(consumer, c.oid, 'select')) then
      execute format('revoke usage on schema report from %I', consumer);
      execute format('revoke connect on database %I from %I', current_database(), consumer);
    end if;
  end if;

  insert into platform.link_log (consumer, views, switched_on, change_ref, reason)
  values (consumer, views, switched_on, change_ref, reason);
end $$;

-- The current links into this database, for the access review (PL-12) and the control panel.
create or replace view platform.current_link as
select r.rolname::text as consumer, c.relname::text as view_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join pg_roles r
where n.nspname = 'report' and c.relkind = 'v' and r.rolname ~ '^([a-z][a-z0-9_]*_app|ext_[a-z0-9_]+)$'
  and r.rolname <> (select h.app from platform.home h)
  and has_table_privilege(r.oid, c.oid, 'select');

alter table platform.home owner to :"owner";
alter table platform.link_log owner to :"owner";
alter function platform.refuse_change() owner to :"owner";
alter function platform.set_link(text, text[], boolean, text, text) owner to :"owner";
alter view platform.current_link owner to :"owner";
revoke all on all tables in schema platform from public;
revoke all on all functions in schema platform from public;

commit;
