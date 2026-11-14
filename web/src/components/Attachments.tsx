import { useState, type FormEvent } from 'react';
import { ApiError, ATTACHMENT_ACCEPT, attachmentType, fileSize, MAX_ATTACHMENT_BYTES, plantTime, uploadAttachment, type Entry } from '../api.js';

// Owner 2026-11-14 (D-44): documents on calibration, requalification and maintenance entries (certificate, service
// report, requalification report): listed on the entry with a download link; added later with a reason.

export function AttachmentLinks({ e, full = false }: { e: Pick<Entry, 'attachments'>; full?: boolean }) {
  if (!e.attachments?.length) return null;
  return (
    <ul className="attachments">
      {e.attachments.map((a) => (
        <li key={a.id}>
          <a href={`/api/attachments/${a.id}`} download={a.fileName}>📎 {a.fileName}</a> <span className="muted">({fileSize(a.size)})</span>
          {full && <span className="muted"> · {a.uploadedBy}, {plantTime(a.uploadedAt)}{a.reason ? ` · added: ${a.reason}` : ''} · SHA-256 {a.sha256.slice(0, 12)}…</span>}
        </li>
      ))}
    </ul>
  );
}

// Files chosen in the entry form before the save; checked here for type and size, uploaded after the save.
export function FilePicker({ files, onChange, id = 'documents' }: { files: File[]; onChange: (files: File[]) => void; id?: string }) {
  const [problem, setProblem] = useState('');
  const add = (list: FileList | null) => {
    const next = [...files];
    const bad: string[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!attachmentType(f)) bad.push(`${f.name}: only PDF, PNG and JPEG documents can be attached.`);
      else if (f.size > MAX_ATTACHMENT_BYTES) bad.push(`${f.name}: a document may be at most 10 MB.`);
      else if (next.length >= 10) bad.push(`${f.name}: at most 10 documents per entry.`);
      else if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setProblem(bad.join(' '));
    onChange(next);
  };
  return (
    <fieldset className="checklist">
      <legend>Documents (certificate, service report, requalification report)</legend>
      <label htmlFor={id}>Attach documents (PDF, PNG or JPEG, up to 10 MB each)</label>
      <input id={id} type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      {files.length > 0 && (
        <ul className="attachments">
          {files.map((f, i) => <li key={`${f.name}-${i}`}>📎 {f.name} <span className="muted">({fileSize(f.size)})</span> <button type="button" className="link dark" onClick={() => onChange(files.filter((_, j) => j !== i))}>Remove</button></li>)}
        </ul>
      )}
      {problem && <p className="error">{problem}</p>}
    </fieldset>
  );
}

// Uploads the chosen files to a saved entry version, one by one; returns what failed, in words.
export async function uploadAll(versionId: number, files: File[], reason?: string): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await uploadAttachment(versionId, f, reason);
    } catch (err) {
      failed.push(err instanceof ApiError ? `${f.name}: ${err.problems.join(' ') || err.message}` : (err as Error).message);
    }
  }
  return failed;
}

// Adding a document to an entry saved earlier: with a reason (LB-17).
export function AttachDialog({ entry, code, onCancel, onDone }: { entry: Entry; code: string; onCancel: () => void; onDone: () => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]);
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const failed = await uploadAll(entry.id, files, reason);
    setBusy(false);
    if (failed.length) return setProblems(failed);
    await onDone();
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>Attach a document · {code}</h2>
        <p className="muted">Entry of {plantTime(entry.activityStart)}. The document is kept with the entry and all its versions; it cannot be removed.</p>
        <FilePicker files={files} onChange={setFiles} id="attach-documents" />
        <label>Reason for adding it now<input value={reason} onChange={(e) => setReason(e.target.value)} required placeholder="e.g. certificate received from the vendor" /></label>
        {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy || !files.length || !reason.trim()}>Attach</button>
        </div>
      </form>
    </div>
  );
}
