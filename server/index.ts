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
import { mergeBatches, sqlBatches, sqlTrueBatchUses } from './batches.js';

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
const ebmr = config.EBMR_DATABASE_URL ? connect(config.EBMR_DATABASE_URL) : null;
const tb = config.TRUEBATCH_DATABASE_URL ? connect(config.TRUEBATCH_DATABASE_URL) : null;
const tbp = config.TRUEBATCH_PACKING_DATABASE_URL ? connect(config.TRUEBATCH_PACKING_DATABASE_URL) : null;
const tbi = config.TRUEBATCH_INJECTABLES_DATABASE_URL ? connect(config.TRUEBATCH_INJECTABLES_DATABASE_URL) : null;
const tbip = config.TRUEBATCH_INJECTABLES_PACKING_DATABASE_URL ? connect(config.TRUEBATCH_INJECTABLES_PACKING_DATABASE_URL) : null;
// D-45: batches from Batchwright, TrueBatch or both; D-61: and from every linked TrueBatch product (packing: packing_batch_v1).
const batches = mergeBatches([ebmr ? sqlBatches(ebmr) : null, tb ? sqlBatches(tb, 'report', 'TrueBatch') : null,
  tbi ? sqlBatches(tbi, 'report', 'TrueBatch Injectables') : null,
  tbp ? sqlBatches(tbp, 'report', 'TrueBatch Packing', 'packing_batch_v1') : null,
  tbip ? sqlBatches(tbip, 'report', 'TrueBatch Injectables Packing', 'packing_batch_v1') : null]);
// D-46: TrueBatch's machine and room uses count in the status as Logbook uses do; D-47: TrueBatch Packing's too (its
// batches are not read); D-52: TrueBatch Injectables' too (its batches read as TrueBatch's); D-54: TrueBatch Injectables
// Packing's too (as Packing's, its batches are not read).
const trueBatchUses = [...(tb ? [sqlTrueBatchUses(tb)] : []), ...(tbp ? [sqlTrueBatchUses(tbp, 'report', 'TrueBatch Packing', null)] : []),
  ...(tbi ? [sqlTrueBatchUses(tbi, 'report', 'TrueBatch Injectables')] : []),
  ...(tbip ? [sqlTrueBatchUses(tbip, 'report', 'TrueBatch Injectables Packing', null)] : [])];
const master = sqlMaster(md);
const qualification = qual ? sqlQualification(qual) : null;
const app = await buildApp({ sql, signOn, proofKey, master, qualification, deviations: dv ? sqlDeviations(dv) : null, batches, trueBatchUses, logger: true, cookieSecure: config.COOKIE_SECURE, speech, advisor });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg));
// D-37: missed limits are recorded for Deviations every minute.
const stopOverdue = scheduleOverdue(sql, master, qualification, (msg) => app.log.info(msg), 60_000, trueBatchUses);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    stopOverdue();
    await app.close();
    await sql.end();
    await md.end();
    await qual?.end();
    await dv?.end();
    await ebmr?.end();
    await tb?.end();
    await tbp?.end();
    await tbi?.end();
    await tbip?.end();
    process.exit(0);
  });
}
