import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY } from '../server/auth.js';
import { TEST_PROOF_KEY, call, directory, freshApp, login, proofFor, seedUser, type TestApp, addItem, addProduct, changeItem } from './helpers.js';
import { PROOF_SECONDS, makeProof } from '../server/signatures.js';

let t: TestApp;
let admin: string;
let qa: string;
let n = 0;

const baseSettings = { enabled: true, sopRef: 'SOP-CL-001', checklist: ['Previous product removed'], verificationRequired: false };
// The content hash the approver was shown, as the UI sends it.
const shownHash = async (id: number) => {
  const types = (await call(t.app, admin, 'GET', '/api/logbook-types')).json();
  for (const ty of types) for (const v of ty.versions) if (v.id === id) return v.contentHash as string;
  throw new Error('version not found');
};
const approve = async (cookie: string, id: number, username: string, proof = proofFor(username)) =>
  call(t.app, cookie, 'POST', `/api/settings/${id}/approve`, { proof, contentHash: await shownHash(id) });

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'admin1', ['admin']);
  await seedUser(t.owner, 'qa1', ['qa']);
  await seedUser(t.owner, 'op1', ['operator']);
  admin = (await login(t.app, 'admin1')).cookie;
  qa = (await login(t.app, 'qa1')).cookie;
});
afterAll(() => t.close());

async function draft(type = 'equipment_cleaning', settings: object = baseSettings, effectiveFrom = new Date().toISOString()) {
  const res = await call(t.app, admin, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom });
  expect(res.statusCode).toBe(201);
  return res.json().id as number;
}
const typeInfo = async (key: string) =>
  (await call(t.app, qa, 'GET', '/api/logbook-types')).json().find((x: { key: string }) => x.key === key);

