import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addItem, call, directory, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Engineering work orders (owner decision, 22 Nov 2026): raise, assign, start, record the work, Done (doer signs),
// Close (a second person signs); permissions per employee; a breakdown's work order is closed before its release.

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
const sig = (u: string) => ({ proof: proofFor(u) });
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const get = async (who: string, url: string) => (await call(t.app, c[who]!, 'GET', url)).json();
const post = (who: string, url: string, body: object = {}) => call(t.app, c[who]!, 'POST', url, body);
const hashOf = async (who: string, id: number, key: 'doneHash' | 'closeHash') => (await get(who, `/api/workorders/${id}`))[key];
let item: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']], ['eng2', ['engineering']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
  }
  directory.get('sup1')!.permissions.push('logbook.workorder.raise');
  directory.get('eng1')!.permissions.push('logbook.workorder.do');
  directory.get('eng2')!.permissions.push('logbook.workorder.do', 'logbook.workorder.close');
  directory.get('qa1')!.permissions.push('logbook.workorder.close');
  for (const u of ['admin', 'qa1', 'op1', 'sup1', 'eng1', 'eng2']) c[u] = (await login(t.app, u)).cookie;
  item = await addItem(t, { code: 'WO-A', name: 'Tablet press', kind: 'equipment', location: 'Block A' });
  const settings = await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: 'maintenance', settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: new Date().toISOString() });
  const sid = settings.json().id;
  const h = (await get('qa1', '/api/logbook-types')).flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions).find((v: { id: number }) => v.id === sid).contentHash;
  await post('qa1', `/api/settings/${sid}/approve`, { ...sig('qa1'), contentHash: h });
});
afterAll(() => t.close());

