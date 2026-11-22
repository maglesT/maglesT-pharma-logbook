import { useEffect, useState, type FormEvent } from 'react';
import { api, plantDay, plantTime, refusalLines, type BreakdownItem, type Equipment, type Me, type Due, DUE_LABEL } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

// Engineering work orders (owner decision, 22 Nov 2026): a list, a page per work order, a tab on the equipment page.
// Raised from a breakdown, a due preventive maintenance or calibration, or by hand; people are picked from the list.
export interface WorkOrder {
  id: number; number: string; equipmentId: number; code: string; name?: string; kind: string; kindLabel: string; title: string; description: string;
  status: 'open' | 'in_progress' | 'done' | 'closed'; statusLabel: string; overdue: boolean; entryId: number | null; assignedTo: number | null; assignedToName: string | null;
  targetDate: string | null; raisedBy: string; raisedAt: string; startedAt: string | null; workDone: string; parts: { name: string; partNumber: string; quantity: number }[];
  partsText: string; timeMinutes: number | null; timeText: string; doneBy: string | null; doneAt: string | null; closedBy: string | null; closedAt: string | null;
  mayDo: boolean; mayClose: boolean;
  signatures?: { meaning: string; by: string; at: string }[]; history?: { at: string; by: string; text: string }[]; doneHash?: string; closeHash?: string;
}
interface Person { id: number; name: string }
const STATUS_CHIP: Record<string, string> = { open: 'chip-warn', in_progress: 'chip-warn', done: 'chip-ok', closed: 'chip-ok' };
const KINDS: [string, string][] = [['breakdown', 'Breakdown'], ['preventive', 'Preventive maintenance'], ['calibration', 'Calibration'], ['other', 'Other']];
const problemsOf = (err: unknown) => refusalLines(err, {}).join(' ');

export const woStatusChip = (w: Pick<WorkOrder, 'status' | 'statusLabel' | 'overdue'>) => (
  <><span className={`chip ${STATUS_CHIP[w.status]}`}>{w.statusLabel}</span>{w.overdue && <> <span className="chip chip-bad">Overdue</span></>}</>
);
const mayRaise = (me: Me) => me.permissions.includes('logbook.workorder.raise');

// The box that raises a work order; what the caller knows is filled in (item, kind, title, description, breakdown).
export interface RaisePreset { equipmentId?: number; kind?: string; title?: string; description?: string; entryId?: number }
export function RaiseDialog({ preset, equipment, onDone, onCancel }: { preset: RaisePreset; equipment: Equipment[]; onDone: (id: number) => void; onCancel: () => void }) {
  const [f, setF] = useState({ equipmentId: String(preset.equipmentId ?? ''), kind: preset.kind ?? 'other', title: preset.title ?? '', description: preset.description ?? '', targetDate: '', assignedTo: '' });
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  // Optional: link one of the item's open breakdowns that has no work order yet.
  const [breakdowns, setBreakdowns] = useState<BreakdownItem[]>([]);
  const [linked, setLinked] = useState<number | null>(preset.entryId ?? null);
  useEffect(() => { void api<Person[]>('GET', '/api/workorders/people').then(setPeople).catch(() => setPeople([])); }, []);
  useEffect(() => {
    setBreakdowns([]);
    if (preset.entryId !== undefined || !f.equipmentId) return;
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA');
    void api<{ items: BreakdownItem[] }>('GET', `/api/breakdowns?fromDay=${day(-365)}&toDay=${day(1)}&equipmentId=${f.equipmentId}`)
      .then((r) => setBreakdowns(r.items.filter((b) => !b.workOrder && b.status !== 'released'))).catch(() => setBreakdowns([]));
  }, [f.equipmentId]);
  const link = (v: string) => {
    const b = breakdowns.find((x) => String(x.entryId) === v);
    setLinked(b ? b.entryId : null);
    if (b) setF({ ...f, kind: 'breakdown', title: f.title || b.description.slice(0, 120), description: f.description || b.description });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ id: number }>('POST', '/api/workorders', { equipmentId: Number(f.equipmentId), kind: f.kind, title: f.title, description: f.description,
        targetDate: f.targetDate || null, assignedTo: f.assignedTo ? Number(f.assignedTo) : null, entryId: linked });
      onDone(r.id);
    } catch (err) { setError(problemsOf(err)); }
  };
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>Raise a work order</h2>
        <label>Item
          <select value={f.equipmentId} onChange={(e) => set('equipmentId', e.target.value)} disabled={preset.equipmentId !== undefined} required>
            <option value="">Choose…</option>
            {equipment.filter((q) => q.active).map((q) => <option key={q.id} value={q.id}>{q.code} · {q.name}</option>)}
          </select>
        </label>
        {preset.entryId === undefined && breakdowns.length > 0 && (
          <label>For a breakdown (optional)
            <select value={linked ?? ''} onChange={(e) => link(e.target.value)}>
              <option value="">None</option>
              {breakdowns.map((b) => <option key={b.entryId} value={b.entryId}>{plantTime(b.occurredAt)} · {b.description.slice(0, 60)}</option>)}
            </select>
          </label>
        )}
        <label>Kind
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)} disabled={linked !== null}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label>Title<input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required /></label>
        <label>What is to be done<textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></label>
        <label>Assigned to
          <select value={f.assignedTo} onChange={(e) => set('assignedTo', e.target.value)}>
            <option value="">Nobody yet</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Target date<input type="date" value={f.targetDate} onChange={(e) => set('targetDate', e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Raise</button></div>
      </form>
    </div>
  );
}

