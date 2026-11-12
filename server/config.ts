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
  // Voice notes (D-26): the speech service key stays on the server. Without it voice notes are off.
  // An empty value (e.g. an unset compose variable) means "not configured".
  SARVAM_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  SARVAM_BASE_URL: z.string().url().default('https://api.sarvam.ai'),
  SARVAM_MODEL: z.string().default('saaras:v3'),
  SARVAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Breakdown suggestions (D-27): Google Gemini. gemini-pro-latest is Google's newest Pro model; the
  // exact model version that answered is kept in the audit trail with each suggestion.
  GEMINI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  GEMINI_MODEL: z.string().default('gemini-pro-latest'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // A voice-note translation waits at most this long before Sarvam's own translation is used.
  GEMINI_TRANSLATE_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  // S16b (D-34): automatic deviations for missed cleaning limits, reported to the site's Deviations system as its user
  // for automatic reports (role "user"), in the named area. Without the URL, user and password the feature is off.
  DEVIATIONS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  DEVIATIONS_USERNAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  DEVIATIONS_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  DEVIATIONS_AREA: z.string().default('Cleaning (Logbook)'),
  // The address people open (shown with each deviation number); defaults to DEVIATIONS_URL.
  DEVIATIONS_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  DEVIATIONS_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
