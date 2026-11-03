import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { logbookItem } from '../master.js';
import { parseId, requirePermission } from '../auth.js';
import { mayRecord } from '../entries.js';
import { VOICE_LANGUAGES, typeByKey, type LogbookSettings } from '../logbook-types.js';
import { settingsInForce } from './settings.js';
import {
  AUDIO_TYPES, MAX_AUDIO_BYTES, MAX_CLIP_MS, SpeechError, VOICE_COLS, VOICE_FIELDS, VOICE_STATEMENT, draftHash, rateLimiter,
  type ConfirmationRow, type SpeechProvider, type VoiceNoteRow,
} from '../voice.js';

// S10 voice notes (D-26): record → transcript + English translation (a draft), served back to the
// speaker. The note joins an entry only when the speaker signs the English text with the entry.

const noteBody = z.object({
  equipmentId: z.number().int().positive(),
  logbookType: z.string().max(40),
  field: z.string().max(40),
  language: z.enum(['unknown', ...VOICE_LANGUAGES]),
  mimeType: z.string().max(80),
  durationMs: z.number().int().positive(),
  audioBase64: z.string().min(1).max(Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4),
});

// The free-text fields that take voice notes, as people call them.
const FIELD_LABEL: Record<string, string> = { remarks: 'Remarks', notes: 'Notes', description: 'What happened', workDone: 'Work done', rootCause: 'Root cause' };

// 20 clips an hour per person keeps the service cost and load bounded.
const limit = rateLimiter(20, 3_600_000);

