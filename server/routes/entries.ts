import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { batchWithProduct } from './batches.js';
import { batchesOffNote, LIMS, useOf } from '../batches.js';
import { QualificationOff } from '../qualification.js';
import { CyclesOff, batchWords } from '../cycles.js';
import { parseId, requirePermission, type SessionUser } from '../auth.js';
import { LOGBOOK_TYPES, typeByKey, type LogbookSettings } from '../logbook-types.js';
import { DATA_SCHEMAS, REPORTED_FIELDS, checkData, correctCodes, mayCorrect, mayRecord, recordCode, performerSigns, verificationNeeded, type EntryContext, type EquipmentInfo } from '../entries.js';
import { logbookItem, logbookProducts, type LogbookItem, type Master } from '../master.js';
import { SignError, authenticateSigner, contentHash, proofOnly, sign, signBody } from '../signatures.js';
import { settingsInForce } from './settings.js';
import { allStatuses, antibioticBlocker, plantTime, reservationText, statusOf, type EquipmentStatus } from '../status.js';
import { VoiceError, confirmVoiceNotes, unsignedDrafts, voiceNotesFor, type VoiceUse } from '../voice.js';
import { recordTraining, skillName, trainingNeeded, trainingState, type TrainingResult } from '../training.js';

import { LATE_MINUTES } from '../entries.js';
export { LATE_MINUTES };

// A signing proof from core's re-authentication (B1-4, PL-05).
const credentials = proofOnly;
// D-26: voice notes confirmed with this save, and the speaker's separate confirmation signature.
const voiceFields = {
  voiceNotes: z.array(z.object({ id: z.number().int().positive(), field: z.string().max(40), finalText: z.string().max(2000), shownHash: z.string().regex(/^[0-9a-f]{64}$/) })).max(10).default([]),
  voiceSignature: credentials.optional(),
};
// D-71: Recruitment not linked or not reachable: the signer states "I am trained in <skill>" (typed by hand).
const trainedTyped = z.boolean().default(false);
const verifyBody = signBody.extend({ trainedTyped });

