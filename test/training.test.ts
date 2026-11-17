import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrainingOff, sqlTraining, type Training, type TrainingRecord } from '../server/training.js';
import { addItem, call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';

// D-71 (owner 17 Nov 2026): only trained people sign. A type's settings may name a Recruitment skill; the person signing
// "performed" or "verified" must be qualified in it in training_v1. Link off or down: the signer states it, typed by hand.

const sig = (u: string) => ({ proof: proofFor(u) });
const now = () => new Date().toISOString();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Stand-in for Recruitment's training_v1 through the link: rows by login, cut on demand (link down).
const rows: TrainingRecord[] = [];
let down = false;
const fakeTraining: Training = {
  skills: async () => {
    if (down) throw new TrainingOff();
    return [...new Map(rows.map((r) => [r.skillCode, { code: r.skillCode, title: r.skillTitle }])).values()];
  },
  of: async (login, code) => {
    if (down) throw new TrainingOff();
    return rows.find((r) => r.login.toLowerCase() === login.toLowerCase() && r.skillCode === code) ?? null;
  },
};
const trained = (login: string, qualified: boolean, validUntil: string) =>
  rows.push({ login, name: login.toUpperCase(), skillCode: 'CLN-01', skillTitle: 'Equipment cleaning', trainedOn: day(-100), validUntil, qualified });

async function setUp(training: Training | null) {
  const t = await freshApp({ training });
  const c: Record<string, string> = {};
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['op2', ['operator']], ['op3', ['operator']],
    ['sup1', ['supervisor']], ['sup2', ['supervisor']]] as const) {
    await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  return { t, c };
}
async function settings(t: TestApp, c: Record<string, string>, type: string, extra: object) {
  const res = await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings: { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...extra }, effectiveFrom: now() });
  if (res.statusCode !== 201) return res;
  const id = res.json().id;
  const v = (await call(t.app, c.qa1!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string; settings: object }[] }) => x.versions)
    .find((x: { id: number }) => x.id === id);
  expect((await call(t.app, c.qa1!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: v.contentHash })).statusCode).toBe(200);
  return { ...res, settings: v.settings };
}
let n = 0;
const clean = async (t: TestApp, c: Record<string, string>, who: string, extra: object = {}) => {
  const id = await addItem(t, { code: `TR-${++n}` });
  const res = await call(t.app, c[who]!, 'POST', `/api/equipment/${id}/entries`, { logbookType: 'equipment_cleaning', activityStart: now(),
    data: { cleaningType: 'major', checklist: {} }, signature: sig(who), ...extra });
  return { item: id, res };
};
const versions = async (t: TestApp, c: Record<string, string>, v: number) => (await call(t.app, c.qa1!, 'GET', `/api/entries/${v}/versions`)).json();
const verify = async (t: TestApp, c: Record<string, string>, who: string, v: number, extra: object = {}) =>
  call(t.app, c[who]!, 'POST', `/api/entries/${v}/verify`, { ...sig(who), contentHash: (await versions(t, c, v)).at(-1).contentHash, ...extra });

describe('the Recruitment link reads training_v1 (D-71)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await freshApp(); });
  afterAll(() => t.close());

  it('D-71: skills and a person\'s training come from the view; a missing view is the link off', async () => {
    const s = `${t.reportSchema.replace(/_report$/, '')}_rec`;
    await t.owner.unsafe(`create schema ${s}`);
    await t.owner.unsafe(`create table ${s}.training_v1 (person_id uuid, person_login text, person_name text, skill_code text, skill_title text,
      trained_on date, valid_until date, qualified boolean, approved_at timestamptz, read_at timestamptz, data_as_of timestamptz)`);
    await t.owner.unsafe(`insert into ${s}.training_v1 values
      (gen_random_uuid(), 'op1', 'Operator One', 'CLN-01', 'Equipment cleaning', '2026-01-10', '2027-01-10', true, now(), now(), now()),
      (gen_random_uuid(), 'op2', 'Operator Two', 'CLN-01', 'Equipment cleaning', '2025-01-10', '2026-01-10', false, now(), now(), now()),
      (gen_random_uuid(), 'op1', 'Operator One', 'GLV-02', 'Glove testing', '2026-02-01', null, true, now(), now(), now())`);
    const r = sqlTraining(t.owner, s);
    expect(await r.skills()).toEqual([{ code: 'CLN-01', title: 'Equipment cleaning' }, { code: 'GLV-02', title: 'Glove testing' }]);
    expect(await r.of('OP1', 'CLN-01')).toEqual({ login: 'op1', name: 'Operator One', skillCode: 'CLN-01', skillTitle: 'Equipment cleaning',
      trainedOn: '2026-01-10', validUntil: '2027-01-10', qualified: true });
    expect((await r.of('op2', 'CLN-01'))!.qualified).toBe(false);
    expect(await r.of('op3', 'CLN-01')).toBeNull();
    await expect(sqlTraining(t.owner, `${s}_missing`).skills()).rejects.toBeInstanceOf(TrainingOff);
    await t.owner.unsafe(`drop schema ${s} cascade`);
  });
});

