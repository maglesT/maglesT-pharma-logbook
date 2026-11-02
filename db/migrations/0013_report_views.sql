-- S15: read-only report views for the site's Deviations & CAPA system (D-28; A11 5 in register section C).
-- The Deviations system logs in as logbook_report and reads four versioned views in the schema `report`.
-- The role can read those views and nothing else: no table, no sequence, no write. The views run with
-- the rights of their owner (the migration login, which owns the tables), so the role needs no table grants.
-- A view is never changed in place: different columns mean a new _v2 view next to the _v1 one.
-- Every row carries read_at (now()) and data_as_of (the newest committed change the row reflects).
-- The views are security barriers: a reader's own function in a WHERE clause runs only on rows the view
-- returns, never on superseded versions or unapproved settings. The role may not create temporary objects
-- (such as its own functions) in this database either.
--
-- Schema name: `report` for an installation in the schema `public` (every site). Tests and browser tests
-- migrate into their own schema <s>; their report views go to <s>_report so parallel runs never collide.

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  -- Production: the site gives this role LOGIN and a password at install (README, "Database roles").
  -- On the Medhanta platform (D-29) the migration login may not create roles, and other products read the
  -- views through platform links instead, so the role is then left out.
  if not exists (select from pg_roles where rolname = 'logbook_report')
     and (select rolsuper or rolcreaterole from pg_roles where rolname = current_user) then
    create role logbook_report nologin;
  end if;
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  if exists (select from pg_roles where rolname = 'logbook_report') then
    execute format('grant usage on schema %I to logbook_report', rep);
  end if;
  -- For the rest of this migration, new objects go to the report schema and table names resolve
  -- to this installation's tables (transaction-local; reset at the end).
  -- PUBLIC may create temporary objects by default; take that from everyone but the app role, so the
  -- report role cannot define functions of its own. The database owner keeps it as owner.
  -- Only while PUBLIC still has it (a database's ACL is one catalog row: repeated changes from parallel
  -- test runs would collide).
  if exists (select from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
             where d.datname = current_database() and a.grantee = 0 and a.privilege_type = 'TEMPORARY') then
    execute format('revoke temporary on database %I from public', current_database());
    execute format('grant temporary on database %I to logbook_app', current_database());
  end if;
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- Equipment, instruments and areas. sop_refs: the SOP references of the latest equipment details
-- version, split at commas, semicolons and line breaks (the details form has one free-text field).
create view equipment_v1 with (security_barrier) as
select q.id, q.code, q.name, q.kind, q.location, q.active, q.needs_calibration,
  array(select btrim(r.ref) from regexp_split_to_table(coalesce(d.details->>'sopRefs', ''), '[,;\n]') with ordinality r(ref, n)
        where btrim(r.ref) <> '' order by r.n)::text[] as sop_refs,
  now() as read_at,
  -- Every change to an item is in the audit trail (created, master data changed, details changed).
  greatest(q.created_at, d.changed_at,
    (select max(a.at) from audit_log a where a.object_type = 'equipment' and a.object_id = q.id::text)) as data_as_of
from equipment q
left join lateral (
  select x.details, x.changed_at from equipment_details x where x.equipment_id = q.id order by x.version desc limit 1
) d on true;

-- The latest version of each entry (no newer version supersedes it). signed: the signature meanings
-- on this version only; a correction needs its verification again (D-16), so a corrected entry shows
-- e.g. {corrected} until it is verified anew. data_as_of: the version's entry time, its newest signature,
-- or the last change of the author's full name (user.updated in the audit trail), whichever is newest.
create view entry_v1 with (security_barrier) as
select e.entry_id, e.version, q.code as equipment_code, q.kind as equipment_kind, e.logbook_type as type, e.change,
  e.activity_start, e.activity_end, p.code as product_code, e.batch, e.data, u.full_name as entered_by, e.entered_at, e.late,
  coalesce(g.meanings, '{}')::text[] as signed,
  now() as read_at,
  greatest(e.entered_at, g.last_signed,
    (select max(a.at) from audit_log a where a.object_type = 'user' and a.object_id = e.entered_by::text and a.action = 'user.updated')) as data_as_of
from entries e
join equipment q on q.id = e.equipment_id
join users u on u.id = e.entered_by
left join products p on p.id = e.product_id
left join lateral (
  select array_agg(s.meaning order by s.signed_at, s.id) as meanings, max(s.signed_at) as last_signed
  from signatures s where s.object_type = 'entry' and s.object_id = e.id
) g on true
where not exists (select 1 from entries x where x.supersedes = e.id);

-- One row per calibration entry (latest version). next_due is a plant-local date (D-19): the
-- instrument is usable on that day and overdue from the next. A blank certificate reference is null.
create view calibration_v1 with (security_barrier) as
select v.equipment_code, coalesce(v.activity_end, v.activity_start) as performed_at, v.data->>'result' as result,
  d.next_due, nullif(btrim(v.data->>'certificateRef'), '') as certificate_ref,
  v.read_at, v.data_as_of
from entry_v1 v
-- The app accepts real dates only; a value that is not one (e.g. 2026-02-30) reads as null instead
-- of failing every read. Nested CASEs, because only CASE guarantees the order of evaluation.
cross join lateral (select v.data->>'nextDue' as raw) n
cross join lateral (select case when n.raw ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' and left(n.raw, 4) <> '0000' then
    case when substr(n.raw, 9, 2)::int <= extract(day from (left(n.raw, 7) || '-01')::date + interval '1 month' - interval '1 day')
      then n.raw::date end end as next_due) d
where v.type = 'calibration';

-- SOP references of the logbook settings in force (LB-24): per type, the latest version with a QA
-- "approved" signature whose effective date has passed, if switched on. Several references in the
-- field give several rows.
create view logbook_sop_v1 with (security_barrier) as
select f.logbook_type as type, btrim(r.ref) as sop_ref, now() as read_at, greatest(f.approved_at, f.effective_from) as data_as_of
from (
  select distinct on (s.logbook_type) s.logbook_type, s.settings, s.effective_from, g.signed_at as approved_at
  from logbook_settings s
  join signatures g on g.object_type = 'settings' and g.object_id = s.id and g.meaning = 'approved'
  where s.effective_from <= now()
  order by s.logbook_type, s.version desc
) f
cross join lateral regexp_split_to_table(coalesce(f.settings->>'sopRef', ''), '[,;\n]') with ordinality r(ref, n)
where coalesce((f.settings->>'enabled')::boolean, false) and btrim(r.ref) <> '';

revoke all on equipment_v1, entry_v1, calibration_v1, logbook_sop_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'logbook_report') then
    grant select on equipment_v1, entry_v1, calibration_v1, logbook_sop_v1 to logbook_report;
  end if;
end $$;

reset search_path;
