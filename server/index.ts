import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { geminiTranslator, sarvamProvider } from './voice.js';
import { geminiProvider } from './advice.js';
import { deviationsClient, scheduleAutoDeviations } from './autodeviation.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const gemini = config.GEMINI_API_KEY
  ? { apiKey: config.GEMINI_API_KEY, baseUrl: config.GEMINI_BASE_URL, model: config.GEMINI_MODEL, timeoutMs: config.GEMINI_TIMEOUT_MS }
  : null;
// D-26: voice notes need the speech service key; without it they stay off and entries are typed.
// D-27: with the Gemini key, Sarvam transcribes and Gemini translates with the entry's context.
const speech = config.SARVAM_API_KEY
  ? sarvamProvider({ apiKey: config.SARVAM_API_KEY, baseUrl: config.SARVAM_BASE_URL, model: config.SARVAM_MODEL, timeoutMs: config.SARVAM_TIMEOUT_MS,
    translator: gemini ? geminiTranslator({ ...gemini, timeoutMs: config.GEMINI_TRANSLATE_TIMEOUT_MS }) : null })
  : null;
// D-27: breakdown suggestions need the language-model key; without it only related breakdowns are listed.
const advisor = gemini ? geminiProvider(gemini) : null;
// D-34: missed cleaning limits raise deviations in the Deviations system when it is configured.
const deviations = config.DEVIATIONS_URL && config.DEVIATIONS_USERNAME && config.DEVIATIONS_PASSWORD
  ? deviationsClient({ baseUrl: config.DEVIATIONS_URL, username: config.DEVIATIONS_USERNAME, password: config.DEVIATIONS_PASSWORD,
    areaName: config.DEVIATIONS_AREA, timeoutMs: config.DEVIATIONS_TIMEOUT_MS })
  : null;
const app = await buildApp({ sql, logger: true, cookieSecure: config.COOKIE_SECURE, speech, advisor,
  deviationsUrl: deviations ? (config.DEVIATIONS_PUBLIC_URL ?? config.DEVIATIONS_URL!) : null });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg));
const stopDeviations = deviations ? scheduleAutoDeviations(sql, deviations, (msg) => app.log.info(msg)) : () => {};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    stopDeviations();
    await app.close();
    await sql.end();
    process.exit(0);
  });
}
