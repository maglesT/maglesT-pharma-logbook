import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import { runIntegrityCheck } from '../server/integrity.js';
import { SpeechError, sarvamProvider, type SpeechProvider } from '../server/voice.js';

// S10 voice notes (D-26). The speech service is mocked: no real API calls in tests.

let t: TestApp;
const c: Record<string, string> = {};
let n = 0;
// The mock answers per requested language; 'ta-IN' fails like an outage.
let outage: SpeechError | null = null;
const calls: { language: string; mime: string; bytes: number }[] = [];
const speech: SpeechProvider = {
  name: 'sarvam',
  async transcribe(audio, mime, language) {
    calls.push({ language, mime, bytes: audio.length });
    if (outage) throw outage;
    return { transcript: 'मोटर अचानक बंद हो गई', translation: 'The motor stopped suddenly.', detectedLanguage: language === 'unknown' ? 'hi-IN' : language, model: 'saaras:v3', requestIds: { transcribe: 'r1', translate: 'r2' } };
  },
};

const sig = (username: string) => ({ username, password: PASSWORD });
const now = () => new Date().toISOString();
const AUDIO = Buffer.from('fake-webm-audio-bytes').toString('base64');

async function approve(type: string, extra: object = {}) {
  const settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false, ...extra };
  const id = (await call(t.app, c.admin!, 'POST', '/api/settings', { logbookType: type, settings, effectiveFrom: now() })).json().id;
  const versions = (await call(t.app, c.qa!, 'GET', '/api/logbook-types')).json().flatMap((x: { versions: { id: number; contentHash: string }[] }) => x.versions);
  expect((await call(t.app, c.qa!, 'POST', `/api/settings/${id}/approve`, { ...sig('qa1'), contentHash: versions.find((v: { id: number }) => v.id === id).contentHash })).statusCode).toBe(200);
}
const newItem = async () => (await call(t.app, c.admin!, 'POST', '/api/equipment', { code: `VN-${++n}`, name: 'Item', kind: 'equipment' })).json().id as number;
const record = (who: string, equipmentId: number, extra: object = {}) =>
  call(t.app, c[who]!, 'POST', '/api/voice-notes', { equipmentId, logbookType: 'general_log', field: 'notes', language: 'hi-IN', mimeType: 'audio/webm;codecs=opus', durationMs: 4000, audioBase64: AUDIO, ...extra });
const logEntry = (who: string, equipmentId: number, notes: string, extra: object = {}) =>
  call(t.app, c[who]!, 'POST', `/api/equipment/${equipmentId}/entries`, { logbookType: 'general_log', activityStart: now(), data: { notes }, ...extra });

beforeAll(async () => {
  t = await freshApp({ speech });
  for (const [u, roles] of [['admin', ['admin']], ['qa1', ['qa']], ['op1', ['operator']], ['op2', ['operator']]] as const) await seedUser(t.owner, u, [...roles]);
  for (const [key, u] of [['admin', 'admin'], ['qa', 'qa1'], ['op1', 'op1'], ['op2', 'op2']] as const) c[key] = (await login(t.app, u)).cookie;
  await approve('general_log');
});
afterAll(() => t.close());

describe('voice notes setting (LB-24)', () => {
  it('LB-24: voice notes stay off until QA approves the site setting, and only the approved languages are used', async () => {
    const id = await newItem();
    expect((await record('op1', id)).json().error).toBe('voice_off');
    await approve('voice_notes', { voiceLanguages: ['hi-IN', 'mr-IN'] });
    expect((await call(t.app, c.op1!, 'GET', '/api/voice-notes/config')).json()).toMatchObject({ enabled: true, languages: ['hi-IN', 'mr-IN'] });
    expect((await record('op1', id, { language: 'ta-IN' })).json().error).toBe('language_not_enabled');
    expect((await record('op1', id)).statusCode).toBe(201);
  });
});

