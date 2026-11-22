import { useState, type FormEvent } from 'react';

// An in-page box that asks for a reason (replaces the browser pop-up): the work happens in onSubmit; a refusal shows here.
export function ReasonDialog({ title, label = 'Reason', onSubmit, onCancel }: {
  title: string; label?: string; onSubmit: (reason: string) => Promise<void> | void; onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setError('Give a reason.');
    setBusy(true);
    setError('');
    try { await onSubmit(reason.trim()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>{title}</h2>
        <label>{label}<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>OK</button>
        </div>
      </form>
    </div>
  );
}
