// Starts the real app with the built UI on a fresh database schema for the browser tests.
// Users, a product and the core logbook settings are seeded; each spec creates its own equipment.
import { connect } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import globalSetup from '../test/global-setup.js';
import { TEST_DATABASE_URL, TEST_PROOF_KEY, fakeSignOn, login, proofFor, seedUser, call } from '../test/helpers.js';
import { NO_CARE, type Care, type Master } from '../server/master.js';
import { scheduleOverdue } from '../server/overdue.js';
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
// As on an installation with history (D-37): limits that ran out in the last 30 days count.
await schemaOwner`update overdue_since set since = now() - interval '30 days'`;
await schemaOwner.end();

const sql = connect(TEST_DATABASE_URL, { role: 'logbook_app', searchPath: E2E_SCHEMA });
// Master data is core's (D-29). The browser tests' stand-in reads items and products from tables in the e2e schema,
// which the specs fill (e2e/helpers.ts newEquipment).
const setup = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await setup`create table e2e_master_items (item_id uuid primary key default gen_random_uuid(), code text, name text, kind text,
  room text, active boolean default true, version int default 1, is_product boolean default false, care jsonb not null default '{}', type text, grade text)`;
await setup`insert into e2e_master_items (code, name, is_product) values ('P1', 'Paracetamol 500 mg', true)`;
const master: Master = {
  items: async () => (await setup<{ item_id: string; code: string; name: string; kind: 'equipment' | 'instrument' | 'area'; room: string | null; active: boolean; version: number; care: Partial<Care>; type: string | null; grade: string | null }[]>`
    select * from e2e_master_items where not is_product`).map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, kind: r.kind, room: r.room,
      active: r.active, version: r.version, make: null, model: null, serial: null, needsCalibration: r.kind === 'instrument',
      care: { ...NO_CARE, cleaningBasis: r.kind === 'area' ? 'operation' : null, ...r.care }, type: r.type, grade: r.grade, area: r.kind === 'area' ? r.type : null })),
  products: async () => (await setup<{ item_id: string; code: string; name: string; active: boolean; version: number }[]>`
    select * from e2e_master_items where is_product`).map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, active: r.active, version: r.version })),
};
const app = await buildApp({ sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master, webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false, speech });

const admin = (await login(app, 'admin')).cookie;
const qa = (await login(app, 'qa1')).cookie;

for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration', 'general_log']) {
  const settings = { enabled: true, sopRef: 'SOP-1', checklist: [], verificationRequired: false };
  const id = (await call(app, admin, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: new Date().toISOString() })).json().id;
  const versions = (await call(app, qa, 'GET', '/api/logbook-types')).json().flatMap((t: { versions: { id: number; contentHash: string }[] }) => t.versions);
  const hash = versions.find((v: { id: number }) => v.id === id).contentHash;
  await call(app, qa, 'POST', `/api/settings/${id}/approve`, { proof: proofFor('qa1'), contentHash: hash });
}
await call(app, admin, 'POST', '/api/logout');
await call(app, qa, 'POST', '/api/logout');

await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
// D-37/D-43: the minute check for missed limits, every 2 s here so a browser test can wait for it.
scheduleOverdue(sql, master, null, () => {}, 2_000);