describe('work orders (D-86)', () => {
  it('LB-21: only a person holding logbook.workorder.raise raises; the number runs WO-yy-nnnn', async () => {
    const body = { equipmentId: item, kind: 'preventive', title: 'Quarterly service', targetDate: '2030-01-31' };
    expect((await post('op1', '/api/workorders', body)).statusCode).toBe(403);
    expect((await post('sup1', '/api/workorders', { equipmentId: item })).statusCode).toBe(400);
    const a = (await post('sup1', '/api/workorders', body)).json();
    const b = (await post('sup1', '/api/workorders', { ...body, kind: 'other', title: 'Paint rail' })).json();
    const yy = String(new Date().getUTCFullYear() % 100).padStart(2, '0');
    expect(a.number).toBe(`WO-${yy}-0001`);
    expect(b.number).toBe(`WO-${yy}-0002`);
    const list = await get('op1', `/api/workorders?equipmentId=${item}`);
    expect(list.items.map((w: { number: string }) => w.number)).toEqual([b.number, a.number]);
    expect(list.items[1]).toMatchObject({ status: 'open', statusLabel: 'Open', kindLabel: 'Preventive maintenance', overdue: false, name: 'Tablet press' });
    expect((await get('op1', '/api/workorders?status=closed')).items).toEqual([]);
  });

  it('LB-06: assign from the people list, start, record the work, Done by the doer, Close by a second person', async () => {
    const id = (await post('sup1', '/api/workorders', { equipmentId: item, kind: 'preventive', title: 'Lubricate', targetDate: '2020-01-01' })).json().id;
    expect((await get('op1', `/api/workorders/${id}`)).overdue).toBe(true);
    const people = await get('op1', '/api/workorders/people');
    expect(people.map((p: { name: string }) => p.name)).toContain('ENG1');
    expect((await post('sup1', `/api/workorders/${id}/assign`, { userId: 99999 })).statusCode).toBe(400);
    expect((await post('sup1', `/api/workorders/${id}/assign`, { userId: ids.eng1 })).statusCode).toBe(200);
    // Not the assigned person, and no permission.
    expect((await post('eng2', `/api/workorders/${id}/start`)).json().problems[0]).toMatch(/is assigned to ENG1/);
    expect((await post('op1', `/api/workorders/${id}/start`)).statusCode).toBe(403);
    expect((await post('eng1', `/api/workorders/${id}/done`, { ...sig('eng1'), contentHash: await hashOf('eng1', id, 'doneHash') })).json().problems[0]).toMatch(/is open/);
    expect((await post('eng1', `/api/workorders/${id}/start`)).statusCode).toBe(200);
    expect((await post('eng1', `/api/workorders/${id}/done`, { ...sig('eng1'), contentHash: await hashOf('eng1', id, 'doneHash') })).json().problems).toEqual(['Record the work done and the time spent first.']);
    expect((await post('eng1', `/api/workorders/${id}/work`, { workDone: 'Lubricated, checked', timeMinutes: 90, parts: [{ name: 'Grease', quantity: 2 }] })).statusCode).toBe(200);
    // The doer signs; the signature covers the work as recorded.
    expect((await post('eng1', `/api/workorders/${id}/done`, { ...sig('eng1'), contentHash: 'a'.repeat(64) })).statusCode).toBe(409);
    expect((await post('eng1', `/api/workorders/${id}/done`, { ...sig('eng1'), contentHash: await hashOf('eng1', id, 'doneHash') })).statusCode).toBe(200);
    expect((await get('op1', `/api/workorders/${id}`))).toMatchObject({ status: 'done', doneBy: 'ENG1', overdue: false, timeText: '1 h 30 min', partsText: '2 × Grease' });
    // Closing: a second person with the close permission, never the doer.
    expect((await post('eng1', `/api/workorders/${id}/close`, { ...sig('eng1'), contentHash: await hashOf('eng1', id, 'closeHash') })).statusCode).toBe(403);
    directory.get('eng1')!.permissions.push('logbook.workorder.close');
    const doerTry = await call(t.app, (await login(t.app, 'eng1')).cookie, 'POST', `/api/workorders/${id}/close`, { ...sig('eng1'), contentHash: await hashOf('eng1', id, 'closeHash') });
    expect(doerTry.json().problems).toEqual(['A second person closes the work order: not the person who did the work.']);
    expect((await post('qa1', `/api/workorders/${id}/close`, { ...sig('qa1'), contentHash: await hashOf('qa1', id, 'closeHash') })).statusCode).toBe(200);
    const d = await get('op1', `/api/workorders/${id}`);
    expect(d).toMatchObject({ status: 'closed', closedBy: 'QA1' });
    expect(d.signatures.map((s: { meaning: string; by: string }) => `${s.meaning}: ${s.by}`)).toEqual(['Performed: ENG1', 'Closed: QA1']);
    expect(d.history.map((h: { text: string }) => h.text).join('|')).toMatch(/Work order raised.*\|Work order assigned: Assigned to ENG1\|Work started\|Work done recorded: Time spent 1 h 30 min\|Work order marked done\|Signed: Performed\|Work order closed\|Signed: Closed/);
    expect((await post('sup1', `/api/workorders/${id}/assign`, { userId: ids.eng2 })).json().problems[0]).toMatch(/closed: it cannot be given/);
    directory.get('eng1')!.permissions.pop();
  });

  it('LB-22: the PDF copy carries the year, words, the signatures and the audit trail', async () => {
    const id = (await get('op1', '/api/workorders?status=closed')).items[0].id;
    const res = await call(t.app, c.op1!, 'GET', `/api/workorders/${id}/export.pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // A closed work order with its whole audit trail fits one page.
    expect((res.rawPayload.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(1);
    expect((await call(t.app, c.op1!, 'GET', '/api/workorders.csv')).payload).toContain('Lubricate');
  });

  it('LB-06: a breakdown work order links both ways, shows in the register, and must be closed before the release', async () => {
    const eq = await addItem(t, { code: 'WO-B', name: 'Mixer', kind: 'equipment', location: 'Block A' });
    const e = (await post('eng1', `/api/equipment/${eq}/entries`, { logbookType: 'maintenance', activityStart: ago(30), activityEnd: ago(5), lateReason: 'after the repair',
      data: { kind: 'breakdown', description: 'Motor trips', occurredAt: ago(60), reportedBy: 'Shift A', failureCategory: 'electrical', rootCause: 'Contactor', workDone: 'Replaced', partsNone: true, doneBy: 'in_house', postRepairChecks: 'ok' },
      signature: sig('eng1') })).json();
    const v = async () => (await get('qa1', `/api/entries/${e.id}/versions`)).at(-1);
    expect((await post('qa1', `/api/entries/${e.id}/verify`, { ...sig('qa1'), contentHash: (await v()).contentHash })).statusCode).toBe(200);
    const reg = async () => (await get('op1', `/api/breakdowns?fromDay=${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}&toDay=${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}`)).items.find((b: { equipmentId: number }) => b.equipmentId === eq);
    const entryId = (await reg()).entryId;
    expect((await post('sup1', '/api/workorders', { equipmentId: eq, kind: 'breakdown', title: 'Motor trips', entryId: 99999 })).json().problems).toEqual(['That breakdown is not an entry of this item.']);
    const wo = (await post('sup1', '/api/workorders', { equipmentId: eq, kind: 'breakdown', title: 'Motor trips', entryId })).json();
    expect((await post('sup1', '/api/workorders', { equipmentId: eq, kind: 'breakdown', title: 'Again', entryId })).json().problems[0]).toMatch(/has work order WO-\d\d-\d{4} already/);
    expect((await reg())).toMatchObject({ workOrderRef: wo.number, workOrder: { number: wo.number, status: 'open' } });
    expect((await get('op1', `/api/workorders/${wo.id}`)).entryId).toBe(entryId);
    const release = async () => post('qa1', `/api/entries/${e.id}/release`, { ...sig('qa1'), contentHash: (await v()).contentHash });
    // MED-10: released by a QA person other than the verifier.
    await seedUser(t.owner, 'qa2', ['qa']);
    directory.get('qa2')!.permissions.push('logbook.breakdown.release');
    c.qa = (await login(t.app, 'qa2')).cookie;
    const refused = await call(t.app, c.qa, 'POST', `/api/entries/${e.id}/release`, { ...sig('qa2'), contentHash: (await v()).contentHash });
    expect(refused.json().problems).toEqual([`Work order ${wo.number} of this breakdown is not closed yet: close it first.`]);
    await post('eng1', `/api/workorders/${wo.id}/start`);
    await post('eng1', `/api/workorders/${wo.id}/work`, { workDone: 'Replaced contactor', timeMinutes: 45 });
    await post('eng1', `/api/workorders/${wo.id}/done`, { ...sig('eng1'), contentHash: await hashOf('eng1', wo.id, 'doneHash') });
    expect((await post('qa1', `/api/workorders/${wo.id}/close`, { ...sig('qa1'), contentHash: await hashOf('qa1', wo.id, 'closeHash') })).statusCode).toBe(200);
    expect((await call(t.app, c.qa, 'POST', `/api/entries/${e.id}/release`, { ...sig('qa2'), contentHash: (await v()).contentHash })).statusCode).toBe(200);
    void release;
  });
});
