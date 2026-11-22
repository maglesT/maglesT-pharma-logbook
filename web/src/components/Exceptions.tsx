import { useState } from 'react';
import { api, ApiError, plantTime } from '../api.js';
import { SignDialog } from './SignDialog.js';

// D-80 (owner decision, 20 Nov 2026): every missed limit is an exception in the Logbook. A person holding
// logbook.exception.decide closes it here (reason and e-signature) or sends it to Deviations, which files only those.
export interface Exception {
  id: number; equipmentId: number; code: string; name: string; label: string; dueAt: string; title: string; contentHash: string;
  decision: { kind: 'closed' | 'sent'; label: string; reason: string | null; by: string | null; at: string; signedBy: string | null } | null;
  deviation: { number: string; status: string } | null;
}
export interface Overdue { linked: boolean; mayDecide: boolean; events: Exception[] }

const DEV_STEP: Record<string, string> = { classification: 'awaiting QA classification', approval: 'awaiting approval', investigation: 'under investigation',
  closure: 'awaiting closure', closed: 'closed', rejected: 'rejected', cancelled: 'cancelled: not a deviation' };

function Outcome({ e, linked }: { e: Exception; linked: boolean }) {
  const d = e.decision;
  if (!d) return <span className="pill warn">Waiting for a decision</span>;
  if (d.kind === 'closed') return <>Closed here by {d.by}, {plantTime(d.at)}<br /><span className="muted">Reason: {d.reason}</span></>;
  return <>Sent to DIVE by {d.by}{' · '}
    {e.deviation ? <><strong>{e.deviation.number}</strong> · {DEV_STEP[e.deviation.status] ?? e.deviation.status}</>
      : linked ? <span className="muted">being filed in DIVE…</span> : <span className="muted">DIVE not linked</span>}</>;
}

export function Exceptions({ data, onOpen, onChanged }: { data: Overdue; onOpen: (equipmentId: number) => void; onChanged: () => void }) {
  const [closing, setClosing] = useState<Exception | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const waiting = data.events.filter((e) => !e.decision).length;

  const send = async (e: Exception) => {
    setError('');
    try {
      await api('POST', `/api/overdue/${e.id}/send`, {});
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.problems.length ? err.problems.join(' ') : (err as Error).message);
    }
  };

  return (
    <section className="dash-panel" aria-label="Missed limits">
      <div className="panel-head"><h2>Missed limits (exceptions)</h2>{waiting > 0 && <span className="pill bad">{waiting} waiting</span>}<span className="pill">{data.events.length}</span></div>
      <p className="muted small">Each missed limit is closed here (reason and e-signature) or sent to DIVE{data.mayDecide ? '' : ', by a person who may decide exceptions'}.</p>
      {error && <p className="error">{error}</p>}
      <table className="plain-table">
        <thead><tr><th>Item</th><th>Missed limit</th><th>Ran out</th><th>Decision</th></tr></thead>
        <tbody>{data.events.map((e) => (
          <tr key={e.id}>
            <td><button className="link" onClick={() => onOpen(e.equipmentId)}><strong>{e.code}</strong></button> {e.name}</td>
            <td>{e.label}</td><td>{plantTime(e.dueAt)}</td>
            <td>
              <Outcome e={e} linked={data.linked} />
              {!e.decision && data.mayDecide && (
                <div className="actions">
                  <button onClick={() => { setReason(''); setClosing(e); }}>Close here</button>
                  <button disabled={!data.linked} title={data.linked ? '' : 'DIVE is not linked'} onClick={() => void send(e)}>Send to DIVE</button>
                </div>
              )}
            </td>
          </tr>))}</tbody>
      </table>
      {closing && (
        <SignDialog meaning="closed" what={`Close the missed limit of ${closing.code} here, without a deviation: ${closing.title}`}
          onCancel={() => setClosing(null)}
          onSign={async ({ proof }) => {
            if (!reason.trim()) throw new Error('Give the reason for closing it here.');
            await api('POST', `/api/overdue/${closing.id}/close`, { proof, contentHash: closing.contentHash, reason });
            setClosing(null);
            onChanged();
          }}>
          <label>Reason for closing it here
            <textarea aria-label="Reason" value={reason} onChange={(ev) => setReason(ev.target.value)} required maxLength={1000} />
          </label>
        </SignDialog>
      )}
    </section>
  );
}