describe('master data', () => {
  it('LB-08: an item\'s code cannot be changed or the item deleted by the app', async () => {
    const id = await addItem(t, { code: 'GRN-01', name: 'Granulator', cleanHoldHours: 72 });
    await expect(t.sql`update equipment set code = 'X' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from equipment where id = ${id}`).rejects.toThrow(/permission denied/);
    // Name and active state are master data now (D-29): the app cannot write them here.
    await expect(t.sql`update equipment set name = 'X' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`update equipment set active = false where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('LB-18: changes to an item\'s Logbook settings need a reason and are audited with old and new values', async () => {
    const id = await addItem(t, { code: 'BLD-01', name: 'Blender' });
    expect((await call(t.app, admin, 'PATCH', `/api/equipment/${id}`, { cleanHoldHours: 48 })).statusCode).toBe(400);
    const res = await call(t.app, admin, 'PATCH', `/api/equipment/${id}`, { name: 'Ignored', cleanHoldHours: 48, reason: 'per SOP' });
    expect(res.json()).toMatchObject({ name: 'Blender', cleanHoldHours: 48 });
    const [row] = await t.owner`select * from audit_log where action = 'equipment.updated' and object_id = ${String(id)}`;
    expect(row!.old_value.cleanHoldHours).toBe(null);
    expect(row!.new_value.cleanHoldHours).toBe(48);
    expect(row!.reason).toBe('per SOP');
  });

  it('LB-21: only Admin changes an item\'s Logbook settings; every user can read items and products', async () => {
    const id = await addItem(t, { code: 'MIX-02' });
    await addProduct(t, 'P1', 'Paracetamol 500 mg');
    const op = (await login(t.app, 'op1')).cookie;
    expect((await call(t.app, op, 'GET', '/api/equipment')).statusCode).toBe(200);
    expect((await call(t.app, op, 'GET', '/api/products')).json().map((p: { code: string }) => p.code)).toContain('P1');
    expect((await call(t.app, op, 'PATCH', `/api/equipment/${id}`, { sterile: true, reason: 'x' })).statusCode).toBe(403);
  });

  it('PL-08: items show their master data live: a rename or a move in core shows at once; nothing is kept as a copy', async () => {
    const id = await addItem(t, { code: 'FBD-07', name: 'Fluid bed dryer', location: 'GRAN-1' });
    changeItem(t, 'FBD-07', { name: 'Fluid bed dryer 7', room: 'GRAN-2' });
    const item = (await call(t.app, admin, 'GET', '/api/equipment')).json().find((e: { id: number }) => e.id === id);
    expect(item).toMatchObject({ code: 'FBD-07', name: 'Fluid bed dryer 7', location: 'GRAN-2', version: 2 });
  });

  it('PL-08: when the master-data link is cut, items and products show "connection off" and nothing is served from a copy', async () => {
    await addItem(t, { code: 'CUT-01' });
    t.master.cut = true;
    try {
      for (const url of ['/api/equipment', '/api/products']) {
        const res = await call(t.app, admin, 'GET', url);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'connection_off', message: 'Connection to master data is off. Ask your administrator.' });
      }
      // The audit trail stays readable: it needs master data only for names.
      expect((await call(t.app, admin, 'GET', '/api/audit')).statusCode).toBe(200);
    } finally {
      t.master.cut = false;
    }
  });


  it('the single site record is set by Admin and audited', async () => {
    const res = await call(t.app, admin, 'PUT', '/api/site', { name: 'Plant 1', code: 'PL1', reason: 'initial setup' });
    expect(res.statusCode).toBe(200);
    expect((await call(t.app, qa, 'GET', '/api/site')).json()).toEqual({ name: 'Plant 1', code: 'PL1' });
    await expect(t.sql`insert into site (id, name, code) values (2, 'Plant 2', 'PL2')`).rejects.toThrow();
  });
});

describe('logbook settings (LB-24)', () => {
  it('LB-24: a draft is not in force until QA approves it with an e-signature', async () => {
    const id = await draft();
    expect((await typeInfo('equipment_cleaning')).versions.find((v: { id: number }) => v.id === id).status).toBe('draft');
    const res = await approve(qa, id, 'qa1');
    expect(res.statusCode).toBe(200);
    const v = (await typeInfo('equipment_cleaning')).versions.find((x: { id: number }) => x.id === id);
    expect(v).toMatchObject({ status: 'in force', approvedBy: 'QA1' });
  });

  it('LB-24: an approved version cannot be edited; a change needs a new version', async () => {
    const id = await draft('general_log');
    await approve(qa, id, 'qa1');
    const res = await call(t.app, admin, 'PATCH', `/api/settings/${id}`, { settings: baseSettings, effectiveFrom: new Date().toISOString(), reason: 'x' });
    expect(res.statusCode).toBe(409);
  });

  it('LB-24: a newer approved version supersedes the older one', async () => {
    const v1 = await draft('calibration');
    await approve(qa, v1, 'qa1');
    const v2 = await draft('calibration', { ...baseSettings, sopRef: 'SOP-CAL-002' });
    await approve(qa, v2, 'qa1');
    const versions = (await typeInfo('calibration')).versions;
    expect(versions.find((v: { id: number }) => v.id === v2).status).toBe('in force');
    expect(versions.find((v: { id: number }) => v.id === v1).status).toBe('superseded');
  });

  it('LB-24: a version with a future effective date is approved but not yet in force', async () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const id = await draft('maintenance', baseSettings, future);
    await approve(qa, id, 'qa1');
    expect((await typeInfo('maintenance')).versions.find((v: { id: number }) => v.id === id).status).toBe('approved, not yet effective');
  });

  it('LB-24: an effective date in the past becomes the approval time', async () => {
    const id = await draft('area_cleaning', baseSettings, '2020-01-01T00:00:00Z');
    await approve(qa, id, 'qa1');
    const [row] = await t.owner`select s.effective_from, g.signed_at from logbook_settings s
      join signatures g on g.object_type = 'settings' and g.object_id = s.id where s.id = ${id}`;
    expect(Math.abs(new Date(row!.effective_from).getTime() - new Date(row!.signed_at).getTime())).toBeLessThan(5_000);
  });

  it('LB-21: only Admin drafts and only QA approves', async () => {
    expect((await call(t.app, qa, 'POST', '/api/settings', { logbookType: 'general_log', settings: baseSettings, effectiveFrom: new Date().toISOString() })).statusCode).toBe(403);
    const id = await draft('general_log');
    expect((await approve(admin, id, 'admin1')).statusCode).toBe(403);
  });

  it('LB-16: pressure points can only be set up as non-critical with a CCS reference', async () => {
    const bad = await call(t.app, admin, 'POST', '/api/settings', {
      logbookType: 'pressure_reading',
      settings: { ...baseSettings, pressurePoints: [{ name: 'Fill room / corridor', critical: true, ccsRef: 'CCS-4', min: 10, max: 30 }] },
      effectiveFrom: new Date().toISOString(),
    });
    expect(bad.statusCode).toBe(400);
    await draft('pressure_reading', { ...baseSettings, pressurePoints: [{ name: 'Wash / corridor', critical: false, ccsRef: 'CCS-4.2', min: 10, max: 30 }] });
  });
});

