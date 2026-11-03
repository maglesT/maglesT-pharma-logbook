import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Equipment, type Me, type Product } from '../api.js';

const KIND_LABEL = { equipment: 'Equipment', instrument: 'Instrument', area: 'Area / room' } as const;
const ask = (what: string) => window.prompt(`Reason for ${what}:`)?.trim();

export function MasterData({ me }: { me: Me }) {
  const isAdmin = can(me, 'site.manage');
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
      {tab === 'products' && <ProductList />}
      {tab === 'site' && isAdmin && <SiteForm />}
    </>
  );
}

// Items and products are Medhanta master data (D-29): added, renamed, moved and retired in core, shown here live.
// The Logbook keeps only its own settings per item.
function EquipmentList({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setItems(await api<Equipment[]>('GET', '/api/equipment'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const change = async (eq: Equipment, what: string, body: Partial<Equipment>) => {
    const reason = ask(`${what} of ${eq.code}`);
    if (!reason) return;
    try {
      await api('PATCH', `/api/equipment/${eq.id}`, { ...body, reason });
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };
  const editHold = (eq: Equipment) => {
    const value = window.prompt(`Clean-hold limit for ${eq.code} in hours (empty for none):`, eq.cleanHoldHours?.toString() ?? '');
    if (value !== null) void change(eq, 'changing the clean-hold limit', { cleanHoldHours: value.trim() ? Number(value) : null });
  };
  const flag = (eq: Equipment, key: 'sterile' | 'classified' | 'needsCalibration', label: string) =>
    isAdmin && !(key === 'needsCalibration' && eq.kind === 'area')
      ? <label className="check"><input type="checkbox" checked={eq[key]} onChange={() => void change(eq, `${eq[key] ? 'switching off' : 'switching on'} "${label}"`, { [key]: !eq[key] })} />{label}</label>
      : eq[key] ? label : '';

  return (
    <>
      <p className="muted">Equipment, instruments and rooms are kept in Medhanta master data; ask your master-data editor to add, rename, move or retire one. The Logbook settings below are this site's.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Kind</th><th>Location</th><th>Clean-hold</th><th>Logbook settings</th><th>Status</th></tr></thead>
        <tbody>
          {items.map((eq) => (
            <tr key={eq.id}>
              <td>{eq.code}</td>
              <td>{eq.name}</td>
              <td>{KIND_LABEL[eq.kind]}</td>
              <td>{eq.location}</td>
              <td>{eq.cleanHoldHours ? `${eq.cleanHoldHours} h` : '—'}{isAdmin && <> <button onClick={() => editHold(eq)}>Change</button></>}</td>
              <td>{flag(eq, 'sterile', 'Sterile')} {flag(eq, 'classified', 'Classified')} {flag(eq, 'needsCalibration', 'Needs calibration')}</td>
              <td>{eq.active ? 'Active' : 'Retired'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ProductList() {
  const [items, setItems] = useState<Product[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Product[]>('GET', '/api/products').then(setItems, (err: Error) => setError(err.message));
  }, []);
  return (
    <>
      <p className="muted">Products are kept in Medhanta master data.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Status</th></tr></thead>
        <tbody>
          {items.map((p) => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>{p.active ? 'Active' : 'Inactive'}</td></tr>)}
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
