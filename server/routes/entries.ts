import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole, type SessionUser } from '../auth.js';
import { LOGBOOK_TYPES, typeByKey, type LogbookSettings } from '../logbook-types.js';
import { DATA_SCHEMAS, REPORTED_FIELDS, VERIFIERS, checkData, mayCorrect, mayRecord, performerSigns, verificationNeeded, type EntryContext, type EquipmentInfo } from '../entries.js';
import { SignError, authenticateSigner, contentHash, sign, signBody, type SignInput } from '../signatures.js';
import { settingsInForce } from './settings.js';
import { allStatuses, statusOf } from '../status.js';
import { VoiceError, confirmVoiceNotes, unsignedDrafts, voiceNotesFor, type VoiceUse } from '../voice.js';

// Product default (LB-04): an activity time older than this makes the entry a late entry.
export const LATE_MINUTES = 30;

const credentials = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });
// D-26: voice notes confirmed with this save, and the speaker's separate confirmation signature.
const voiceFields = {
  voiceNotes: z.array(z.object({ id: z.number().int().positive(), field: z.string().max(40), finalText: z.string().max(2000), shownHash: z.string().regex(/^[0-9a-f]{64}$/) })).max(10).default([]),
  voiceSignature: credentials.optional(),
};

const createBody = z.object({
  logbookType: z.string(),
  activityStart: z.coerce.date(),
  activityEnd: z.coerce.date().optional(),
  productId: z.number().int().positive().optional(),
  batch: z.string().trim().min(1).max(60).optional(),
  data: z.record(z.unknown()),
  lateReason: z.string().trim().max(500).optional(),
  // Required for types whose performer signs (D-16).
  signature: credentials.optional(),
  ...voiceFields,
});
// Ends a use, or completes the repair of a breakdown (D-25): then with the repair data and the
// performer's signature.
const completeBody = z.object({
  activityEnd: z.coerce.date(),
  lateReason: z.string().trim().max(500).optional(),
  data: z.record(z.unknown()).optional(),
  signature: credentials.optional(),
  ...voiceFields,
});
const correctBody = z.object({
  activityStart: z.coerce.date(),
  activityEnd: z.coerce.date().nullable().optional(),
  productId: z.number().int().positive().nullable().optional(),
  batch: z.string().trim().min(1).max(60).nullable().optional(),
  data: z.record(z.unknown()),
  reason: z.string().trim().min(1).max(500),
  lateReason: z.string().trim().max(500).optional(),
  signature: credentials,
  ...voiceFields,
});

export interface EntryRow {
  id: number;
  equipment_id: number;
  logbook_type: string;
  settings_id: number;
  entry_id: number;
  version: number;
  supersedes: number | null;
  change: string;
  activity_start: Date;
  activity_end: Date | null;
  product_id: number | null;
  batch: string | null;
  data: Record<string, unknown>;
  late: boolean;
  late_reason: string | null;
  correction_reason: string | null;
  entered_by: number;
  entered_at: Date;
}

export const ENTRY_COLS = `id::int, equipment_id::int, logbook_type, settings_id::int, entry_id::int, version, supersedes::int, change,
  activity_start, activity_end, product_id::int, batch, data, late, late_reason, correction_reason, entered_by::int, entered_at`;

// What every signature on an entry version covers (LB-19).
export const entryContent = (e: EntryRow) => ({
  equipmentId: e.equipment_id,
  logbookType: e.logbook_type,
  settingsId: e.settings_id,
  entryId: e.entry_id,
  version: e.version,
  supersedes: e.supersedes,
  change: e.change,
  activityStart: e.activity_start,
  activityEnd: e.activity_end,
  productId: e.product_id,
  batch: e.batch,
  data: e.data,
  late: e.late,
  lateReason: e.late_reason,
  correctionReason: e.correction_reason,
  enteredBy: e.entered_by,
  enteredAt: e.entered_at,
});
export const hashOf = (e: EntryRow) => contentHash('entry', e.id, entryContent(e));

class EntryError extends Error {
  constructor(
    public status: number,
    public code: string,
    public problems: string[] = [],
  ) {
    super(code);
  }
}

