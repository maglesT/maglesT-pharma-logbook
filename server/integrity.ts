import type { Sql } from './db.js';
import { audit } from './audit.js';
import { contentHash } from './signatures.js';
import { ENTRY_COLS, entryContent, type EntryRow } from './routes/entries.js';
import { signedContent, type SettingsRow } from './routes/settings.js';
import { VOICE_COLS, voiceContent, type ConfirmationRow, type VoiceNoteRow } from './voice.js';

// LB-23 (A11 7.1, P11 11.10(c)): re-read every record, check each signature still matches the
// content it signed, that every entry's version chain is complete, and that every entry version
// has its audit row. The result is written to the audit trail.

export interface IntegrityResult {
  checkedAt: Date;
  entries: number;
  signatures: number;
  problems: string[];
}

export async function runIntegrityCheck(sql: Sql, actorId: number | null = null): Promise<IntegrityResult> {
  // All reads from one snapshot, so records saved during the check cannot look inconsistent (review S7-1).
  const result = await sql.begin('isolation level repeatable read read only', (tx) => check(tx as unknown as Sql));
  await audit(sql, {
    actorId,
    action: result.problems.length ? 'integrity.failed' : 'integrity.passed',
    objectType: 'system',
    objectId: 'integrity',
    new: { entries: result.entries, signatures: result.signatures, problems: result.problems.slice(0, 200), problemCount: result.problems.length },
  });
  return result;
}

async function check(sql: Sql): Promise<IntegrityResult> {
  const problems: string[] = [];

  const entries = await sql.unsafe<EntryRow[]>(`select ${ENTRY_COLS} from entries order by entry_id, version`);
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Version chains: 1..n without gaps, each version pointing to the one before it.
  const chains = new Map<number, EntryRow[]>();
  for (const e of entries) chains.set(e.entry_id, [...(chains.get(e.entry_id) ?? []), e]);
  for (const [entryId, versions] of chains) {
    versions.forEach((v, i) => {
      const expectedPrev = i === 0 ? null : versions[i - 1]!.id;
      if (v.version !== i + 1 || v.supersedes !== expectedPrev) problems.push(`Entry ${entryId}: version chain broken at version ${v.version}.`);
    });
  }

  // Every entry version has the audit row written with it.
  const audited = new Set(
    (await sql<{ object_id: string }[]>`
      select object_id from audit_log where object_type = 'entry' and action in ('entry.created', 'entry.completed', 'entry.corrected')`).map((a) => Number(a.object_id)),
  );
  for (const e of entries) if (!audited.has(e.id)) problems.push(`Entry version ${e.id}: no audit row.`);

  // S9: equipment details versions run 1..n per item, each with the audit row written with it (D-25).
  const details = await sql<{ id: number; equipment_id: number; version: number }[]>`
    select id::int, equipment_id::int, version from equipment_details order by equipment_id, version`;
  const detailsAudited = new Set(
    (await sql<{ id: string | null }[]>`
      select new_value->>'id' as id from audit_log where object_type = 'equipment' and action = 'equipment.details_updated'`).map((a) => Number(a.id)),
  );
  details.forEach((d, i) => {
    const prev = details[i - 1];
    const expected = prev && prev.equipment_id === d.equipment_id ? prev.version + 1 : 1;
    if (d.version !== expected) problems.push(`Equipment ${d.equipment_id}: details version ${d.version} out of sequence.`);
    if (!detailsAudited.has(d.id)) problems.push(`Equipment ${d.equipment_id}: details version ${d.version} has no audit row.`);
  });

  // S10: each voice note's audio still matches its hash, and each has its audit rows (D-26). The hash
  // is computed in the database so the audio is not loaded into memory.
  const voices = await sql.unsafe<(VoiceNoteRow & { actual: string })[]>(`select ${VOICE_COLS}, encode(sha256(audio), 'hex') as actual from voice_notes order by id`);
  const confirmations = new Map((await sql<ConfirmationRow[]>`
    select id::int, voice_note_id::int, entry_version_id::int, final_text, edited, confirmed_at from voice_note_confirmations`).map((c) => [c.voice_note_id, c]));
  const voiceAudit = await sql<{ object_id: string; action: string }[]>`
    select object_id, action from audit_log where object_type = 'voice_note' and action in ('voice_note.created', 'voice_note.confirmed')`;
  const voiceAudited = new Set(voiceAudit.map((a) => `${a.action}:${a.object_id}`));
  for (const v of voices) {
    if (v.actual !== v.audio_sha256) problems.push(`Voice note ${v.id}: the audio no longer matches its hash.`);
    if (!voiceAudited.has(`voice_note.created:${v.id}`)) problems.push(`Voice note ${v.id}: no audit row.`);
    const c = confirmations.get(v.id);
    if (c && !byId.has(c.entry_version_id)) problems.push(`Voice note ${v.id}: confirmed into a missing entry version.`);
    if (c && !voiceAudited.has(`voice_note.confirmed:${v.id}`)) problems.push(`Voice note ${v.id}: confirmation has no audit row.`);
  }
  const voiceById = new Map(voices.map((v) => [v.id, v]));

  // Signatures against the content they signed.
  const settings = new Map(
    (await sql<SettingsRow[]>`select id::int, logbook_type, version, settings, effective_from, created_by::int, created_at from logbook_settings`).map((s) => [s.id, s]),
  );
  const reviews = new Map((await sql<{ id: number; content: unknown }[]>`select id::int, content from reviews`).map((r) => [r.id, r.content]));
  const sigs = await sql<{ id: number; object_type: string; object_id: number; meaning: string; content_hash: string }[]>`
    select id::int, object_type, object_id::int, meaning, content_hash from signatures order by id`;
  for (const g of sigs) {
    const content =
      g.object_type === 'entry' ? (byId.has(g.object_id) ? entryContent(byId.get(g.object_id)!) : undefined)
      : g.object_type === 'settings' ? (settings.has(g.object_id) ? signedContent(settings.get(g.object_id)!) : undefined)
      : g.object_type === 'voice_note' ? (voiceById.has(g.object_id) && confirmations.has(g.object_id) ? voiceContent(voiceById.get(g.object_id)!, confirmations.get(g.object_id)!) : undefined)
      : reviews.get(g.object_id);
    if (content === undefined) problems.push(`Signature ${g.id} (${g.meaning}): the signed ${g.object_type} ${g.object_id} is missing.`);
    else if (contentHash(g.object_type, g.object_id, content) !== g.content_hash) {
      problems.push(`Signature ${g.id} (${g.meaning}) on ${g.object_type} ${g.object_id}: content changed after signing.`);
    }
  }

  return { checkedAt: new Date(), entries: entries.length, signatures: sigs.length, problems };
}

// Runs the check once a day from the server process (LB-23, "periodically").
export function scheduleIntegrityCheck(sql: Sql, log: (msg: string) => void): () => void {
  const DAY = 24 * 3_600_000;
  const tick = async () => {
    try {
      const [last] = await sql<{ at: Date }[]>`
        select at from audit_log where object_type = 'system' and object_id = 'integrity' order by at desc limit 1`;
      if (last && Date.now() - last.at.getTime() < DAY) return;
      const r = await runIntegrityCheck(sql);
      log(r.problems.length ? `integrity check FAILED: ${r.problems.length} problem(s)` : `integrity check passed (${r.entries} entries, ${r.signatures} signatures)`);
    } catch (e) {
      log(`integrity check could not run: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 3_600_000);
  void tick();
  return () => clearInterval(timer);
}
