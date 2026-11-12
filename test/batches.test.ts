import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlBatches } from '../server/batches.js';
import { addItem, addProduct, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { connect, type Sql } from '../server/db.js';
import { TEST_DATABASE_URL } from './helpers.js';

// Owner 2026-11-12: the batch of a use or change over is chosen from Batchwright's batch records (report.batch_fact_v1,
// report.equipment_use_v1, read through the platform link); the product is the batch's. Nothing is typed.
let t: TestApp;
let reader: Sql;
const c: Record<string, string> = {};
const S = `bw_${process.pid}`;
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
let rmg: number;
let mill: number;
let met: number;

beforeAll(async () => {
  t = await freshApp();
  await t.owner.unsafe(`create schema ${S}`);
  await t.owner.unsafe(`create table ${S}.batch_fact_v1 (batch_number text, product_code text, strength text, status text, issued_at timestamptz, completed_at timestamptz, released boolean);
    create table ${S}.equipment_use_v1 (batch_number text, equipment_code text, room_code text);
    insert into ${S}.batch_fact_v1 values
      ('MET26007', 'FG-MET500', '500 mg', 'IN_PROGRESS', now() - interval '1 day', null, false),
      ('PCM26010', 'FG-PCM500', '500 mg', 'QA_REVIEWED', now() - interval '5 days', now() - interval '3 days', false),
      ('PCM26011', 'FG-PCM500', '500 mg', 'IN_PROGRESS', now() - interval '2 hours', null, false),
      ('XYZ26001', 'FG-XYZ', '10 mg', 'IN_PROGRESS', now() - interval '3 hours', null, false),
      ('OLD25001', 'FG-MET500', '500 mg', 'QA_REVIEWED', now() - interval '400 days', now() - interval '399 days', true);
    insert into ${S}.equipment_use_v1 values ('PCM26011', 'RMG-T1', 'GRAN-T'), ('MET26007', 'CMP-T9', 'COMP-T');
    grant usage on schema ${S} to logbook_app; grant select on all tables in schema ${S} to logbook_app;`);
  reader = connect(TEST_DATABASE_URL, { role: 'logbook_app' });
  t.app.batches = sqlBatches(reader, S);
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1']] as const) c[k] = (await login(t.app, u)).cookie;
  met = await addProduct(t, 'FG-MET500', 'Metformin tablets 500 mg');
  await addProduct(t, 'FG-PCM500', 'Paracetamol tablets 500 mg');
  rmg = await addItem(t, { code: 'RMG-T1', location: 'GRAN-T' });
  mill = await addItem(t, { code: 'MILL-T2', location: 'GRAN-T' });
  for (const type of ['equipment_use', 'change_over']) {
    const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
    const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === id).contentHash;
    await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
  }
});
afterAll(async () => {
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${S} cascade`);
  await t.close();
});

const use = (id: number, body: object) => call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_use', activityStart: now(), data: { stage: 'Granulation' }, ...body });

describe('batches from the batch records (owner 2026-11-12)', () => {
  it('LB-02: the batch list has the batches in production first, those using this item on top, with the product from master data', async () => {
    const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${rmg}/batches`)).json();
    expect(r.linked).toBe(true);
    const numbers = r.batches.map((b: { batchNumber: string }) => b.batchNumber);
    expect(numbers.slice(0, 3)).toEqual(['PCM26011', 'XYZ26001', 'MET26007']);   // in production; PCM26011 uses RMG-T1
    expect(numbers).toContain('PCM26010');            // finished recently: offered as "from batch" of a change over
    expect(numbers).not.toContain('OLD25001');        // finished long ago
    expect(r.batches[0]).toMatchObject({ onThisItem: true, inProduction: true, productCode: 'FG-PCM500', productName: 'Paracetamol tablets 500 mg' });
    expect(r.batches.find((b: { batchNumber: string }) => b.batchNumber === 'XYZ26001')).toMatchObject({ productId: null });
  });

  it('LB-02: a use takes its batch from the batch records and its product from the batch; a typed or finished batch is refused', async () => {
    expect((await use(mill, { batch: 'TYPED-1', productId: met })).json().problems).toEqual(['Batch TYPED-1 is not in the batch records (Batchwright).']);
    expect((await use(mill, { batch: 'PCM26010' })).json().problems).toEqual(['Batch PCM26010 is not in production in Batchwright (QA_REVIEWED).']);
    expect((await use(mill, { batch: 'XYZ26001' })).json().problems[0]).toContain('The product FG-XYZ of batch XYZ26001 is not in master data');
    expect((await use(mill, {})).json().problems).toEqual(['Choose the batch from the batch records.']);
    const ok = await use(mill, { batch: 'PCM26011', productId: met });   // the product is the batch's, whatever is sent
    expect(ok.statusCode).toBe(201);
    const [row] = await t.owner<{ code: string; batch: string }[]>`select p.code, e.batch from entries e join products p on p.id = e.product_id where e.id = ${ok.json().id}`;
    expect(row).toEqual({ code: 'FG-PCM500', batch: 'PCM26011' });
  });

  it('LB-02: a change over names its batches from the batch records and takes their products', async () => {
    const r = await call(t.app, c.op1!, 'POST', `/api/equipment/${rmg}/entries`, { logbookType: 'change_over', activityStart: now(),
      data: { fromBatch: 'PCM26010', toBatch: 'MET26007', fromProduct: 'typed', toProduct: 'typed', checklist: {} }, signature: sig('op1') });
    expect(r.statusCode).toBe(201);
    const [row] = await t.owner<{ data: Record<string, string> }[]>`select data from entries where id = ${r.json().id}`;
    expect(row!.data).toMatchObject({ fromBatch: 'PCM26010', fromProduct: 'FG-PCM500 · Paracetamol tablets 500 mg', toBatch: 'MET26007', toProduct: 'FG-MET500 · Metformin tablets 500 mg' });
    const bad = await call(t.app, c.op1!, 'POST', `/api/equipment/${mill}/entries`, { logbookType: 'change_over', activityStart: now(),
      data: { fromBatch: 'MET26007', toBatch: 'PCM26010', checklist: {} }, signature: sig('op1') });
    expect(bad.json().problems).toEqual(['Batch PCM26010 is not in production in Batchwright (QA_REVIEWED).']);
  });

  it('PL-08: with the link to Batchwright cut, the batch list and a new use stop with "connection off"', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${S} from logbook_app`);
    try {
      const r = await call(t.app, c.op1!, 'GET', `/api/equipment/${rmg}/batches`);
      expect(r.statusCode).toBe(503);
      expect(r.json().message).toContain('Batchwright');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${S} to logbook_app`);
    }
  });
});