describe('recording (D-26)', () => {
  it('LB-19: the server returns the original transcript and the English translation as a draft; the browser never sees the key', async () => {
    const id = await newItem();
    const res = await record('op1', id, { language: 'unknown' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ transcript: 'मोटर अचानक बंद हो गई', translation: 'The motor stopped suddenly.', detectedLanguage: 'hi-IN' });
    expect(calls.at(-1)).toMatchObject({ language: 'unknown', mime: 'audio/webm' });
    expect(JSON.stringify(res.json())).not.toMatch(/key/i);
    // Until confirmed, only the speaker sees it.
    expect((await call(t.app, c.op2!, 'GET', `/api/voice-notes/${res.json().id}`)).statusCode).toBe(404);
    expect((await call(t.app, c.op1!, 'GET', `/api/voice-notes/${res.json().id}/audio`)).rawPayload.toString()).toBe('fake-webm-audio-bytes');
  });

  it('LB-21: clip length, size, format, field and role are limited', async () => {
    const id = await newItem();
    expect((await record('op1', id, { durationMs: 45_000 })).json().error).toBe('clip_too_long');
    expect((await record('op1', id, { mimeType: 'video/x-matroska' })).json().error).toBe('audio_type');
    expect((await record('op1', id, { audioBase64: Buffer.alloc(1_600_000).toString('base64') })).statusCode).toBe(400);
    expect((await record('op1', id, { field: 'checklist' })).json().error).toBe('field_not_supported');
    expect((await record('qa', id)).statusCode).toBe(403);
  });

  it('LB-26: when the speech service fails, the user is told and can still type the entry', async () => {
    const id = await newItem();
    outage = new SpeechError('timeout', 'The speech service did not answer in time.');
    const res = await record('op1', id);
    outage = null;
    expect(res.statusCode).toBe(504);
    expect(res.json().problems[0]).toMatch(/type the text instead/);
    const typed = await logEntry('op1', id, 'Motor stopped, typed by hand');
    expect(typed.statusCode).toBe(201);
  });

  it('LB-26: without an API key voice notes are not offered and entries are typed', async () => {
    const plain = await freshApp();
    try {
      await seedUser(plain.owner, 'op9', ['operator']);
      const cookie = (await login(plain.app, 'op9')).cookie;
      expect((await call(plain.app, cookie, 'GET', '/api/voice-notes/config')).json()).toMatchObject({ enabled: false, configured: false });
    } finally {
      await plain.close();
    }
  });

  it('LB-21: voice notes are rate-limited per user', async () => {
    const id = await newItem();
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await record('op2', id)).statusCode;
    expect(last).toBe(429);
  });
});

