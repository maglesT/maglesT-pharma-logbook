import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Equipment, type Me, type Product } from '../api.js';

const KIND_LABEL = { equipment: 'Equipment', instrument: 'Instrument', area: 'Area / room' } as const;
const ask = (what: string) => window.prompt(`Reason for ${what}:`)?.trim();
const BASIS_LABEL = { operation: 'Operation-based', frequency: 'Frequency-based' } as const;
const hours = (v: string) => (v.trim() ? Number(v) : null);

// S16: how an item's cleaning is scheduled, in words.
export function scheduleText(eq: Equipment): string {
  if (eq.kind === 'area' && eq.cleaningBasis === 'frequency') return eq.cleaningFrequencyHours ? `Every ${eq.cleaningFrequencyHours} h` : 'Frequency not set';
  const parts = [eq.dirtyHoldHours ? `dirty hold ${eq.dirtyHoldHours} h` : '', eq.cleanHoldHours ? `clean hold ${eq.cleanHoldHours} h` : ''].filter(Boolean);
  const text = parts.join(' · ') || 'no hold times';
  return eq.kind === 'area' ? `Operation-based: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

// The schedule fields of one item, for the add form and the editor.
function ScheduleFields({ kind, v, set }: { kind: Equipment['kind']; v: ScheduleForm; set: (v: ScheduleForm) => void }) {
  const frequency = kind === 'area' && v.cleaningBasis === 'frequency';
  return (
    <>
      {kind === 'area' && (
        <select aria-label="Room cleaning" value={v.cleaningBasis} onChange={(e) => set({ ...v, cleaningBasis: e.target.value as ScheduleForm['cleaningBasis'] })}>
          <option value="operation">Operation-based room (cleaned after use)</option>
          <option value="frequency">Frequency-based room (cleaned on a schedule)</option>
        </select>
      )}
      {frequency ? (
        <>
          <input aria-label="Cleaning frequency (hours)" placeholder="Every … hours" inputMode="numeric" value={v.cleaningFrequencyHours}
            onChange={(e) => set({ ...v, cleaningFrequencyHours: e.target.value })} />
          <button type="button" onClick={() => set({ ...v, cleaningFrequencyHours: '24' })}>Daily</button>
          <button type="button" onClick={() => set({ ...v, cleaningFrequencyHours: '168' })}>Weekly</button>
        </>
      ) : (
        <>
          <input aria-label="Dirty-hold hours" placeholder="Dirty-hold hours" inputMode="numeric" value={v.dirtyHoldHours} onChange={(e) => set({ ...v, dirtyHoldHours: e.target.value })} />
          <input aria-label="Clean-hold hours" placeholder="Clean-hold hours" inputMode="numeric" value={v.cleanHoldHours} onChange={(e) => set({ ...v, cleanHoldHours: e.target.value })} />
        </>
      )}
    </>
  );
}
interface ScheduleForm { cleaningBasis: 'operation' | 'frequency'; dirtyHoldHours: string; cleanHoldHours: string; cleaningFrequencyHours: string }
const scheduleBody = (kind: Equipment['kind'], v: ScheduleForm) => {
  const frequency = kind === 'area' && v.cleaningBasis === 'frequency';
  return {
    ...(kind === 'area' ? { cleaningBasis: v.cleaningBasis } : {}),
    dirtyHoldHours: frequency ? null : hours(v.dirtyHoldHours),
    cleanHoldHours: frequency ? null : hours(v.cleanHoldHours),
    cleaningFrequencyHours: frequency ? hours(v.cleaningFrequencyHours) : null,
  };
};

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
  const empty = { code: '', name: '', kind: 'equipment' as Equipment['kind'], location: '', sterile: false, classified: false, needsCalibration: false,
    cleaningBasis: 'operation' as ScheduleForm['cleaningBasis'], dirtyHoldHours: '', cleanHoldHours: '', cleaningFrequencyHours: '' };
  const [editing, setEditing] = useState<{ id: number; v: ScheduleForm; error: string } | null>(null);
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
      const { cleaningBasis: _b, dirtyHoldHours: _d, cleanHoldHours: _c, cleaningFrequencyHours: _f, ...rest } = form;
      await api('POST', '/api/equipment', {
        ...rest,
        needsCalibration: form.needsCalibration || form.kind === 'instrument',
        ...scheduleBody(form.kind, form),
      });
      setForm(empty);
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'code_taken' ? 'That ID exists already (IDs are never reused).'
        : err instanceof ApiError && err.message && err.message !== err.code ? err.message
          : 'Check the fields: the ID may use letters, digits and . _ / -; hours are whole numbers.');
    }
  };

  const toggleActive = async (eq: Equipment) => {
    const reason = ask(`${eq.active ? 'retiring' : 'reactivating'} ${eq.code}`);
    if (!reason) return;
    await api('PATCH', `/api/equipment/${eq.id}`, { active: !eq.active, reason });
    await load();
  };

  const startEdit = (eq: Equipment) => setEditing({ id: eq.id, error: '', v: {
    cleaningBasis: eq.cleaningBasis ?? 'operation', dirtyHoldHours: eq.dirtyHoldHours?.toString() ?? '',
    cleanHoldHours: eq.cleanHoldHours?.toString() ?? '', cleaningFrequencyHours: eq.cleaningFrequencyHours?.toString() ?? '' } });
  const saveEdit = async (eq: Equipment) => {
    if (!editing) return;
    const reason = ask(`changing the cleaning schedule of ${eq.code}`);
    if (!reason) return;
    try {
      await api('PATCH', `/api/equipment/${eq.id}`, { ...scheduleBody(eq.kind, editing.v), reason });
      setEditing(null);
      await load();
    } catch (err) {
      setEditing({ ...editing, error: err instanceof ApiError && err.message ? err.message : 'Hours must be whole numbers above 0.' });
    }
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
          <ScheduleFields kind={form.kind} v={form} set={(v) => setForm({ ...form, ...v })} />
          <label className="check"><input type="checkbox" checked={form.sterile} onChange={(e) => setForm({ ...form, sterile: e.target.checked })} />Sterile</label>
          <label className="check"><input type="checkbox" checked={form.classified} onChange={(e) => setForm({ ...form, classified: e.target.checked })} />Classified room</label>
          <label className="check"><input type="checkbox" checked={form.needsCalibration || form.kind === 'instrument'} onChange={(e) => setForm({ ...form, needsCalibration: e.target.checked })} />Needs calibration</label>
          <button className="primary" type="submit">Add</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Kind</th><th>Location</th><th>Cleaning schedule</th><th>Flags</th><th>Status</th>{isAdmin && <th />}</tr></thead>
        <tbody>
          {items.map((eq) => (<Fragment key={eq.id}>
            <tr key={eq.id}>
              <td>{eq.code}</td>
              <td>{eq.name}</td>
              <td>{KIND_LABEL[eq.kind]}</td>
              <td>{eq.location}</td>
              <td>{scheduleText(eq)}</td>
              <td>{[eq.sterile && 'Sterile', eq.classified && 'Classified', eq.needsCalibration && 'Calibrated'].filter(Boolean).join(', ')}</td>
              <td>{eq.active ? 'Active' : 'Retired'}</td>
              {isAdmin && (
                <td>
                  <button onClick={() => startEdit(eq)}>Cleaning schedule</button> <button onClick={() => toggleActive(eq)}>{eq.active ? 'Retire' : 'Reactivate'}</button>
                </td>
              )}
            </tr>
            {editing?.id === eq.id && (
              <tr key={`${eq.id}-edit`}>
                <td colSpan={8}>
                  <div className="row">
                    <ScheduleFields kind={eq.kind} v={editing.v} set={(v) => setEditing({ ...editing, v })} />
                    <button className="primary" onClick={() => saveEdit(eq)}>Save</button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                  {editing.error && <p className="error">{editing.error}</p>}
                </td>
              </tr>
            )}
          </Fragment>))}
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
