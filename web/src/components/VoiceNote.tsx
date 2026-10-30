import { useEffect, useRef, useState } from 'react';
import { api, ApiError, plantTime, VOICE_LANGUAGE_LABEL, type VoiceConfig, type VoiceDraft, type VoiceNote } from '../api.js';

// Formats the browser can record that the speech service takes: Chrome/Android record WebM/Opus,
// iPhone/iPad Safari records MP4/AAC.
const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const pickType = () => (typeof MediaRecorder === 'undefined' ? undefined : RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t)));

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

// "Record voice note" for one free-text field (D-26). The result is only a draft for the field.
export function VoiceButton({ config, equipmentId, logbookType, field, onDraft }: {
  config: VoiceConfig;
  equipmentId: number;
  logbookType: string;
  field: string;
  onDraft: (d: VoiceDraft) => void;
}) {
  const [language, setLanguage] = useState('unknown');
  const [state, setState] = useState<'idle' | 'recording' | 'sending'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const rec = useRef<{ recorder: MediaRecorder; started: number; timer: number; stream: MediaStream } | null>(null);
  // Closing the form while recording discards the clip: nothing is sent (review S10).
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
    if (rec.current) {
      window.clearInterval(rec.current.timer);
      if (rec.current.recorder.state === 'recording') rec.current.recorder.stop();
      rec.current.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const send = async (blob: Blob, durationMs: number) => {
    setState('sending');
    try {
      const draft = await api<VoiceDraft>('POST', '/api/voice-notes', {
        equipmentId, logbookType, field, language, mimeType: blob.type || 'audio/webm', durationMs: Math.max(1, Math.round(durationMs)), audioBase64: await toBase64(blob),
      });
      onDraft(draft);
    } catch (e) {
      setError(e instanceof ApiError && e.problems.length ? e.problems.join(' ') : 'The voice note could not be processed. Type the text instead.');
    }
    setState('idle');
  };

  const start = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return setError('This browser cannot record audio. Type the text instead.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError('No microphone access. Allow the microphone or type the text instead.');
    }
    const recorder = new MediaRecorder(stream, pickType() ? { mimeType: pickType() } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = Date.now();
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearInterval(rec.current?.timer);
      rec.current = null;
      if (!cancelled.current) void send(new Blob(chunks, { type: recorder.mimeType }), Date.now() - started);
    };
    const timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      // Stop at the clip limit of the speech service.
      if (Date.now() - started >= config.maxClipMs - 500 && recorder.state === 'recording') recorder.stop();
    }, 250);
    rec.current = { recorder, started, timer, stream };
    setSeconds(0);
    setState('recording');
    recorder.start();
  };

  return (
    <span className="voice">
      {state === 'idle' && (
        <>
          <select aria-label={`Voice language for ${field}`} value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="unknown">{VOICE_LANGUAGE_LABEL.unknown}</option>
            {config.languages.map((l) => <option key={l} value={l}>{VOICE_LANGUAGE_LABEL[l] ?? l}</option>)}
          </select>
          <button type="button" onClick={start}>🎤 Record voice note</button>
        </>
      )}
      {state === 'recording' && (
        <button type="button" className="recording" onClick={() => rec.current?.recorder.stop()}>
          ■ Stop ({seconds} / {Math.round(config.maxClipMs / 1000)} s)
        </button>
      )}
      {state === 'sending' && <span className="muted">Transcribing and translating…</span>}
      {error && <span className="error" role="status">{error}</span>}
    </span>
  );
}

// The original data of a voice note: audio, transcript, machine translation, signed text.
export function VoiceNoteDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [v, setV] = useState<VoiceNote | null>(null);
  useEffect(() => {
    void api<VoiceNote>('GET', `/api/voice-notes/${id}`).then(setV);
  }, [id]);
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="card dialog wide">
        <h2>Voice note</h2>
        {!v ? <p>Loading…</p> : (
          <dl className="details">
            <dt>Speaker</dt><dd>{v.speaker}</dd>
            <dt>Language</dt><dd>{VOICE_LANGUAGE_LABEL[v.detectedLanguage ?? v.requestedLanguage] ?? v.detectedLanguage}{v.requestedLanguage === 'unknown' && ' (detected)'}</dd>
            <dt>Audio</dt><dd><audio controls src={`/api/voice-notes/${v.id}/audio`} /> <span className="muted">{Math.round((v.durationMs ?? 0) / 100) / 10} s · SHA-256 {v.audioSha256.slice(0, 12)}…</span></dd>
            <dt>Transcript (original)</dt><dd lang={v.detectedLanguage ?? undefined}>{v.transcript}</dd>
            <dt>Machine translation</dt><dd>{v.translation}</dd>
            <dt>Signed English text</dt>
            <dd>{v.confirmation ? <>{v.confirmation.finalText}{v.confirmation.edited && <span className="chip chip-warn"> edited by the speaker</span>}</> : <em>Not confirmed: not part of any entry.</em>}</dd>
            {v.confirmation && <><dt>Confirmed</dt><dd>{v.confirmation.signedBy}, {plantTime(v.confirmation.signedAt)}: “{v.statement}”</dd></>}
            <dt>Service</dt><dd className="muted">{v.provider} {v.model}, requested {plantTime(v.requestedAt)}</dd>
          </dl>
        )}
        <div className="actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