describe('e-signatures (LB-19, LB-20)', () => {
  it('PL-05: a signature needs core\'s fresh re-authentication of the signed-in person; anything else is refused and audited', async () => {
    const id = await draft('glove_integrity');
    expect((await approve(qa, id, 'op1')).statusCode).toBe(401);                              // another person
    expect((await approve(qa, id, 'qa1', 'made-up.proof')).statusCode).toBe(401);             // not made by /cb
    const forged = makeProof(Buffer.alloc(32, 9), { sub: directory.get('qa1')!.sub, roles: ['qa'] }, ['approved']);
    expect((await approve(qa, id, 'qa1', forged)).statusCode).toBe(401);                       // wrong key
    expect((await approve(qa, id, 'qa1', proofFor('qa1', Date.now() - (PROOF_SECONDS + 1) * 1000))).statusCode).toBe(401); // too old
    const fails = await t.owner`select reason from audit_log where action = 'signature.failed' and object_id = ${String(id)} order by id`;
    expect(fails.map((f) => f.reason)).toEqual(['meaning approved: signed by another person', 'meaning approved: invalid proof',
      'meaning approved: invalid proof', 'meaning approved: proof expired']);
    expect(await t.owner`select 1 from signatures where object_id = ${id}`).toHaveLength(0);
  });

  it('PL-05: a signing proof is used once, only for the meaning it was made for, and refused if the signer\'s rights changed at core', async () => {
    const id = await draft('steriliser_test');
    const proof = proofFor('qa1');
    expect((await approve(qa, id, 'qa1', proof)).statusCode).toBe(200);
    const again = await draft('general_log');
    expect((await approve(qa, again, 'qa1', proof)).statusCode).toBe(401);
    const changed = makeProof(TEST_PROOF_KEY, { sub: directory.get('qa1')!.sub, roles: ['qa', 'supervisor'] }, ['approved']);
    expect((await approve(qa, again, 'qa1', proofFor('qa1', undefined, ['verified']))).statusCode).toBe(401);   // made for another meaning
    expect((await approve(qa, again, 'qa1', changed)).statusCode).toBe(401);
  });

  it('LB-19: a signature shows printed name, meaning and server time, and is linked to the content by hash', async () => {
    const id = await draft('steriliser_cycle');
    await approve(qa, id, 'qa1');
    const [sig] = (await call(t.app, qa, 'GET', `/api/settings/${id}/signatures`)).json();
    expect(sig).toMatchObject({ printedName: 'QA1', meaning: 'approved', valid: true });
    expect(Math.abs(Date.now() - new Date(sig.signedAt).getTime())).toBeLessThan(60_000);

    // The database refuses changes to an approved version, even to the application role.
    await expect(t.sql`update logbook_settings set settings = settings || '{"sopRef":"X"}' where id = ${id}`).rejects.toThrow(/approved/);
    // Tampering behind every control (trigger switched off by the table owner) still breaks the link.
    await t.owner.begin(async (tx) => {
      await tx`alter table logbook_settings disable trigger logbook_settings_frozen_when_approved`;
      await tx`update logbook_settings set settings = settings || '{"sopRef":"TAMPERED"}' where id = ${id}`;
      await tx`alter table logbook_settings enable trigger logbook_settings_frozen_when_approved`;
    });
    const [after] = (await call(t.app, qa, 'GET', `/api/settings/${id}/signatures`)).json();
    expect(after.valid).toBe(false);
  });

  it('LB-19: the same meaning cannot be signed twice, and the app cannot alter or delete signatures', async () => {
    const id = await draft('equipment_use');
    await approve(qa, id, 'qa1');
    expect((await approve(qa, id, 'qa1')).statusCode).toBe(409);
    await expect(t.sql`update signatures set printed_name = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from signatures`).rejects.toThrow(/permission denied/);
    await expect(t.sql`insert into signatures (object_type, object_id, user_id, printed_name, meaning, content_hash, signed_at)
                       values ('settings', 1, 1, 'x', 'reviewed', 'h', now() - interval '1 day')`).rejects.toThrow(/permission denied/);
  });

  it('LB-20: Admin can never sign, even when also holding QA', async () => {
    await seedUser(t.owner, `adminqa${++n}`, ['admin', 'qa']);
    const cookie = (await login(t.app, `adminqa${n}`)).cookie;
    const id = await draft('general_log');
    expect((await approve(cookie, id, `adminqa${n}`)).statusCode).toBe(403);
  });
});

describe('review fixes (S2)', () => {
  it('LB-19: QA cannot approve content that changed after it was shown', async () => {
    const id = await draft('general_log');
    const hash = await shownHash(id);
    await call(t.app, admin, 'PATCH', `/api/settings/${id}`, {
      settings: { ...baseSettings, checklist: ['Changed after QA opened the dialog'] },
      effectiveFrom: new Date().toISOString(),
      reason: 'late edit',
    });
    const res = await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, { proof: proofFor('qa1'), contentHash: hash });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('content_changed');
  });

  it('LB-24: pressure limits must have min not above max', async () => {
    const res = await call(t.app, admin, 'POST', '/api/settings', {
      logbookType: 'pressure_reading',
      settings: { ...baseSettings, pressurePoints: [{ name: 'A/B', critical: false, ccsRef: 'CCS-1', min: 30, max: 10 }] },
      effectiveFrom: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('LB-08: equipment codes are unique regardless of case, also at database level', async () => {
    await addItem(t, { code: 'TAB-77', name: 'Press' });
    await expect(t.sql`insert into equipment (code, name, kind) values ('tab-77', 'Other', 'equipment')`).rejects.toThrow(/duplicate key/);
  });

});
