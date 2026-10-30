import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { sarvamProvider } from './voice.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
// D-26: voice notes need the speech service key; without it they stay off and entries are typed.
const speech = config.SARVAM_API_KEY
  ? sarvamProvider({ apiKey: config.SARVAM_API_KEY, baseUrl: config.SARVAM_BASE_URL, model: config.SARVAM_MODEL, timeoutMs: config.SARVAM_TIMEOUT_MS })
  : null;
const app = await buildApp({ sql, logger: true, cookieSecure: config.COOKIE_SECURE, speech });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    await app.close();
    await sql.end();
    process.exit(0);
  });
}
