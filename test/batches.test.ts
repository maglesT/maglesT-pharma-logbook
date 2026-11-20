import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeBatches, sqlBatches, trueBatchReaders, TrueBatchOff, type Batch, type Batches, type BatchSource } from '../server/batches.js';
import { TRUEBATCH_PROVIDERS } from '../server/truebatch-providers.js';
import { addItem, addProduct, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { connect, type Sql } from '../server/db.js';
import { TEST_DATABASE_URL } from './helpers.js';

// Owner 2026-11-12: the batch of a use or change over is chosen from the batch records (report.batch_fact_v1,
// report.equipment_use_v1, read through the platform link); the product is the batch's. Nothing is typed.
// D-68: the first product here is TrueBatch Injectables (the generic columns only); Batchwright is retired.
let t: TestApp;
let reader: Sql;
const c: Record<string, string> = {};
const S = `ti_${process.pid}`;
// D-45: TrueBatch's views of the same names and columns (its own statuses: IN_PRODUCTION until production approval).
const TB = `tb_${process.pid}`;
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
  await t.owner.unsafe(`create schema ${TB}`);
  await t.owner.unsafe(`create table ${TB}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
      completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
    create table ${TB}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
      ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz);
    insert into ${TB}.batch_fact_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
      ('TBM26001', 'FG-MET500', 'IN_PRODUCTION', now() - interval '1 hour', null, false),
      ('TBM26002', 'FG-MET500', 'PRODUCTION_APPROVED', now() - interval '4 days', now() - interval '1 day', false),
      ('MET26007', 'FG-PCM500', 'IN_PRODUCTION', now() - interval '1 hour', null, false);
    insert into ${TB}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step) values ('TBM26001', 'CMP-TB1', 'machine', 'COMP-T', 'compression/press');
    grant usage on schema ${TB} to logbook_app; grant select on all tables in schema ${TB} to logbook_app;`);
  reader = connect(TEST_DATABASE_URL, { role: 'logbook_app' });
  t.app.batches = mergeBatches([sqlBatches(reader, S, 'TrueBatch Injectables')]);
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
  await t.owner.unsafe(`drop schema if exists ${TB} cascade`);
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
    expect((await use(mill, { batch: 'TYPED-1', productId: met })).json().problems).toEqual(['Batch TYPED-1 is not in the batch records (TrueBatch Injectables): choose it from the list or type it by hand.']);
    expect((await use(mill, { batch: 'PCM26010' })).json().problems).toEqual(['Batch PCM26010 is not in production in TrueBatch Injectables (QA_REVIEWED).']);
    expect((await use(mill, { batch: 'XYZ26001' })).json().problems[0]).toContain('The product FG-XYZ of batch XYZ26001 is not in master data');
    expect((await use(mill, {})).json().problems).toEqual(['Choose the batch from the batch records, or type it by hand.']);
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
    expect(bad.json().problems).toEqual(['Batch PCM26010 is not in production in TrueBatch Injectables (QA_REVIEWED).']);
  });

  it('LB-01: ending a use of a batch from the batch records needs the reason, kept with the use; it needs no link to end (D-49)', async () => {
    const press = await addItem(t, { code: 'CMP-T9', location: 'COMP-T' });
    const id = (await use(press, { batch: 'MET26007' })).json().id;
    const open = (await call(t.app, c.op1!, 'GET', `/api/equipment/${press}/entries`)).json().find((e: { id: number }) => e.id === id);
    expect(open).toMatchObject({ inProgress: true, endReasonFrom: 'TrueBatch Injectables' });
    const end = (body: object = {}) => call(t.app, c.op1!, 'POST', `/api/entries/${id}/complete`, { activityEnd: now(), ...body });
    for (const missing of [{}, { endReason: '   ' }]) {
      const refused = await end(missing);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: 'end_reason_required', problems: ['Batch MET26007 is from the batch records of TrueBatch Injectables: give the reason the use ends.'] });
    }
    // The reason is a Logbook record: ending needs no answer from the batch records.
    await t.owner.unsafe(`revoke select on all tables in schema ${S} from logbook_app`);
    try {
      expect((await end({ endReason: 'Batch record withdrawn' })).statusCode).toBe(200);
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${S} to logbook_app`);
    }
    const [v1, v2] = (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json();
    expect(v1.data).not.toHaveProperty('endReason');
    expect(v2).toMatchObject({ change: 'completed', batch: 'MET26007', data: { stage: 'Granulation', endReason: 'Batch record withdrawn' } });
    expect(v2.activityEnd).not.toBeNull();
  });

  it('D-69: with the link cut, the batch list is empty and says so in one line', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${S} from logbook_app`);
    try {
      const r = await call(t.app, c.op1!, 'GET', `/api/equipment/${rmg}/batches`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ linked: true, batches: [], notes: ['Connection to TrueBatch Injectables is off: its batches are not listed.'] });
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${S} to logbook_app`);
    }
  });
});

describe('batches from two TrueBatch products (D-45, D-61)', () => {
  let ti: ReturnType<typeof sqlBatches>;
  const tiOnly = () => mergeBatches([ti]);
  let press: number;
  let blender: number;
  beforeAll(async () => {
    ti = sqlBatches(reader, S, 'TrueBatch Injectables');
    press = await addItem(t, { code: 'CMP-TB1', location: 'COMP-T' });
    blender = await addItem(t, { code: 'BLD-TB2', location: 'COMP-T' });
    t.app.batches = mergeBatches([ti, sqlBatches(reader, TB, 'TrueBatch')]);
  });
  afterAll(() => { t.app.batches = tiOnly(); });

  it('LB-02: with both linked, the list has the batches of both, a TrueBatch batch using this item on top; a number in both is the first product\'s', async () => {
    const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${press}/batches`)).json();
    expect(r.linked).toBe(true);
    expect(r.batches[0]).toMatchObject({ batchNumber: 'TBM26001', source: 'TrueBatch', onThisItem: true, inProduction: true, productName: 'Metformin tablets 500 mg' });
    const numbers = r.batches.map((b: { batchNumber: string }) => b.batchNumber);
    expect(numbers).toEqual(expect.arrayContaining(['TBM26001', 'TBM26002', 'PCM26011', 'MET26007']));
    expect(numbers.filter((b: string) => b === 'MET26007')).toHaveLength(1);
    expect(r.batches.find((b: { batchNumber: string }) => b.batchNumber === 'MET26007')).toMatchObject({ source: 'TrueBatch Injectables', productCode: 'FG-MET500' });
  });

  it('LB-02: a use takes a TrueBatch batch and its product; a TrueBatch batch past production or a number in neither is refused', async () => {
    expect((await use(blender, { batch: 'TBM26002' })).json().problems).toEqual(['Batch TBM26002 is not in production in TrueBatch (PRODUCTION_APPROVED).']);
    expect((await use(blender, { batch: 'NONE-1' })).json().problems).toEqual(['Batch NONE-1 is not in the batch records (TrueBatch Injectables, TrueBatch): choose it from the list or type it by hand.']);
    const ok = await use(press, { batch: 'TBM26001' });
    expect(ok.statusCode).toBe(201);
    const [row] = await t.owner<{ code: string; batch: string }[]>`select p.code, e.batch from entries e join products p on p.id = e.product_id where e.id = ${ok.json().id}`;
    expect(row).toEqual({ code: 'FG-MET500', batch: 'TBM26001' });
  });

  it('LB-02: with TrueBatch alone, batches come from TrueBatch', async () => {
    t.app.batches = mergeBatches([null, sqlBatches(reader, TB, 'TrueBatch')]);
    try {
      const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${blender}/batches`)).json();
      expect(r.batches.map((b: { batchNumber: string }) => b.batchNumber).sort()).toEqual(['MET26007', 'TBM26001', 'TBM26002']);
      expect((await use(blender, { batch: 'PCM26011' })).json().problems).toEqual(['Batch PCM26011 is not in the batch records (TrueBatch): choose it from the list or type it by hand.']);
    } finally {
      t.app.batches = mergeBatches([ti, sqlBatches(reader, TB, 'TrueBatch')]);
    }
  });

  it('D-69: with the link to TrueBatch cut, the list has the other product\'s batches and names TrueBatch in one line; a batch not listed may be typed by hand', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${TB} from logbook_app`);
    try {
      const r = await call(t.app, c.op1!, 'GET', `/api/equipment/${blender}/batches`);
      expect(r.statusCode).toBe(200);
      expect(r.json().notes).toEqual(['Connection to TrueBatch is off: its batches are not listed.']);
      const numbers = r.json().batches.map((b: { batchNumber: string }) => b.batchNumber);
      expect(numbers).toContain('PCM26011');
      expect(numbers).not.toContain('TBM26001');
      // Not listed and not typed: refused, with the reason.
      const unknown = await use(blender, { batch: 'NONE-2' });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().problems).toEqual(['Batch NONE-2 is not in the batch records (TrueBatch Injectables, TrueBatch): choose it from the list or type it by hand.',
        'Connection to TrueBatch is off: its batches are not listed.']);
      expect((await use(blender, { batch: 'XYZ26001' })).json().problems[0]).toContain('The product FG-XYZ of batch XYZ26001 is not in master data');
      // Typed by hand: the product is picked from master data, and the entry says why it was typed.
      expect((await use(blender, { batch: 'TBM26001', batchTyped: true })).json().problems).toEqual(['Pick the product of batch TBM26001 from master data.']);
      const typed = await use(blender, { batch: 'TBM26001', batchTyped: true, productId: met });
      expect(typed.statusCode).toBe(201);
      const [row] = await t.owner<{ code: string; batch: string; data: Record<string, unknown> }[]>`
        select p.code, e.batch, e.data from entries e join products p on p.id = e.product_id where e.id = ${typed.json().id}`;
      expect(row).toMatchObject({ code: 'FG-MET500', batch: 'TBM26001', data: { batchTyped: 'Batch TBM26001: TrueBatch not reachable' } });
      // A typed batch needs no end reason (it is not from the batch records); the flag stays with the entry.
      const open = (await call(t.app, c.op1!, 'GET', `/api/equipment/${blender}/entries`)).json().find((e: { id: number }) => e.id === typed.json().id);
      expect(open.endReasonFrom).toBeNull();
      const ended = await call(t.app, c.op1!, 'POST', `/api/entries/${typed.json().id}/complete`, { activityEnd: now() });
      expect(ended.statusCode).toBe(200);
      const versions = (await call(t.app, c.qa!, 'GET', `/api/entries/${typed.json().id}/versions`)).json();
      expect(versions[1].data.batchTyped).toBe('Batch TBM26001: TrueBatch not reachable');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${TB} to logbook_app`);
    }
  });
});

describe('batches from the packing products as well (D-61)', () => {
  const PK = `pk_${process.pid}`;
  let blister: number;
  beforeAll(async () => {
    await t.owner.unsafe(`create schema ${PK}`);
    await t.owner.unsafe(`create table ${PK}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text,
        pack_type text, status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
      create table ${PK}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
        ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz);
      insert into ${PK}.packing_batch_v1 (batch_number, coded_batch_number, product_code, bulk_product_code, pack_type, status, issued_at, completed_at, released) values
        ('TP26001', 'TBM26001', 'PK-MET500-B10', 'FG-MET500', 'blister', 'IN_PACKING', now() - interval '1 hour', null, false),
        ('TP26002', 'TBM26001', 'PK-MET500-B10', 'FG-MET500', 'blister', 'RELEASED', now() - interval '3 days', now() - interval '2 days', true);
      insert into ${PK}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step) values ('TP26001', 'BLS-PK1', 'machine', 'PACK-T', 'blister/run');
      grant usage on schema ${PK} to logbook_app; grant select on all tables in schema ${PK} to logbook_app;`);
    await addProduct(t, 'PK-MET500-B10', 'Metformin 500 mg blister pack of 10');
    blister = await addItem(t, { code: 'BLS-PK1', location: 'PACK-T' });
    t.app.batches = mergeBatches([sqlBatches(reader, TB, 'TrueBatch'), sqlBatches(reader, PK, 'TrueBatch Packing', 'packing_batch_v1')]);
  });
  afterAll(async () => {
    t.app.batches = mergeBatches([sqlBatches(reader, S, 'TrueBatch Injectables')]);
    await t.owner.unsafe(`drop schema if exists ${PK} cascade`);
  });

  it('LB-02: a packing line is offered its packing batch on top, and a use takes it with the pack product', async () => {
    const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${blister}/batches`)).json();
    expect(r.batches[0]).toMatchObject({ batchNumber: 'TP26001', source: 'TrueBatch Packing', strength: null, onThisItem: true, inProduction: true,
      productName: 'Metformin 500 mg blister pack of 10' });
    expect(r.batches.map((b: { batchNumber: string }) => b.batchNumber)).toEqual(expect.arrayContaining(['TP26002', 'TBM26001']));
    expect((await use(blister, { batch: 'TP26002' })).json().problems).toEqual(['Batch TP26002 is not in production in TrueBatch Packing (RELEASED).']);
    expect((await use(blister, { batch: 'TP26001' })).statusCode).toBe(201);
  });

  it('D-69: with the link to the packing product cut, the list names it and still has TrueBatch\'s batches', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${PK} from logbook_app`);
    try {
      const r = await call(t.app, c.op1!, 'GET', `/api/equipment/${blister}/batches`);
      expect(r.statusCode).toBe(200);
      expect(r.json().notes).toEqual(['Connection to TrueBatch Packing is off: its batches are not listed.']);
      expect(r.json().batches.map((b: { batchNumber: string }) => b.batchNumber)).toContain('TBM26001');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${PK} to logbook_app`);
    }
  });
});

