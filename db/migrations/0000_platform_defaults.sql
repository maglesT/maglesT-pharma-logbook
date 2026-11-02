-- Medhanta platform (D-29). The platform's init gives a product's app login SELECT, INSERT, UPDATE and DELETE on
-- every new table by default. The Logbook grants its app role column by column instead, and keeps signed and
-- audited tables insert-only (LB-18), so these defaults are taken back before any table is created. A later
-- platform init sets them again, so every later migration that creates a table revokes them on that table itself
-- (test/platform.test.ts checks this). Nothing to do on a standalone installation.
do $$
begin
  if exists (select from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
             where n.nspname = 'public' and d.defaclrole = current_user::regrole)
     and exists (select from pg_roles where rolname = 'logbook_app') then
    execute format('alter default privileges for role %I in schema public revoke all on tables from logbook_app', current_user);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from logbook_app', current_user);
  end if;
end $$;
