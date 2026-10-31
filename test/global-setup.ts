import postgres from 'postgres';
import { TEST_DATABASE_URL } from './helpers.js';

// Roles are cluster-wide: create the app role once, before test files run in parallel.
export default async function setup() {
  const sql = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  await sql`do $$ begin
    if not exists (select from pg_roles where rolname = 'logbook_app') then create role logbook_app nologin; end if;
    if not exists (select from pg_roles where rolname = 'logbook_report') then create role logbook_report nologin; end if;
  end $$`;
  // The test login switches to the app role (SET ROLE), so it must be a member.
  await sql.unsafe('grant logbook_app to current_user');
  // S15: the report-view tests switch to the read-only report role.
  await sql.unsafe('grant logbook_report to current_user');
  // As migration 0013 does, once, before test files migrate in parallel.
  await sql.unsafe(`do $$ begin
    execute format('revoke temporary on database %I from public', current_database());
    execute format('grant temporary on database %I to logbook_app', current_database());
  end $$`);
  await sql.end();
}
