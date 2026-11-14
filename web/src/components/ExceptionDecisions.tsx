import { useEffect, useState } from 'react';
import { api, plantTime, type Problem } from '../api.js';

// Owner 2026-11-14 (D-43): the problems waiting for a QA route decision (send to Deviations, or handle here as a Logbook
// exception), oldest first. Mounted on Home; the decision itself is taken on the item's page ("Problems and exceptions").
export function ExceptionDecisions({ onOpen, limit = 8 }: { onOpen: (equipmentId: number) => void; limit?: number }) {
  const [data, setData] = useState<{ mayDecide: boolean; problems: Problem[] } | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void api<{ mayDecide: boolean; problems: Problem[] }>('GET', '/api/problems', undefined, true).then(setData).catch(() => setData({ mayDecide: false, problems: [] }));
  }, []);
  if (!data) return null;
  const shown = all ? data.problems : data.problems.slice(0, limit);
  return (
    <section className="dash-panel" aria-label="Waiting for a QA decision">
      <div className="panel-head"><h2>Waiting for a QA decision</h2><span className="pill">{data.problems.length}</span></div>
      <p className="muted">
        {data.mayDecide ? 'Open the item to send the problem to Deviations or to handle it here as a Logbook exception.'
          : 'Missed limits and reported problems that QA has not routed yet.'}
      </p>
      {data.problems.length === 0 && <p className="muted">Nothing is waiting for a decision.</p>}
      <div className="pending-list">
        {shown.map((p) => (
          <button key={p.id} type="button" className={`pending-row${p.severity === 'critical' ? ' late' : ''}`} onClick={() => onOpen(p.equipmentId)}>
            <span className={p.severity === 'critical' ? 'age-dot late' : 'age-dot'} aria-hidden="true" />
            <span className="pending-what"><strong>{p.code}</strong> {p.label}<small>{p.title}{p.reportedBy ? ` · reported by ${p.reportedBy}` : ''}</small></span>
            <span className="pending-age">{plantTime(p.createdAt)}<small>waiting</small></span>
          </button>
        ))}
      </div>
      {data.problems.length > limit && <button type="button" className="link dark" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${data.problems.length}`}</button>}
    </section>
  );
}
