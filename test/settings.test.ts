import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY } from '../server/auth.js';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
let admin: string;
let qa: string;
let n = 0;

const baseSettings = { enabled: true, sopRef: 'SOP-CL-001', checklist: ['Previous product removed'], verificationRequired: false };
const signAs = (username: string, password = PASSWORD) => ({ username, password });

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
  it('LB-08: equipment codes are unique, never reused and cannot be changed by the app', async () => {
    const res = await call(t.app, admin, 'POST', '/api/equipment', { code: 'GRN-01', name: 'Granulator', kind: 'equipment', cleanHoldHours: 72 });
    expect(res.statusCode).toBe(201);
    const dup = await call(t.app, admin, 'POST', '/api/equipment', { code: 'grn-01', name: 'Other', kind: 'equipment' });
    expect(dup.statusCode).toBe(409);
    await expect(t.sql`update equipment set code = 'X' where id = ${res.json().id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from equipment where id = ${res.json().id}`).rejects.toThrow(/permission denied/);
  });

  it('LB-18: equipment changes need a reason and are audited with old and new values', async () => {
    const created = (await call(t.app, admin, 'POST', '/api/equipment', { code: 'BLD-01', name: 'Blender', kind: 'equipment' })).json();
    expect((await call(t.app, admin, 'PATCH', `/api/equipment/${created.id}`, { name: 'V-Blender' })).statusCode).toBe(400);
    const res = await call(t.app, admin, 'PATCH', `/api/equipment/${created.id}`, { name: 'V-Blender', cleanHoldHours: 48, reason: 'renamed per SOP' });
    expect(res.json()).toMatchObject({ name: 'V-Blender', cleanHoldHours: 48 });
    const [row] = await t.owner`select * from audit_log where action = 'equipment.updated' and object_id = ${String(created.id)}`;
    expect(row!.old_value.name).toBe('Blender');
    expect(row!.new_value.name).toBe('V-Blender');
    expect(row!.reason).toBe('renamed per SOP');
  });

  it('LB-21: only Admin manages master data; every user can read it', async () => {
    const op = (await login(t.app, 'op1')).cookie;
    expect((await call(t.app, op, 'GET', '/api/equipment')).statusCode).toBe(200);
    expect((await call(t.app, op, 'POST', '/api/products', { code: 'P1', name: 'Paracetamol 500 mg' })).statusCode).toBe(403);
    expect((await call(t.app, admin, 'POST', '/api/products', { code: 'P1', name: 'Paracetamol 500 mg' })).statusCode).toBe(201);
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
    const res = await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    expect(res.statusCode).toBe(200);
    const v = (await typeInfo('equipment_cleaning')).versions.find((x: { id: number }) => x.id === id);
    expect(v).toMatchObject({ status: 'in force', approvedBy: 'QA1' });
  });

  it('LB-24: an approved version cannot be edited; a change needs a new version', async () => {
    const id = await draft('general_log');
    await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    const res = await call(t.app, admin, 'PATCH', `/api/settings/${id}`, { settings: baseSettings, effectiveFrom: new Date().toISOString(), reason: 'x' });
    expect(res.statusCode).toBe(409);
  });

  it('LB-24: a newer approved version supersedes the older one', async () => {
    const v1 = await draft('calibration');
    await call(t.app, qa, 'POST', `/api/settings/${v1}/approve`, signAs('qa1'));
    const v2 = await draft('calibration', { ...baseSettings, sopRef: 'SOP-CAL-002' });
    await call(t.app, qa, 'POST', `/api/settings/${v2}/approve`, signAs('qa1'));
    const versions = (await typeInfo('calibration')).versions;
    expect(versions.find((v: { id: number }) => v.id === v2).status).toBe('in force');
    expect(versions.find((v: { id: number }) => v.id === v1).status).toBe('superseded');
  });

  it('LB-24: a version with a future effective date is approved but not yet in force', async () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const id = await draft('maintenance', baseSettings, future);
    await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    expect((await typeInfo('maintenance')).versions.find((v: { id: number }) => v.id === id).status).toBe('approved, not yet effective');
  });

  it('LB-24: an effective date in the past becomes the approval time', async () => {
    const id = await draft('area_cleaning', baseSettings, '2020-01-01T00:00:00Z');
    await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    const [row] = await t.owner`select s.effective_from, g.signed_at from logbook_settings s
      join signatures g on g.object_type = 'settings' and g.object_id = s.id where s.id = ${id}`;
    expect(Math.abs(new Date(row!.effective_from).getTime() - new Date(row!.signed_at).getTime())).toBeLessThan(5_000);
  });

  it('LB-21: only Admin drafts and only QA approves', async () => {
    expect((await call(t.app, qa, 'POST', '/api/settings', { logbookType: 'general_log', settings: baseSettings, effectiveFrom: new Date().toISOString() })).statusCode).toBe(403);
    const id = await draft('general_log');
    expect((await call(t.app, admin, 'POST', `/api/settings/${id}/approve`, signAs('admin1'))).statusCode).toBe(403);
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
  it('LB-20: signing needs the signer\'s own user ID and password; anything else is refused and audited', async () => {
    const id = await draft('glove_integrity');
    expect((await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1', 'wrong-pass-1'))).statusCode).toBe(401);
    expect((await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('op1'))).statusCode).toBe(401);
    const fails = await t.owner`select 1 from audit_log where action = 'signature.failed' and object_id = ${String(id)}`;
    expect(fails).toHaveLength(2);
    expect(await t.owner`select 1 from signatures where object_id = ${id}`).toHaveLength(0);
  });

  it(`LB-20: ${POLICY.maxFailedAttempts} wrong signing passwords lock the account like failed logins`, async () => {
    const qaId = await seedUser(t.owner, `qa_lock${++n}`, ['qa']);
    const cookie = (await login(t.app, `qa_lock${n}`)).cookie;
    const id = await draft('steriliser_test');
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) {
      await call(t.app, cookie, 'POST', `/api/settings/${id}/approve`, signAs(`qa_lock${n}`, 'wrong-pass-1'));
    }
    expect(await t.owner`select 1 from users where id = ${qaId} and locked_at is not null`).toHaveLength(1);
  });

  it('LB-19: a signature shows printed name, meaning and server time, and is linked to the content by hash', async () => {
    const id = await draft('steriliser_cycle');
    await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    const [sig] = (await call(t.app, qa, 'GET', `/api/settings/${id}/signatures`)).json();
    expect(sig).toMatchObject({ printedName: 'QA1', meaning: 'approved', valid: true });
    expect(Math.abs(Date.now() - new Date(sig.signedAt).getTime())).toBeLessThan(60_000);

    // Changing the signed content behind the application's back breaks the link.
    await t.owner`update logbook_settings set settings = settings || '{"sopRef":"TAMPERED"}' where id = ${id}`;
    const [after] = (await call(t.app, qa, 'GET', `/api/settings/${id}/signatures`)).json();
    expect(after.valid).toBe(false);
  });

  it('LB-19: the same meaning cannot be signed twice, and the app cannot alter or delete signatures', async () => {
    const id = await draft('equipment_use');
    await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'));
    expect((await call(t.app, qa, 'POST', `/api/settings/${id}/approve`, signAs('qa1'))).statusCode).toBe(409);
    await expect(t.sql`update signatures set printed_name = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from signatures`).rejects.toThrow(/permission denied/);
    await expect(t.sql`insert into signatures (object_type, object_id, user_id, printed_name, meaning, content_hash, signed_at)
                       values ('settings', 1, 1, 'x', 'reviewed', 'h', now() - interval '1 day')`).rejects.toThrow(/permission denied/);
  });

  it('LB-20: Admin can never sign, even when also holding QA', async () => {
    await seedUser(t.owner, `adminqa${++n}`, ['admin', 'qa']);
    const cookie = (await login(t.app, `adminqa${n}`)).cookie;
    const id = await draft('general_log');
    expect((await call(t.app, cookie, 'POST', `/api/settings/${id}/approve`, signAs(`adminqa${n}`))).statusCode).toBe(403);
  });
});
