import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, cleaningText, QUAL_LABEL, type Candidate, type Equipment, type Me, type Product } from '../api.js';

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

// Items and products are Medhanta master data (D-29). Owner 2026-11-12 (point 4): an item is added to the Logbook by
// choosing its ID (searchable; only qualified items); its name, location, hold times and frequencies are pulled from
// master data and its qualification from the Qualification system, never typed here. The Logbook keeps only whether
// the item is sterile and in a classified room. Retiring is done in master data.
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
  const flag = (eq: Equipment, key: 'sterile' | 'classified', label: string) =>
    isAdmin
      ? <label className="check"><input type="checkbox" checked={eq[key]} onChange={() => void change(eq, `${eq[key] ? 'switching off' : 'switching on'} "${label}"`, { [key]: !eq[key] })} />{label}</label>
      : eq[key] ? label : '';

  return (
    <>
      {isAdmin && <AddItem onAdded={load} />}
      <p className="muted">Name, location, hold times, frequencies and calibration come from Medhanta master data; ask your master-data editor to change them or to retire an item. Only the Logbook settings (sterile, classified room) are this site's.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Kind</th><th>Location</th><th>Cleaning</th><th>PM</th><th>Calibration</th><th>Requalification</th><th>Logbook settings</th><th>Status</th></tr></thead>
        <tbody>
          {items.map((eq) => (
            <tr key={eq.id}>
              <td><strong>{eq.code}</strong></td>
              <td>{eq.name}</td>
              <td>{KIND_LABEL[eq.kind]}</td>
              <td>{eq.location || '—'}</td>
              <td>{cleaningText(eq)}</td>
              <td>{eq.pmFrequencyDays ? `every ${eq.pmFrequencyDays} days` : '—'}</td>
              <td>{eq.calibrationFrequencyDays ? `every ${eq.calibrationFrequencyDays} days` : eq.needsCalibration ? 'per certificate' : '—'}</td>
              <td>{eq.requalificationFrequencyMonths ? `every ${eq.requalificationFrequencyMonths} months` : '—'}</td>
              <td>{flag(eq, 'sterile', 'Sterile')} {flag(eq, 'classified', 'Classified')}</td>
              <td>{eq.active ? 'Active' : 'Retired in master data'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AddItem({ onAdded }: { onAdded: () => Promise<void> }) {
  const [list, setList] = useState<{ qualificationLinked: boolean; items: Candidate[] } | null>(null);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [settings, setSettings] = useState({ sterile: false, classified: false, reason: '' });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const load = () => api<{ qualificationLinked: boolean; items: Candidate[] }>('GET', '/api/equipment/candidates').then(setList, (e: Error) => setMsg({ error: e.message }));
  useEffect(() => {
    void load();
  }, []);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (list?.items ?? []).filter((c) => words.every((w) => `${c.code} ${c.name} ${c.location}`.toLowerCase().includes(w))).slice(0, 50);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    try {
      await api('POST', '/api/equipment', { itemId: chosen.itemId, ...settings });
      setMsg({ ok: `${chosen.code} added to the Logbook.` });
      setChosen(null);
      setQ('');
      setSettings({ sterile: false, classified: false, reason: '' });
      await Promise.all([load(), onAdded()]);
    } catch (err) {
      setMsg({ error: err instanceof ApiError ? err.message : 'Could not add the item.' });
    }
  };
  const row = (label: string, value: string) => <div><dt>{label}</dt><dd>{value || '—'}</dd></div>;
  return (
    <form className="card add-item" onSubmit={add}>
      <h2>Add an item to the Logbook</h2>
      <label>Equipment / instrument / area ID
        <input type="search" placeholder="Search by ID, name or location" value={q} onChange={(e) => { setQ(e.target.value); setChosen(null); }} aria-label="Search the ID" />
      </label>
      {!chosen && (
        <div className="pick-list" role="listbox" aria-label="Items in master data">
          {shown.length === 0 && <p className="muted">{list ? 'No item matches.' : 'Loading…'}</p>}
          {shown.map((c) => (
            <button type="button" role="option" aria-selected={false} key={c.itemId} className={c.selectable ? 'pick' : 'pick off'} disabled={!c.selectable}
              title={c.selectable ? '' : `${QUAL_LABEL[c.qualification ?? ''] ?? 'Not qualified'}: only qualified items can be added`}
              onClick={() => { setChosen(c); setQ(c.code); setMsg({}); }}>
              <strong>{c.code}</strong> <span>{c.name}</span> <span className="muted">{c.location}</span>
              {list?.qualificationLinked && <span className={c.selectable ? 'chip chip-ok' : 'chip chip-bad'}>{QUAL_LABEL[c.qualification ?? ''] ?? c.qualification}</span>}
            </button>
          ))}
        </div>
      )}
      {chosen && (
        <>
          <dl className="fields pulled">
            {row('Name', chosen.name)}
            {row('Kind', KIND_LABEL[chosen.kind])}
            {row('Location', chosen.location)}
            {row('Make / model / serial', [chosen.make, chosen.model, chosen.serial].filter(Boolean).join(' · '))}
            {row('Cleaning', cleaningText(chosen))}
            {row('Preventive maintenance', chosen.pmFrequencyDays ? `every ${chosen.pmFrequencyDays} days` : '')}
            {row('Calibration', chosen.calibrationFrequencyDays ? `every ${chosen.calibrationFrequencyDays} days` : '')}
            {row('Requalification', chosen.requalificationFrequencyMonths ? `every ${chosen.requalificationFrequencyMonths} months` : '')}
            {list?.qualificationLinked && row('Qualification', `${QUAL_LABEL[chosen.qualification ?? ''] ?? ''}${chosen.nextReviewDue ? ` · next review ${chosen.nextReviewDue}` : ''}`)}
          </dl>
          <p className="muted">Pulled from master data and the Qualification system: nothing to type.</p>
          <div className="row">
            {chosen.kind !== 'area' && <label className="check"><input type="checkbox" checked={settings.sterile} onChange={(e) => setSettings({ ...settings, sterile: e.target.checked })} />Sterile</label>}
            <label className="check"><input type="checkbox" checked={settings.classified} onChange={(e) => setSettings({ ...settings, classified: e.target.checked })} />Classified room</label>
          </div>
          <label>Reason<input value={settings.reason} onChange={(e) => setSettings({ ...settings, reason: e.target.value })} placeholder="e.g. new line commissioned (CC-2026-014)" /></label>
          <div className="row">
            <button className="primary" type="submit" disabled={!settings.reason.trim()}>Add to the Logbook</button>
            <button type="button" onClick={() => { setChosen(null); setQ(''); }}>Cancel</button>
          </div>
        </>
      )}
      {msg.ok && <p className="notice">{msg.ok}</p>}
      {msg.error && <p className="error">{msg.error}</p>}
    </form>
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