// A refused request body names what is missing, so the screen can show it (S11).
const FIELD_PROBLEM: Record<string, string> = {
  reason: 'Give the reason for the correction.',
  'signature.username': 'Enter your user ID to sign.',
  'signature.password': 'Enter your password to sign.',
  username: 'Enter your user ID to sign.',
  password: 'Enter your password to sign.',
};
function invalid(reply: FastifyReply, issues: z.ZodIssue[] = []) {
  const problems = [...new Set(issues.map((i) => FIELD_PROBLEM[i.path.join('.')] ?? `${i.path.join('.') || 'request'}: ${i.message}`))];
  return reply.code(400).send({ error: 'invalid_request', problems });
}

// What the logbook screen may offer this user: the server's own rule (D-17), never a copy of it (S11).
async function withMayCorrect<T extends { id: number; logbookType: string }>(sql: Sql, user: SessionUser, entries: T[]) {
  if (!entries.length) return entries;
  const authors = await sql<{ id: number; latest: number; first: number }[]>`
    select e.id::int, e.entered_by::int as latest, f.entered_by::int as first
    from entries e join entries f on f.entry_id = e.entry_id and f.version = 1
    where e.id = any(${entries.map((x) => x.id)}::bigint[])`;
  const own = new Map(authors.map((a) => [a.id, a.latest === user.id || a.first === user.id]));
  return entries.map((x) => ({ ...x, mayCorrect: mayCorrect(x.logbookType, user.roles, own.get(x.id) ?? false) }));
}

function send(reply: FastifyReply, e: unknown) {
  if (e instanceof EntryError || e instanceof VoiceError) return reply.code(e.status).send({ error: e.code, problems: e.problems });
  if (e instanceof SignError) {
    const status = e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409;
    return reply.code(status).send({ error: e.code });
  }
  throw e;
}

// LB-04: timing rules against the database clock. Returns whether the entry is late.
function timing(now: Date, times: (Date | null | undefined)[], lateReason: string | undefined): boolean {
  for (const t of times) {
    if (t && t.getTime() > now.getTime() + 60_000) throw new EntryError(400, 'future_time', ['An activity time cannot be in the future.']);
  }
  const latest = Math.max(...times.filter((t): t is Date => Boolean(t)).map((t) => t.getTime()));
  const late = latest < now.getTime() - LATE_MINUTES * 60_000;
  if (late && !lateReason?.trim()) {
    throw new EntryError(400, 'late_reason_required', [`This is a late entry (more than ${LATE_MINUTES} minutes ago): give a reason.`]);
  }
  return late;
}

// A cleaning is recorded only when the item is not in use, and starts after the last use ended
// (review S4-3/7).
function cleaningFits(status: { inUse: unknown; lastUseEnd: Date | null }, start: Date) {
  if (status.inUse) throw new EntryError(409, 'in_use', ['End the current use before recording a cleaning.']);
  // Forms enter times to the minute, so compare at minute precision.
  const useEndMinute = status.lastUseEnd ? Math.floor(status.lastUseEnd.getTime() / 60_000) * 60_000 : null;
  if (useEndMinute !== null && start.getTime() < useEndMinute) {
    throw new EntryError(400, 'check_failed', ['A cleaning cannot start before the last use ended.']);
  }
}

// A1 8.45: a cycle identifier is unique per steriliser. Checked under the equipment lock.
async function checkCycleId(tx: Tx, type: string, equipmentId: number, data: Record<string, unknown>, entryId: number | null) {
  if (type !== 'steriliser_cycle') return;
  const [dup] = await tx`
    select 1 from entries e
    where e.equipment_id = ${equipmentId} and e.logbook_type = 'steriliser_cycle'
      and lower(e.data->>'cycleId') = lower(${String(data.cycleId)})
      and e.entry_id <> ${entryId ?? -1}
      and not exists (select 1 from entries x where x.supersedes = e.id)`;
  if (dup) throw new EntryError(409, 'check_failed', [`Cycle ID ${String(data.cycleId)} is already recorded on this steriliser.`]);
}

async function dbNow(tx: Tx): Promise<Date> {
  const [r] = await tx<{ now: Date }[]>`select now() as now`;
  return r!.now;
}

