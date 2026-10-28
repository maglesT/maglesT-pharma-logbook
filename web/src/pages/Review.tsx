import { useEffect, useState } from 'react';
import { api, MEANING_LABEL, plantTime, TYPE_LABEL, type Entry, type Equipment, type Me } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}
type PeriodEntry = Entry & { latest: boolean; open: boolean; equipmentCode?: string };
interface Period {
  entries: PeriodEntry[];
  openItems: { notFinishedOrNotVerified: number; late: number; corrected: number; failedCalibrations: number };
  audit: AuditRow[];
  contentHash: string;
  reviews: { id: number; periodFrom: string; periodTo: string; reviewedBy: string; reviewedAt: string; superseded: boolean }[];
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
// Whole plant-local days: from 00:00 of the first day to 00:00 after the last day.
const startOf = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOf = (d: string) => new Date(new Date(`${d}T00:00:00`).getTime() + 86_400_000).toISOString();

export function Review({ me }: { me: Me }) {
  const reviewer = me.roles.includes('qa') || me.roles.includes('supervisor');
  const auditor = me.roles.includes('qa') || me.roles.includes('admin');
  const [tab, setTab] = useState<'period' | 'batch' | 'audit'>(reviewer ? 'period' : 'audit');
  return (
    <>
      <h1>Review</h1>
      <div className="subtabs">
        {reviewer && <button className={tab === 'period' ? 'on' : ''} onClick={() => setTab('period')}>Logbook review</button>}
        {reviewer && <button className={tab === 'batch' ? 'on' : ''} onClick={() => setTab('batch')}>Batch view</button>}
        {auditor && <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit trail</button>}
      </div>
      {tab === 'period' && reviewer && <PeriodReview me={me} />}
      {tab === 'batch' && reviewer && <BatchView />}
      {tab === 'audit' && auditor && <AuditTrail />}
    </>
  );
}

function PeriodReview({ me }: { me: Me }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [equipmentId, setEquipmentId] = useState<number | ''>('');
  const [fromDay, setFromDay] = useState(day(-30));
  const [toDay, setToDay] = useState(day(0));
  const [period, setPeriod] = useState<Period | null>(null);
  const [signing, setSigning] = useState(false);
  useEffect(() => {
    void api<Equipment[]>('GET', '/api/equipment').then(setEquipment);
  }, []);

  const range = () => ({ from: startOf(fromDay), to: endOf(toDay) });
  const load = async () => {
    if (!equipmentId) return;
    const { from, to } = range();
    setPeriod(await api<Period>('GET', `/api/equipment/${equipmentId}/period?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
  };
  const exportUrl = (fmt: string) => {
    const { from, to } = range();
    return `/api/export/period.${fmt}?equipmentId=${equipmentId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };
  const eq = equipment.find((e) => e.id === equipmentId);

  return (
    <>
      <div className="card row">
        <select value={equipmentId} onChange={(e) => { setEquipmentId(e.target.value ? Number(e.target.value) : ''); setPeriod(null); }}>
          <option value="">Equipment or area…</option>
          {equipment.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
        </select>
        <label>From<input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} /></label>
        <label>To<input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} /></label>
        <button className="primary" onClick={load} disabled={!equipmentId}>Show</button>
        {period && <a className="button" href={exportUrl('pdf')}>PDF</a>}
        {period && <a className="button" href={exportUrl('csv')}>CSV</a>}
      </div>

      {period && (
        <>
          <div className="statusbar fit">
            <span><strong>{period.entries.filter((e) => e.latest).length}</strong> entries</span>
            <span className={period.openItems.notFinishedOrNotVerified ? 'reason' : ''}>{period.openItems.notFinishedOrNotVerified} open (not ended or not verified)</span>
            <span className={period.openItems.late ? 'reason' : ''}>{period.openItems.late} late</span>
            <span className={period.openItems.corrected ? 'reason' : ''}>{period.openItems.corrected} corrections</span>
            <span className={period.openItems.failedCalibrations ? 'reason' : ''}>{period.openItems.failedCalibrations} failed calibrations</span>
          </div>
          {period.reviews.map((r) => (
            <p key={r.id}>
              Reviewed by {r.reviewedBy}, {plantTime(r.reviewedAt)} (period {plantTime(r.periodFrom)} – {plantTime(r.periodTo)})
              {r.superseded && <span className="chip chip-warn"> Superseded: entries changed after the review</span>}
            </p>
          ))}
          {me.roles.includes('qa') && <button className="primary" onClick={() => setSigning(true)}>Sign as reviewed</button>}

          <h2>Entries</h2>
          <EntryTable entries={period.entries} />
          <h2>Audit trail for these entries</h2>
          <AuditTable rows={period.audit} />
        </>
      )}

      {signing && period && eq && (
        <SignDialog
          meaning="reviewed"
          what={`Logbook ${eq.code}, ${fromDay} to ${toDay}: ${period.entries.filter((e) => e.latest).length} entries, ${period.openItems.notFinishedOrNotVerified} open items, ${period.openItems.corrected} corrections.`}
          onCancel={() => setSigning(false)}
          onSign={async (c) => {
            await api('POST', `/api/equipment/${equipmentId}/reviews`, { ...c, ...range(), contentHash: period.contentHash });
            setSigning(false);
            await load();
          }}
        />
      )}
    </>
  );
}

function BatchView() {
  const [batch, setBatch] = useState('');
  const [data, setData] = useState<{ batch: string; entries: PeriodEntry[]; audit: AuditRow[] } | null>(null);
  const load = async () => batch.trim() && setData(await api('GET', `/api/batches/${encodeURIComponent(batch.trim())}`));
  return (
    <>
      <div className="card row">
        <input placeholder="Batch number" value={batch} onChange={(e) => setBatch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load()} />
        <button className="primary" onClick={load}>Show</button>
        {data && <a className="button" href={`/api/export/batch.pdf?batch=${encodeURIComponent(data.batch)}`}>PDF</a>}
        {data && <a className="button" href={`/api/export/batch.csv?batch=${encodeURIComponent(data.batch)}`}>CSV</a>}
      </div>
      {data && (data.entries.length === 0 ? <p className="muted">No entries reference this batch.</p> : (
        <>
          <EntryTable entries={data.entries} showEquipment />
          <h2>Audit trail</h2>
          <AuditTable rows={data.audit} />
        </>
      ))}
    </>
  );
}

function AuditTrail() {
  const [filter, setFilter] = useState({ objectType: '', objectId: '', user: '', from: day(-7), to: day(0) });
  const [rows, setRows] = useState<AuditRow[]>([]);
  const load = async () => {
    const q = new URLSearchParams();
    if (filter.objectType) q.set('objectType', filter.objectType);
    if (filter.objectId) q.set('objectId', filter.objectId);
    if (filter.user) q.set('user', filter.user);
    q.set('from', startOf(filter.from));
    q.set('to', endOf(filter.to));
    setRows(await api<AuditRow[]>('GET', `/api/audit?${q}`));
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <div className="card row">
        <select value={filter.objectType} onChange={(e) => setFilter({ ...filter, objectType: e.target.value })}>
          <option value="">All objects</option>
          {['entry', 'user', 'equipment', 'product', 'settings', 'review', 'site', 'alert'].map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input placeholder="Object id" value={filter.objectId} onChange={(e) => setFilter({ ...filter, objectId: e.target.value })} />
        <input placeholder="User ID" value={filter.user} onChange={(e) => setFilter({ ...filter, user: e.target.value })} />
        <label>From<input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></label>
        <label>To<input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></label>
        <button className="primary" onClick={load}>Filter</button>
      </div>
      <p className="muted">Newest first, up to 1000 rows.</p>
      <AuditTable rows={rows} />
    </>
  );
}

function EntryTable({ entries, showEquipment = false }: { entries: PeriodEntry[]; showEquipment?: boolean }) {
  return (
    <table>
      <thead><tr>{showEquipment && <th>Equipment</th>}<th>Activity</th><th>Type</th><th>Entry</th><th>Data</th><th>Signatures</th></tr></thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className={!e.latest ? 'superseded' : e.open ? 'pending' : ''}>
            {showEquipment && <td>{e.equipmentCode}</td>}
            <td>{plantTime(e.activityStart)}{e.activityEnd && <><br />to {plantTime(e.activityEnd)}</>}{e.late && <><br /><span className="chip chip-warn">Late: {e.lateReason}</span></>}</td>
            <td>{TYPE_LABEL[e.logbookType]}</td>
            <td>
              #{e.entryId} v{e.version} · {e.change}{!e.latest && ' (superseded)'}
              {e.correctionReason && <><br />Reason: {e.correctionReason}</>}
              <br /><span className="muted">{e.enteredBy}, {plantTime(e.enteredAt)}</span>
            </td>
            <td className="mono">{e.batch && `Batch ${e.batch} · `}{JSON.stringify(e.data)}</td>
            <td>{e.signatures.map((s) => <div key={s.meaning}>{MEANING_LABEL[s.meaning]}: {s.printedName}, {plantTime(s.signedAt)}{!s.valid && ' (INVALID)'}</div>)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Object</th><th>Details</th></tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <td>{plantTime(a.at)}</td>
            <td>{a.actor ?? 'system'}</td>
            <td>{a.action}</td>
            <td>{a.objectType} {a.objectId}</td>
            <td className="mono">
              {a.reason && <div>Reason: {a.reason}</div>}
              {a.oldValue != null && <div>Old: {JSON.stringify(a.oldValue)}</div>}
              {a.newValue != null && <div>New: {JSON.stringify(a.newValue)}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
