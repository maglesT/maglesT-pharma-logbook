// Starts the real app with the built UI on a fresh database schema for the browser tests.
// Users, a product and the core logbook settings are seeded; each spec creates its own equipment.
import { connect } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import { sqlCycles } from '../server/cycles.js';
import { sqlSops } from '../server/sops.js';
import globalSetup from '../test/global-setup.js';
import { TEST_DATABASE_URL, TEST_PROOF_KEY, directory, fakeSignOn, login, proofFor, seedUser, call } from '../test/helpers.js';
import { NO_CARE, type Care, type Master } from '../server/master.js';
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
// D-78: TrueBatch Injectables linked: its batches and sterilisation cycles, stood in for by tables of the same names and
// columns (the specs fill them, e2e/sterile.spec.ts).
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA}_ti cascade; create schema ${E2E_SCHEMA}_ti;
  create table ${E2E_SCHEMA}_ti.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
    completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
  insert into ${E2E_SCHEMA}_ti.batch_fact_v1 (batch_number, product_code, status, issued_at) values ('TI260007', 'FG-TI', 'IN_PRODUCTION', now());
  create table ${E2E_SCHEMA}_ti.steriliser_cycle_v1 (cycle_id text, batch_number text, product_code text, step_key text, step_name text, equipment_code text,
    equipment_name text, equipment_type text, room_code text, cycle_type text, programme text, load text, controller_record_ref text,
    started_at timestamptz, ended_at timestamptz, result text, exposure_min numeric, lowest_temp_c numeric, lowest_f0 numeric,
    max_product_temp_c numeric, h2o2_ppm numeric, leak_rate numeric, units numeric, bi_id text, use_by date, signed text[],
    read_at timestamptz default now(), data_as_of timestamptz);
  grant usage on schema ${E2E_SCHEMA}_ti to logbook_app; grant select on all tables in schema ${E2E_SCHEMA}_ti to logbook_app;`);
// D-79: QMS linked: its controlled documents, stood in for by a table of document_v1's name and columns.
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA}_qms cascade; create schema ${E2E_SCHEMA}_qms;
  create table ${E2E_SCHEMA}_qms.document_v1 (number text, revision text, title text, type text, effective_date date, next_review_due date, status text,
    record_number text, next_revision text, next_effective_date date, read_at timestamptz default now(), data_as_of timestamptz);
  insert into ${E2E_SCHEMA}_qms.document_v1 (number, revision, title, type, effective_date, status) values
    ('SOP-1', '01', 'Logbook entries', 'SOP', '2026-01-01', 'effective'), ('SOP-CO-01', '02', 'Product change over', 'SOP', '2026-01-01', 'effective'),
    ('SOP-ENG-010', '03', 'Preventive maintenance', 'SOP', '2026-01-01', 'effective'), ('SOP-ENG-020', '01', 'Old PM', 'SOP', '2025-01-01', 'superseded');
  grant usage on schema ${E2E_SCHEMA}_qms to logbook_app; grant select on all tables in schema ${E2E_SCHEMA}_qms to logbook_app;`);
await owner.end();

const schemaOwner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await migrate(schemaOwner);
for (const [username, roles] of Object.entries(USERS)) await seedUser(schemaOwner, username, [...roles]);
// D-80: the exception permission is per person: qa1 holds it.
directory.get('qa1')!.permissions.push('logbook.exception.decide');
// Work orders (22 Nov 2026): per person. sup1 raises, eng1 does, qa1 closes.
directory.get('sup1')!.permissions.push('logbook.workorder.raise');
directory.get('eng1')!.permissions.push('logbook.workorder.do');
directory.get('qa1')!.permissions.push('logbook.workorder.close');
await schemaOwner.end();

const sql = connect(TEST_DATABASE_URL, { role: 'logbook_app', searchPath: E2E_SCHEMA });
// Master data is core's (D-29). The browser tests' stand-in reads items and products from tables in the e2e schema,
// which the specs fill (e2e/helpers.ts newEquipment).
const setup = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await setup`create table e2e_master_items (item_id uuid primary key default gen_random_uuid(), code text, name text, kind text,
  room text, active boolean default true, version int default 1, is_product boolean default false, care jsonb not null default '{}')`;
await setup`insert into e2e_master_items (code, name, is_product) values ('P1', 'Paracetamol 500 mg', true)`;
const master: Master = {
  items: async () => (await setup<{ item_id: string; code: string; name: string; kind: 'equipment' | 'instrument' | 'area'; room: string | null; active: boolean; version: number; care: Partial<Care> }[]>`
    select * from e2e_master_items where not is_product`).map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, kind: r.kind, room: r.room,
      active: r.active, version: r.version, make: null, model: null, serial: null, needsCalibration: r.kind === 'instrument',
      care: { ...NO_CARE, cleaningBasis: r.kind === 'area' ? 'operation' : null, ...r.care } })),
  products: async () => (await setup<{ item_id: string; code: string; name: string; active: boolean; version: number }[]>`
    select * from e2e_master_items where is_product`).map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, active: r.active, version: r.version })),
};
const app = await buildApp({ sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master, webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false, speech,
  cycles: sqlCycles(sql, `${E2E_SCHEMA}_ti`, 'TrueBatch Injectables'), sops: sqlSops(sql, `${E2E_SCHEMA}_qms`),
  // D-80: Deviations linked (no deviation filed yet), so a missed limit can be sent there.
  deviations: { bySource: async () => new Map() } });

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