function Table({ items, onOpen, showItem }: { items: WorkOrder[]; onOpen: (id: number) => void; showItem: boolean }) {
  if (!items.length) return <p className="muted">No work orders.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Number</th>{showItem && <th>Item</th>}<th>Kind</th><th>Title</th><th>Status</th><th>Assigned to</th><th>Raised</th><th>Target date</th><th>Closed</th></tr></thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className="clickable" onClick={() => onOpen(w.id)}>
              <td><strong>{w.number}</strong></td>
              {showItem && <td>{w.code}<br /><span className="muted">{w.name}</span></td>}
              <td>{w.kindLabel}</td>
              <td>{w.title}</td>
              <td>{woStatusChip(w)}</td>
              <td>{w.assignedToName ?? <span className="muted">Nobody yet</span>}</td>
              <td>{plantTime(w.raisedAt)}<br /><span className="muted">{w.raisedBy}</span></td>
              <td>{w.targetDate ? plantDay(w.targetDate) : '—'}</td>
              <td>{w.closedAt ? plantTime(w.closedAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The menu page: every work order, newest first, by status and item.
export function WorkOrders({ me, openId, onOpenItem }: { me: Me; openId?: number; onOpenItem: (equipmentId: number) => void }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [f, setF] = useState({ status: '', equipmentId: '', overdue: '' });
  const [items, setItems] = useState<WorkOrder[] | null>(null);
  const [open, setOpen] = useState<number | undefined>(openId);
  const [raising, setRaising] = useState(false);
  const query = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
  const load = async (q = query()) => setItems((await api<{ items: WorkOrder[] }>('GET', `/api/workorders?${q}`)).items);
  useEffect(() => { void api<Equipment[]>('GET', '/api/equipment').then(setEquipment); void load(); }, []);
  if (open !== undefined) return <WorkOrderPage me={me} id={open} onBack={() => { setOpen(undefined); void load(); }} onOpenItem={onOpenItem} />;
  const set = (k: keyof typeof f, v: string) => { const n = { ...f, [k]: v }; setF(n); void load(new URLSearchParams(Object.entries(n).filter(([, x]) => x !== '')).toString()); };
  return (
    <>
      <h1>Work orders</h1>
      <div className="card row">
        <label>Status
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option><option value="closed">Closed</option>
          </select>
        </label>
        <label>Item
          <select value={f.equipmentId} onChange={(e) => set('equipmentId', e.target.value)}>
            <option value="">All items</option>
            {equipment.map((q) => <option key={q.id} value={q.id}>{q.code} · {q.name}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={f.overdue === '1'} onChange={(e) => set('overdue', e.target.checked ? '1' : '')} />Overdue only</label>
        {mayRaise(me) && <button className="primary" onClick={() => setRaising(true)}>+ Raise a work order</button>}
        <a className="button" href="/api/workorders.csv">CSV</a>
      </div>
      {items && <Table items={items} onOpen={setOpen} showItem />}
      {raising && <RaiseDialog preset={{}} equipment={equipment} onCancel={() => setRaising(false)} onDone={(id) => { setRaising(false); setOpen(id); }} />}
    </>
  );
}

// One work order: details, assign, start, record the work, Done (doer's signature), Close (second person's).
export function WorkOrderPage({ me, id, onBack, onOpenItem }: { me: Me; id: number; onBack: () => void; onOpenItem: (equipmentId: number) => void }) {
  const [w, setW] = useState<(WorkOrder & { mayRaise: boolean }) | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState<'done' | 'close' | null>(null);
  const [work, setWork] = useState({ workDone: '', hours: '', minutes: '', parts: [] as { name: string; partNumber: string; quantity: string }[] });
  const load = async () => {
    const r = await api<WorkOrder & { mayRaise: boolean }>('GET', `/api/workorders/${id}`);
    setW(r);
    const m = r.timeMinutes ?? 0;
    setWork({ workDone: r.workDone, hours: r.timeMinutes === null ? '' : String(Math.floor(m / 60)), minutes: r.timeMinutes === null ? '' : String(m % 60),
      parts: r.parts.map((p) => ({ name: p.name, partNumber: p.partNumber, quantity: String(p.quantity) })) });
  };
  useEffect(() => { void load(); void api<Person[]>('GET', '/api/workorders/people').then(setPeople).catch(() => setPeople([])); }, [id]);
  if (!w) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (err) { setError(problemsOf(err)); } };
  const saveWork = (e: FormEvent) => { e.preventDefault(); void act(() => api('POST', `/api/workorders/${id}/work`, {
    workDone: work.workDone, timeMinutes: (Number(work.hours) || 0) * 60 + (Number(work.minutes) || 0),
    parts: work.parts.filter((p) => p.name.trim()).map((p) => ({ name: p.name, partNumber: p.partNumber, quantity: Number(p.quantity) || 1 })) })); };
  const setPart = (i: number, k: 'name' | 'partNumber' | 'quantity', v: string) => setWork({ ...work, parts: work.parts.map((p, n) => (n === i ? { ...p, [k]: v } : p)) });
  const editing = w.status === 'in_progress' && w.mayDo;

  return (
    <>
      <p><button className="link" onClick={onBack}>← All work orders</button></p>
      <h1>{w.number} · {w.title}</h1>
      <p className="muted">{w.kindLabel} · <button className="link" onClick={() => onOpenItem(w.equipmentId)}>{w.code}{w.name ? ` · ${w.name}` : ''}</button> · {woStatusChip(w)}</p>
      <div className="card">
        <dl className="details">
          <dt>What is to be done</dt><dd>{w.description || '—'}</dd>
          <dt>Raised</dt><dd>{plantTime(w.raisedAt)} by {w.raisedBy}</dd>
          <dt>Assigned to</dt>
          <dd>{w.assignedToName ?? 'Nobody yet'}
            {w.mayRaise && (w.status === 'open' || w.status === 'in_progress') && (
              <> <select aria-label="Assign to" value="" onChange={(e) => e.target.value && void act(() => api('POST', `/api/workorders/${id}/assign`, { userId: Number(e.target.value) }))}>
                <option value="">{w.assignedToName ? 'Give to someone else…' : 'Assign to…'}</option>
                {people.filter((p) => p.id !== w.assignedTo).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></>
            )}
          </dd>
          <dt>Target date</dt><dd>{w.targetDate ? plantDay(w.targetDate) : '—'}</dd>
          {w.entryId !== null && <><dt>Breakdown</dt><dd><button className="link" onClick={() => onOpenItem(w.equipmentId)}>Open the breakdown on the item page</button></dd></>}
          {w.startedAt && <><dt>Started</dt><dd>{plantTime(w.startedAt)}</dd></>}
          {w.status !== 'in_progress' && w.workDone && <><dt>Work done</dt><dd>{w.workDone}</dd><dt>Spare parts used</dt><dd>{w.partsText || 'None'}</dd><dt>Time spent</dt><dd>{w.timeText}</dd></>}
          {w.doneAt && <><dt>Done</dt><dd>{plantTime(w.doneAt)} by {w.doneBy}</dd></>}
          {w.closedAt && <><dt>Closed</dt><dd>{plantTime(w.closedAt)} by {w.closedBy}</dd></>}
        </dl>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          {w.status === 'open' && w.mayDo && <button className="primary" onClick={() => void act(() => api('POST', `/api/workorders/${id}/start`, {}))}>Start work</button>}
          {w.status === 'done' && w.mayClose && <button className="primary" onClick={() => setSigning('close')}>Close work order</button>}
          <a className="button" href={`/api/workorders/${id}/export.pdf`}>PDF</a>
        </div>
      </div>

      {editing && (
        <form className="card" onSubmit={saveWork}>
          <h2>Work done</h2>
          <label>What was done<textarea value={work.workDone} onChange={(e) => setWork({ ...work, workDone: e.target.value })} maxLength={4000} required /></label>
          <h3>Spare parts used</h3>
          {work.parts.map((p, i) => (
            <div className="row" key={i}>
              <label>Part<input value={p.name} onChange={(e) => setPart(i, 'name', e.target.value)} /></label>
              <label>Part no.<input value={p.partNumber} onChange={(e) => setPart(i, 'partNumber', e.target.value)} /></label>
              <label>Quantity<input inputMode="decimal" value={p.quantity} onChange={(e) => setPart(i, 'quantity', e.target.value)} /></label>
              <button type="button" onClick={() => setWork({ ...work, parts: work.parts.filter((_, n) => n !== i) })}>Remove</button>
            </div>
          ))}
          <div className="row"><button type="button" onClick={() => setWork({ ...work, parts: [...work.parts, { name: '', partNumber: '', quantity: '1' }] })}>+ Add a spare part</button></div>
          <div className="row">
            <label>Time spent: hours<input inputMode="numeric" value={work.hours} onChange={(e) => setWork({ ...work, hours: e.target.value })} /></label>
            <label>minutes<input inputMode="numeric" value={work.minutes} onChange={(e) => setWork({ ...work, minutes: e.target.value })} /></label>
          </div>
          <div className="actions">
            <button type="submit">Save the work</button>
            <button type="button" className="primary" disabled={!w.workDone || w.timeMinutes === null} title={w.workDone ? '' : 'Save the work first'} onClick={() => setSigning('done')}>Mark done (sign)</button>
          </div>
        </form>
      )}

      {w.signatures && w.signatures.length > 0 && (
        <div className="card"><h2>Signatures</h2>{w.signatures.map((s) => <p key={s.meaning}>{s.meaning}: {s.by}, {plantTime(s.at)}</p>)}</div>
      )}
      {w.history && (
        <div className="card"><h2>Audit trail</h2>
          <table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{w.history.map((h, i) => <tr key={i}><td>{plantTime(h.at)}</td><td>{h.by}</td><td>{h.text}</td></tr>)}</tbody></table>
        </div>
      )}

      {signing && (
        <SignDialog meaning={signing === 'done' ? 'performed' : 'closed'} what={signing === 'done' ? `Work order ${w.number}: the work was done as recorded below.` : `Close work order ${w.number}, done by ${w.doneBy}.`}
          onCancel={() => setSigning(null)}
          onSign={async ({ proof }) => {
            await api('POST', `/api/workorders/${id}/${signing === 'done' ? 'done' : 'close'}`, { proof, contentHash: signing === 'done' ? w.doneHash : w.closeHash });
            setSigning(null);
            await load();
          }}>
          <p>{w.workDone}</p>
          <p className="muted">Spare parts: {w.partsText || 'None'} · Time spent: {w.timeText}</p>
        </SignDialog>
      )}
    </>
  );
}

// The "Work orders" tab of an item: its work orders, raise by hand, and what is due now (preventive maintenance, calibration).
export function WorkOrdersTab({ me, equipment, dues, onOpen }: { me: Me; equipment: Equipment; dues: Due[]; onOpen: (id: number) => void }) {
  const [items, setItems] = useState<WorkOrder[] | null>(null);
  const [raising, setRaising] = useState<RaisePreset | null>(null);
  const load = async () => setItems((await api<{ items: WorkOrder[] }>('GET', `/api/workorders?equipmentId=${equipment.id}`)).items);
  useEffect(() => { void load(); }, [equipment.id]);
  const raise = mayRaise(me);
  const due = dues.filter((d) => (d.kind === 'pm' || d.kind === 'calibration') && (d.overdue || d.soon));
  return (
    <>
      {raise && <div className="row"><button className="primary" onClick={() => setRaising({ equipmentId: equipment.id })}>+ Raise a work order</button></div>}
      {raise && due.map((d) => (
        <p key={d.kind}><span className="reason">{DUE_LABEL[d.kind]} {d.overdue ? 'overdue since' : 'due'} {plantDay(d.due)}</span>{' '}
          <button onClick={() => setRaising({ equipmentId: equipment.id, kind: d.kind === 'pm' ? 'preventive' : 'calibration', title: `${DUE_LABEL[d.kind]} of ${equipment.code}` })}>Raise a work order</button></p>
      ))}
      {items && <Table items={items.map((w) => ({ ...w, name: equipment.name }))} onOpen={onOpen} showItem={false} />}
      {raising && <RaiseDialog preset={raising} equipment={[equipment]} onCancel={() => setRaising(null)} onDone={(id) => { setRaising(null); onOpen(id); }} />}
    </>
  );
}