export function voiceRoutes(app: FastifyInstance, sql: Sql, speech: SpeechProvider | null) {
  const anyUser = { preHandler: requirePermission() };

  // What the screens need to offer voice notes: on/off, languages, fields, limits.
  app.get('/api/voice-notes/config', anyUser, async (req) => {
    const s = await settingsInForce(sql, 'voice_notes');
    const settings = s?.settings as LogbookSettings | undefined;
    return {
      // Offered only to people holding the voice-note code, as POST /api/voice-notes checks.
      enabled: Boolean(settings?.enabled && settings.voiceLanguages.length && speech && req.user!.permissions.includes('logbook.voice_note.record')),
      switchedOn: Boolean(settings?.enabled),
      configured: Boolean(speech),
      languages: settings?.voiceLanguages ?? [],
      fields: VOICE_FIELDS,
      maxClipMs: MAX_CLIP_MS,
      statement: VOICE_STATEMENT,
    };
  });

  app.post('/api/voice-notes', { preHandler: requirePermission('logbook.voice_note.record'), bodyLimit: 3_000_000 }, async (req, reply) => {
    const body = noteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const b = body.data;
    const user = req.user!;
    const refuse = (status: number, error: string, message: string) => reply.code(status).send({ error, problems: [message] });
    const s = await settingsInForce(sql, 'voice_notes');
    const settings = s?.settings as LogbookSettings | undefined;
    if (!settings?.enabled) return refuse(409, 'voice_off', 'Voice notes are not switched on at this site. Type the text instead.');
    if (!speech) return refuse(503, 'voice_not_configured', 'Voice notes are not set up on this server. Type the text instead.');
    if (b.language !== 'unknown' && !settings.voiceLanguages.includes(b.language)) return refuse(400, 'language_not_enabled', 'This language is not enabled for voice notes at this site.');
    if (!(VOICE_FIELDS[b.logbookType] ?? []).includes(b.field)) return refuse(400, 'field_not_supported', 'This field does not take voice notes.');
    if (!mayRecord(b.logbookType, user.permissions)) return reply.code(403).send({ error: 'forbidden' });
    const mime = b.mimeType.split(';')[0]!.trim().toLowerCase();
    if (!AUDIO_TYPES.includes(mime)) return refuse(400, 'audio_type', 'This audio format is not supported.');
    const audio = Buffer.from(b.audioBase64, 'base64');
    if (audio.length > MAX_AUDIO_BYTES) return refuse(413, 'audio_too_large', 'The recording is too large.');
    if (b.durationMs > MAX_CLIP_MS + 1_000) return refuse(400, 'clip_too_long', `A voice note can be at most ${MAX_CLIP_MS / 1000} seconds.`);
    // The item as master data has it now, live (D-29); only an active one takes entries.
    const eq = await logbookItem(sql, app.master, b.equipmentId);
    if (!eq?.active) return reply.code(404).send({ error: 'not_found' });
    // Only for an entry that could be saved on this item (review S10).
    const lt = typeByKey(b.logbookType);
    if (!lt || !lt.appliesTo.includes(eq.kind) || (lt.sterile && !eq.sterile)) return refuse(400, 'type_not_for_equipment', 'This logbook type does not apply to this item.');
    if (!limit.take(user.id)) return refuse(429, 'rate_limited', 'Too many voice notes in the last hour. Type the text instead, or try later.');

    const [clock] = await sql<{ now: Date }[]>`select now() as now`;
    const requestedAt = clock!.now;
    let result;
    try {
      result = await speech.transcribe(audio, mime, b.language, { equipment: `${eq.code} · ${eq.name}`, logbook: lt.label, field: FIELD_LABEL[b.field] ?? b.field });
    } catch (e) {
      if (e instanceof SpeechError) {
        if (e.code !== 'rejected') limit.refund(user.id);
        const status = e.code === 'timeout' ? 504 : e.code === 'rejected' ? 422 : 503;
        return refuse(status, `speech_${e.code}`, `${e.message} Your entry is not affected: type the text instead.`);
      }
      throw e;
    }
    const detected = result.detectedLanguage;
    if (detected && detected !== b.language && !settings.voiceLanguages.includes(detected as never)) {
      return refuse(422, 'language_not_enabled', `The detected language (${detected}) is not enabled for voice notes at this site.`);
    }
    if (!result.translation.trim()) return refuse(422, 'speech_empty', 'No speech was recognised. Try again or type the text.');
    const sha = createHash('sha256').update(audio).digest('hex');
    const row = await sql.begin(async (tx) => {
      const [r] = await tx.unsafe<VoiceNoteRow[]>(
        `insert into voice_notes (equipment_id, logbook_type, field, user_id, requested_language, detected_language, audio, audio_mime,
           audio_sha256, duration_ms, transcript, translation, provider, model, provider_request_ids, requested_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning ${VOICE_COLS}`,
        [b.equipmentId, b.logbookType, b.field, user.id, b.language, detected, audio, mime, sha, b.durationMs, result.transcript,
          result.translation, speech.name, result.model, tx.json(result.requestIds as never), requestedAt] as never[],
      );
      await audit(tx, { actorId: user.id, action: 'voice_note.created', objectType: 'voice_note', objectId: r!.id, new: {
        equipmentId: b.equipmentId, logbookType: b.logbookType, field: b.field, requestedLanguage: b.language, detectedLanguage: detected,
        audioSha256: sha, audioBytes: audio.length, audioMime: mime, durationMs: b.durationMs, transcript: result.transcript,
        translation: result.translation, provider: speech.name, model: result.model, requestIds: result.requestIds, requestedAt } });
      return r!;
    });
    return reply.code(201).send({ id: row.id, transcript: row.transcript, translation: row.translation, detectedLanguage: row.detected_language,
      statement: VOICE_STATEMENT, shownHash: draftHash(row) });
  });

  // Everything kept for a voice note: original texts, model, times, and where it was confirmed.
  app.get<{ Params: { id: string } }>('/api/voice-notes/:id', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [n] = await sql.unsafe<(VoiceNoteRow & { speaker: string; audio_bytes: number })[]>(
      `select ${VOICE_COLS}, (select full_name from users u where u.id = v.user_id) as speaker, octet_length(audio) as audio_bytes
       from voice_notes v where id = $1`, [id]);
    if (!n) return reply.code(404).send({ error: 'not_found' });
    // Until confirmed, a voice note is visible only to its speaker.
    const [c] = await sql<(ConfirmationRow & { printed_name: string | null; signed_at: Date | null })[]>`
      select c.id::int, c.voice_note_id::int, c.entry_version_id::int, c.final_text, c.edited, c.confirmed_at, g.printed_name, g.signed_at
      from voice_note_confirmations c
      left join signatures g on g.object_type = 'voice_note' and g.object_id = c.voice_note_id and g.meaning = 'voice_confirmed'
      where c.voice_note_id = ${id}`;
    if (!c && n.user_id !== req.user!.id) return reply.code(404).send({ error: 'not_found' });
    return {
      id: n.id, equipmentId: n.equipment_id, logbookType: n.logbook_type, field: n.field, speaker: n.speaker,
      requestedLanguage: n.requested_language, detectedLanguage: n.detected_language, audioMime: n.audio_mime, audioBytes: n.audio_bytes,
      audioSha256: n.audio_sha256, durationMs: n.duration_ms, transcript: n.transcript, translation: n.translation, provider: n.provider,
      model: n.model, requestedAt: n.requested_at, receivedAt: n.received_at, statement: VOICE_STATEMENT,
      confirmation: c ? { entryVersionId: c.entry_version_id, finalText: c.final_text, edited: c.edited, confirmedAt: c.confirmed_at, signedBy: c.printed_name, signedAt: c.signed_at } : null,
    };
  });

  app.get<{ Params: { id: string } }>('/api/voice-notes/:id/audio', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [n] = await sql<{ audio: Buffer; audio_mime: string; user_id: number; confirmed: boolean }[]>`
      select audio, audio_mime, user_id::int, exists (select 1 from voice_note_confirmations c where c.voice_note_id = v.id) as confirmed
      from voice_notes v where id = ${id}`;
    if (!n || (!n.confirmed && n.user_id !== req.user!.id)) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', n.audio_mime).header('cache-control', 'private, no-store').send(n.audio);
  });
}
