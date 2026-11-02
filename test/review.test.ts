import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, seedUser, type TestApp, proofFor, addItem, addProduct } from './helpers.js';
import { runs } from '../server/routes/exports.js';

let t: TestApp;
const c: Record<string, string> = {};
let mixer: number;
let product: number;
const sig = (username: string) => ({ proof: proofFor(username) });
const now = () => new Date().toISOString();
// Plant-local days covering yesterday to tomorrow.
const dayOf = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const fromDay = dayOf(-1);
const toDay = dayOf(1);
const range = `fromDay=${fromDay}&toDay=${toDay}`;

async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const v = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number }[] }) => x.versions).find((x: { id: number }) => x.id === id);
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: v.contentHash });
}
const entry = (who: string, body: object) => call(t.app, c[who]!, 'POST', `/api/equipment/${mixer}/entries`, body);
const versionsOf = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/entries/${id}/versions`)).json();
const period = async () => (await call(t.app, c.qa!, 'GET', `/api/equipment/${mixer}/period?${range}`)).json();

let cleaningId: number;
let useId: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [k, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1']] as const) c[k] = (await login(t.app, u)).cookie;
  await call(t.app, c.admin!, 'PUT', '/api/site', { name: 'Plant One', code: 'P1', reason: 'setup' });
  mixer = (await addItem(t, { code: 'RMG-9', name: 'Mixer', kind: 'equipment' }));
  product = await addProduct(t, 'PX', 'Product X');
  for (const type of ['equipment_use', 'equipment_cleaning', 'maintenance']) await approve(type);
  cleaningId = (await entry('op1', { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') })).json().id;
  const v = (await versionsOf(cleaningId))[0];
  await call(t.app, c.sup1!, 'POST', `/api/entries/${cleaningId}/verify`, { ...sig('sup1'), contentHash: v.contentHash });
  useId = (await entry('op1', { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: 'B-777', data: { stage: 'Mixing' } })).json().id;
  await call(t.app, c.op1!, 'POST', `/api/entries/${useId}/complete`, { activityEnd: now() });
});
afterAll(() => t.close());

describe('QA period review (LB-25)', () => {
  it('LB-25: the period view shows entries with history, open items and the audit trail', async () => {
    const p = await period();
    expect(p.entries.length).toBe(3); // cleaning v1, use v1 (superseded), use v2
    expect(p.audit.some((a: { action: string }) => a.action === 'signed.verified')).toBe(true);
    expect(p.openItems).toMatchObject({ notFinishedOrNotVerified: 0, late: 0, corrected: 0 });
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('LB-25: QA signs "Reviewed" for exactly what was shown; a later correction marks the review superseded', async () => {
    const p = await period();
    const res = await call(t.app, c.qa!, 'POST', `/api/equipment/${mixer}/reviews`, { fromDay, toDay, ...sig('qa1'), contentHash: p.contentHash });
    expect(res.statusCode).toBe(201);
    let reviews = (await call(t.app, c.qa!, 'GET', `/api/equipment/${mixer}/reviews`)).json();
    expect(reviews[0]).toMatchObject({ reviewedBy: 'QA1', superseded: false, valid: true });

    const latest = (await versionsOf(useId)).at(-1);
    const corr = await call(t.app, c.op1!, 'POST', `/api/entries/${latest.id}/correct`, {
      activityStart: latest.activityStart, activityEnd: latest.activityEnd, batch: 'B-778', data: latest.data, reason: 'typo', signature: sig('op1'),
    });
    expect(corr.statusCode).toBe(200);
    reviews = (await call(t.app, c.qa!, 'GET', `/api/equipment/${mixer}/reviews`)).json();
    expect(reviews[0].superseded).toBe(true);
  });

  it('LB-25: signing a review refuses content that changed after it was shown', async () => {
    const p = await period();
    await entry('op1', { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {} }, signature: sig('op1') });
    const res = await call(t.app, c.qa!, 'POST', `/api/equipment/${mixer}/reviews`, { fromDay, toDay, ...sig('qa1'), contentHash: p.contentHash });
    expect(res.json().error).toBe('content_changed');
  });

  it('LB-21: only QA signs reviews; operators cannot see review data', async () => {
    const p = await period();
    expect((await call(t.app, c.sup1!, 'POST', `/api/equipment/${mixer}/reviews`, { fromDay, toDay, ...sig('sup1'), contentHash: p.contentHash })).statusCode).toBe(403);
    expect((await call(t.app, c.op1!, 'GET', `/api/equipment/${mixer}/period?${range}`)).statusCode).toBe(403);
  });
});

describe('batch view and audit trail (LB-22, LB-18)', () => {
  it('LB-22: the batch view lists every entry and version that referenced the batch, with audit rows', async () => {
    const res = (await call(t.app, c.qa!, 'GET', '/api/batches/b-777')).json();
    expect(res.entries.map((e: { version: number }) => e.version)).toEqual([1, 2, 3]);
    expect(res.entries.at(-1)).toMatchObject({ batch: 'B-778', change: 'corrected', equipmentCode: 'RMG-9' });
    expect(res.audit.some((a: { action: string }) => a.action === 'entry.corrected')).toBe(true);
  });

  it('LB-18: the audit trail can be filtered by object and user; only QA and Admin can read it', async () => {
    const rows = (await call(t.app, c.qa!, 'GET', `/api/audit?user=op1&objectType=entry`)).json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { actor: string; objectType: string }) => r.actor === 'OP1' && r.objectType === 'entry')).toBe(true);
    expect((await call(t.app, c.op1!, 'GET', '/api/audit')).statusCode).toBe(403);
  });
});

describe('exports (LB-22)', () => {
  it('LB-22: the CSV contains every version, the correction note, signatures and the audit trail', async () => {
    const res = await call(t.app, c.qa!, 'GET', `/api/export/batch.csv?batch=B-777`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const text = res.body;
    expect(text).toContain('Superseded by version 3 (corrected)');
    expect(text).toContain('Corrected: typo');
    expect(text).toContain('"audit"');
    expect(text.split('\r\n').filter((l) => l.startsWith('"entry"'))).toHaveLength(3);
  });

  it('LB-22: the PDF is a readable copy of a logbook period', async () => {
    const res = await call(t.app, c.qa!, 'GET', `/api/export/period.pdf?equipmentId=${mixer}&${range}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(2000);
  });

  it('LB-22: spreadsheet formulas in entered text are neutralised in the CSV', async () => {
    const id = (await entry('op1', { logbookType: 'equipment_cleaning', activityStart: now(), data: { cleaningType: 'major', checklist: {}, remarks: '=HYPERLINK("x")' }, signature: sig('op1') })).json().id;
    expect(id).toBeGreaterThan(0);
    const res = await call(t.app, c.qa!, 'GET', `/api/export/period.csv?equipmentId=${mixer}&${range}`);
    expect(res.body).not.toMatch(/(^|,)"=/m);
  });
});

