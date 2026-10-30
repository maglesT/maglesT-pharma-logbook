import type { Sql, Tx } from './db.js';
import { audit } from './audit.js';
import { createHash } from 'node:crypto';
import { canonical, contentHash, sign, type AuthenticatedSigner } from './signatures.js';

// S10 voice notes (D-26). The browser sends audio to our server only; the server asks the speech
// service for the transcript in the spoken language and an English translation. Nothing from a
// voice note becomes part of an entry until the speaker signs the English text.

// What the speaker signs, shown on screen and stored in the signed content (LB-19).
export const VOICE_STATEMENT = 'I confirm this English text is a true record of what I said.';

// Free-text fields that take a voice note, per logbook type.
export const VOICE_FIELDS: Record<string, string[]> = {
  equipment_use: ['remarks'],
  equipment_cleaning: ['remarks'],
  maintenance: ['description', 'workDone', 'rootCause'],
  calibration: ['remarks'],
  area_cleaning: ['remarks'],
  general_log: ['notes'],
  steriliser_cycle: ['remarks'],
  steriliser_test: ['remarks'],
  glove_integrity: ['remarks'],
};

// Sarvam's REST speech-to-text takes clips up to 30 seconds (docs checked 2026-10-30).
export const MAX_CLIP_MS = 30_000;
export const MAX_AUDIO_BYTES = 1_500_000;
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a'];

export interface SpeechResult {
  transcript: string;
  translation: string;
  detectedLanguage: string | null;
  model: string;
  requestIds: Record<string, string | null>;
}

export interface SpeechProvider {
  name: string;
  transcribe(audio: Buffer, mime: string, language: string): Promise<SpeechResult>;
}

export class SpeechError extends Error {
  constructor(public code: 'unavailable' | 'timeout' | 'rejected', message: string) {
    super(message);
  }
}

