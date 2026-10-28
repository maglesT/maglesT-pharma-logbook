import { z } from 'zod';

const schema = z.object({
  // The app connects as the restricted role logbook_app (LB-18); migrations use MIGRATION_DATABASE_URL.
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  // Set only when DATABASE_URL logs in as the owner (local development): the app then switches role.
  DB_APP_ROLE: z.string().optional(),
  // Set to false only for plain-HTTP development; production runs behind TLS.
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Plant-local display time zone (register LB-19); storage is always UTC.
  DISPLAY_TZ: z.string().default('Asia/Kolkata'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