describe('review fixes (S5)', () => {
  it('LB-25: an entry corrected into another period still shows in its original period', async () => {
    const id = (await entry('op1', { logbookType: 'maintenance', activityStart: now(), data: { kind: 'preventive', description: 'Lubrication' }, signature: sig('op1') })).json().id;
    const v = (await versionsOf(id))[0];
    const earlier = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const corr = await call(t.app, c.op1!, 'POST', `/api/entries/${id}/correct`, { activityStart: earlier, activityEnd: earlier, data: v.data, reason: 'wrong date', lateReason: 'from paper', signature: sig('op1') });
    expect(corr.statusCode).toBe(200);
    const p = await period();
    expect(p.entries.filter((e: { entryId: number }) => e.entryId === v.entryId)).toHaveLength(2);
  });

  it('LB-25: periods are limited in length', async () => {
    const res = await call(t.app, c.qa!, 'GET', `/api/equipment/${mixer}/period?fromDay=2000-01-01&toDay=2026-01-01`);
    expect(res.statusCode).toBe(400);
  });

  it('LB-19: a tampered review shows as invalid', async () => {
    const [r] = await t.owner`select id from reviews order by id limit 1`;
    await t.owner`update reviews set content = jsonb_set(content, '{versions}', '[]') where id = ${r!.id}`;
    const reviews = (await call(t.app, c.qa!, 'GET', `/api/equipment/${mixer}/reviews`)).json();
    expect(reviews.find((x: { id: number }) => x.id === Number(r!.id)).valid).toBe(false);
  });

  it('LB-22: PDF text uses embedded fonts; symbols use the math font; unknown characters stay visible', () => {
    expect(runs('रमेश 5 µm')).toEqual([{ text: 'रमेश 5 µm' }]);
    expect(runs('a ≤ b')).toEqual([{ text: 'a ' }, { text: '≤', font: 'NotoMath' }, { text: ' b' }]);
    expect(runs('ok \u{1F600}')).toEqual([{ text: 'ok [U+1F600]' }]);
  });

  it('LB-22: CSV cells starting with a tab or spaces before a formula are neutralised', async () => {
    await entry('op1', { logbookType: 'equipment_use', activityStart: now(), productId: product, batch: '\t=1+1', data: {} }).catch(() => undefined);
    const res = await call(t.app, c.qa!, 'GET', `/api/export/batch.csv?batch=${encodeURIComponent('\t=1+1')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/,"\t=/);
  });

  it('LB-22: the period export includes the QA reviews', async () => {
    const res = await call(t.app, c.qa!, 'GET', `/api/export/period.csv?equipmentId=${mixer}&${range}`);
    expect(res.body).toContain('"review"');
    expect(res.body).toMatch(/Reviewed by QA1/);
  });
});
