// Starts the real app with the built UI on a fresh database schema for the browser tests.
// Users, a product and the core logbook settings are seeded; each spec creates its own equipment.
import { connect } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import globalSetup from '../test/global-setup.js';
import { PASSWORD, TEST_DATABASE_URL, fakeSignOn, login, seedUser, call } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA, USERS } from './config.js';
import type { SpeechProvider } from '../server/voice.js';

// A stand-in for the Sarvam service: no real API calls in tests (D-26).
const speech: SpeechProvider = {
  name: 'sarvam',
  async transcribe(_audio, _mime, language) {
    return { transcript: 'मोटर अचानक बंद हो गई', translation: 'The motor stopped suddenly.', detectedLanguage: language === 'unknown' ? 'hi-IN' : language, model: 'saaras:v3', requestIds: { transcribe: 'mock-1', translate: 'mock-2' } };
  },
};

await globalSetup();
const owner = connect(TEST_DATABASE_URL);
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA} cascade`);
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA}_report cascade`);
await owner.unsafe(`create schema ${E2E_SCHEMA}`);
await owner.end();

const schemaOwner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await migrate(schemaOwner);
for (const [username, roles] of Object.entries(USERS)) await seedUser(schemaOwner, username, [...roles]);
await schemaOwner.end();

const sql = connect(TEST_DATABASE_URL, { role: 'logbook_app', searchPath: E2E_SCHEMA });
const app = await buildApp({ sql, signOn: fakeSignOn(), webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false, speech });

const admin = (await login(app, 'admin')).cookie;
const qa = (await login(app, 'qa1')).cookie;
await call(app, admin, 'POST', '/api/products', { code: 'P1', name: 'Paracetamol 500 mg' });
for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration', 'general_log']) {
  const settings = { enabled: true, sopRef: 'SOP-1', checklist: [], verificationRequired: false };
  const id = (await call(app, admin, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: new Date().toISOString() })).json().id;
  const versions = (await call(app, qa, 'GET', '/api/logbook-types')).json().flatMap((t: { versions: { id: number; contentHash: string }[] }) => t.versions);
  const hash = versions.find((v: { id: number }) => v.id === id).contentHash;
  await call(app, qa, 'POST', `/api/settings/${id}/approve`, { username: 'qa1', password: PASSWORD, contentHash: hash });
}
await call(app, admin, 'POST', '/api/logout');
await call(app, qa, 'POST', '/api/logout');

await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
