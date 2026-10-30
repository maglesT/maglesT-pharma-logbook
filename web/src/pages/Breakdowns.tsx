import { useEffect, useState } from 'react';
import { api, BREAKDOWN_STATUS_LABEL, downtimeText, FAILURE_CATEGORIES, plantTime, type Equipment, type Register } from '../api.js';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const hours = (h: number | null) => (h === null ? '—' : `${h} h`);

// Site-wide breakdown register (S9, D-25): one row per breakdown, counts, MTTR and MTBF.
export function Breakdowns({ onOpen }: { onOpen: (equipmentId: number) => void }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [f, setF] = useState({ fromDay: day(-90), toDay: day(0), equipmentId: '', location: '', category: '', status: '', sort: 'occurred' });
  const [data, setData] = useState<Register | null>(null);
  const query = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
  const load = async () => setData(await api<Register>('GET', `/api/breakdowns?${query()}`));
  useEffect(() => {
    void api<Equipment[]>('GET', '/api/equipment').then(setEquipment);
    void load();
  }, []);
  const locations = [...new Set(equipment.map((e) => e.location).filter(Boolean))].sort();
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  return (
    <>
      <h1>Breakdown register</h1>
      <div className="card row">
        <label>From<input type="date" value={f.fromDay} onChange={(e) => set('fromDay', e.target.value)} /></label>
        <label>To<input type="date" value={f.toDay} onChange={(e) => set('toDay', e.target.value)} /></label>
        <label>
          Machine
          <select value={f.equipmentId} onChange={(e) => set('equipmentId', e.target.value)}>
            <option value="">All</option>
            {equipment.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
          </select>
        </label>
        <label>
          Location
          <select value={f.location} onChange={(e) => set('location', e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>
          Failure type
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">All</option>
            {FAILURE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          Status
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All</option>
            {Object.entries(BREAKDOWN_STATUS_LABEL).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>
          Sort
          <select value={f.sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="occurred">Newest first</option>
            <option value="downtime">Longest downtime first</option>
          </select>
        </label>
        <button className="primary" onClick={load}>Show</button>
        <a className="button" href={`/api/export/breakdowns.pdf?${query()}`}>PDF</a>
        <a className="button" href={`/api/export/breakdowns.csv?${query()}`}>CSV</a>
      </div>

      {data && (
        <>
          <table className="register">
            <thead>
              <tr><th>Machine</th><th>Location</th><th>Occurred</th><th>Repair end</th><th>QA released</th><th>Downtime</th><th>Failure type</th><th>What happened</th><th>Root cause</th><th>Work done</th><th>Parts used</th><th>Done by</th><th>WO</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.items.length === 0 && <tr><td colSpan={14} className="muted">No breakdowns in this period.</td></tr>}
              {data.items.map((b) => {
                const [label, cls] = BREAKDOWN_STATUS_LABEL[b.status] ?? [b.status, 'chip-warn'];
                return (
                  <tr key={b.entryId} className="clickable" onClick={() => onOpen(b.equipmentId)}>
                    <td>{b.code}<br /><span className="muted">{b.name}</span></td>
                    <td>{b.location}</td>
                    <td>{plantTime(b.occurredAt)}</td>
                    <td>{plantTime(b.repairEnd)}</td>
                    <td>{plantTime(b.releasedAt)}</td>
                    <td>{downtimeText(b)}</td>
                    <td>{b.failureCategory ?? '—'}</td>
                    <td>{b.description}</td>
                    <td>{b.rootCause || '—'}</td>
                    <td>{b.workDone || '—'}</td>
                    <td>{b.partsText || '—'}</td>
                    <td>{b.doneBy || '—'}</td>
                    <td>{b.workOrderRef}</td>
                    <td><span className={`chip ${cls}`}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h2>Per machine</h2>
          <p className="muted">Downtime runs from the breakdown to the QA release. MTTR: mean downtime of released breakdowns. MTBF: operating time in the period (from installation, if later) per failure.</p>
          <table>
            <thead><tr><th>Machine</th><th>Failures</th><th>Downtime</th><th>MTTR</th><th>MTBF</th></tr></thead>
            <tbody>
              {data.stats.machines.map((m) => (
                <tr key={m.equipmentId}><td>{m.code} · {m.name}</td><td>{m.failures}</td><td>{m.downtimeHours} h</td><td>{hours(m.mttrHours)}</td><td>{hours(m.mtbfHours)}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>Per failure category</h2>
          <table>
            <thead><tr><th>Category</th><th>Failures</th></tr></thead>
            <tbody>{data.stats.categories.map((c) => <tr key={c.category}><td>{c.category}</td><td>{c.failures}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </>
  );
}
