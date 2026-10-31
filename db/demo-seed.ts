// Demo data (S15, D-28): the shared investigation scenario of the Deviations & CAPA system, created
// through the app's own API (same checks, signatures and audit trail as a user at the screen).
// Every activity is back-dated, so every entry is a late entry with the reason "Demo data" (LB-04).
//
// Usage: DEMO_DATABASE_URL=postgres://logbook_owner:...@localhost/logbook_demo npm run demo:seed [-- --force]
// The database must be migrated first (npm run migrate). It must be a fresh one: the script refuses a
// database whose name does not contain "demo" or "test" (unless --i-know-this-is-not-production, which
// also needs DEMO_PASSWORD: the published default password is never used there), that has approved
// logbook settings, or users other than one initial admin, and, unless --force, one that has entries.
// --force never skips the other checks. Never run it against a production database: it creates users.
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { audit } from '../server/audit.js';
import { connect, type Sql } from '../server/db.js';
import { hashPassword, temporaryPassword } from '../server/passwords.js';

export const DEMO_REASON = 'Demo data';
const DEFAULT_PASSWORD = 'Demo-Logbook-2026';

// Demo accounts: [username, full name, role].
export const DEMO_USERS = [
  ['demo.admin', 'Demo Site Admin', 'admin'],
  ['qa.priya', 'Priya Nair', 'qa'],
  ['sup.rakesh', 'Rakesh Patil', 'supervisor'],
  ['op.suresh', 'Suresh Yadav', 'operator'],
  ['eng.imran', 'Imran Shaikh', 'engineering'],
] as const;
type Who = 'admin' | 'qa' | 'sup' | 'op' | 'eng';
const WHO: Record<Who, string> = { admin: 'demo.admin', qa: 'qa.priya', sup: 'sup.rakesh', op: 'op.suresh', eng: 'eng.imran' };

// Plant time (IST, UTC+05:30) to an ISO timestamp.
export const ist = (dayTime: string) => new Date(`${dayTime}:00+05:30`).toISOString();
// The event under investigation: low tablet hardness on CMP-02 from about 14:00 IST.
export const EVENT_AT = ist('2026-10-31T14:00');
const daysBefore = (iso: string, days: number) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();

export class SeedError extends Error {}

export interface SeedResult {
  password: string;
  entries: number;
}

// `sql` runs as the application role (logbook_app), exactly like the server.
// A demo or test database by its name.
export const demoDatabaseName = (name: string) => /demo|test/i.test(name);

export interface SeedOptions {
  // Add demo data although the database has entries (never skips the other checks).
  force?: boolean;
  // Seed a database whose name does not say demo or test; needs an explicit password.
  notProduction?: boolean;
  password?: string;
}

// Why this database must not get demo data; empty when it may.
export async function seedRefusals(sql: Sql, { force = false, notProduction = false, password }: SeedOptions = {}): Promise<string[]> {
  const [m] = await sql<{ migrated: boolean }[]>`select to_regclass('entries') is not null as migrated`;
  if (!m!.migrated) return ['This database is not migrated: run npm run migrate first.'];
  const [f] = await sql<{ db: string; entries: boolean; approved: boolean; users: number; lone_admin: boolean }[]>`
    select current_database() as db,
      exists (select 1 from entries) as entries,
      exists (select 1 from signatures where object_type = 'settings' and meaning = 'approved') as approved,
      (select count(*)::int from users) as users,
      coalesce((select bool_and(r.role = 'admin') from user_roles r), true) as lone_admin`;
  const problems: string[] = [];
  if (!demoDatabaseName(f!.db) && !notProduction) {
    problems.push(`Database "${f!.db}" is not named as a demo or test database (use --i-know-this-is-not-production if it really is not production).`);
  }
  if (notProduction && !password) problems.push('Set DEMO_PASSWORD: the default demo password is only used on demo and test databases.');
  if (f!.users > 1 || (f!.users === 1 && !f!.lone_admin)) problems.push('This database has user accounts other than one initial admin: refusing to add demo users.');
  if (f!.approved) problems.push('This database has approved logbook settings: refusing to add demo settings.');
  if (f!.entries && !force) problems.push('This database already has logbook entries: refusing to add demo data (use --force to add it anyway).');
  return problems;
}

export async function seedDemo(sql: Sql, opts: SeedOptions = {}): Promise<SeedResult> {
  const problems = await seedRefusals(sql, opts);
  if (problems.length) throw new SeedError(problems.join('\n'));
  const password = opts.password ?? DEFAULT_PASSWORD;

  const app = await buildApp({ sql, webRoot: '/nonexistent' });
  try {
    return await run(app, sql, password);
  } finally {
    await app.close();
  }
}

