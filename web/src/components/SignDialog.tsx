import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, MEANING_LABEL, getSignProof } from '../api.js';

// LB-19/LB-20, PL-05: every signing asks for the password again (at Medhanta core) and shows the meaning being signed.
export function SignDialog({
  meaning,
  what,
  children,
  onSign,
  onCancel,
}: {
  meaning: string;
  what: string;
  // The content being signed, shown in full so the signer sees what the signature covers.
  children?: ReactNode;
  onSign: (credentials: { proof: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSign({ proof: await getSignProof() });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'wrong_credentials'
          ? 'Your password was not confirmed for this signature. Try again.'
          : err instanceof ApiError && err.code === 'not_allowed'
            ? 'Your role may not sign.'
            : err instanceof ApiError && err.code === 'content_changed'
              ? 'The content changed while this dialog was open. Close it and review the new content.'
            : err instanceof ApiError && err.code === 'forbidden'
              ? 'Your role may not sign this.'
            : err instanceof ApiError && err.problems.length
              ? err.problems.join(' ')
            : (err as Error).message,
      );
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>Sign: {MEANING_LABEL[meaning] ?? meaning}</h2>
        <p>{what}</p>
        {children}
        <p className="muted">
          Your electronic signature is the legally binding equivalent of your handwritten signature. It records your
          name, the date and time, and the meaning “{MEANING_LABEL[meaning] ?? meaning}”.
        </p>
        <p className="muted">Sign opens a small window where you enter your password again.</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Sign</button>
        </div>
      </form>
    </div>
  );
}
