import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api.js';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/api/login', { username, password });
      onLoggedIn();
    } catch {
      setError('Login failed. Check your user ID and password. After 5 failed attempts the account is locked.');
    }
  };

  return (
    <main className="page narrow login">
      <div className="login-brand" aria-hidden="true" />
      <h1>Pharma Logbook</h1>
      <p className="muted">Electronic GMP logbooks for equipment, rooms and breakdowns. Log in with your own user ID.</p>
      <form className="card" onSubmit={submit}>
        <label>
          User ID
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">Log in</button>
      </form>
    </main>
  );
}

export function ChangePassword({ me, forced = false, onDone }: { me: Me; forced?: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== repeat) return setError('The new passwords do not match.');
    try {
      await api('POST', '/api/me/password', { current, new: next });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'wrong_password' ? 'The current password is wrong.' : (err as Error).message);
    }
  };

  return (
    <main className="page narrow">
      <h1>Change password</h1>
      {forced && <p>Hello {me.fullName}. You must set a new password before you continue.</p>}
      <form className="card" onSubmit={submit}>
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </label>
        <label>
          New password (at least 10 characters, not containing your user ID)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <label>
          Repeat new password
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">Save password</button>
      </form>
    </main>
  );
}