describe('only trained people sign, Recruitment linked (D-71)', () => {
  let t: TestApp;
  let c: Record<string, string>;
  beforeAll(async () => {
    ({ t, c } = await setUp(fakeTraining));
    trained('op1', true, day(200));
    trained('op2', false, day(-3));          // expired: Recruitment already says not qualified
    trained('sup1', true, day(90));
    // op3 and sup2: no training at all.
  });
  afterAll(() => t.close());

  it('D-71: settings pick the skill from Recruitment (title pulled); an unknown skill is refused; without one nothing changes', async () => {
    const bad = await settings(t, c, 'equipment_cleaning', { training: { code: 'XX-9', title: 'Made up' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems).toEqual(['Training XX-9 is not a skill in Recruitment: pick it from the list.']);
    expect((await call(t.app, c.admin!, 'GET', '/api/training/skills')).json()).toEqual({ linked: true, skills: [{ code: 'CLN-01', title: 'Equipment cleaning' }], note: '' });
    // No training on the cleaning yet: signing is as before, no training line.
    await settings(t, c, 'equipment_cleaning', {});
    const { res } = await clean(t, c, 'op3');
    expect(res.statusCode).toBe(201);
    expect((await versions(t, c, res.json().id))[0].signatures[0]).not.toHaveProperty('training');
    expect((await call(t.app, c.op3!, 'GET', '/api/training/check?logbookType=equipment_cleaning')).json()).toEqual({ needed: null });

    const ok = await settings(t, c, 'equipment_cleaning', { training: { code: 'CLN-01', title: 'typed title is replaced' } });
    expect((ok as { settings: object }).settings).toMatchObject({ training: { code: 'CLN-01', title: 'Equipment cleaning' } });
  });

  it('D-71: a qualified person signs and the entry notes the training; expired or missing training is refused in plain words', async () => {
    expect((await call(t.app, c.op1!, 'GET', '/api/training/check?logbookType=equipment_cleaning')).json())
      .toEqual({ needed: { code: 'CLN-01', title: 'Equipment cleaning' }, state: 'trained', validUntil: day(200),
        note: `Trained: Equipment cleaning (CLN-01), valid until ${day(200)} (Recruitment)` });
    const { res } = await clean(t, c, 'op1');
    expect(res.statusCode).toBe(201);
    const [v] = await versions(t, c, res.json().id);
    expect(v.signatures[0]).toMatchObject({ meaning: 'performed', printedName: 'OP1', valid: true,
      training: `Trained: Equipment cleaning (CLN-01), valid until ${day(200)} (Recruitment)`, trainingTyped: false });

    for (const who of ['op2', 'op3']) {
      const r = (await clean(t, c, who)).res;
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'not_trained', problems: [`${who.toUpperCase()} has no valid training in Equipment cleaning (CLN-01) (Recruitment): another trained person signs.`] });
    }
    // Ticking "I am trained" does not help while Recruitment answers.
    expect((await clean(t, c, 'op3', { trainedTyped: true })).res.json().error).toBe('not_trained');
    expect((await call(t.app, c.op3!, 'GET', '/api/training/check?logbookType=equipment_cleaning')).json().state).toBe('not_trained');
  });

  it('D-71: the verifier needs the training too; the verification notes it', async () => {
    const { res } = await clean(t, c, 'op1');
    const id = res.json().id;
    const refused = await verify(t, c, 'sup2', id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().problems).toEqual(['SUP2 has no valid training in Equipment cleaning (CLN-01) (Recruitment): another trained person signs.']);
    expect((await verify(t, c, 'sup1', id)).statusCode).toBe(200);
    const [v] = await versions(t, c, id);
    expect(v.signatures.find((s: { meaning: string }) => s.meaning === 'verified')).toMatchObject({ printedName: 'SUP1',
      training: `Trained: Equipment cleaning (CLN-01), valid until ${day(90)} (Recruitment)`, trainingTyped: false });
  });

  it('D-71: Recruitment down: the signer states the training, the signature is marked typed by hand and the review counts it', async () => {
    down = true;
    try {
      expect((await call(t.app, c.op3!, 'GET', '/api/training/check?logbookType=equipment_cleaning')).json()).toMatchObject({ state: 'typed', why: 'not reachable',
        message: 'Recruitment is not reachable: confirm you are trained in Equipment cleaning (CLN-01).' });
      const first = (await clean(t, c, 'op3')).res;
      expect(first.statusCode).toBe(400);
      expect(first.json()).toEqual({ error: 'training_confirmation_required', problems: ['Recruitment is not reachable: confirm you are trained in Equipment cleaning (CLN-01).'] });
      const { item, res } = await clean(t, c, 'op3', { trainedTyped: true });
      expect(res.statusCode).toBe(201);
      const typedNote = 'Training typed by hand (Recruitment not reachable): OP3 stated being trained in Equipment cleaning (CLN-01)';
      expect((await versions(t, c, res.json().id))[0].signatures[0]).toMatchObject({ training: typedNote, trainingTyped: true });
      // The verifier too.
      expect((await verify(t, c, 'sup2', res.json().id)).json().error).toBe('training_confirmation_required');
      expect((await verify(t, c, 'sup2', res.json().id, { trainedTyped: true })).statusCode).toBe(200);
      const p = (await call(t.app, c.qa1!, 'GET', `/api/equipment/${item}/period?fromDay=${day(0)}&toDay=${day(0)}`)).json();
      expect(p.openItems.typedByHand).toBe(1);
      // Settings may take a typed skill while Recruitment does not answer.
      expect((await settings(t, c, 'calibration', { training: { code: 'CAL-07', title: 'Balance calibration' } })).statusCode).toBe(201);
    } finally { down = false; }
    // Kept with the signature: the history copy shows it.
    const [row] = await t.owner<{ n: number }[]>`select count(*)::int as n from signature_training where typed`;
    expect(row!.n).toBe(2);
  });

  it('D-71: the record is insert-only for the app', async () => {
    const [r] = await t.owner<{ privileges: string }[]>`
      select string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants
      where table_name = 'signature_training' and grantee = 'logbook_app' and table_schema = current_schema()`;
    expect(r!.privileges).toBe('SELECT');
    await expect(t.sql`update signature_training set typed = false`).rejects.toMatchObject({ code: '42501' });
    await expect(t.sql`delete from signature_training`).rejects.toMatchObject({ code: '42501' });
  });
});

describe('only trained people sign, Recruitment not linked (D-71)', () => {
  let t: TestApp;
  let c: Record<string, string>;
  beforeAll(async () => { ({ t, c } = await setUp(null)); });
  afterAll(() => t.close());

  it('D-71: the skill is typed in the settings, and each signer states the training ("Recruitment not linked")', async () => {
    expect((await call(t.app, c.admin!, 'GET', '/api/training/skills')).json()).toEqual({ linked: false, skills: [], note: 'Recruitment is not linked: type the skill code and title.' });
    expect((await settings(t, c, 'equipment_cleaning', { training: { code: 'CLN-01', title: 'Equipment cleaning' } })).statusCode).toBe(201);
    expect((await clean(t, c, 'op1')).res.json().error).toBe('training_confirmation_required');
    const { res } = await clean(t, c, 'op1', { trainedTyped: true });
    expect(res.statusCode).toBe(201);
    expect((await versions(t, c, res.json().id))[0].signatures[0]).toMatchObject({ trainingTyped: true,
      training: 'Training typed by hand (Recruitment not linked): OP1 stated being trained in Equipment cleaning (CLN-01)' });
  });
});
