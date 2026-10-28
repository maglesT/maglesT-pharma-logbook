import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  // Sessions run in UTC so timestamps never depend on the server's local zone.
  return postgres(url, { connection: { TimeZone: 'UTC' }, onnotice: () => {} });
}