describe('confirmation (LB-19, LB-20)', () => {
  it('LB-20: an unsigned translation is never stored as the entry text', async () => {
    const id = await newItem();
    const note = (await record('op1', id)).json();
    const before = (await t.owner`select count(*)::int as n from entries`)[0]!.n;
    // The draft text without confirming the voice note.
    expect((await logEntry('op1', id, note.translation)).json().error).toBe('voice_confirmation_required');
    // Naming the voice note but without the confirmation signature.
    expect((await logEntry('op1', id, note.translation, { voiceNotes: [{ id: note.id, field: 'notes', finalText: note.translation }] })).json().error).toBe('voice_signature_required');
    // With a wrong password.
    expect((await logEntry('op1', id, note.translation, { voiceNotes: [{ id: note.id, field: 'notes', finalText: note.translation }], voiceSignature: { username: 'op1', password: 'nope' } })).statusCode).toBe(401);
    // The field text differs from the text being confirmed.
    expect((await logEntry('op1', id, 'Something else', { voiceNotes: [{ id: note.id, field: 'notes', finalText: note.translation }], voiceSignature: sig('op1') })).json().error).toBe('voice_check_failed');
    expect((await t.owner`select count(*)::int as n from entries`)[0]!.n).toBe(before);
    expect((await t.owner`select count(*)::int as n from voice_note_confirmations where voice_note_id = ${note.id}`)[0]!.n).toBe(0);
  });

  it('LB-19: the speaker signs the English text; it is linked to the entry version with the original data', async () => {
    const id = await newItem();
    const note = (await record('op1', id, { language: 'mr-IN' })).json();
    const finalText = 'The motor stopped suddenly during mixing.';
    // Someone else cannot confirm another person's voice note.
    expect((await logEntry('op2', id, finalText, { voiceNotes: [{ id: note.id, field: 'notes', finalText }], voiceSignature: sig('op2') })).statusCode).toBe(403);
    const res = await logEntry('op1', id, finalText, { voiceNotes: [{ id: note.id, field: 'notes', finalText }], voiceSignature: sig('op1') });
    expect(res.statusCode).toBe(201);
    const [entry] = (await call(t.app, c.qa!, 'GET', `/api/equipment/${id}/entries`)).json();
    expect(entry.data.notes).toBe(finalText);
    expect(entry.voiceNotes).toEqual([{ id: note.id, field: 'notes', language: 'mr-IN', edited: true }]);
    const v = (await call(t.app, c.qa!, 'GET', `/api/voice-notes/${note.id}`)).json();
    expect(v).toMatchObject({ transcript: 'मोटर अचानक बंद हो गई', translation: 'The motor stopped suddenly.', model: 'saaras:v3', provider: 'sarvam', requestedLanguage: 'mr-IN',
      audioSha256: createHash('sha256').update('fake-webm-audio-bytes').digest('hex'), confirmation: { entryVersionId: entry.id, finalText, edited: true, signedBy: 'OP1' } });
    expect((await call(t.app, c.qa!, 'GET', `/api/voice-notes/${note.id}/audio`)).statusCode).toBe(200);
    const [g] = await t.owner`select meaning from signatures where object_type = 'voice_note' and object_id = ${note.id}`;
    expect(g!.meaning).toBe('voice_confirmed');
    const actions = (await t.owner`select action from audit_log where object_type = 'voice_note' and object_id = ${String(note.id)} order by id`).map((a) => a.action);
    expect(actions).toEqual(['voice_note.created', 'voice_note.confirmed', 'signed.voice_confirmed']);
    // Used once only.
    expect((await logEntry('op1', id, finalText, { voiceNotes: [{ id: note.id, field: 'notes', finalText }], voiceSignature: sig('op1') })).json().error).toBe('voice_check_failed');
  });

  it('LB-17: a correction keeps the earlier voice note on the earlier version and never deletes it', async () => {
    const id = await newItem();
    const note = (await record('op1', id)).json();
    const created = (await logEntry('op1', id, note.translation, { voiceNotes: [{ id: note.id, field: 'notes', finalText: note.translation }], voiceSignature: sig('op1') })).json().id;
    const v1 = (await call(t.app, c.qa!, 'GET', `/api/entries/${created}/versions`)).json()[0];
    expect(v1.voiceNotes[0]).toMatchObject({ id: note.id, edited: false });
    const res = await call(t.app, c.op1!, 'POST', `/api/entries/${created}/correct`, { activityStart: v1.activityStart, data: { notes: 'The pump stopped suddenly.' }, reason: 'wrong unit named', signature: sig('op1') });
    expect(res.statusCode).toBe(200);
    const versions = (await call(t.app, c.qa!, 'GET', `/api/entries/${created}/versions`)).json();
    expect(versions.map((x: { voiceNotes: unknown[] }) => x.voiceNotes.length)).toEqual([1, 0]);
    await expect(t.sql`delete from voice_notes`).rejects.toThrow(/permission denied/);
    await expect(t.sql`update voice_note_confirmations set final_text = 'x'`).rejects.toThrow(/permission denied/);
  });

  it('LB-22: exports show the signed English text and say that an original-language voice note exists', async () => {
    const [row] = await t.owner`select v.equipment_id::int as id from voice_notes v join voice_note_confirmations c on c.voice_note_id = v.id limit 1`;
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const csv = await call(t.app, c.qa!, 'GET', `/api/export/period.csv?equipmentId=${row!.id}&fromDay=${day}&toDay=${day}`);
    expect(csv.body).toContain('Voice note for notes: signed English text; original');
    const hist = await call(t.app, c.op1!, 'GET', `/api/export/history.csv?equipmentId=${row!.id}&fromDay=${day}&toDay=${day}`);
    expect(hist.body).toContain('audio and transcript kept');
  });

  it('LB-23: the integrity check covers the audio hash and the confirmation signature', async () => {
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([]);
    const [v] = await t.owner`select v.id::int from voice_notes v join voice_note_confirmations c on c.voice_note_id = v.id limit 1`;
    await t.owner`update voice_notes set audio = ${Buffer.from('tampered')} where id = ${v!.id}`;
    expect((await runIntegrityCheck(t.sql)).problems).toEqual([`Voice note ${v!.id}: the audio no longer matches its hash.`]);
    await t.owner`update voice_notes set audio = ${Buffer.from('fake-webm-audio-bytes')} where id = ${v!.id}`;
    await t.owner`update voice_note_confirmations set final_text = 'changed' where voice_note_id = ${v!.id}`;
    expect((await runIntegrityCheck(t.sql)).problems[0]).toMatch(/content changed after signing/);
  });
});