const createBody = z.object({
  logbookType: z.string(),
  activityStart: z.coerce.date(),
  activityEnd: z.coerce.date().optional(),
  productId: z.number().int().positive().optional(),
  batch: z.string().trim().min(1).max(60).optional(),
  // D-69: the batch (of a change over: the batches not in the list) typed by hand, its product picked from master data.
  batchTyped: z.boolean().default(false),
  data: z.record(z.unknown()),
  lateReason: z.string().trim().max(500).optional(),
  // Required for types whose performer signs (D-16).
  signature: credentials.optional(),
  trainedTyped,
  ...voiceFields,
});
// Ends a use, or completes the repair of a breakdown (D-25): then with the repair data and the
// performer's signature.
const completeBody = z.object({
  activityEnd: z.coerce.date(),
  lateReason: z.string().trim().max(500).optional(),
  // D-49: why a use ends (data field endReason).
  endReason: z.string().trim().max(500).optional(),
  data: z.record(z.unknown()).optional(),
  signature: credentials.optional(),
  trainedTyped,
  ...voiceFields,
});
const correctBody = z.object({
  activityStart: z.coerce.date(),
  activityEnd: z.coerce.date().nullable().optional(),
  productId: z.number().int().positive().nullable().optional(),
  batch: z.string().trim().min(1).max(60).nullable().optional(),
  batchTyped: z.boolean().default(false),
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
  'signature.proof': 'Sign again: confirm your password in the sign window.',
  proof: 'Sign again: confirm your password in the sign window.',
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
  return entries.map((x) => ({ ...x, mayCorrect: mayCorrect(x.logbookType, user.permissions, own.get(x.id) ?? false) }));
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
// (review S4-3/7). D-46: a use open in TrueBatch (D-47: or TrueBatch Packing) ends there, when the batch is done with it (D-49).
function cleaningFits(status: Pick<EquipmentStatus, 'inUse' | 'lastUseEnd'>, start: Date) {
  if (status.inUse && status.inUse.source !== 'Logbook') {
    const { batch, source } = status.inUse;
    const what = useOf(source); // D-76: an analysis in LIMS
    throw new EntryError(409, 'in_use', [`In use by ${what} ${batch} in ${source}: record the cleaning once the ${what} is done with it in ${source}.`]);
  }
  if (status.inUse) throw new EntryError(409, 'in_use', ['End the current use before recording a cleaning.']);
  // Forms enter times to the minute, so compare at minute precision.
  const useEndMinute = status.lastUseEnd ? Math.floor(status.lastUseEnd.getTime() / 60_000) * 60_000 : null;
  if (useEndMinute !== null && start.getTime() < useEndMinute) {
    throw new EntryError(400, 'check_failed', ['A cleaning cannot start before the last use ended.']);
  }
}

// D-49: ending a use is a Logbook entry like any other, so it may say why; it must when the batch is from another product's
// batch records (TrueBatch), which the Logbook does not keep: the reason is the record of why the use ended
// here. Returns those products, or null when the reason is optional. The screen asks the same rule (S11).
// D-69: a batch typed by hand is not from the batch records.
export const endReasonFrom = (app: FastifyInstance, type: string, batch: string | null, data: Record<string, unknown> = {}) =>
  type === 'equipment_use' && batch && app.batches && !data.batchTyped ? app.batches.source.replaceAll(', ', ' or ') : null;

/**
 * D-69 (owner 17 Nov 2026, G2): with batch records linked, a batch is pulled from the product that lists it, with that
 * product. A batch none of them lists (its product is not linked here, or its link is down) may be typed by hand, its
 * product picked from master data; the entry says so ("Typed by hand") for the reviewer. A typed batch that a linked
 * product lists with another product is refused. Returns the product and, for a typed batch, why it was typed.
 */
async function linkedBatch(tx: Tx, app: FastifyInstance, n: string, o: { typed: boolean; mustRun: boolean; product: { id?: number | null; label?: string } }) {
  const { found, down } = await batchWithProduct(tx, app, n);
  if (found) {
    const { batch } = found;
    if (o.mustRun && !batch.inProduction) throw new EntryError(409, 'check_failed', [`Batch ${n} is not in production in ${batch.source} (${batch.status}).`]);
    if (!found.productId) throw new EntryError(409, 'check_failed', [`The product ${batch.productCode} of batch ${n} is not in master data: ask your master data editor.`]);
    const other = o.typed && ((o.product.id && o.product.id !== found.productId) || (o.product.label && o.product.label !== found.productLabel));
    if (other) throw new EntryError(409, 'check_failed', [`Batch ${n} is in ${batch.source} with the product ${found.productLabel}: choose it from the list.`]);
    return { productId: found.productId, productLabel: found.productLabel, typed: null };
  }
  const notes = down.map(batchesOffNote);
  if (!o.typed) {
    throw new EntryError(400, 'check_failed', [`Batch ${n} is not in the batch records (${app.batches!.source}): choose it from the list or type it by hand.`, ...notes]);
  }
  const products = (await logbookProducts(tx, app.master)).filter((p) => p.active);
  const p = products.find((x) => (o.product.id ? x.id === o.product.id : `${x.code} · ${x.name}` === o.product.label));
  if (!p) throw new EntryError(400, 'check_failed', [`Pick the product of batch ${n} from master data.`]);
  return { productId: p.id, productLabel: `${p.code} · ${p.name}`, typed: down.length ? `${down.join(', ')} not reachable` : 'not in the linked batch records' };
}

/**
 * D-71 (owner 17 Nov 2026): only trained people sign. When the settings in force name a training, the person signing
 * "performed" or "verified" must be qualified in it in Recruitment (training_v1); else refused, and another trained person
 * signs. Recruitment not linked or not reachable: the signer states it ("I am trained in ..."), and the signature is
 * marked "Training typed by hand". Returns what to keep with the signature, or null when no training is named.
 */
async function trainedSigner(tx: Tx, app: FastifyInstance, user: SessionUser, type: string, fallback: LogbookSettings | undefined, typed: boolean): Promise<TrainingResult | null> {
  const inForce = await settingsInForce(tx, type);
  const st = await trainingState(app.training, user, trainingNeeded((inForce?.settings as LogbookSettings | undefined) ?? fallback));
  if (!st.needed) return null;
  if (st.state === 'trained') return { skill: st.needed, typed: false, validUntil: st.validUntil, note: st.note };
  if (st.state === 'not_trained') throw new EntryError(403, 'not_trained', [st.message]);
  if (!typed) throw new EntryError(400, 'training_confirmation_required', [st.message]);
  return { skill: st.needed, typed: true, validUntil: null,
    note: `Training typed by hand (Recruitment ${st.why}): ${user.fullName} stated being trained in ${skillName(st.needed)}` };
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

/**
 * D-78 (owner, 19 Nov 2026): with TrueBatch Injectables linked, a cycle run for one of its batches is recorded in the batch
 * record there and shown here read only; the Logbook records only cycles not made for a batch (empty chamber, non-batch
 * loads). A cycle entry naming a batch (the entry's batch, or a batch number of its batch records in the load or cycle
 * number) is refused. Its link down: not checked, and the entry says so. Without the link (standalone) nothing changes.
 */
export const cycleForBatchMessage = (source: string, batch: string) =>
  `Batch ${batch}: a sterilisation cycle for a batch is recorded in its batch record in ${source} and shown here read only. Record here only cycles not made for a batch (e.g. empty chamber, non-batch loads).`;
async function notForBatch(app: FastifyInstance, type: string, batch: string | null | undefined, data: Record<string, unknown>): Promise<Record<string, string>> {
  if (type !== 'steriliser_cycle' || !app.cycles) return {};
  if (batch) throw new EntryError(400, 'check_failed', [cycleForBatchMessage(app.cycles.source, batch)]);
  try {
    const [found] = await app.cycles.batchesIn(batchWords(String(data.load ?? ''), String(data.cycleId ?? '')));
    if (found) throw new EntryError(400, 'check_failed', [cycleForBatchMessage(app.cycles.source, found)]);
    return {};
  } catch (e) {
    if (e instanceof CyclesOff) return { batchNotChecked: `${app.cycles.source} was not reachable` };
    throw e;
  }
}

/**
 * D-84 (fix round 21 Nov 2026): a move to another room. The room moved to is an active room of master data (picked, never
 * typed); the room moved from is where the Logbook has the item now (its last move here, else master data's room), set
 * here, never by the form. A correction keeps the room moved from.
 */
async function roomMove(app: FastifyInstance, item: LogbookItem, data: Record<string, unknown>, fromRoom: string | null) {
  const to = String(data.toRoom ?? '').trim();
  const room = (await app.master.items()).find((i) => i.kind === 'area' && i.active && i.code.toLowerCase() === to.toLowerCase());
  if (!room) throw new EntryError(400, 'check_failed', [`${to || 'The room'} is not an active room in master data: choose the room from the list.`]);
  if (fromRoom && room.code.toLowerCase() === fromRoom.toLowerCase()) throw new EntryError(400, 'check_failed', [`${item.code} is in ${room.code} already.`]);
  return { toRoom: room.code, fromRoom: fromRoom ?? '' };
}

async function dbNow(tx: Tx): Promise<Date> {
  const [r] = await tx<{ now: Date }[]>`select now() as now`;
  return r!.now;
}

// D-26: the speaker confirms voice-note text with a signature of its own. One re-authentication at core may serve
// both signatures of one save (same proof): the signer entered both components for this save (11.200(a)(1)).
// Each signature still checks its own code (D-30).
async function voiceSigner(sql: Sql, key: Buffer, user: SessionUser, b: { voiceNotes: VoiceUse[]; voiceSignature?: { proof: string }; signature?: { proof: string } }) {
  if (!b.voiceNotes.length) return null;
  if (!b.voiceSignature) throw new EntryError(400, 'voice_signature_required', ['Sign to confirm the voice-note text.']);
  return authenticateSigner(sql, key, user, b.voiceSignature, { objectType: 'voice_note', objectId: 0, meaning: 'voice_confirmed', needs: ['logbook.voice_note.record'] });
}

// Refuses a voice translation that is not being confirmed now; links and signs those that are.
async function guardVoice(tx: Tx, user: SessionUser, equipmentId: number, type: string, data: Record<string, unknown>, uses: VoiceUse[]) {
  const problems = await unsignedDrafts(tx, user.id, equipmentId, type, data, uses.map((u) => u.id));
  if (problems.length) throw new EntryError(400, 'voice_confirmation_required', problems);
}

// An open breakdown repair or use is completed, not corrected (D-25).
const isOpenable = (type: string, data: Record<string, unknown>) =>
  type === 'equipment_use' || type === 'change_over' || (type === 'maintenance' && data.kind === 'breakdown');

// Owner 2026-11-12 ("one activity at a time"): the activities that occupy an item. While one is in progress (a use, a
// change over, a repair not finished) nothing else is recorded on the item except reporting a breakdown or a note, and
// no two of them may overlap in time. A breakdown may happen during another activity, so it is not checked for overlap.
const ACTIVITIES = ['equipment_use', 'equipment_cleaning', 'area_cleaning', 'change_over', 'maintenance', 'calibration', 'requalification', 'room_move'];
const ACTIVITY_LABEL: Record<string, string> = { equipment_use: 'in use', change_over: 'in change over', maintenance: 'under repair' };
async function oneActivityAtATime(tx: Tx, equipmentId: number, type: string, data: Record<string, unknown>, start: Date, end: Date | null,
  ignoreEntryId: number | null = null, checkOpen = true) {
  const breakdown = type === 'maintenance' && data.kind === 'breakdown';
  if (type === 'general_log' || breakdown || !ACTIVITIES.includes(type)) return;
  const [open] = await tx<{ logbook_type: string; activity_start: Date }[]>`
    select e.logbook_type, e.activity_start from entries e
    where e.equipment_id = ${equipmentId} and e.activity_end is null and not exists (select 1 from entries x where x.supersedes = e.id)
      and (e.logbook_type in ('equipment_use', 'change_over') or (e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown'))
      and (${ignoreEntryId}::bigint is null or e.entry_id <> ${ignoreEntryId}::bigint)
    order by e.activity_start desc limit 1`;
  if (open && checkOpen) {
    throw new EntryError(409, 'busy', [`This item is ${ACTIVITY_LABEL[open.logbook_type] ?? 'busy'} since ${plantTime(open.activity_start)}: end that first. One activity at a time.`]);
  }
  const [clash] = await tx<{ logbook_type: string }[]>`
    select e.logbook_type from entries e
    where e.equipment_id = ${equipmentId} and e.logbook_type = any(${ACTIVITIES}::text[])
      and not (e.logbook_type = 'maintenance' and e.data->>'kind' = 'breakdown')
      and not exists (select 1 from entries x where x.supersedes = e.id)
      and (${ignoreEntryId}::bigint is null or e.entry_id <> ${ignoreEntryId}::bigint)
      -- Forms enter whole minutes (S5): an activity may start in the minute the previous one ended.
      and e.activity_start < coalesce(${end}::timestamptz, 'infinity') and ${start}::timestamptz < coalesce(date_trunc('minute', e.activity_end), 'infinity')
    limit 1`;
  if (clash) throw new EntryError(409, 'busy', [`The time overlaps another activity on this item (${clash.logbook_type.replaceAll('_', ' ')}). One activity at a time.`]);
}

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

// PL-08 (A11 5): a product must be in master data and active when an entry refers to it.
async function activeProduct(tx: Tx, master: Master, id: number) {
  const p = (await logbookProducts(tx, master)).find((x) => x.id === id);
  if (!p?.active) throw new EntryError(400, 'check_failed', ['Unknown or inactive product.']);
}

// The item's kind never changes; sterile and classified are the Logbook's own settings (D-29).
async function loadEquipment(tx: Tx, id: number): Promise<EquipmentInfo> {
  const [eq] = await tx<EquipmentInfo[]>`
    select kind, sterile, classified from equipment where id = ${id} for update`;
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

async function insertVersion(tx: Tx, master: Master, v: Omit<EntryRow, 'id' | 'entered_at' | 'entry_id'> & { entry_id?: number }): Promise<EntryRow> {
  const [row] = await tx.unsafe<EntryRow[]>(
    `insert into entries (equipment_id, logbook_type, settings_id, entry_id, version, supersedes, change, activity_start,
       activity_end, product_id, batch, data, late, late_reason, correction_reason, entered_by)
     values ($1, $2, $3, coalesce($4, nextval('entry_ids')), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning ${ENTRY_COLS}`,
    [v.equipment_id, v.logbook_type, v.settings_id, v.entry_id ?? null, v.version, v.supersedes, v.change, v.activity_start,
      v.activity_end, v.product_id, v.batch, tx.json(v.data as never), v.late, v.late_reason, v.correction_reason, v.entered_by] as never[],
  );
  // PL-07: the master values this version is made with, kept as they are now.
  const item = await logbookItem(tx, master, v.equipment_id);
  if (!item) throw new EntryError(409, 'equipment_unknown', ['No such equipment in master data.']);
  const product = v.product_id ? (await logbookProducts(tx, master)).find((p) => p.id === v.product_id) : undefined;
  if (v.product_id && !product) throw new EntryError(409, 'check_failed', ['Unknown product in master data.']);
  await tx`insert into entry_master_values (entry_version_id, item_id, item_code, item_name, item_version,
      product_item_id, product_code, product_name, product_version)
    values (${row!.id}, ${item.itemId}, ${item.code}, ${item.name}, ${item.version},
      ${product?.itemId ?? null}, ${product?.code ?? null}, ${product?.name ?? null}, ${product?.version ?? null})`;
  return row!;
}

async function settingsFor(tx: Tx, type: string): Promise<{ id: number; settings: LogbookSettings }> {
  const s = await settingsInForce(tx, type);
  const settings = s?.settings as LogbookSettings | undefined;
  if (!s || !settings?.enabled) throw new EntryError(409, 'type_not_configured', ['This logbook type has no approved settings switched on at this site.']);
  return { id: s.id, settings };
}

export function entryRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

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
      if (!mayRecord(b.logbookType, user.permissions)) throw new EntryError(403, 'forbidden');
      const signs = performerSigns(b.logbookType);
      if (signs && !b.signature) throw new EntryError(400, 'signature_required');
      // Check the signing proofs first, in their own transaction, so a refused one is always audited (LB-20).
      const signer = signs ? await authenticateSigner(sql, app.proofKey, user, b.signature!,
        { objectType: 'entry', objectId: 0, meaning: 'performed', needs: [recordCode(b.logbookType)!] }) : null;
      const voice = await voiceSigner(sql, app.proofKey, user, b);

      const created = await sql.begin(async (tx) => {
        const eq = await loadEquipment(tx, equipmentId);
        // PL-08 (A11 5): the item must be in master data and active when the entry is written.
        const item = await logbookItem(tx, app.master, equipmentId);
        if (!item) throw new EntryError(409, 'equipment_unknown', ['No such active equipment in master data.']);
        if (!item.active) throw new EntryError(409, 'equipment_retired');
        if (!type.appliesTo.includes(eq.kind)) throw new EntryError(400, 'type_not_for_equipment');
        if (type.sterile && !eq.sterile) throw new EntryError(400, 'type_not_for_equipment');
        const { id: settingsId, settings } = await settingsFor(tx, b.logbookType);
        const trained = signer ? await trainedSigner(tx, app, user, b.logbookType, settings, b.trainedTyped) : null;
        const isUse = b.logbookType === 'equipment_use';
        // LB-05–07: a new use is refused unless the item is fit; the reasons are shown to the user.
        // The equipment row is locked, so the status cannot change before this entry commits.
        const ctx = await app.statusContext(tx);
        // D-70 (G15): a requalification waits for the Qualification product when its link is down.
        if (b.logbookType === 'requalification' && ctx.qualDown) throw new QualificationOff();
        const status = (await statusOf(tx, equipmentId, ctx))!;
        if (isUse && status.blockers.length) throw new EntryError(409, 'not_fit_for_use', status.blockers);
        // A sterilisation cycle needs a steriliser that is in service, calibrated and has passed its tests.
        if (b.logbookType === 'steriliser_cycle' && status.cycleBlockers.length) throw new EntryError(409, 'not_fit_for_use', status.cycleBlockers);
        // D-22: a steam steriliser needs a verified passed leak or air-removal test on record (A1 8.60–8.61).
        if (b.logbookType === 'steriliser_cycle' && b.data.cycleType === 'steam' && !status.hasPassedSterilizerTest) {
          throw new EntryError(409, 'not_fit_for_use', ['No verified passed steriliser test on record: test the steriliser first.']);
        }
        if (b.logbookType === 'equipment_cleaning' || b.logbookType === 'area_cleaning') {
          cleaningFits(status, b.activityStart);
          // D-46: a cleaning that ends after the dirty hold ran out is late: it says why ("clean, verify and record why").
          if (status.dirtyUntil && (b.activityEnd ?? b.activityStart) > status.dirtyUntil && !String(b.data.delayReason ?? '').trim()) {
            throw new EntryError(400, 'check_failed', [`The dirty hold ran out at ${plantTime(status.dirtyUntil)}: give the reason the cleaning is late.`]);
          }
        }
        // Owner 2026-11-12, D-45: with TrueBatch linked, the batch is one of its batch records and the product is the batch's.
        // D-69: or typed by hand when no linked product lists it (flags.batchTyped says so on the entry).
        const flags: Record<string, string> = {};
        const typedLines: string[] = [];
        if (app.batches && isUse) {
          if (!b.batch) throw new EntryError(400, 'check_failed', ['Choose the batch from the batch records, or type it by hand.']);
          const got = await linkedBatch(tx, app, b.batch, { typed: b.batchTyped, mustRun: true, product: { id: b.productId } });
          b.productId = got.productId;
          if (got.typed) typedLines.push(`Batch ${b.batch}: ${got.typed}`);
        }
        if (app.batches && b.logbookType === 'change_over') {
          for (const [k, product, must, what] of [['fromBatch', 'fromProduct', false, 'From batch'], ['toBatch', 'toProduct', true, 'To batch']] as const) {
            const n = String(b.data[k] ?? '').trim();
            if (!n) continue;
            const got = await linkedBatch(tx, app, n, { typed: b.batchTyped, mustRun: must, product: { label: String(b.data[product] ?? '').trim() } });
            b.data[product] = got.productLabel;
            if (got.typed) typedLines.push(`${what} ${n}: ${got.typed}`);
          }
        }
        if (typedLines.length) flags.batchTyped = typedLines.join('; ');
        // D-70 (G15): a use while Qualification is linked but down is not checked against it; the entry says so.
        if (isUse && ctx.qualDown) flags.qualNotChecked = 'Qualification was not reachable';
        if (isUse && (!b.productId || !b.batch)) throw new EntryError(400, 'check_failed', ['Product and batch are required.']);
        // D-85: an item reserved now for a batch is used for that batch only (a reservation without a batch only warns).
        const held = status.reservation;
        if (isUse && held?.now && held.batch && held.batch.toLowerCase() !== b.batch!.toLowerCase()) {
          throw new EntryError(409, 'reserved', [`${reservationText(held)}. Use it for batch ${held.batch}, or ask for the reservation to be cancelled.`]);
        }
        // D-67: a product change to or from an antibiotic needs a product-changeover cleaning after the last use.
        if (isUse && status.schedule !== null && status.lastUseEnd) {
          const products = await logbookProducts(tx, app.master);
          // The last use's product; for a TrueBatch use without one from its uses (packing), from the batch records.
          const lastCode = status.lastUseProductCode
            ?? (status.lastTrueBatchUse && status.lastTrueBatchUse.source !== LIMS && app.batches ? (await app.batches.get(status.lastTrueBatchUse.batch)).batch?.productCode ?? null : null);
          const next = products.find((p) => p.id === b.productId);
          const last = lastCode ? products.find((p) => p.code === lastCode) ?? { code: lastCode, antibiotic: false } : undefined;
          const problem = next ? antibioticBlocker(last, next, status.changeoverCleaned) : null;
          if (problem) throw new EntryError(409, 'not_fit_for_use', [problem]);
        }
        if (isUse && b.activityEnd) throw new EntryError(400, 'check_failed', ['Record the end of use when it happens.']);
        // A breakdown may be reported before its repair has ended (D-25); a change over may be started and ended later
        // like a use; other activities end when recorded.
        const openBreakdown = b.logbookType === 'maintenance' && b.data.kind === 'breakdown' && !b.activityEnd;
        const openChangeOver = b.logbookType === 'change_over' && !b.activityEnd;
        const end = isUse || openBreakdown || openChangeOver ? null : (b.activityEnd ?? b.activityStart);
        if (b.logbookType === 'change_over' && status.inUse) throw new EntryError(409, 'busy', ['End the use first: a change over follows the use.']);
        // D-84: an item in use (here or in a linked product) is not moved.
        if (b.logbookType === 'room_move') {
          if (status.inUse) throw new EntryError(409, 'busy', [`${item.code} is in use${status.inUse.batch ? ` by batch ${status.inUse.batch}` : ''}: move it once the use has ended.`]);
          Object.assign(b.data, await roomMove(app, item, b.data, item.room));
        }
        await oneActivityAtATime(tx, equipmentId, b.logbookType, b.data, b.activityStart, end);
        // Owner 2026-11-12: a requalification from a protocol takes its stage, result and next due date from the
        // Qualification product (the approved report); nothing is typed again.
        if (b.logbookType === 'requalification' && b.data.source === 'protocol') {
          if (!app.qualification) throw new EntryError(409, 'check_failed', ['The Qualification system is not linked: record the requalification by hand.']);
          const number = String(b.data.protocolNumber ?? '').trim();
          const p = (await app.qualification.protocols(item.itemId)).find((x) => x.number === number);
          if (!p) throw new EntryError(400, 'check_failed', [`Protocol ${number || '(none)'} is not a protocol of ${item.code} in the Qualification system.`]);
          if (!p.reportApprovedAt || !p.reportOutcome) throw new EntryError(409, 'check_failed', [`The report of ${p.number} is not approved yet in the Qualification system.`]);
          Object.assign(b.data, { stage: p.stage, outcome: p.reportOutcome, nextDue: p.nextReviewDueDecided ?? '', reportRef: p.number });
        }
        if (end && end < b.activityStart) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        if (b.productId) await activeProduct(tx, app.master, b.productId);
        const late = timing(await dbNow(tx), [b.activityStart, end], b.lateReason);
        const data = { ...validate(b.logbookType, b.data, settings, eq, b.activityStart, { end, legacy: false }), ...flags };
        Object.assign(data, await notForBatch(app, b.logbookType, b.batch, data));
        await checkCycleId(tx, b.logbookType, equipmentId, data, null);
        await guardVoice(tx, user, equipmentId, b.logbookType, data, b.voiceNotes);
        const row = await insertVersion(tx, app.master, {
          equipment_id: equipmentId, logbook_type: b.logbookType, settings_id: settingsId, version: 1, supersedes: null,
          change: 'created', activity_start: b.activityStart, activity_end: end, product_id: b.productId ?? null,
          batch: b.batch ?? null, data, late, late_reason: late ? b.lateReason!.trim() : null, correction_reason: null, entered_by: user.id,
        });
        await audit(tx, { actorId: user.id, action: 'entry.created', objectType: 'entry', objectId: row.id, new: entryContent(row) });
        if (signer) {
          const s = await sign(tx, { signer, objectType: 'entry', objectId: row.id, meaning: 'performed', content: entryContent(row), shownHash: hashOf(row) });
          if (trained) await recordTraining(tx, s.id, trained);
        }
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
      if (!mayRecord(peek.logbook_type, user.permissions)) throw new EntryError(403, 'forbidden');
      const repair = peek.logbook_type === 'maintenance';
      if (repair && (!b.signature || !b.data)) throw new EntryError(400, 'signature_required');
      if (!repair && b.voiceNotes.length) throw new EntryError(400, 'check_failed', ['Ending a use takes no voice note.']);
      if (b.endReason && peek.logbook_type !== 'equipment_use') throw new EntryError(400, 'check_failed', ['Only a use ends with a reason.']);
      const signer = repair ? await authenticateSigner(sql, app.proofKey, user, b.signature!,
        { objectType: 'entry', objectId: id, meaning: 'performed', needs: [recordCode(peek.logbook_type)!] }) : null;
      const voice = await voiceSigner(sql, app.proofKey, user, b);
      const row = await sql.begin(async (tx) => {
        const prev = await latestVersion(tx, id);
        if (!isOpenable(prev.logbook_type, prev.data) || prev.activity_end || prev.logbook_type !== peek!.logbook_type) throw new EntryError(409, 'not_open');
        if (!mayRecord(prev.logbook_type, user.permissions)) throw new EntryError(403, 'forbidden');
        if (b.activityEnd < prev.activity_start) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        const late = timing(await dbNow(tx), [b.activityEnd], b.lateReason);
        let data = prev.data;
        let trained: TrainingResult | null = null;
        const from = endReasonFrom(app, prev.logbook_type, prev.batch, prev.data);
        if (from && !b.endReason) {
          throw new EntryError(400, 'end_reason_required', [`Batch ${prev.batch} is from the batch records of ${from}: give the reason the use ends.`]);
        }
        if (b.endReason) data = { ...data, endReason: b.endReason };
        if (repair) {
          const eq = await loadEquipment(tx, prev.equipment_id);
          const [s] = await tx<{ settings: LogbookSettings }[]>`select settings from logbook_settings where id = ${prev.settings_id}`;
          trained = await trainedSigner(tx, app, user, prev.logbook_type, s!.settings, b.trainedTyped);
          data = validate('maintenance', b.data!, s!.settings, eq, prev.activity_start, { end: b.activityEnd, legacy: await isLegacyBreakdown(tx, prev.entry_id) });
          // What was reported stays as reported; changing it is a correction with a reason (LB-17).
          const changed = REPORTED_FIELDS.filter((k) => prev.data[k] !== undefined && JSON.stringify(prev.data[k]) !== JSON.stringify(data[k]));
          if (changed.length) throw new EntryError(400, 'check_failed', [`Completing the repair cannot change what was reported (${changed.join(', ')}): use Correct.`]);
          await guardVoice(tx, user, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        }
        const next = await insertVersion(tx, app.master, {
          ...prev, entry_id: prev.entry_id, version: prev.version + 1, supersedes: prev.id, change: 'completed',
          activity_end: b.activityEnd, data, late: prev.late || late,
          late_reason: late ? b.lateReason!.trim() : prev.late_reason, correction_reason: null, entered_by: user.id,
        });
        await audit(tx, { actorId: user.id, action: 'entry.completed', objectType: 'entry', objectId: next.id, old: entryContent(prev), new: entryContent(next) });
        if (signer) {
          const s = await sign(tx, { signer, objectType: 'entry', objectId: next.id, meaning: 'performed', content: entryContent(next), shownHash: hashOf(next) });
          if (trained) await recordTraining(tx, s.id, trained);
        }
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
      // The rights this correction needs; checked again under the lock below.
      const [peek] = await sql<{ logbook_type: string; own: boolean }[]>`
        select e.logbook_type, (e.entered_by = ${user.id} or f.entered_by = ${user.id}) as own
        from entries e join entries f on f.entry_id = e.entry_id and f.version = 1 where e.id = ${id}`;
      if (!peek) throw new EntryError(404, 'not_found');
      if (!mayCorrect(peek.logbook_type, user.permissions, peek.own)) throw new EntryError(403, 'forbidden');
      const signer = await authenticateSigner(sql, app.proofKey, user, b.signature,
        { objectType: 'entry', objectId: id, meaning: 'corrected', needs: correctCodes(peek.logbook_type, peek.own) });
      const voice = await voiceSigner(sql, app.proofKey, user, b);
      const row = await sql.begin(async (tx) => {
        const prev = await latestVersion(tx, id);
        const [first] = await tx<{ entered_by: number; entered_at: Date }[]>`
          select entered_by::int, entered_at from entries where entry_id = ${prev.entry_id} and version = 1`;
        const own = first!.entered_by === user.id || prev.entered_by === user.id;
        if (!mayCorrect(prev.logbook_type, user.permissions, own)) {
          throw new EntryError(403, 'forbidden');
        }
        const eq = await loadEquipment(tx, prev.equipment_id);
        const [s] = await tx<{ settings: LogbookSettings }[]>`select settings from logbook_settings where id = ${prev.settings_id}`;
        if (prev.logbook_type === 'equipment_cleaning' || prev.logbook_type === 'area_cleaning') {
          cleaningFits((await statusOf(tx, prev.equipment_id, await app.statusContext(tx)))!, b.activityStart);
        }
        // A correction keeps an open use open and a finished activity finished (review S3-2).
        if (prev.activity_end === null && b.activityEnd) {
          throw new EntryError(400, 'check_failed', [prev.logbook_type === 'maintenance' ? 'Complete the repair with "Complete repair", not by a correction.' : 'End the use with "End use", not by a correction.']);
        }
        if (prev.activity_end !== null && b.activityEnd === null) throw new EntryError(400, 'check_failed', ['A finished activity cannot be reopened.']);
        const end = b.activityEnd === undefined || b.activityEnd === null ? prev.activity_end : b.activityEnd;
        if (end && end < b.activityStart) throw new EntryError(400, 'check_failed', ['The end cannot be before the start.']);
        // One activity at a time: the corrected times must not overlap another activity (the entry itself excepted).
        if (prev.activity_end !== null) await oneActivityAtATime(tx, prev.equipment_id, prev.logbook_type, (b.data ?? prev.data) as Record<string, unknown>, b.activityStart, end, prev.entry_id, false);
        if (prev.logbook_type === 'equipment_use' && (b.productId === null || b.batch === null)) {
          throw new EntryError(400, 'check_failed', ['Product and batch are required.']);
        }
        // D-69, D-70: what the entry says about typed batches and an unchecked qualification stays with it; a corrected
        // batch is checked again (pulled, or typed by hand).
        const flags: Record<string, unknown> = Object.fromEntries(['batchTyped', 'qualNotChecked', 'batchNotChecked'].filter((k) => prev.data[k]).map((k) => [k, prev.data[k]]));
        if (app.batches && prev.logbook_type === 'equipment_use' && b.batch && b.batch !== prev.batch) {
          const got = await linkedBatch(tx, app, b.batch, { typed: b.batchTyped, mustRun: false, product: { id: b.productId } });
          b.productId = got.productId;
          if (got.typed) flags.batchTyped = `Batch ${b.batch}: ${got.typed}`;
          else delete flags.batchTyped;
        }
        if (b.productId && b.productId !== prev.product_id) await activeProduct(tx, app.master, b.productId);
        const now = await dbNow(tx);
        timing(now, [b.activityStart, end], 'n/a');
        // LB-04: lateness is judged against when the entry was first made (review S3-1).
        const latest = Math.max(b.activityStart.getTime(), end?.getTime() ?? 0);
        const late = latest < first!.entered_at.getTime() - LATE_MINUTES * 60_000;
        const lateReason = late ? (b.lateReason?.trim() || prev.late_reason) : null;
        if (late && !lateReason) {
          throw new EntryError(400, 'late_reason_required', [`The corrected time is more than ${LATE_MINUTES} minutes before the entry was made: give a reason.`]);
        }
        // D-84: a corrected move keeps the room it was moved from; the room moved to is checked again.
        if (prev.logbook_type === 'room_move') {
          const item = await logbookItem(tx, app.master, prev.equipment_id);
          if (!item) throw new EntryError(409, 'equipment_unknown', ['No such equipment in master data.']);
          Object.assign(b.data, await roomMove(app, item, b.data, String(prev.data.fromRoom ?? '') || null));
        }
        const breakdownEntry = prev.logbook_type === 'maintenance' && prev.data.kind === 'breakdown';
        const data = { ...validate(prev.logbook_type, b.data, s!.settings, eq, b.activityStart, { end, legacy: breakdownEntry && await isLegacyBreakdown(tx, prev.entry_id) }), ...flags };
        // An open repair stays a breakdown until it is completed (D-25).
        if (prev.activity_end === null && prev.logbook_type === 'maintenance' && data.kind !== 'breakdown') {
          throw new EntryError(400, 'check_failed', ['An open breakdown stays a breakdown; complete the repair first.']);
        }
        // D-78: a corrected load or cycle number (or a batch given) is checked again.
        if (b.batch || data.load !== prev.data.load || data.cycleId !== prev.data.cycleId) {
          delete data.batchNotChecked;
          Object.assign(data, await notForBatch(app, prev.logbook_type, b.batch, data));
        }
        await checkCycleId(tx, prev.logbook_type, prev.equipment_id, data, prev.entry_id);
        await guardVoice(tx, user, prev.equipment_id, prev.logbook_type, data, b.voiceNotes);
        const next = await insertVersion(tx, app.master, {
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
  app.post<{ Params: { id: string } }>('/api/entries/:id/verify', { preHandler: requirePermission('logbook.entry.verify') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = verifyBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, body.data, { objectType: 'entry', objectId: id, meaning: 'verified', needs: ['logbook.entry.verify'] });
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
        const trained = await trainedSigner(tx, app, user, row.logbook_type, s!.settings, body.data.trainedTyped);
        const g = await sign(tx, { signer, objectType: 'entry', objectId: row.id, meaning: 'verified', content: entryContent(row), shownHash: body.data.contentHash });
        if (trained) await recordTraining(tx, g.id, trained);
      });
      return { ok: true };
    } catch (e) {
      return send(reply, e);
    }
  });

  // LB-06: QA returns equipment to service after a breakdown, with a "Released" e-signature on
  // the verified breakdown entry (SchM 18.4.3; Annex 1 5.6).
  app.post<{ Params: { id: string } }>('/api/entries/:id/release', { preHandler: requirePermission('logbook.breakdown.release') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return invalid(reply, body.error?.issues);
    try {
      const signer = await authenticateSigner(sql, app.proofKey, req.user!, body.data, { objectType: 'entry', objectId: id, meaning: 'released', needs: ['logbook.breakdown.release'] });
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
  app.get('/api/equipment/status', anyUser, async () => allStatuses(sql, await app.statusContext()));
  app.get<{ Params: { id: string } }>('/api/equipment/:id/status', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return (await statusOf(sql, id, await app.statusContext())) ?? reply.code(404).send({ error: 'not_found' });
  });

  // The logbook of one equipment item or area: latest version of each entry, newest first.
  app.get<{ Params: { id: string } }>('/api/equipment/:id/entries', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const list = await listEntries(sql, sql`e.equipment_id = ${id}`);
    // D-49: an open use says whether "End use" needs a reason, by the server's own rule.
    return withMayCorrect(sql, req.user!, list.map((e) => (e.inProgress ? { ...e, endReasonFrom: endReasonFrom(app, e.logbookType, e.batch, e.data) } : e)));
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

interface SigRow { object_id: number; printed_name: string; meaning: string; signed_at: Date; content_hash: string; training: string | null; training_typed: boolean | null }

// Presents entry versions with their signatures and the name of who entered them, in two queries.
export async function present(sql: Sql, rows: EntryRow[], needsVerification?: (r: EntryRow) => boolean) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sigs = await sql<SigRow[]>`
    select g.object_id::int, g.printed_name, g.meaning, g.signed_at, g.content_hash, t.note as training, t.typed as training_typed
    from signatures g left join signature_training t on t.signature_id = g.id
    where g.object_type = 'entry' and g.object_id = any(${ids}::bigint[]) order by g.signed_at`;
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
      // D-71: what the signer's training check found, when the settings named a training.
      signatures: mine.map((g) => ({ printedName: g.printed_name, meaning: g.meaning, signedAt: g.signed_at, valid: g.content_hash === hash,
        ...(g.training ? { training: g.training, trainingTyped: Boolean(g.training_typed) } : {}) })),
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
