import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyse } from '../server/routes/dashboard.js';
import { addItem, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Owner 2026-11-13 (D-41): the dashboard's three parts: on-time completion, pending review and approval, exceptions.
let t: TestApp;
const c: Record<string, string> = {};
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  await approve('equipment_cleaning');
});
afterAll(() => t.close());

describe('dashboard (owner 2026-11-13, D-41)', () => {
  it('LB-06: on-time completion counts activities done against those that fell due; a missed limit counts against it', async () => {
    const id = await addItem(t, { code: 'DB-1', cleanHoldHours: 72 });
    const clean = async () => (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
    await clean(); await clean();
    let r = (await call(t.app, c.op1!, 'GET', '/api/dashboard/compliance')).json();
    expect(r.byKind.cleaning).toMatchObject({ total: 2, onTime: 2, missed: 0, percent: 100 });
    // A missed clean hold before the last cleaning: done late (still counted once, not on time).
    await t.owner`insert into overdue_events (equipment_id, kind, due_at, code, name, item_kind, title, description, immediate_action, impact_notes)
      values (${id}, 'clean_hold', now() - interval '1 hour', 'DB-1', 'x', 'equipment', 't', 'd', 'a', 'i')`;
    r = (await call(t.app, c.op1!, 'GET', '/api/dashboard/compliance')).json();
    expect(r.byKind.cleaning).toMatchObject({ total: 2, onTime: 1, missed: 1, percent: 50 });
    expect(r.percent).toBe(50);
  });

  it('LB-14: pending review: an entry waits for the verifier (not its author); the author sees it as his own; senior people see it by department', async () => {
    const id = await addItem(t, { code: 'DB-2' });
    const e = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
    const sup = (await call(t.app, c.sup1!, 'GET', '/api/dashboard/pending')).json();
    expect(sup.forMe.find((p: { id: number }) => p.id === e)).toMatchObject({ kind: 'verify', code: 'DB-2', late: false, by: expect.any(String) });
    const op = (await call(t.app, c.op1!, 'GET', '/api/dashboard/pending')).json();
    expect(op.forMe.find((p: { id: number }) => p.id === e)).toBeUndefined();
    expect(op.mine.find((p: { id: number }) => p.id === e)).toBeDefined();
    expect(op.others).toBeNull();
    await t.owner`update entries set entered_at = now() - interval '9 hours' where id = ${e}`;
    const qa = (await call(t.app, c.qa!, 'GET', '/api/dashboard/pending')).json();
    expect(qa.byDepartment.reduce((a: number, d: { late: number }) => a + d.late, 0)).toBeGreaterThanOrEqual(1);
    expect([...qa.forMe, ...qa.others].find((p: { id: number }) => p.id === e)).toMatchObject({ late: true });
  });

  it('LB-11: the exception analysis flags open severe exceptions, failed checks and repeats, from the abnormal records only', () => {
    const ex = (n: number, extra = {}) => ({ batchNumber: `B${n % 2}`, exceptionId: String(n), type: 'MANUAL_ENTRY_FALLBACK', category: 'MANUAL_ENTRY', severity: 'ALERT',
      step: 's1', stepTitle: 'Dispense actives', description: null, status: 'DISPOSITIONED', disposition: 'NO_IMPACT', disposedAt: null, raisedAt: now(), ...extra });
    const a = analyse({ exceptions: [ex(1), ex(2), ex(3), ex(4, { type: 'IPC_CHECK_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', status: 'OPEN', disposition: null })],
      ipc: [{ batchNumber: 'B1', step: 'c', stepTitle: 'Hardness', checkKind: 'PHYSICAL_CHECK', item: 'Hardness', instrumentCode: null, value: '3.1', unit: 'kP', lower: '4', upper: '8', result: 'FAIL', recordedAt: now() }],
      process: [], alarms: [] });
    expect(a.openExceptions).toBe(1);
    expect(a.abnormalReadings).toBe(1);
    expect(a.insights.map((i) => i.level)).toEqual(expect.arrayContaining(['high', 'medium']));
    expect(a.insights.map((i) => i.text).join(' ')).toMatch(/Repeat: 3 manual weight entries .*Dispense actives/);
    expect(a.insights.map((i) => i.text).join(' ')).toMatch(/in-process check\(s\) failed: B1 Hardness = 3.1 kP \(limits 4 to 8\)/);
  });
});
