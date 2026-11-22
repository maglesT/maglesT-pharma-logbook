import { useEffect, useState, type FormEvent } from 'react';
import { api, can, localInputValue, plantTime, refusalLines, type BatchChoice, type Equipment, type EquipmentStatus, type Me, type Reservation } from '../api.js';
import { BatchSelect } from '../pages/EntryForm.js';
import { ReasonDialog } from './ReasonDialog.js';

// D-85 (fix round 21 Nov 2026): an item is reserved for a batch or for dates (from, to, why). The batch is picked from the
// batch records when they are linked; a person holding logbook.equipment.reserve reserves and cancels (with a reason).

export const reservationLine = (r: NonNullable<EquipmentStatus['reservation']>, head = 'Reserved') =>
  `${head}${r.batch ? ` for batch ${r.batch}` : ''}: ${plantTime(r.from)} to ${plantTime(r.until)}, by ${r.by} (${r.purpose})`;

export function Reservations({ me, equipment, onChange }: { me: Me; equipment: Equipment; onChange: () => Promise<void> | void }) {
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const mayReserve = can(me, 'equipment.reserve');
  const load = async () => setRows(await api<Reservation[]>('GET', `/api/equipment/${equipment.id}/reservations`));
  useEffect(() => { void load(); }, [equipment.id]);
  const done = async () => { setAdding(false); await load(); await onChange(); };

  const cancel = async (r: Reservation, reason: string) => {
    try {
      await api('POST', `/api/equipment/${equipment.id}/reservations/${r.id}/cancel`, { reason });
    } catch (err) { throw new Error(refusalLines(err, {}).join(' ')); }
    setCancelling(null);
    await done();
  };
  const now = Date.now();
  return (
    <>
      <p className="muted">A reservation holds this item for a batch or for dates. While a reservation for a batch is in force, the Logbook
        records a use of this item for that batch only.</p>
      {mayReserve && <div className="row"><button className="primary" onClick={() => setAdding(true)}>+ Reserve</button></div>}
      {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {rows && rows.length === 0 && <p className="muted">No reservations.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead><tr><th>From</th><th>To</th><th>Batch</th><th>Why</th><th>Reserved by</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const ended = new Date(r.until).getTime() <= now;
              const state = r.cancelled ? `Cancelled by ${r.cancelled.by}, ${plantTime(r.cancelled.at)}: ${r.cancelled.reason}`
                : ended ? 'Ended' : new Date(r.from).getTime() <= now ? 'In force' : 'Planned';
              return (
                <tr key={r.id} className={r.cancelled || ended ? 'grey' : ''}>
                  <td>{plantTime(r.from)}</td>
                  <td>{plantTime(r.until)}</td>
                  <td>{r.batch ?? '—'}</td>
                  <td>{r.purpose}</td>
                  <td>{r.by}<br /><span className="muted">{plantTime(r.createdAt)}</span></td>
                  <td>{state}</td>
                  <td className="actions-cell">{mayReserve && !r.cancelled && !ended && <button onClick={() => { setProblems([]); setCancelling(r); }}>Cancel</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {cancelling && <ReasonDialog title="Cancel the reservation" label="Reason for cancelling" onSubmit={(reason) => cancel(cancelling, reason)} onCancel={() => setCancelling(null)} />}
      {adding && <ReserveDialog equipment={equipment} onDone={done} onCancel={() => setAdding(false)} />}
    </>
  );
}

function ReserveDialog({ equipment, onDone, onCancel }: { equipment: Equipment; onDone: () => void; onCancel: () => void }) {
  const [from, setFrom] = useState(localInputValue());
  const [until, setUntil] = useState(localInputValue(new Date(Date.now() + 8 * 3_600_000)));
  const [batch, setBatch] = useState('');
  const [typed, setTyped] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [list, setList] = useState<{ linked: boolean; batches: BatchChoice[]; notes?: string[] } | null>(null);
  useEffect(() => {
    api<{ linked: boolean; batches: BatchChoice[]; notes: string[] }>('GET', `/api/equipment/${equipment.id}/batches`)
      .then(setList).catch(() => setList({ linked: false, batches: [] }));
  }, [equipment.id]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    try {
      await api('POST', `/api/equipment/${equipment.id}/reservations`, {
        from: new Date(from).toISOString(), until: new Date(until).toISOString(), purpose,
        ...(batch.trim() ? { batch: batch.trim(), batchTyped: Boolean(list?.linked && typed) } : {}),
      });
      onDone();
    } catch (err) { setProblems(refusalLines(err, {})); }
  };
  const pick = list?.linked && !typed;
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>Reserve {equipment.code}</h2>
        <label>From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label>To<input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} required /></label>
        {(list?.notes ?? []).map((n) => <p key={n} className="reason" role="status">{n}</p>)}
        {pick && <BatchSelect label="For batch (optional, from the batch records)" value={batch} onChange={setBatch} batches={list!.batches} inProductionOnly />}
        {list?.linked && (
          <label className="check"><input type="checkbox" checked={typed} onChange={(e) => { setTyped(e.target.checked); setBatch(''); }} />
            Batch not in the list: type it by hand</label>
        )}
        {list && !pick && <label>For batch (optional)<input value={batch} onChange={(e) => setBatch(e.target.value)} /></label>}
        <label>Why (required)<input value={purpose} onChange={(e) => setPurpose(e.target.value)} required placeholder="e.g. validation run, campaign of batch …" /></label>
        {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={!purpose.trim()}>Reserve</button>
        </div>
      </form>
    </div>
  );
}
