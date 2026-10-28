import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Equipment, type Me, type Product } from '../api.js';

const KIND_LABEL = { equipment: 'Equipment', instrument: 'Instrument', area: 'Area / room' } as const;
const ask = (what: string) => window.prompt(`Reason for ${what}:`)?.trim();

export function MasterData({ me }: { me: Me }) {
  const isAdmin = me.roles.includes('admin');
  const [tab, setTab] = useState<'equipment' | 'products' | 'site'>('equipment');
  return (
    <>
      <h1>Master data</h1>
      <div className="subtabs">
        <button className={tab === 'equipment' ? 'on' : ''} onClick={() => setTab('equipment')}>Equipment and areas</button>
        <button className={tab === 'products' ? 'on' : ''} onClick={() => setTab('products')}>Products</button>
        {isAdmin && <button className={tab === 'site' ? 'on' : ''} onClick={() => setTab('site')}>Site</button>}
      </div>
      {tab === 'equipment' && <EquipmentList isAdmin={isAdmin} />}
      {tab === 'products' && <ProductList isAdmin={isAdmin} />}
      {tab === 'site' && isAdmin && <SiteForm />}
    </>
  );
}

function EquipmentList({ isAdmin }: { isAdmin: boolean }) {
  const empty = { code: '', name: '', kind: 'equipment' as Equipment['kind'], location: '', sterile: false, classified: false, cleanHoldHours: '' };
  const [items, setItems] = useState<Equipment[]>([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const load = async () => setItems(await api<Equipment[]>('GET', '/api/equipment'));
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/api/equipment', { ...form, cleanHoldHours: form.cleanHoldHours ? Number(form.cleanHoldHours) : null });
      setForm(empty);
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'code_taken' ? 'That ID exists already (IDs are never reused).' : 'Check the fields: the ID may use letters, digits and . _ / -');
    }
  };

  const toggleActive = async (eq: Equipment) => {
    const reason = ask(`${eq.active ? 'retiring' : 'reactivating'} ${eq.code}`);
    if (!reason) return;
    await api('PATCH', `/api/equipment/${eq.id}`, { active: !eq.active, reason });
    await load();
  };

  const editHold = async (eq: Equipment) => {
    const value = window.prompt(`Clean-hold limit for ${eq.code} in hours (empty for none):`, eq.cleanHoldHours?.toString() ?? '');
    if (value === null) return;
    const reason = ask(`changing the clean-hold limit of ${eq.code}`);
    if (!reason) return;
    await api('PATCH', `/api/equipment/${eq.id}`, { cleanHoldHours: value.trim() ? Number(value) : null, reason });
    await load();
  };

  return (
    <>
      {isAdmin && (
        <form className="card row" onSubmit={create}>
          <input placeholder="ID (e.g. GRN-01)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Equipment['kind'] })}>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input placeholder="Clean-hold hours" inputMode="numeric" value={form.cleanHoldHours} onChange={(e) => setForm({ ...form, cleanHoldHours: e.target.value })} />
          <label className="check"><input type="checkbox" checked={form.sterile} onChange={(e) => setForm({ ...form, sterile: e.target.checked })} />Sterile</label>
          <label className="check"><input type="checkbox" checked={form.classified} onChange={(e) => setForm({ ...form, classified: e.target.checked })} />Classified room</label>
          <button className="primary" type="submit">Add</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Kind</th><th>Location</th><th>Clean-hold</th><th>Flags</th><th>Status</th>{isAdmin && <th />}</tr></thead>
        <tbody>
          {items.map((eq) => (
            <tr key={eq.id}>
              <td>{eq.code}</td>
              <td>{eq.name}</td>
              <td>{KIND_LABEL[eq.kind]}</td>
              <td>{eq.location}</td>
              <td>{eq.cleanHoldHours ? `${eq.cleanHoldHours} h` : '—'}</td>
              <td>{[eq.sterile && 'Sterile', eq.classified && 'Classified'].filter(Boolean).join(', ')}</td>
              <td>{eq.active ? 'Active' : 'Retired'}</td>
              {isAdmin && (
                <td>
                  <button onClick={() => editHold(eq)}>Clean-hold</button> <button onClick={() => toggleActive(eq)}>{eq.active ? 'Retire' : 'Reactivate'}</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ProductList({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Product[]>([]);
  const [form, setForm] = useState({ code: '', name: '' });
  const [error, setError] = useState('');
  const load = async () => setItems(await api<Product[]>('GET', '/api/products'));
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/api/products', form);
      setForm({ code: '', name: '' });
      await load();
    } catch {
      setError('That product code exists already.');
    }
  };

  const toggle = async (p: Product) => {
    const reason = ask(`${p.active ? 'deactivating' : 'reactivating'} ${p.code}`);
    if (!reason) return;
    await api('PATCH', `/api/products/${p.id}`, { active: !p.active, reason });
    await load();
  };

  return (
    <>
      {isAdmin && (
        <form className="card row" onSubmit={create}>
          <input placeholder="Product code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input placeholder="Product name and strength" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <button className="primary" type="submit">Add</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Status</th>{isAdmin && <th />}</tr></thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{p.code}</td><td>{p.name}</td><td>{p.active ? 'Active' : 'Inactive'}</td>
              {isAdmin && <td><button onClick={() => toggle(p)}>{p.active ? 'Deactivate' : 'Reactivate'}</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SiteForm() {
  const [form, setForm] = useState({ name: '', code: '' });
  const [saved, setSaved] = useState('');
  useEffect(() => {
    void api<{ name: string; code: string } | null>('GET', '/api/site').then((s) => s && setForm(s));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const reason = ask('changing the site record');
    if (!reason) return;
    await api('PUT', '/api/site', { ...form, reason });
    setSaved('Saved.');
  };

  return (
    <form className="card" onSubmit={save}>
      <label>Site name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Site code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
      <button className="primary" type="submit">Save</button>
      {saved && <p className="notice">{saved}</p>}
    </form>
  );
}
