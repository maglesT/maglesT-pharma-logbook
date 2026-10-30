import { useEffect, useState, type FormEvent } from 'react';
import {
  api, ApiError, EMPTY_DETAILS, MEANING_LABEL, plantTime, QUALIFICATION_LABEL, TYPE_LABEL,
  type Details, type Equipment, type EquipmentCard, type HistoryEvent, type Me,
} from '../api.js';
import { StatusChip } from '../components/StatusChip.js';
import { Summary } from './EquipmentPage.js';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const ACTION_LABEL: Record<string, string> = {
  'equipment.created': 'Item created', 'equipment.updated': 'Master data changed', 'equipment.details_updated': 'Equipment details changed',
};

// Equipment history card (S9, D-25): the details, current status and the full life history of one item.
export function HistoryCard({ me, equipment }: { me: Me; equipment: Equipment }) {
  const [fromDay, setFromDay] = useState(day(-365));
  const [toDay, setToDay] = useState(day(0));
  const [type, setType] = useState('');
  const [data, setData] = useState<(EquipmentCard & { events: HistoryEvent[] }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  const query = () => `fromDay=${fromDay}&toDay=${toDay}${type ? `&types=${type}` : ''}`;
  const load = async () => {
    setError('');
    try {
      setData(await api('GET', `/api/equipment/${equipment.id}/history?${query()}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [equipment.id]);

  const d = data?.details?.details;
  return (
    <>
      <div className="card">
        <h2>Equipment details {data && <StatusChip status={data.status} />}</h2>
        {d ? (
          <dl className="details">
            <dt>Asset number</dt><dd>{d.assetNumber || '—'}</dd>
            <dt>Make / model</dt><dd>{`${d.manufacturer} ${d.model}`.trim() || '—'}</dd>
            <dt>Serial number</dt><dd>{d.serialNumber || '—'}</dd>
            <dt>Capacity / size</dt><dd>{d.capacity || '—'}</dd>
            <dt>Installed</dt><dd>{d.installationDate ?? '—'}{d.supplier && ` · supplier ${d.supplier}`}</dd>
            <dt>Qualification</dt>
            <dd>
              {QUALIFICATION_LABEL[d.qualificationStatus]} · IQ {d.iq.date ?? '—'} {d.iq.ref} · OQ {d.oq.date ?? '—'} {d.oq.ref} · PQ {d.pq.date ?? '—'} {d.pq.ref}
              {d.lastRequalification && ` · last requalification ${d.lastRequalification}`}
            </dd>
            <dt>Product contact / MOC</dt><dd>{d.productContactMoc || '—'}</dd>
            <dt>SOPs</dt><dd>{d.sopRefs || '—'}</dd>
            <dt>Record</dt><dd className="muted">Version {data!.details!.version}, {data!.details!.changedBy}, {plantTime(data!.details!.changedAt)}: {data!.details!.reason}</dd>
          </dl>
        ) : <p className="muted">No equipment details recorded yet.</p>}
        {me.roles.includes('admin') && <button onClick={() => setEditing(true)}>Edit details</button>}
        {data && data.locationHistory.length > 0 && (
          <>
            <h3>Location history</h3>
            <ul>
              {data.locationHistory.map((l, i) => (
                <li key={i}>{plantTime(l.at)}: {l.from === null ? `created at ${l.to || '—'}` : `moved from ${l.from || '—'} to ${l.to || '—'}`}{l.by && ` by ${l.by}`}{l.reason && ` (${l.reason})`}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card row">
        <label>From<input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} /></label>
        <label>To<input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} /></label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            <option value="review">QA reviews</option>
            <option value="masterdata">Master-data changes</option>
          </select>
        </label>
        <button className="primary" onClick={load}>Show</button>
        <a className="button" href={`/api/export/history.pdf?equipmentId=${equipment.id}&${query()}`}>PDF</a>
        <a className="button" href={`/api/export/history.csv?equipmentId=${equipment.id}&${query()}`}>CSV</a>
      </div>
      {error && <p className="error">{error}</p>}

      {data && (
        <table className="history">
          <thead><tr><th>When</th><th>What</th><th>Details</th><th>By</th><th>Signatures</th></tr></thead>
          <tbody>
            {data.events.length === 0 && <tr><td colSpan={5} className="muted">Nothing in this period.</td></tr>}
            {data.events.map((ev, i) => <EventRow key={i} ev={ev} />)}
          </tbody>
        </table>
      )}
      {editing && (
        <DetailsDialog
          equipmentId={equipment.id}
          current={data?.details ?? null}
          onCancel={() => setEditing(false)}
          onDone={async () => {
            setEditing(false);
            await load();
          }}
        />
      )}
    </>
  );
}

function EventRow({ ev }: { ev: HistoryEvent }) {
  if (ev.kind === 'entry') {
    const e = ev.entry;
    return (
      <tr className={ev.breakdown ? 'breakdown' : !e.latest ? 'superseded' : ''}>
        <td>{plantTime(e.activityStart)}{e.activityEnd && e.activityEnd !== e.activityStart && <><br />to {plantTime(e.activityEnd)}</>}</td>
        <td>
          {TYPE_LABEL[e.logbookType]}<br />
          <span className="muted">#{e.entryId} v{e.version} · {e.change}{!e.latest && ' (superseded)'}</span>
          {e.correctionReason && <><br />Reason: {e.correctionReason}</>}
        </td>
        <td>
          {ev.breakdown && <div><strong>Downtime {ev.breakdown.downtime}</strong> · parts: {ev.breakdown.parts || '—'} · {ev.breakdown.status}</div>}
          {e.batch && <>Batch {e.batch} · </>}<Summary e={e} />
        </td>
        <td>{e.enteredBy}<br /><span className="muted">{plantTime(e.enteredAt)}</span></td>
        <td>{e.signatures.map((s) => <div key={s.meaning}>{MEANING_LABEL[s.meaning]}: {s.printedName}, {plantTime(s.signedAt)}{!s.valid && ' (INVALID)'}</div>)}</td>
      </tr>
    );
  }
  if (ev.kind === 'review') {
    const r = ev.review;
    return (
      <tr>
        <td>{plantTime(ev.at)}</td>
        <td>QA review</td>
        <td>Period {plantTime(r.periodFrom)} – {plantTime(r.periodTo)}{r.superseded && ' · superseded: entries changed after the review'}</td>
        <td>{r.reviewedBy}</td>
        <td>Reviewed: {r.reviewedBy}, {plantTime(r.reviewedAt)}{!r.valid && ' (INVALID)'}</td>
      </tr>
    );
  }
  return (
    <tr className="masterdata">
      <td>{plantTime(ev.at)}</td>
      <td>{ACTION_LABEL[ev.action] ?? ev.action}</td>
      <td className="mono">
        {ev.reason && <div>Reason: {ev.reason}</div>}
        {ev.old != null && <div>Old: {JSON.stringify(ev.old)}</div>}
        {ev.new != null && <div>New: {JSON.stringify(ev.new)}</div>}
      </td>
      <td>{ev.actor ?? 'system'}</td>
      <td />
    </tr>
  );
}

// Admin edits the details; the server keeps every version (D-25).
function DetailsDialog({ equipmentId, current, onCancel, onDone }: {
  equipmentId: number;
  current: EquipmentCard['details'];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [d, setD] = useState<Details>({ ...EMPTY_DETAILS, ...current?.details });
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const set = <K extends keyof Details>(k: K, v: Details[K]) => setD({ ...d, [k]: v });
  const text = (k: 'assetNumber' | 'manufacturer' | 'model' | 'serialNumber' | 'capacity' | 'supplier' | 'sopRefs', label: string) => (
    <label>{label}<input value={d[k]} onChange={(e) => set(k, e.target.value)} /></label>
  );
  const step = (k: 'iq' | 'oq' | 'pq', label: string) => (
    <div className="row">
      <label>{label} date<input type="date" value={d[k].date ?? ''} onChange={(e) => set(k, { ...d[k], date: e.target.value || null })} /></label>
      <label>{label} document<input value={d[k].ref} onChange={(e) => set(k, { ...d[k], ref: e.target.value })} /></label>
    </div>
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    try {
      await api('PUT', `/api/equipment/${equipmentId}/details`, { details: d, reason, expectedVersion: current?.version ?? 0 });
      onDone();
    } catch (err) {
      const msg: Record<string, string> = { no_change: 'Nothing was changed.', changed_meanwhile: 'Someone changed the details meanwhile: close and reopen.' };
      setProblems([msg[(err as ApiError).code] ?? (err as Error).message, ...(err instanceof ApiError ? err.problems : [])]);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>Equipment details</h2>
        {text('assetNumber', 'Asset number')}
        {text('manufacturer', 'Make / manufacturer')}
        {text('model', 'Model')}
        {text('serialNumber', 'Serial number')}
        {text('capacity', 'Capacity / size')}
        <label>Installation date<input type="date" value={d.installationDate ?? ''} onChange={(e) => set('installationDate', e.target.value || null)} /></label>
        {text('supplier', 'Supplier')}
        <label>
          Qualification status
          <select value={d.qualificationStatus} onChange={(e) => set('qualificationStatus', e.target.value as Details['qualificationStatus'])}>
            {Object.entries(QUALIFICATION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {step('iq', 'IQ')}
        {step('oq', 'OQ')}
        {step('pq', 'PQ')}
        <label>Last requalification<input type="date" value={d.lastRequalification ?? ''} onChange={(e) => set('lastRequalification', e.target.value || null)} /></label>
        <label>Product-contact parts / MOC<textarea value={d.productContactMoc} onChange={(e) => set('productContactMoc', e.target.value)} /></label>
        {text('sopRefs', 'SOP references')}
        <label>Reason for the change<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