// D-26: the speaker re-enters user ID and password to confirm voice-note text; checked before the
// transaction so a wrong password always counts.
async function voiceSigner(sql: Sql, user: SessionUser, b: { voiceNotes: VoiceUse[]; voiceSignature?: { username: string; password: string } }) {
  if (!b.voiceNotes.length) return null;
  if (!b.voiceSignature) throw new EntryError(400, 'voice_signature_required', ['Sign to confirm the voice-note text.']);
  return authenticateSigner(sql, user, { ...b.voiceSignature, contentHash: '0'.repeat(64) }, { objectType: 'voice_note', objectId: 0, meaning: 'voice_confirmed' });
}

// Refuses a voice translation that is not being confirmed now; links and signs those that are.
async function guardVoice(tx: Tx, user: SessionUser, equipmentId: number, type: string, data: Record<string, unknown>, uses: VoiceUse[]) {
  const problems = await unsignedDrafts(tx, user.id, equipmentId, type, data, uses.map((u) => u.id));
  if (problems.length) throw new EntryError(400, 'voice_confirmation_required', problems);
}

// An open breakdown repair or use is completed, not corrected (D-25).
const isOpenable = (type: string, data: Record<string, unknown>) => type === 'equipment_use' || (type === 'maintenance' && data.kind === 'breakdown');

// An entry made before S9 (its first version has no occurrence time) keeps its old rules (D-25).
async function isLegacyBreakdown(tx: Tx, entryId: number): Promise<boolean> {
  const [first] = await tx<{ data: Record<string, unknown>; logbook_type: string }[]>`
    select data, logbook_type from entries where entry_id = ${entryId} and version = 1`;
  return first!.logbook_type === 'maintenance' && first!.data.kind === 'breakdown' && first!.data.occurredAt === undefined;
}

// Entries are insert-only, so the app role cannot row-lock them; every write to a logbook locks
// its equipment row instead, which serialises changes per logbook (unique `supersedes` backs this up).
async function latestVersion(tx: Tx, versionId: number): Promise<EntryRow> {
  const [owner] = await tx<{ equipment_id: number }[]>`select equipment_id::int from entries where id = ${versionId}`;
  if (!owner) throw new EntryError(404, 'not_found');
  await tx`select 1 from equipment where id = ${owner.equipment_id} for update`;
  const [row] = await tx.unsafe<EntryRow[]>(`select ${ENTRY_COLS} from entries where id = $1`, [versionId]);
  if (!row) throw new EntryError(404, 'not_found');
  const [next] = await tx`select 1 from entries where supersedes = ${versionId}`;
  if (next) throw new EntryError(409, 'not_latest_version', ['This version has been replaced; open the latest version.']);
  return row;
}

async function loadEquipment(tx: Tx, id: number): Promise<EquipmentInfo & { active: boolean }> {
  const [eq] = await tx<(EquipmentInfo & { active: boolean })[]>`
    select kind, sterile, classified, active from equipment where id = ${id} for update`;
  if (!eq) throw new EntryError(404, 'not_found');
  return eq;
}

