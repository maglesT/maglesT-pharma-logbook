import { useEffect, useState } from 'react';
import { api, ApiError, plantTime, BREAKDOWN_STATUS_LABEL, type AdviceResponse } from '../api.js';

const CONFIDENCE: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

// S12 (D-27): related past breakdowns and, when switched on, the language model's suggestion.
// Advice only: it is never part of the entry and is not signed.
export function AdviceDialog({ versionId, code, onClose }: { versionId: number; code: string; onClose: () => void }) {
  const [data, setData] = useState<AdviceResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<AdviceResponse>('POST', `/api/entries/${versionId}/advice`, {})
      .then(setData)
      .catch((e: Error) => setError(e instanceof ApiError && e.problems.length ? e.problems.join(' ') : e.message));
  }, [versionId]);

  const byId = new Map((data?.similar ?? []).map((s) => [s.entryId, s]));
  const refs = (ids: number[]) =>
    ids.length ? <span className="muted"> (based on {ids.map((i) => `#${i} ${byId.get(i)?.code ?? ''}`).join(', ')})</span> : <span className="muted"> (no matching record)</span>;
  const a = data?.advice;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="card dialog wider">
        <h2>Suggestions from breakdown history · {code}</h2>
        {!data && !error && <p className="muted">Reading the breakdown history… this can take up to a minute.</p>}
        {error && <p className="error">{error}</p>}
        {data?.adviceNote && <p className="muted">{data.adviceNote}</p>}
        {a && (
          <div className="advice">
            <p className="advice-flag">AI suggestion ({data!.model}) · advice only, not part of the record. Check it before acting; record and sign what was actually done.</p>
            {!a.enoughHistory && <p className="reason">The history does not cover this failure well: treat these points with care.</p>}
            <p>{a.summary}</p>
            <p className="muted">Confidence: {CONFIDENCE[a.confidence]}</p>
            {a.likelyCauses.length > 0 && (<><h3>Likely causes</h3><ul>{a.likelyCauses.map((c, i) => <li key={i}>{c.cause}{refs(c.basis)}</li>)}</ul></>)}
            {a.checks.length > 0 && (<><h3>What to check first</h3><ol>{a.checks.map((c, i) => <li key={i}>{c.step}{refs(c.basis)}</li>)}</ol></>)}
            {a.parts.length > 0 && (<><h3>Parts used before</h3><ul>{a.parts.map((p, i) => <li key={i}>{p.name}{p.partNumber && ` (P/N ${p.partNumber})`}{refs(p.basis)}</li>)}</ul></>)}
            {a.preventive && (<><h3>Preventive measure</h3><p>{a.preventive}</p></>)}
          </div>
        )}
        {data && (
          <>
            <h3>Related past breakdowns ({data.similar.length})</h3>
            {data.similar.length === 0 && <p className="muted">None found on this machine, its make and model, or its machine type in the last 3 years.</p>}
            {data.similar.length > 0 && (
              <table className="register">
                <thead><tr><th>#</th><th>Machine</th><th>Occurred</th><th>Category</th><th>What failed</th><th>Root cause</th><th>Work done</th><th>Parts</th><th>Status</th></tr></thead>
                <tbody>
                  {data.similar.map((s) => (
                    <tr key={s.entryId}>
                      <td>#{s.entryId}</td>
                      <td>{s.code}<br /><span className="muted">{s.relationLabel}</span></td>
                      <td>{plantTime(s.occurredAt)}</td>
                      <td>{s.failureCategory ?? '—'}</td>
                      <td>{s.description || '—'}</td>
                      <td>{s.rootCause || '—'}</td>
                      <td>{s.workDone || '—'}</td>
                      <td>{s.partsText || '—'}</td>
                      <td>{BREAKDOWN_STATUS_LABEL[s.status]?.[0] ?? s.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <div className="actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
