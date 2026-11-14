import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { addItem, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// Owner 2026-11-14 (D-44): documents (PDF, PNG, JPEG; 10 MB each, 10 per entry) attached to calibration, requalification
// and maintenance entries, kept in the database with their SHA-256, downloadable, listed on the entry and in the item
// history; a correction keeps them; a document added later needs a reason.

let t: TestApp;
const c: Record<string, string> = {};
let n = 0;
const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n%certificate CAL-778\n'), Buffer.alloc(300, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const upload = (who: string, versionId: number, file: Buffer, body: object = {}) =>
  call(t.app, c[who]!, 'POST', `/api/entries/${versionId}/attachments`, { fileName: 'certificate.pdf', mediaType: 'application/pdf', dataBase64: file.toString('base64'), ...body });
async function approve(type: string) {
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false }, effectiveFrom: now() })).json().id;
  const hash = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions)
    .find((v: { id: number }) => v.id === id).contentHash;
  await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: hash });
}
const newItem = (body: object = {}) => addItem(t, { code: `AT-${++n}`, location: 'QC-1', ...body });
const calibration = async (id: number) => {
  const r = await call(t.app, c.eng1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'calibration', activityStart: now(), data: { result: 'pass', nextDue: '2027-04-01', certificateRef: 'CAL-778' }, signature: sig('eng1') });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: number; entryId: number };
};
const entriesOf = async (id: number) => (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/entries`)).json();

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['sup1', ['supervisor']], ['eng1', ['engineering']], ['eng2', ['engineering']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['sup1', 'sup1'], ['eng1', 'eng1'], ['eng2', 'eng2']] as const) c[key] = (await login(t.app, u)).cookie;
  for (const type of ['equipment_cleaning', 'maintenance', 'calibration', 'requalification', 'general_log']) await approve(type);
});
afterAll(() => t.close());

describe('documents on calibration, requalification and maintenance entries (D-44)', () => {
  it('LB-02: the certificate is attached with the calibration entry, listed on the entry and in the history, downloadable with its type and name', async () => {
    const id = await newItem({ kind: 'instrument' });
    const e = await calibration(id);
    const r = await upload('eng1', e.id, PDF, { fileName: 'CAL-778 certificate.pdf' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ fileName: 'CAL-778 certificate.pdf', mediaType: 'application/pdf', size: PDF.length, sha256: sha(PDF) });
    const [entry] = await entriesOf(id);
    expect(entry.attachments).toEqual([expect.objectContaining({ id: r.json().id, fileName: 'CAL-778 certificate.pdf', size: PDF.length, sha256: sha(PDF), uploadedBy: 'ENG1', reason: null })]);
    const dl = await call(t.app, c.op1!, 'GET', `/api/attachments/${r.json().id}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toContain('attachment; filename="CAL-778 certificate.pdf"');
    expect(dl.headers['content-length']).toBe(String(PDF.length));
    expect(Buffer.from(dl.rawPayload).equals(PDF)).toBe(true);
    // In the item history (versions, history card) and audited.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const h = (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/history?fromDay=${today}&toDay=${today}`)).json();
    expect(h.events.find((x: { kind: string }) => x.kind === 'entry').entry.attachments).toHaveLength(1);
    const csv = (await call(t.app, c.qa!, 'GET', `/api/export/history.csv?equipmentId=${id}&fromDay=${today}&toDay=${today}`)).body;
    expect(csv).toContain('documents: CAL-778 certificate.pdf');
    const [a] = await t.owner`select action, new_value, reason from audit_log where action = 'attachment.added' and object_id = ${String(e.id)}`;
    expect(a).toMatchObject({ reason: null, new_value: expect.objectContaining({ sha256: sha(PDF), fileName: 'CAL-778 certificate.pdf' }) });
    expect((await call(t.app, c.op1!, 'GET', '/api/attachments/999999')).statusCode).toBe(404);
  });

  it('LB-11: the file type is read from its bytes, not its name; only PDF, PNG and JPEG; at most 10 MB', async () => {
    const id = await newItem({ kind: 'instrument' });
    const e = await calibration(id);
    const fake = await upload('eng1', e.id, Buffer.from('<html>not a pdf</html>'), { fileName: 'report.pdf' });
    expect(fake.statusCode).toBe(400);
    expect(fake.json()).toMatchObject({ error: 'file_type' });
    const mislabelled = await upload('eng1', e.id, PNG, { fileName: 'scan.pdf', mediaType: 'application/pdf' });
    expect(mislabelled.json()).toMatchObject({ error: 'file_type', problems: ['The file is a PNG, not the type given.'] });
    expect((await upload('eng1', e.id, PNG, { fileName: 'scan.png', mediaType: 'image/png' })).statusCode).toBe(201);
    expect((await upload('eng1', e.id, JPEG, { fileName: 'photo.jpg', mediaType: 'image/jpeg' })).statusCode).toBe(201);
    expect((await upload('eng1', e.id, PDF, { mediaType: 'image/gif' })).statusCode).toBe(400);
    expect((await upload('eng1', e.id, Buffer.alloc(0))).statusCode).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload('eng1', e.id, big)).statusCode).toBe(413);
    expect((await entriesOf(id))[0].attachments.map((a: { mediaType: string }) => a.mediaType)).toEqual(['image/png', 'image/jpeg']);
  });

  it('LB-17: a correction keeps the documents; a document added later needs a reason and is audited with it; at most 10 per entry', async () => {
    const id = await newItem({ kind: 'instrument' });
    const e = await calibration(id);
    expect((await upload('eng1', e.id, PDF)).statusCode).toBe(201);
    // The engineer corrects the entry: the certificate stays with it.
    const [v1] = await entriesOf(id);
    const fix = await call(t.app, c.eng1!, 'POST', `/api/entries/${e.id}/correct`, { activityStart: v1.activityStart, data: { ...v1.data, certificateRef: 'CAL-778-A' }, reason: 'certificate number typo', signature: sig('eng1') });
    expect(fix.statusCode, fix.body).toBe(200);
    const [v2] = await entriesOf(id);
    expect(v2.version).toBe(2);
    expect(v2.attachments).toHaveLength(1);
    expect((await upload('eng1', e.id, PNG, { fileName: 'x.png', mediaType: 'image/png' })).statusCode).toBe(409);   // superseded version
    // Someone else, or later: a reason is required (LB-17).
    expect((await upload('eng2', v2.id, PNG, { fileName: 'x.png', mediaType: 'image/png' })).json()).toMatchObject({ error: 'reason_required' });
    await t.owner`update entries set entered_at = now() - interval '2 hours' where id = ${v2.id}`;
    expect((await upload('eng1', v2.id, PNG, { fileName: 'x.png', mediaType: 'image/png' })).json()).toMatchObject({ error: 'reason_required' });
    const later = await upload('eng1', v2.id, PNG, { fileName: 'vendor scan.png', mediaType: 'image/png', reason: 'Certificate scan received from the vendor' });
    expect(later.statusCode, later.body).toBe(201);
    const [a] = await t.owner`select reason from audit_log where action = 'attachment.added' and object_id = ${String(v2.id)}`;
    expect(a!.reason).toBe('Certificate scan received from the vendor');
    expect((await entriesOf(id))[0].attachments.map((x: { fileName: string; reason: string | null }) => [x.fileName, x.reason])).toEqual([['certificate.pdf', null], ['vendor scan.png', 'Certificate scan received from the vendor']]);
    for (let i = 0; i < 8; i++) expect((await upload('eng1', v2.id, JPEG, { fileName: `p${i}.jpg`, mediaType: 'image/jpeg', reason: 'photos' })).statusCode).toBe(201);
    expect((await upload('eng1', v2.id, JPEG, { fileName: 'p9.jpg', mediaType: 'image/jpeg', reason: 'photos' })).json()).toMatchObject({ error: 'too_many_attachments' });
  });

  it('LB-21: only someone who may record the entry type attaches to it; documents go on calibration, requalification and maintenance entries only', async () => {
    const id = await newItem();
    const cal = await calibration(id);
    expect((await upload('op1', cal.id, PDF)).statusCode).toBe(403);
    const note = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'general_log', activityStart: now(), data: { checklist: {}, notes: 'x' } })).json();
    expect((await upload('op1', note.id, PDF)).json()).toMatchObject({ error: 'no_attachments' });
    const pm = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'maintenance', activityStart: now(), data: { kind: 'preventive', description: 'Quarterly PM', partsNone: true, doneBy: 'vendor', vendorName: 'ACME Service', serviceReportRef: 'SR-1' }, signature: sig('op1') })).json();
    expect((await upload('op1', pm.id, PDF, { fileName: 'SR-1 service report.pdf' })).statusCode).toBe(201);
    const rq = (await call(t.app, c.eng1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'requalification', activityStart: now(), data: { source: 'manual', outcome: 'pass', reportRef: 'RQ-2026-07', stage: 'PQ', nextDue: '2028-01-01' }, signature: sig('eng1') })).json();
    expect((await upload('eng1', rq.id, PDF, { fileName: 'RQ-2026-07 report.pdf' })).statusCode).toBe(201);
    expect((await upload('eng1', 999999, PDF)).statusCode).toBe(404);
  });

  it('LB-18: documents are insert-only and the database checks the type of entry, the size and the SHA-256 itself', async () => {
    const id = await newItem({ kind: 'instrument' });
    const e = await calibration(id);
    const a = (await upload('eng1', e.id, PDF)).json();
    expect((await t.sql`update entry_attachments set file_name = 'x' where id = ${a.id}`.catch((x) => x)).code).toBe('42501');
    expect((await t.sql`delete from entry_attachments where id = ${a.id}`.catch((x) => x)).code).toBe('42501');
    const eng = (await t.owner<{ id: number }[]>`select id::int from users where username = 'eng1'`)[0]!.id;
    const note = (await call(t.app, c.op1!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'general_log', activityStart: now(), data: { checklist: {}, notes: 'x' } })).json();
    const insert = (versionId: number, entryId: number, content: Buffer, hash: string, size = content.length) => t.owner`
      insert into entry_attachments (entry_id, entry_version_id, file_name, media_type, size_bytes, sha256, content, uploaded_by)
      values (${entryId}, ${versionId}, 'f.pdf', 'application/pdf', ${size}, ${hash}, ${content}, ${eng})`;
    await expect(insert(note.id, note.entryId, PDF, sha(PDF))).rejects.toMatchObject({ code: 'P0001' });               // not a report entry
    await expect(insert(e.id, note.entryId, PDF, sha(PDF))).rejects.toMatchObject({ code: 'P0001' });                  // version of another entry
    await expect(insert(e.id, e.entryId, PDF, sha(PNG))).rejects.toMatchObject({ code: '23514' });                      // wrong hash
    await expect(insert(e.id, e.entryId, PDF, sha(PDF), PDF.length + 1)).rejects.toMatchObject({ code: '23514' });     // wrong size
    await expect(t.owner`insert into entry_attachments (entry_id, entry_version_id, file_name, media_type, size_bytes, sha256, content, uploaded_by)
      values (${e.entryId}, ${e.id}, 'f.gif', 'image/gif', ${PDF.length}, ${sha(PDF)}, ${PDF}, ${eng})`).rejects.toMatchObject({ code: '23514' });   // type not allowed
  });
});
