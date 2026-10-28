import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://logbook_owner:dev@localhost:5432/logbook_test';

// A fresh schema per test file keeps files independent when Vitest runs them in parallel.
export async function freshDb(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = connect(TEST_DATABASE_URL);
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = connect(`${TEST_DATABASE_URL}?search_path=${schema},public`);
  await migrate(sql);
  return {
    sql,
    close: async () => {
      await sql.unsafe(`drop schema ${schema} cascade`);
      await sql.end();
    },
  };
}