describe('batches from TrueBatch Capsules, Oral Liquids, API and their packing (D-75)', () => {
  // A stand-in schema per new product, with the views its kind publishes (D-61): bulk batch_fact_v1, packing packing_batch_v1.
  const NEW = TRUEBATCH_PROVIDERS.filter((p) => ['truebatch_capsules', 'truebatch_capsules_packing', 'truebatch_liquids', 'truebatch_liquids_packing', 'truebatch_api'].includes(p.id));
  const schema = (id: string) => `${id.replace('truebatch', 'n')}_${process.pid}`;
  const number = (id: string, n = 1) => `${id.replace('truebatch_', '').toUpperCase()}-${n}`;
  let filler: number;
  beforeAll(async () => {
    for (const p of NEW) {
      const x = schema(p.id);
      await t.owner.unsafe(`create schema ${x};
        create table ${x}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz,
          ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz, step_name text);
        ${p.packing
          ? `create table ${x}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text,
              pack_type text, status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
            insert into ${x}.packing_batch_v1 (batch_number, product_code, status, issued_at, completed_at, released) values
              ('${number(p.id)}', 'FG-MET500', 'IN_PACKING', now() - interval '1 hour', null, false),
              ('${number(p.id, 2)}', 'FG-MET500', 'RELEASED', now() - interval '3 days', now() - interval '2 days', true);`
          : `create table ${x}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, status text, issued_at timestamptz,
              completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz);
            insert into ${x}.batch_fact_v1 (batch_number, product_code, strength, status, issued_at, completed_at, released) values
              ('${number(p.id)}', 'FG-MET500', '500 mg', 'IN_PRODUCTION', now() - interval '1 hour', null, false),
              ('${number(p.id, 2)}', 'FG-MET500', '500 mg', 'PRODUCTION_APPROVED', now() - interval '3 days', now() - interval '2 days', false);`}
        grant usage on schema ${x} to logbook_app; grant select on all tables in schema ${x} to logbook_app;`);
    }
    await t.owner.unsafe(`insert into ${schema('truebatch_capsules')}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step)
      values ('CAPSULES-1', 'CFM-N1', 'machine', 'CAPS-T', 'filling/run')`);
    filler = await addItem(t, { code: 'CFM-N1', location: 'CAPS-T' });
    t.app.batches = trueBatchReaders(NEW.map((provider) => ({ provider, q: reader, schema: schema(provider.id) }))).batches;
  });
  afterAll(async () => {
    t.app.batches = mergeBatches([sqlBatches(reader, S, 'TrueBatch Injectables')]);
    for (const p of NEW) await t.owner.unsafe(`drop schema if exists ${schema(p.id)} cascade`);
  });

  it('LB-02: each product\'s batches are listed under its name, a packing batch without a strength; a batch using this item is on top', async () => {
    const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${filler}/batches`)).json();
    expect(r).toMatchObject({ linked: true, notes: [] });
    expect(r.batches[0]).toMatchObject({ batchNumber: 'CAPSULES-1', source: 'TrueBatch Capsules', strength: '500 mg', onThisItem: true, inProduction: true });
    for (const p of NEW) {
      expect(r.batches.find((b: { batchNumber: string }) => b.batchNumber === number(p.id))).toMatchObject({ source: p.name, inProduction: true,
        strength: p.packing ? null : '500 mg', productName: 'Metformin tablets 500 mg' });
      expect(r.batches.map((b: { batchNumber: string }) => b.batchNumber)).toContain(number(p.id, 2));
    }
    expect((await use(filler, { batch: 'CAPSULES-2' })).json().problems).toEqual(['Batch CAPSULES-2 is not in production in TrueBatch Capsules (PRODUCTION_APPROVED).']);
    expect((await use(filler, { batch: 'LIQUIDS_PACKING-2' })).json().problems).toEqual(['Batch LIQUIDS_PACKING-2 is not in production in TrueBatch Liquids Packing (RELEASED).']);
    expect((await use(filler, { batch: 'NONE-9' })).json().problems).toEqual(['Batch NONE-9 is not in the batch records (TrueBatch Capsules, TrueBatch Liquids, TrueBatch API, TrueBatch Capsules Packing, TrueBatch Liquids Packing): choose it from the list or type it by hand.']);
    expect((await use(filler, { batch: 'API-1' })).statusCode).toBe(201);
  });

  it('D-69: with the link to TrueBatch API cut, the list names it in one line and still has the other products\' batches', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${schema('truebatch_api')} from logbook_app`);
    try {
      const r = (await call(t.app, c.op1!, 'GET', `/api/equipment/${filler}/batches`)).json();
      expect(r.notes).toEqual(['Connection to TrueBatch API is off: its batches are not listed.']);
      const numbers = r.batches.map((b: { batchNumber: string }) => b.batchNumber);
      expect(numbers).toContain('CAPSULES-1');
      expect(numbers).not.toContain('API-1');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${schema('truebatch_api')} to logbook_app`);
    }
  });
});

describe('a batch typed by hand (D-69, owner 17 Nov 2026)', () => {
  const fake = (source: BatchSource, batches: string[], off = false): Batches => {
    const b = (n: string): Batch => ({ batchNumber: n, productCode: 'FG-MET500', strength: null, status: 'IN_PRODUCTION', issuedAt: null, completedAt: null,
      released: false, inProduction: true, source });
    const answer = async <T>(v: T) => { if (off) throw new TrueBatchOff(source); return v; };
    return { source, list: () => answer(batches.map(b)), get: (n) => answer(batches.includes(n) ? b(n) : null), usedOn: () => answer(new Set<string>()) };
  };

  it('one of four products cut: the other three are listed, the cut one named; a lookup still finds the others\' batches', async () => {
    const m = mergeBatches([fake('TrueBatch', ['A1']), fake('TrueBatch Packing', ['P1'], true), fake('TrueBatch Injectables', ['I1']),
      fake('TrueBatch Injectables Packing', ['IP1'])])!;
    const r = await m.list(60);
    expect(r.batches.map((b) => b.batchNumber)).toEqual(['A1', 'I1', 'IP1']);
    expect(r.down).toEqual(['TrueBatch Packing']);
    expect(await m.get('I1')).toMatchObject({ batch: { batchNumber: 'I1', source: 'TrueBatch Injectables' }, down: ['TrueBatch Packing'] });
    expect(await m.get('P1')).toEqual({ batch: null, down: ['TrueBatch Packing'] });
    // All answer: as before.
    const ok = mergeBatches([fake('TrueBatch', ['A1']), fake('TrueBatch Packing', ['P1'])])!;
    expect(await ok.list(60)).toMatchObject({ down: [] });
    expect((await ok.list(60)).batches.map((b) => b.batchNumber)).toEqual(['A1', 'P1']);
  });

  it('a batch of a product not linked here is typed with its product from master data and marked; a listed batch typed with another product is refused', async () => {
    const tablet = await addItem(t, { code: 'TAB-H1', location: 'COMP-T' });
    // PCM26011 is listed by TrueBatch Injectables with FG-PCM500.
    const other = await use(tablet, { batch: 'PCM26011', batchTyped: true, productId: met });
    expect(other.statusCode).toBe(409);
    expect(other.json().problems).toEqual(['Batch PCM26011 is in TrueBatch Injectables with the product FG-PCM500 · Paracetamol tablets 500 mg: choose it from the list.']);
    const typed = await use(tablet, { batch: 'EXT26001', batchTyped: true, productId: met });
    expect(typed.statusCode).toBe(201);
    const [row] = await t.owner<{ batch: string; data: Record<string, unknown> }[]>`select batch, data from entries where id = ${typed.json().id}`;
    expect(row).toEqual({ batch: 'EXT26001', data: { stage: 'Granulation', remarks: '', batchTyped: 'Batch EXT26001: not in the linked batch records' } });
    // The flag cannot be sent in the data.
    const forged = await use(await addItem(t, { code: 'TAB-H2', location: 'COMP-T' }), { batch: 'MET26007', data: { stage: 'x', batchTyped: 'no' } });
    expect(forged.statusCode).toBe(201);
    const [f] = await t.owner<{ data: Record<string, unknown> }[]>`select data from entries where id = ${forged.json().id}`;
    expect(f!.data).not.toHaveProperty('batchTyped');
    // The reviewer sees it counted on the period.
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const p = (await call(t.app, c.qa!, 'GET', `/api/equipment/${tablet}/period?fromDay=${day}&toDay=${day}`)).json();
    expect(p.openItems.typedByHand).toBe(1);
  });

  it('a change over may name typed batches with products picked from master data', async () => {
    const granulator = await addItem(t, { code: 'GRN-H3', location: 'GRAN-T' });
    const co = (data: object) => call(t.app, c.op1!, 'POST', `/api/equipment/${granulator}/entries`, { logbookType: 'change_over', activityStart: now(),
      batchTyped: true, data: { checklist: {}, ...data }, signature: sig('op1') });
    expect((await co({ fromBatch: 'EXT26001', fromProduct: 'made up', toBatch: 'MET26007' })).json().problems).toEqual(['Pick the product of batch EXT26001 from master data.']);
    const r = await co({ fromBatch: 'EXT26001', fromProduct: 'FG-MET500 · Metformin tablets 500 mg', toBatch: 'MET26007' });
    expect(r.statusCode).toBe(201);
    const [row] = await t.owner<{ data: Record<string, string> }[]>`select data from entries where id = ${r.json().id}`;
    expect(row!.data).toMatchObject({ fromBatch: 'EXT26001', fromProduct: 'FG-MET500 · Metformin tablets 500 mg', toBatch: 'MET26007',
      toProduct: 'FG-MET500 · Metformin tablets 500 mg', batchTyped: 'From batch EXT26001: not in the linked batch records' });
  });
});
