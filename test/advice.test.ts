import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import { AdviceError, advicePrompt, type AdviceProvider } from '../server/advice.js';

// S12 breakdown suggestions (D-27). The language model is mocked: no real API calls in tests.

let t: TestApp;
const c: Record<string, string> = {};
let n = 0;
let outage: AdviceError | null = null;
let answer: unknown = null;
const prompts: string[] = [];
const advisor: AdviceProvider = {
  name: 'gemini',
  model: 'gemini-test',
  async advise(_instructions, prompt) {
    prompts.push(prompt);
    if (outage) throw outage;
    return { json: answer, modelVersion: 'gemini-test-001', responseId: 'resp-1' };
  },
};

const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function approve(type: string) {
  const settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: now() })).json().id;
  const versions = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions);
  expect((await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: versions.find((v: { id: number }) => v.id === id).contentHash })).statusCode).toBe(200);
}
const newItem = async (name: string, model?: string) => {
  const id = (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `AD-${++n}`, name, kind: 'equipment', location: 'Block A' })).json().id as number;
  if (model) await call(t.app, c.admin!, 'PUT', `/api/equipment/${id}/details`, { details: { manufacturer: 'Acme', model }, reason: 'Initial record', expectedVersion: 0 });
  return id;
};
const breakdown = async (id: number, description: string, extra: object = {}) =>
  (await call(t.app, c.eng1!, 'POST', `/api/equipment/${id}/entries`, {
    logbookType: 'maintenance', activityStart: ago(30), activityEnd: ago(5), lateReason: 'after repair',
    data: { kind: 'breakdown', description, occurredAt: ago(60), reportedBy: 'Asha (shift A)', failureCategory: 'mechanical',
      rootCause: 'Worn guide bush', workDone: 'Guide bush replaced', parts: [{ name: 'Guide bush', partNumber: 'GB-1', quantity: 1 }], doneBy: 'in_house', ...extra },
    signature: sig('eng1'),
  })).json().id as number;
const ask = (who: string, versionId: number) => call(t.app, c[who]!, 'POST', `/api/entries/${versionId}/advice`, {});

const GOOD = (basis: number[]) => ({
  summary: 'Punch sticking was fixed before by replacing the guide bush.',
  likelyCauses: [{ cause: 'Worn guide bush', basis: [...basis, 999999] }],
  checks: [{ step: 'Check the guide bush at the sticking station', basis }],
  parts: [{ name: 'Guide bush', partNumber: 'GB-1', basis }],
  preventive: '', confidence: 'medium', enoughHistory: true,
});

beforeAll(async () => {
  t = await freshApp({ advisor });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['eng1', ['engineering']], ['op1', ['operator']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['eng1', 'eng1'], ['op1', 'op1']] as const) c[key] = (await login(t.app, u)).cookie;
  await approve('maintenance');
});
afterAll(() => t.close());

