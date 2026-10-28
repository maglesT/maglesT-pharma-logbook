import { useState, type FormEvent } from 'react';
import { ApiError, MEANING_LABEL } from '../api.js';

// LB-19/LB-20: every signing asks for both components and shows the meaning being signed.
export function SignDialog({
  meaning,
  what,
  onSign,
  onCancel,
}: {
  meaning: string;
  what: string;
  onSign: (credentials: { username: string; password: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSign({ username, password });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'wrong_credentials'
          ? 'User ID or password is wrong. Repeated failures lock your account.'
          : err instanceof ApiError && err.code === 'not_allowed'
            ? 'Your role may not sign.'
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
        <p className="muted">
          Your electronic signature is the legally binding equivalent of your handwritten signature. It records your
          name, the date and time, and the meaning “{MEANING_LABEL[meaning] ?? meaning}”.
        </p>
        <label>
          User ID
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Sign</button>
        </div>
      </form>
    </div>
  );
}