async function run(app: FastifyInstance, sql: Sql, password: string): Promise<SeedResult> {
  const cookies = {} as Record<Who, string>;
  let entries = 0;
  const api = async (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await app.inject({ method, url, headers: { cookie: cookies[who] }, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
    if (res.statusCode >= 300) throw new SeedError(`${method} ${url} as ${WHO[who]} failed (${res.statusCode}): ${res.body}`);
    return res.json();
  };
  const sig = (who: Who) => ({ username: WHO[who], password });
  // First login with a temporary password, then the user sets the demo password (LB-20).
  const firstLogin = async (who: Who, temp: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: WHO[who], password: temp } });
    const sid = res.cookies.find((c) => c.name === 'sid');
    if (!sid) throw new SeedError(`login of ${WHO[who]} failed`);
    cookies[who] = `sid=${sid.value}`;
    await api(who, 'POST', '/api/me/password', { current: temp, new: password });
  };

  // The first Admin, as `npm run create-admin` makes it; every other account through the users API.
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  await sql.begin(async (tx) => {
    const [u] = await tx<{ id: number }[]>`
      insert into users (username, full_name, password_hash, temp_password_expires_at)
      values (${WHO.admin}, ${DEMO_USERS[0][1]}, ${hash}, now() + interval '24 hours') returning id::int`;
    await tx`insert into user_roles (user_id, role) values (${u!.id}, 'admin')`;
    await audit(tx, { actorId: null, action: 'user.created', objectType: 'user', objectId: u!.id,
      new: { username: WHO.admin, fullName: DEMO_USERS[0][1], roles: ['admin'] }, reason: 'demo data (demo seed script)' });
  });
  await firstLogin('admin', temp);
  for (const [username, fullName, role] of DEMO_USERS.slice(1)) {
    const created = await api('admin', 'POST', '/api/users', { username, fullName, roles: [role] });
    await firstLogin((Object.entries(WHO).find(([, u]) => u === username)![0]) as Who, created.temporaryPassword);
  }

  // Master data.
  if (!(await api('admin', 'GET', '/api/site'))) await api('admin', 'PUT', '/api/site', { name: 'Demo Tablet Plant', code: 'DEMO', reason: DEMO_REASON });
  const product = (await api('admin', 'POST', '/api/products', { code: 'PCM500', name: 'Paracetamol 500 mg Tablets' })).id as number;
  const item = async (code: string, name: string, kind: 'equipment' | 'instrument' | 'area', location: string, sopRefs = '', more: object = {}) => {
    const id = (await api('admin', 'POST', '/api/equipment', { code, name, kind, location })).id as number;
    if (sopRefs) {
      await api('admin', 'PUT', `/api/equipment/${id}/details`, { details: { sopRefs, ...more }, reason: DEMO_REASON, expectedVersion: 0 });
    }
    return id;
  };
  await item('GRN-RM-1', 'Granulation room 1', 'area', 'Block A, ground floor');
  await item('CMP-RM-2', 'Compression room 2', 'area', 'Block A, ground floor');
  const fbd = await item('FBD-01', 'Fluid bed dryer', 'equipment', 'GRN-RM-1', 'SOP-PRD-014', { manufacturer: 'Demo Process Equipment', model: 'FBD-120' });
  const cmp = await item('CMP-02', 'Rotary tablet press', 'equipment', 'CMP-RM-2', 'SOP-PRD-021, SOP-ENG-010', { manufacturer: 'Demo Press Works', model: 'RTP-37' });
  const ht = await item('HT-01', 'Tablet hardness tester', 'instrument', 'CMP-RM-2', 'SOP-QC-005', { manufacturer: 'Demo Instruments', model: 'HT-500' });

  // Logbook settings: drafted by Admin, approved by QA with an e-signature (LB-24). Approval makes
  // them effective now; the back-dated entries below are recorded under these settings.
  const settings: Record<string, string> = { equipment_use: '', equipment_cleaning: '', maintenance: 'SOP-ENG-010', calibration: 'SOP-QC-005' };
  for (const [logbookType, sopRef] of Object.entries(settings)) {
    const { id } = await api('admin', 'POST', '/api/settings', {
      logbookType, settings: { enabled: true, sopRef, checklist: [], verificationRequired: false }, effectiveFrom: new Date().toISOString() });
    const types = (await api('qa', 'GET', '/api/logbook-types')) as { versions: { id: number; contentHash: string }[] }[];
    const contentHash = types.flatMap((t) => t.versions).find((v) => v.id === id)!.contentHash;
    await api('qa', 'POST', `/api/settings/${id}/approve`, { ...sig('qa'), contentHash });
  }

  // Entries, in the order they happened (status rules apply at each step: clean before use, etc.).
  const record = async (who: Who, equipmentId: number, body: object) => {
    entries++;
    return (await api(who, 'POST', `/api/equipment/${equipmentId}/entries`, { lateReason: DEMO_REASON, ...body })).id as number;
  };
  const signLatest = async (who: Who, action: 'verify' | 'release', versionId: number) => {
    const latest = ((await api(who, 'GET', `/api/entries/${versionId}/versions`)) as { id: number; contentHash: string }[]).at(-1)!;
    await api(who, 'POST', `/api/entries/${latest.id}/${action}`, { ...sig(who), contentHash: latest.contentHash });
    return latest.id;
  };
  const clean = async (id: number, from: string, to: string, cleaningType: string) => {
    const e = await record('op', id, { logbookType: 'equipment_cleaning', activityStart: ist(from), activityEnd: ist(to),
      data: { cleaningType, checklist: {}, remarks: cleaningType === 'major' ? 'Initial cleaning before first use' : '' }, signature: sig('op') });
    await signLatest('sup', 'verify', e);
  };
  const use = async (id: number, batch: string, stage: string, from: string, to: string) => {
    const e = await record('op', id, { logbookType: 'equipment_use', activityStart: ist(from), productId: product, batch, data: { stage } });
    await api('op', 'POST', `/api/entries/${e}/complete`, { activityEnd: ist(to), lateReason: DEMO_REASON });
  };

  // HT-01: calibrated three months ago, next due the day before the event (overdue at the event).
  const cal = await record('eng', ht, { logbookType: 'calibration', activityStart: ist('2026-07-30T10:00'), activityEnd: ist('2026-07-30T11:00'),
    data: { result: 'pass', certificateRef: 'CAL-HT01-2607', nextDue: '2026-10-30', remarks: 'Checked with reference weights 2, 5, 10 kg' }, signature: sig('eng') });
  await signLatest('qa', 'verify', cal);

  // CMP-02: preventive maintenance 40 days before the event, none since.
  const pmEnd = daysBefore(EVENT_AT, 40);
  const pm = await record('eng', cmp, { logbookType: 'maintenance', activityStart: daysBefore(pmEnd, 4 / 24), activityEnd: pmEnd,
    data: { kind: 'preventive', description: 'Preventive maintenance per SOP-ENG-010', workDone: 'Turret, punches and dies inspected; cams and guides lubricated; force rollers checked' }, signature: sig('eng') });
  await signLatest('sup', 'verify', pm);
  await clean(cmp, '2026-09-21T15:00', '2026-09-21T16:00', 'major');

  // FBD-01: batch 013, cleaning, batch 014 (granulation drying), cleaning.
  await clean(fbd, '2026-10-27T09:00', '2026-10-27T10:00', 'major');
  await use(fbd, 'PCM-2610-013', 'Granulation drying', '2026-10-27T11:00', '2026-10-27T15:00');
  await clean(fbd, '2026-10-27T16:00', '2026-10-27T17:00', 'batch_to_batch');
  await use(fbd, 'PCM-2610-014', 'Granulation drying', '2026-10-30T09:00', '2026-10-30T13:00');
  await clean(fbd, '2026-10-30T14:00', '2026-10-30T15:00', 'batch_to_batch');

  // CMP-02: breakdown two days before the event, reported, repaired, verified and released by QA.
  const reported = { kind: 'breakdown', description: 'Upper punch sticking', occurredAt: ist('2026-10-29T09:40'),
    reportedBy: 'Suresh Yadav (operator)', failureCategory: 'mechanical' };
  const bd = await record('op', cmp, { logbookType: 'maintenance', activityStart: ist('2026-10-29T10:00'), data: reported, signature: sig('op') });
  const repaired = await api('eng', 'POST', `/api/entries/${bd}/complete`, {
    activityEnd: ist('2026-10-29T12:30'), lateReason: DEMO_REASON, signature: sig('eng'),
    data: { ...reported, rootCause: 'Dry punch guides and worn upper punch tips', workDone: 'Upper punches and guides cleaned and polished, guides lubricated',
      partsNone: true, doneBy: 'in_house', postRepairChecks: 'Trial run 15 min, no sticking' } });
  await signLatest('sup', 'verify', repaired.id);
  await signLatest('qa', 'release', repaired.id);
  await clean(cmp, '2026-10-29T13:00', '2026-10-29T13:45', 'batch_to_batch');

  // CMP-02: batch 013, cleaning between batches, batch 014 (the event at about 14:00).
  await use(cmp, 'PCM-2610-013', 'Compression', '2026-10-29T14:00', '2026-10-30T06:00');
  await clean(cmp, '2026-10-30T07:00', '2026-10-30T08:00', 'batch_to_batch');
  await use(cmp, 'PCM-2610-014', 'Compression', '2026-10-31T09:00', '2026-10-31T16:30');

  for (const who of Object.keys(cookies) as Who[]) await api(who, 'POST', '/api/logout');
  return { password, entries };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DEMO_DATABASE_URL;
  if (!url) {
    console.error('DEMO_DATABASE_URL is required (a migrated demo database; never production).');
    process.exit(1);
  }
  const sql = connect(url, { role: process.env.DB_APP_ROLE ?? 'logbook_app' });
  try {
    const r = await seedDemo(sql, { force: process.argv.includes('--force'), notProduction: process.argv.includes('--i-know-this-is-not-production'),
      password: process.env.DEMO_PASSWORD || undefined });
    console.log(`Demo data created: ${r.entries} entries. Users ${DEMO_USERS.map((u) => u[0]).join(', ')}; password: ${r.password}`);
  } catch (e) {
    console.error(e instanceof SeedError ? e.message : e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
