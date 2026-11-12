import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { geminiTranslator, sarvamProvider } from './voice.js';
import { geminiProvider } from './advice.js';
import { oidcSignOn } from './signon.js';
import { createHash } from 'node:crypto';
import { sqlMaster } from './master.js';
import { sqlQualification } from './qualification.js';
import { scheduleOverdue, sqlDeviations } from './overdue.js';

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
const signOn = oidcSignOn({ issuer: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID, clientSecret: config.OIDC_CLIENT_SECRET,
  redirectUri: config.OIDC_REDIRECT_URI });
// Signing proofs (B1-4) stay valid across a restart and between instances: the key is derived from the client secret.
const proofKey = createHash('sha256').update(`logbook-signing-proof:${config.OIDC_CLIENT_SECRET}`).digest();
const md = connect(config.MASTER_DATA_DATABASE_URL);
const qual = config.QUAL_DATABASE_URL ? connect(config.QUAL_DATABASE_URL) : null;
const dv = config.DEVIATIONS_DATABASE_URL ? connect(config.DEVIATIONS_DATABASE_URL) : null;
const master = sqlMaster(md);
const qualification = qual ? sqlQualification(qual) : null;
const app = await buildApp({ sql, signOn, proofKey, master, qualification, deviations: dv ? sqlDeviations(dv) : null, logger: true, cookieSecure: config.COOKIE_SECURE, speech, advisor });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg));
// D-37: missed limits are recorded for Deviations every minute.
const stopOverdue = scheduleOverdue(sql, master, qualification, (msg) => app.log.info(msg));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    stopOverdue();
    await app.close();
    await sql.end();
    await md.end();
    await qual?.end();
    await dv?.end();
    process.exit(0);
  });
}
