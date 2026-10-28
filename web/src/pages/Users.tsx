import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, plantTime, ROLE_LABEL, ROLES, type Me, type Role, type User } from '../api.js';

function RolePicker({ value, onChange }: { value: Role[]; onChange: (r: Role[]) => void }) {
  return (
    <span className="roles">
      {ROLES.map((r) => (
        <label key={r} className="check">
          <input
            type="checkbox"
            checked={value.includes(r)}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
          />
          {ROLE_LABEL[r]}
        </label>
      ))}
    </span>
  );
}

export function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', fullName: '', roles: ['operator'] as Role[] });
  const [editing, setEditing] = useState<User | null>(null);

  const load = async () => setUsers(await api<User[]>('GET', '/api/users'));
  useEffect(() => {
    void load();
  }, []);

  const fail = (e: unknown) =>
    setError(e instanceof ApiError && e.code === 'username_taken' ? 'That user ID exists already (user IDs are never reused).' : (e as Error).message);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ user: User; temporaryPassword: string }>('POST', '/api/users', form);
      setNotice(`User ${res.user.username} created. Temporary password (shown once): ${res.temporaryPassword}`);
      setForm({ username: '', fullName: '', roles: ['operator'] });
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const ask = (what: string) => window.prompt(`Reason for ${what}:`)?.trim();

  const save = async () => {
    if (!editing) return;
    const reason = ask(`changing ${editing.username}`);
    if (!reason) return;
    try {
      await api('PATCH', `/api/users/${editing.id}`, { fullName: editing.fullName, roles: editing.roles, active: editing.active, reason });
      setEditing(null);
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const reset = async (u: User) => {
    const reason = ask(`resetting the password of ${u.username}`);
    if (!reason) return;
    const res = await api<{ temporaryPassword: string }>('POST', `/api/users/${u.id}/reset-password`, { reason });
    setNotice(`New temporary password for ${u.username} (shown once): ${res.temporaryPassword}`);
    await load();
  };

  return (
    <>
      <h1>Users</h1>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <form className="card row" onSubmit={create}>
        <input placeholder="User ID" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        <RolePicker value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
        <button className="primary" type="submit">Add user</button>
      </form>

      <table>
        <thead>
          <tr><th>User ID</th><th>Name</th><th>Roles</th><th>Status</th><th>Last login</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) =>
            editing?.id === u.id ? (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td><input value={editing.fullName} onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} /></td>
                <td><RolePicker value={editing.roles} onChange={(roles) => setEditing({ ...editing, roles })} /></td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={editing.active} disabled={u.id === me.id}
                      onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                    Active
                  </label>
                </td>
                <td />
                <td><button onClick={save}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button></td>
              </tr>
            ) : (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.fullName}</td>
                <td>{u.roles.map((r) => ROLE_LABEL[r]).join(', ')}</td>
                <td>{!u.active ? 'Inactive' : u.locked ? <span className="chip chip-bad">Locked</span> : 'Active'}</td>
                <td>{plantTime(u.lastLoginAt)}</td>
                <td>
                  <button onClick={() => setEditing(u)}>Edit</button> <button onClick={() => reset(u)}>Reset password</button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </>
  );
}