// Sarvam AI: /speech-to-text with saaras:v3, once with mode=transcribe (spoken language) and once
// with mode=translate (always English). The standalone /speech-to-text-translate endpoint is
// documented as legacy and points to this mode (D-26).
export function sarvamProvider(opts: { apiKey: string; baseUrl: string; model: string; timeoutMs: number }): SpeechProvider {
  const call = async (audio: Buffer, mime: string, language: string, mode: 'transcribe' | 'translate') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `voice.${mime.split('/')[1]?.split(';')[0] ?? 'webm'}`);
    form.append('model', opts.model);
    form.append('mode', mode);
    form.append('language_code', language);
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/speech-to-text`, {
        method: 'POST',
        headers: { 'api-subscription-key': opts.apiKey },
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw name === 'TimeoutError' || name === 'AbortError'
        ? new SpeechError('timeout', 'The speech service did not answer in time.')
        : new SpeechError('unavailable', 'The speech service cannot be reached.');
    }
    const body = (await res.json().catch(() => ({}))) as { transcript?: string; language_code?: string | null; request_id?: string | null; error?: { message?: string } };
    if (res.status >= 500 || res.status === 429) throw new SpeechError('unavailable', `The speech service is not available (${res.status}).`);
    if (!res.ok || typeof body.transcript !== 'string') throw new SpeechError('rejected', body.error?.message ?? `The speech service refused the clip (${res.status}).`);
    return { transcript: body.transcript, language: body.language_code ?? null, requestId: body.request_id ?? null };
  };
  return {
    name: 'sarvam',
    async transcribe(audio, mime, language) {
      const [original, english] = await Promise.all([call(audio, mime, language, 'transcribe'), call(audio, mime, language, 'translate')]);
      return {
        transcript: original.transcript,
        translation: english.transcript,
        // The spoken language comes from the transcription; the translate call describes English output.
        detectedLanguage: original.language ?? (language !== 'unknown' ? language : null),
        model: opts.model,
        requestIds: { transcribe: original.requestId, translate: english.requestId },
      };
    },
  };
}

// Per-user rate limit for calls to the speech service. A call the service never answered is
// refunded, so an outage does not lock people out afterwards (review S10).
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<number, number[]>();
  const take = (userId: number, now = Date.now()) => {
    for (const [id, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(id);
    const recent = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(userId, recent);
    return true;
  };
  const refund = (userId: number) => hits.get(userId)?.pop();
  return { take, refund };
}

// What the speaker was shown as the draft: sent back with the confirmation (review S10).
export const draftHash = (n: Pick<VoiceNoteRow, 'id' | 'audio_sha256' | 'transcript' | 'translation'>) =>
  createHash('sha256').update(canonical({ id: n.id, audioSha256: n.audio_sha256, transcript: n.transcript, translation: n.translation })).digest('hex');

export interface VoiceNoteRow {
  id: number;
  equipment_id: number;
  logbook_type: string;
  field: string;
  user_id: number;
  requested_language: string;
  detected_language: string | null;
  audio_mime: string;
  audio_sha256: string;
  duration_ms: number | null;
  transcript: string;
  translation: string;
  provider: string;
  model: string;
  requested_at: Date;
  received_at: Date;
}
export const VOICE_COLS = `id::int, equipment_id::int, logbook_type, field, user_id::int, requested_language, detected_language, audio_mime,
  audio_sha256, duration_ms, transcript, translation, provider, model, requested_at, received_at`;

export interface ConfirmationRow { id: number; voice_note_id: number; entry_version_id: number; final_text: string; edited: boolean; confirmed_at: Date }

// What the voice confirmation signature covers: the original data and the signed English text.
export const voiceContent = (n: VoiceNoteRow, c: Pick<ConfirmationRow, 'entry_version_id' | 'final_text' | 'edited'>) => ({
  voiceNoteId: n.id,
  equipmentId: n.equipment_id,
  logbookType: n.logbook_type,
  field: n.field,
  entryVersionId: c.entry_version_id,
  audioSha256: n.audio_sha256,
  requestedLanguage: n.requested_language,
  detectedLanguage: n.detected_language,
  transcript: n.transcript,
  translation: n.translation,
  model: n.model,
  finalText: c.final_text,
  edited: c.edited,
  statement: VOICE_STATEMENT,
});

export interface VoiceUse { id: number; field: string; finalText: string; shownHash: string }

export class VoiceError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) {
    super(code);
  }
}

// A field holding, unchanged, a recent voice translation this user recorded for that field and has
// not confirmed: such a draft must be signed before it is saved (D-26). Limited to the same item,
// type and field and the last 12 hours, so an abandoned draft cannot block later typing (review S10).
export async function unsignedDrafts(tx: Tx, userId: number, equipmentId: number, type: string, data: Record<string, unknown>, using: number[]): Promise<string[]> {
  const rows = await tx<{ field: string; translation: string }[]>`
    select v.field, v.translation from voice_notes v
    where v.user_id = ${userId} and v.equipment_id = ${equipmentId} and v.logbook_type = ${type}
      and v.received_at > now() - interval '12 hours' and v.id <> all(${using}::bigint[])
      and not exists (select 1 from voice_note_confirmations c where c.voice_note_id = v.id)`;
  const hit = rows.some((r) => typeof data[r.field] === 'string' && String(data[r.field]).trim() === r.translation.trim());
  return hit ? ['A voice-note translation must be confirmed with your signature before it is saved.'] : [];
}

// Links the speaker's voice notes to the entry version just written and signs each (D-26).
export async function confirmVoiceNotes(tx: Tx, signer: AuthenticatedSigner, versionId: number, equipmentId: number, type: string, data: Record<string, unknown>, uses: VoiceUse[]) {
  for (const u of uses) {
    const [n] = await tx.unsafe<VoiceNoteRow[]>(`select ${VOICE_COLS} from voice_notes where id = $1`, [u.id]);
    const problems: string[] = [];
    if (!n || n.user_id !== signer.user.id) throw new VoiceError(403, 'not_your_voice_note', ['Only the speaker can confirm a voice note.']);
    if (n.equipment_id !== equipmentId || n.logbook_type !== type || n.field !== u.field) problems.push('This voice note was recorded for another field.');
    if (draftHash(n) !== u.shownHash) problems.push('This is not the voice note that was shown: record it again.');
    const finalText = u.finalText.trim();
    if (!finalText) problems.push('The confirmed text cannot be empty.');
    if (String(data[u.field] ?? '').trim() !== finalText) problems.push(`The text in ${u.field} must be exactly the text you confirm.`);
    const [done] = await tx`select 1 from voice_note_confirmations where voice_note_id = ${u.id}`;
    if (done) problems.push('This voice note is already part of an entry.');
    if (problems.length) throw new VoiceError(400, 'voice_check_failed', problems);
    const [c] = await tx<ConfirmationRow[]>`
      insert into voice_note_confirmations (voice_note_id, entry_version_id, final_text, edited)
      values (${u.id}, ${versionId}, ${finalText}, ${finalText !== n!.translation.trim()})
      returning id::int, voice_note_id::int, entry_version_id::int, final_text, edited, confirmed_at`;
    const content = voiceContent(n!, c!);
    await audit(tx, { actorId: signer.user.id, action: 'voice_note.confirmed', objectType: 'voice_note', objectId: n!.id,
      new: { entryVersionId: versionId, field: u.field, finalText, edited: c!.edited } });
    await sign(tx, { signer, objectType: 'voice_note', objectId: n!.id, meaning: 'voice_confirmed', content, shownHash: contentHash('voice_note', n!.id, content) });
  }
}

export interface VoiceLink { id: number; field: string; language: string | null; edited: boolean; carried: boolean }

// Voice notes behind the text of each version: signed into that version, or into an earlier version
// of the same entry while the field still holds the signed text (review S10).
export async function voiceNotesFor(q: Sql | Tx, versions: { id: number; entry_id: number; version: number; data: Record<string, unknown> }[]) {
  const out = new Map<number, VoiceLink[]>();
  if (!versions.length) return out;
  const rows = await q<{ id: number; entry_id: number; version: number; field: string; language: string | null; edited: boolean; final_text: string }[]>`
    select v.id::int, e.entry_id::int, e.version, v.field, coalesce(v.detected_language, v.requested_language) as language, c.edited, c.final_text
    from voice_note_confirmations c join voice_notes v on v.id = c.voice_note_id join entries e on e.id = c.entry_version_id
    where e.entry_id = any(${[...new Set(versions.map((x) => x.entry_id))]}::bigint[]) order by v.id`;
  for (const ver of versions) {
    const links = rows
      .filter((r) => r.entry_id === ver.entry_id && r.version <= ver.version && (r.version === ver.version || String(ver.data[r.field] ?? '').trim() === r.final_text))
      .map((r) => ({ id: r.id, field: r.field, language: r.language, edited: r.edited, carried: r.version !== ver.version }));
    if (links.length) out.set(ver.id, links);
  }
  return out;
}