describe('Sarvam client (D-26)', () => {
  let server: Server;
  let base = '';
  const seen: { mode: string; model: string; language: string; key: string | undefined }[] = [];
  let status = 200;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('latin1');
        const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text)?.[1] ?? '';
        seen.push({ mode: field('mode'), model: field('model'), language: field('language_code'), key: req.headers['api-subscription-key'] as string | undefined });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200
          ? { request_id: `req-${field('mode')}`, transcript: field('mode') === 'translate' ? 'The belt is torn.' : 'बेल्ट फट गया', language_code: 'hi-IN' }
          : { error: { message: 'bad' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('LB-19: calls /speech-to-text with saaras:v3 in transcribe and translate modes, with the key in the header', async () => {
    const p = sarvamProvider({ apiKey: 'secret-key', baseUrl: base, model: 'saaras:v3', timeoutMs: 2000 });
    const r = await p.transcribe(Buffer.from('audio'), 'audio/webm', 'unknown');
    expect(r).toEqual({ transcript: 'बेल्ट फट गया', translation: 'The belt is torn.', detectedLanguage: 'hi-IN', model: 'saaras:v3', requestIds: { transcribe: 'req-transcribe', translate: 'req-translate' } });
    expect(seen.map((s) => s.mode).sort()).toEqual(['transcribe', 'translate']);
    expect(seen.every((s) => s.model === 'saaras:v3' && s.language === 'unknown' && s.key === 'secret-key')).toBe(true);
  });

  it('LB-26: service errors and timeouts become clear errors', async () => {
    status = 503;
    await expect(sarvamProvider({ apiKey: 'k', baseUrl: base, model: 'saaras:v3', timeoutMs: 2000 }).transcribe(Buffer.from('a'), 'audio/webm', 'hi-IN')).rejects.toMatchObject({ code: 'unavailable' });
    status = 400;
    await expect(sarvamProvider({ apiKey: 'k', baseUrl: base, model: 'saaras:v3', timeoutMs: 2000 }).transcribe(Buffer.from('a'), 'audio/webm', 'hi-IN')).rejects.toMatchObject({ code: 'rejected' });
    await expect(sarvamProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', model: 'saaras:v3', timeoutMs: 2000 }).transcribe(Buffer.from('a'), 'audio/webm', 'hi-IN')).rejects.toMatchObject({ code: 'unavailable' });
    status = 200;
  });
});