describe('breakdown suggestions (D-27)', () => {
  it('LB-24: related breakdowns are listed, but the model is asked only once QA has approved the site setting', async () => {
    const press = await newItem('Rotary tablet press', 'RTP-45');
    const sister = await newItem('Rotary tablet press (standby)', 'RTP-45');
    const sameType = await newItem('Rotary tablet press');
    const other = await newItem('Fluid bed dryer');
    const old = await breakdown(press, 'Upper punch sticking at station 12');
    await breakdown(sister, 'Punch sticking');
    await breakdown(sameType, 'Turret noise');
    await breakdown(other, 'Blower trips');
    await breakdown(other, 'Heater fails', { failureCategory: 'electrical' });
    const current = await breakdown(press, 'Upper punch sticking again');

    const before = await ask('eng1', current);
    expect(before.statusCode).toBe(200);
    expect(before.json().advice).toBeNull();
    expect(before.json().adviceNote).toMatch(/not switched on/);
    expect(prompts).toHaveLength(0);
    // Same machine first, then same make and model, then same machine type, then the same failure type elsewhere;
    // never another failure type on another machine, nor itself.
    expect(before.json().similar.map((s: { relation: string }) => s.relation)).toEqual(['same_machine', 'same_model', 'same_type', 'same_failure_type']);
    expect(before.json().similar[0].entryId).toBe((await t.owner`select entry_id::int from entries where id = ${old}`)[0]!.entry_id);

    await approve('breakdown_advice');
    const ids = before.json().similar.map((s: { entryId: number }) => s.entryId);
    answer = GOOD(ids);
    const res = await ask('eng1', current);
    expect(res.statusCode).toBe(200);
    expect(res.json().advice.summary).toMatch(/guide bush/);
    expect(res.json().model).toBe('gemini-test-001');
    // An entry number the model was not given is dropped.
    expect(res.json().advice.likelyCauses[0].basis).toEqual(ids);
  });

  it('LB-18: each suggestion is kept in the audit trail with the model and the records it used; no names are sent', async () => {
    const id = await newItem('Blister packing machine');
    await breakdown(id, 'Camera rejects good blisters', { failureCategory: 'instrumentation' });
    const current = await breakdown(id, 'Camera rejects again', { failureCategory: 'instrumentation' });
    answer = GOOD([]);
    expect((await ask('op1', current)).statusCode).toBe(200);
    const [row] = await t.owner<{ new_value: { modelVersion: string; basedOn: number[]; advice: { summary: string } } }[]>`
      select new_value from audit_log where action = 'breakdown_advice.generated' and object_id = ${String(current)}`;
    expect(row!.new_value.modelVersion).toBe('gemini-test-001');
    expect(row!.new_value.basedOn).toHaveLength(1);
    expect(prompts.at(-1)).not.toContain('Asha');
    expect(prompts.at(-1)).toContain('Guide bush replaced');
  });

  it('LB-21: Admin cannot ask; only breakdown entries take suggestions', async () => {
    const id = await newItem('Granulator');
    const b = await breakdown(id, 'Impeller noise');
    expect((await ask('admin', b)).statusCode).toBe(403);
    const log = (await call(t.app, c.eng1!, 'POST', `/api/equipment/${id}/entries`, {
      logbookType: 'maintenance', activityStart: ago(10), activityEnd: ago(5), lateReason: 'after the work', data: { kind: 'preventive', description: 'Monthly PM', workDone: 'Greased' }, signature: sig('eng1') })).json().id;
    expect((await ask('eng1', log)).json().error).toBe('not_a_breakdown');
  });

  it('LB-26: an outage or a malformed answer is reported, and the related breakdowns still come back', async () => {
    const id = await newItem('Autocoater');
    await breakdown(id, 'Spray gun clogged', { failureCategory: 'utility' });
    const current = await breakdown(id, 'Spray gun clogged again', { failureCategory: 'utility' });
    outage = new AdviceError('unavailable', 'The suggestion service is not available (503).');
    const down = await ask('eng1', current);
    expect(down.statusCode).toBe(503);
    expect(down.json().similar).toHaveLength(1);
    outage = null;
    answer = { summary: 42 };
    expect((await ask('eng1', current)).json().error).toBe('advice_rejected');
  });

  it('the prompt carries the new breakdown and the past repairs, labelled by relation', () => {
    const text = advicePrompt({ code: 'M-1', name: 'Press', location: 'A', details: { manufacturer: 'Acme', model: 'RTP-45' }, data: { description: 'Sticking', failureCategory: 'mechanical' } }, [
      { entryId: 7, equipmentId: 1, code: 'M-2', name: 'Press', relation: 'same_model', occurredAt: new Date('2026-09-01T00:00:00Z'), failureCategory: 'mechanical',
        description: 'Sticking', rootCause: 'Bush', workDone: 'Bush replaced', partsText: '1 × Bush', doneBy: 'Vendor: Acme (report R1)', downtime: '2 h', postRepairChecks: '', status: 'released' },
    ]);
    expect(text).toContain('Make / model: Acme RTP-45');
    expect(text).toContain('#7 · M-2 · Press (same make and model) · occurred 2026-09-01');
    expect(text).toContain('Done by: external vendor');
  });
});