function validate(type: string, raw: Record<string, unknown>, settings: LogbookSettings, eq: EquipmentInfo, start: Date, ctx: EntryContext) {
  const parsed = DATA_SCHEMAS[type]!.safeParse(raw);
  if (!parsed.success) throw new EntryError(400, 'invalid_data', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const data = parsed.data as Record<string, unknown>;
  const problems = checkData(type, data, settings, eq, start, ctx);
  if (problems.length) throw new EntryError(400, 'check_failed', problems);
  // Dates inside data are stored as ISO strings so the stored JSON and the signed content match.
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

async function insertVersion(tx: Tx, v: Omit<EntryRow, 'id' | 'entered_at' | 'entry_id'> & { entry_id?: number }): Promise<EntryRow> {
  const [row] = await tx.unsafe<EntryRow[]>(
    `insert into entries (equipment_id, logbook_type, settings_id, entry_id, version, supersedes, change, activity_start,
       activity_end, product_id, batch, data, late, late_reason, correction_reason, entered_by)
     values ($1, $2, $3, coalesce($4, nextval('entry_ids')), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning ${ENTRY_COLS}`,
    [v.equipment_id, v.logbook_type, v.settings_id, v.entry_id ?? null, v.version, v.supersedes, v.change, v.activity_start,
      v.activity_end, v.product_id, v.batch, tx.json(v.data as never), v.late, v.late_reason, v.correction_reason, v.entered_by] as never[],
  );
  return row!;
}

async function settingsFor(tx: Tx, type: string): Promise<{ id: number; settings: LogbookSettings }> {
  const s = await settingsInForce(tx, type);
  const settings = s?.settings as LogbookSettings | undefined;
  if (!s || !settings?.enabled) throw new EntryError(409, 'type_not_configured', ['This logbook type has no approved settings switched on at this site.']);
  return { id: s.id, settings };
}

export function entryRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requireRole() };

  // Create an entry (LB-01–04, LB-10, LB-11).
  app.post<{ Params: { id: string } }>('/api/equipment/:id/entries', anyUser, async (req, reply) => {
    const equipmentId = parseId(req.params.id);
    const body = createBody.safeParse(req.body);
    if (equipmentId === null || !body.success) return invalid(reply, body.error?.issues);
    const b = body.data;
    const user = req.user!;
    const type = typeByKey(b.logbookType);
    try {
      if (!type || !DATA_SCHEMAS[b.logbookType]) throw new EntryError(400, 'type_not_available');
      if (!mayRecord(b.logbookType, user.roles)) throw new EntryError(403, 'forbidden');
      const signs = performerSigns(b.logbookType);
      if (signs && !b.signature) throw new EntryError(400, 'signature_required');
      // Authenticate first, in its own transaction, so a wrong password always counts (LB-20).
      const signer = signs ? await authenticateSigner(sql, user, { ...b.signature!, contentHash: '0'.repeat(64) } as SignInput,
        { objectType: 'entry', objectId: 0, meaning: 'performed' }) : null;
      const voice = await voiceSigner(sql, user, b);

      const created = await sql.begin(async (tx) => {
        const eq = await loadEquipment(tx, equipmentId);
        if (!eq.active) throw new EntryError(409, 'equipment_retired');
        if (!type.appliesTo.includes(eq.kind)) throw new EntryError(400, 'type_not_for_equipment');
        if (type.sterile && !eq.sterile) throw new EntryError(400, 'type_not_for_equipment');
        const { id: settingsId, settings } = await settingsFor(tx, b.logbookType);
        const isUse = b.logbookType === 'equipment_use';
        // LB-05–07: a new use is refused unless the item is fit; the reasons are shown to the user.
        // The equipment row is locked, so the status cannot change before this entry commits.
        const status = (await statusOf(tx, equipmentId))!;
        if (isUse && status.blockers.length) throw new EntryError(409, 'not_fit_for_use', status.blockers);
        // A sterilisation cycle needs a steriliser that is in service, calibrated and has passed its tests.
        if (b.logbookType === 'steriliser_cycle' && status.cycleBlockers.length) throw new EntryError(409, 'not_fit_for_use', status.cycleBlockers);
        // D-22: a steam steriliser needs a verified passed leak or air-removal test on record (A1 8.60–8.61).
        if (b.logbookType === 'steriliser_cycle' && b.data.cycleType === 'steam' && !status.hasPassedSterilizerTest) {
          throw new EntryError(409, 'not_fit_for_use', ['No verified passed steriliser test on record: test the steriliser first.']);
        }
        if (b.logbookType === 'equipment_cleaning' || b.logbookType === 'area_cleaning') cleaningFits(status, b.activityStart);
        if (isUse && (!b.productId || !b.batch)) throw new EntryError(400, 'check_failed', ['Product and batch are required.']);
        if (isUse && b.activityEnd) throw new EntryError(400, 'check_failed', ['Record the end of use when it happens.']);
        // A breakdown may be reported before its repair has ended (D-25); other activities end when recorded.
        const openBreakdown = b.logbookType === 'maintenance' && b.data.kind === 'breakdown' && !b.activityEnd;
        const end = isUse || openBreakdown ? null : (b.activityEnd ?? b.activityStart);
        if (end && end < b.activityStart) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        if (b.productId) {
          const [p] = await tx`select 1 from products where id = ${b.productId} and active`;
          if (!p) throw new EntryError(400, 'check_failed', ['Unknown or inactive product.']);
        }
        const late = timing(await dbNow(tx), [b.activityStart, end], b.lateReason);
        const data = validate(b.logbookType, b.data, settings, eq, b.activityStart, { end, legacy: false });
        await checkCycleId(tx, b.logbookType, equipmentId, data, null);
        await guardVoice(tx, user, equipmentId, b.logbookType, data, b.voiceNotes);
        const row = await insertVersion(tx, {
          equipment_id: equipmentId, logbook_type: b.logbookType, settings_id: settingsId, version: 1, supersedes: null,
          change: 'created', activity_start: b.activityStart, activity_end: end, product_id: b.productId ?? null,
          batch: b.batch ?? null, data, late, late_reason: late ? b.lateReason!.trim() : null, correction_reason: null, entered_by: user.id,
        });
        await audit(tx, { actorId: user.id, action: 'entry.created', objectType: 'entry', objectId: row.id, new: entryContent(row) });
        if (signer) await sign(tx, { signer, objectType: 'entry', objectId: row.id, meaning: 'performed', content: entryContent(row), shownHash: hashOf(row) });
        if (voice) await confirmVoiceNotes(tx, voice, row.id, equipmentId, b.logbookType, data, b.voiceNotes);
        return row;
      });
      return reply.code(201).send({ id: created.id, entryId: created.entry_id, late: created.late });
    } catch (e) {
      return send(reply, e);
    }
  });

  // End of an equipment use, or completion of a breakdown repair: a new version with the end time
  // (LB-01, LB-10). A repair completion adds the repair data and is signed by the performer (D-16, D-25).
  app.post<{ Params: { id: string } }>('/api/entries/:id/complete', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = completeBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    const b = body.data;
    const user = req.user!;
    try {
      // Refuse what cannot be completed before checking a password (review S9); re-checked under the lock.
      const [peek] = await sql<{ logbook_type: string; data: Record<string, unknown>; activity_end: Date | null; replaced: boolean }[]>`
        select logbook_type, data, activity_end, exists (select 1 from entries x where x.supersedes = e.id) as replaced from entries e where id = ${id}`;
      if (!peek) throw new EntryError(404, 'not_found');
      if (!isOpenable(peek.logbook_type, peek.data) || peek.activity_end || peek.replaced) throw new EntryError(409, 'not_open');
      if (!mayRecord(peek.logbook_type, user.roles)) throw new EntryError(403, 'forbidden');
      const repair = peek.logbook_type === 'maintenance';
      if (repair && (!b.signature || !b.data)) throw new EntryError(400, 'signature_required');
      if (!repair && b.voiceNotes.length) throw new EntryError(400, 'check_failed', ['Ending a use takes no voice note.']);
      const signer = repair ? await authenticateSigner(sql, user, { ...b.signature!, contentHash: '0'.repeat(64) } as SignInput,
        { objectType: 'entry', objectId: id, meaning: 'performed' }) : null;
      const voice = await voiceSigner(sql, user, b);
      const row = await sql.begin(async (tx) => {
        const prev = await latestVersion(tx, id);
        if (!isOpenable(prev.logbook_type, prev.data) || prev.activity_end || prev.logbook_type !== peek!.logbook_type) throw new EntryError(409, 'not_open');
        if (!mayRecord(prev.logbook_type, user.roles)) throw new EntryError(403, 'forbidden');
        if (b.activityEnd < prev.activity_start) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        const late = timing(await dbNow(tx), [b.activityEnd], b.lateReason);
        let data = prev.data;
        if (repair) {
          const eq = await loadEquipment(tx, prev.equipment_id);
          const [s] = await tx<{ settings: LogbookSettings }[]>`select settings from logbook_settings where id = ${prev.settings_id}`;
          data = validate('maintenance', b.data!, s!.settings, eq, prev.activity_start, { end: b.activityEnd, legacy: await isLegacyBreakdown(tx, prev.entry_id) });
          // What was reported stays as reported; changing it is a correction with a reason (LB-17).
          const changed = REPORTED_FIELDS.filter((k) => prev.data[k] !== undefined && JSON.stringify(prev.data[k]) !== JSON.stringify(data[k]));
          if (changed.length) throw new EntryError(400, 'check_failed', [`Completing the repair cannot change what was reported (${changed.join(', ')}): use Correct.`]);
          await guardVoice(tx, user, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        }
        const next = await insertVersion(tx, {
          ...prev, entry_id: prev.entry_id, version: prev.version + 1, supersedes: prev.id, change: 'completed',
          activity_end: b.activityEnd, data, late: prev.late || late,
          late_reason: late ? b.lateReason!.trim() : prev.late_reason, correction_reason: null, entered_by: user.id,
        });
        await audit(tx, { actorId: user.id, action: 'entry.completed', objectType: 'entry', objectId: next.id, old: entryContent(prev), new: entryContent(next) });
        if (signer) await sign(tx, { signer, objectType: 'entry', objectId: next.id, meaning: 'performed', content: entryContent(next), shownHash: hashOf(next) });
        if (voice) await confirmVoiceNotes(tx, voice, next.id, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        return next;
      });
      return { id: row.id };
    } catch (e) {
      return send(reply, e);
    }
  });

  // LB-17: a correction is a new version with a reason and a "Corrected" e-signature; the
  // original stays readable and verifications must be redone.
  app.post<{ Params: { id: string } }>('/api/entries/:id/correct', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = correctBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    const b = body.data;
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, user, { ...b.signature, contentHash: '0'.repeat(64) }, { objectType: 'entry', objectId: id, meaning: 'corrected' });
      const voice = await voiceSigner(sql, user, b);
      const row = await sql.begin(async (tx) => {
        const prev = await latestVersion(tx, id);
        const [first] = await tx<{ entered_by: number; entered_at: Date }[]>`
          select entered_by::int, entered_at from entries where entry_id = ${prev.entry_id} and version = 1`;
        const own = first!.entered_by === user.id || prev.entered_by === user.id;
        if (!mayCorrect(prev.logbook_type, user.roles, own)) {
          throw new EntryError(403, 'forbidden');
        }
        const eq = await loadEquipment(tx, prev.equipment_id);
        const [s] = await tx<{ settings: LogbookSettings }[]>`select settings from logbook_settings where id = ${prev.settings_id}`;
        if (prev.logbook_type === 'equipment_cleaning' || prev.logbook_type === 'area_cleaning') {
          cleaningFits((await statusOf(tx, prev.equipment_id))!, b.activityStart);
        }
        // A correction keeps an open use open and a finished activity finished (review S3-2).
        if (prev.activity_end === null && b.activityEnd) {
          throw new EntryError(400, 'check_failed', [prev.logbook_type === 'maintenance' ? 'Complete the repair with "Complete repair", not by a correction.' : 'End the use with "End use", not by a correction.']);
        }
        if (prev.activity_end !== null && b.activityEnd === null) throw new EntryError(400, 'check_failed', ['A finished activity cannot be reopened.']);
        const end = b.activityEnd === undefined || b.activityEnd === null ? prev.activity_end : b.activityEnd;
        if (end && end < b.activityStart) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        if (prev.logbook_type === 'equipment_use' && (b.productId === null || b.batch === null)) {
          throw new EntryError(400, 'check_failed', ['Product and batch are required.']);
        }
        const now = await dbNow(tx);
        timing(now, [b.activityStart, end], 'n/a');
        // LB-04: lateness is judged against when the entry was first made (review S3-1).
        const latest = Math.max(b.activityStart.getTime(), end?.getTime() ?? 0);
        const late = latest < first!.entered_at.getTime() - LATE_MINUTES * 60_000;
        const lateReason = late ? (b.lateReason?.trim() || prev.late_reason) : null;
        if (late && !lateReason) {
          throw new EntryError(400, 'late_reason_required', [`The corrected time is more than ${LATE_MINUTES} minutes before the entry was made: give a reason.`]);
        }
        const breakdownEntry = prev.logbook_type === 'maintenance' && prev.data.kind === 'breakdown';
        const data = validate(prev.logbook_type, b.data, s!.settings, eq, b.activityStart, { end, legacy: breakdownEntry && await isLegacyBreakdown(tx, prev.entry_id) });
        // An open repair stays a breakdown until it is completed (D-25).
        if (prev.activity_end === null && prev.logbook_type === 'maintenance' && data.kind !== 'breakdown') {
          throw new EntryError(400, 'check_failed', ['An open breakdown stays a breakdown; complete the repair first.']);
        }
        await checkCycleId(tx, prev.logbook_type, prev.equipment_id, data, prev.entry_id);
        await guardVoice(tx, user, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        const next = await insertVersion(tx, {
          ...prev, entry_id: prev.entry_id, version: prev.version + 1, supersedes: prev.id, change: 'corrected',
          activity_start: b.activityStart, activity_end: end, late, late_reason: lateReason,
          product_id: b.productId === undefined ? prev.product_id : b.productId,
          batch: b.batch === undefined ? prev.batch : b.batch, data, correction_reason: b.reason, entered_by: user.id,
        });
        await audit(tx, { actorId: user.id, action: 'entry.corrected', objectType: 'entry', objectId: next.id,
          old: entryContent(prev), new: entryContent(next), reason: b.reason });
        await sign(tx, { signer, objectType: 'entry', objectId: next.id, meaning: 'corrected', content: entryContent(next), shownHash: hashOf(next) });
        if (voice) await confirmVoiceNotes(tx, voice, next.id, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        return next;
      });
      return { id: row.id };
    } catch (e) {
      return send(reply, e);
    }
  });

  // LB-03: second-person verification of the latest version, signed against the content shown.
  app.post<{ Params: { id: string } }>('/api/entries/:id/verify', { preHandler: requireRole(...VERIFIERS) }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, user, body.data, { objectType: 'entry', objectId: id, meaning: 'verified' });
      await sql.begin(async (tx) => {
        const row = await latestVersion(tx, id);
        const [s] = await tx<{ settings: LogbookSettings }[]>`select settings from logbook_settings where id = ${row.settings_id}`;
        if (!verificationNeeded(row.logbook_type, s!.settings)) throw new EntryError(409, 'verification_not_required');
        if (isOpenable(row.logbook_type, row.data) && !row.activity_end) throw new EntryError(409, 'not_finished', ['Verify after the activity has ended.']);
        // Nobody verifies their own work: neither the performer nor whoever made this version.
        const people = await tx<{ entered_by: number }[]>`select distinct entered_by::int from entries where entry_id = ${row.entry_id}`;
        if (people.some((p) => p.entered_by === user.id)) throw new EntryError(403, 'own_entry', ['You cannot verify an entry you made or changed.']);
        if (performerSigns(row.logbook_type)) {
          const [performed] = await tx`select 1 from signatures where object_type = 'entry' and meaning in ('performed', 'corrected')
            and object_id in (select id from entries where entry_id = ${row.entry_id})`;
          if (!performed) throw new EntryError(409, 'not_performed');
        }
        await sign(tx, { signer, objectType: 'entry', objectId: row.id, meaning: 'verified', content: entryContent(row), shownHash: body.data.contentHash });
      });
      return { ok: true };
    } catch (e) {
      return send(reply, e);
    }
  });

  // LB-06: QA returns equipment to service after a breakdown, with a "Released" e-signature on
  // the verified breakdown entry (SchM 18.4.3; Annex 1 5.6).
  app.post<{ Params: { id: string } }>('/api/entries/:id/release', { preHandler: requireRole('qa') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    try {
      const signer = await authenticateSigner(sql, req.user!, body.data, { objectType: 'entry', objectId: id, meaning: 'released' });
      await sql.begin(async (tx) => {
        const row = await latestVersion(tx, id);
        if (row.logbook_type !== 'maintenance' || row.data.kind !== 'breakdown') throw new EntryError(409, 'not_a_breakdown');
        const [verified] = await tx`select 1 from signatures where object_type = 'entry' and object_id = ${row.id} and meaning = 'verified'`;
        if (!verified) throw new EntryError(409, 'not_verified', ['The breakdown entry must be verified before release.']);
        await sign(tx, { signer, objectType: 'entry', objectId: row.id, meaning: 'released', content: entryContent(row), shownHash: body.data.contentHash });
      });
      return { ok: true };
    } catch (e) {
      return send(reply, e);
    }
  });

  // Status of every item (home screen, tiles) and of one item (logbook page).
  app.get('/api/equipment/status', anyUser, async () => allStatuses(sql));
  app.get<{ Params: { id: string } }>('/api/equipment/:id/status', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return (await statusOf(sql, id)) ?? reply.code(404).send({ error: 'not_found' });
  });

  // The logbook of one equipment item or area: latest version of each entry, newest first.
  app.get<{ Params: { id: string } }>('/api/equipment/:id/entries', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return withMayCorrect(sql, req.user!, await listEntries(sql, sql`e.equipment_id = ${id}`));
  });

  // All versions of one entry, oldest first, with their signatures (LB-17: originals stay readable).
  app.get<{ Params: { id: string } }>('/api/entries/:id/versions', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await sql.unsafe<EntryRow[]>(
      `select ${ENTRY_COLS} from entries where entry_id = (select entry_id from entries where id = $1) order by version`, [id]);
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    return present(sql, rows);
  });

  // LB-26: open items, so nothing is silently left unfinished.
  app.get('/api/entries/open', anyUser, async () => {
    const always = LOGBOOK_TYPES.filter((t) => t.alwaysVerified).map((t) => t.key);
    const rows = await listEntries(
      sql,
      sql`((e.logbook_type = 'equipment_use' and e.activity_end is null)
        or ((e.logbook_type = any(${always}) or coalesce((s.settings->>'verificationRequired')::boolean, false))
            and not exists (select 1 from signatures g where g.object_type = 'entry' and g.object_id = e.id and g.meaning = 'verified')
            and not (e.logbook_type = 'equipment_use' and e.activity_end is null)))`,
      null,
    );
    return rows.filter((r) => r.awaitingVerification || r.inProgress);
  });
}

interface SigRow { object_id: number; printed_name: string; meaning: string; signed_at: Date; content_hash: string }

// Presents entry versions with their signatures and the name of who entered them, in two queries.
export async function present(sql: Sql, rows: EntryRow[], needsVerification?: (r: EntryRow) => boolean) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sigs = await sql<SigRow[]>`
    select object_id::int, printed_name, meaning, signed_at, content_hash from signatures
    where object_type = 'entry' and object_id = any(${ids}::bigint[]) order by signed_at`;
  const voices = await voiceNotesFor(sql, rows);
  const names = new Map(
    (await sql<{ id: number; full_name: string }[]>`
      select id::int, full_name from users where id = any(${[...new Set(rows.map((r) => r.entered_by))]}::bigint[])`).map((u) => [u.id, u.full_name]),
  );
  return rows.map((r) => {
    const hash = hashOf(r);
    const mine = sigs.filter((g) => g.object_id === r.id);
    return {
      id: r.id,
      entryId: r.entry_id,
      version: r.version,
      change: r.change,
      equipmentId: r.equipment_id,
      logbookType: r.logbook_type,
      activityStart: r.activity_start,
      activityEnd: r.activity_end,
      productId: r.product_id,
      batch: r.batch,
      data: r.data,
      late: r.late,
      lateReason: r.late_reason,
      correctionReason: r.correction_reason,
      enteredBy: names.get(r.entered_by),
      enteredAt: r.entered_at,
      contentHash: hash,
      signatures: mine.map((g) => ({ printedName: g.printed_name, meaning: g.meaning, signedAt: g.signed_at, valid: g.content_hash === hash })),
      // D-26: voice notes whose signed English text is in this version.
      voiceNotes: voices.get(r.id) ?? [],
      ...(needsVerification
        ? {
            awaitingVerification: needsVerification(r) && !mine.some((g) => g.meaning === 'verified'),
            inProgress: isOpenable(r.logbook_type, r.data) && !r.activity_end,
          }
        : {}),
    };
  });
}

// limit null: every matching row (open items must never be cut off; LB-26).
async function listEntries(sql: Sql, where: ReturnType<Sql>, limit: number | null = 500) {
  const rows = await sql<(EntryRow & { settings: LogbookSettings })[]>`
    select e.id::int, e.equipment_id::int, e.logbook_type, e.settings_id::int, e.entry_id::int, e.version, e.supersedes::int,
      e.change, e.activity_start, e.activity_end, e.product_id::int, e.batch, e.data, e.late, e.late_reason,
      e.correction_reason, e.entered_by::int, e.entered_at, s.settings
    from entries e join logbook_settings s on s.id = e.settings_id
    where ${where} and not exists (select 1 from entries x where x.supersedes = e.id)
    order by e.activity_start desc ${limit === null ? sql`` : sql`limit ${limit}`}`;
  const needs = new Map(rows.map((r) => [r.id, verificationNeeded(r.logbook_type, r.settings)]));
  return present(sql, rows, (r) => needs.get(r.id) ?? false);
}

export type { SessionUser };
