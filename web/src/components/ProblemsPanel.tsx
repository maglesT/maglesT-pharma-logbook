import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, getSignProof, plantDay, plantTime, SEVERITY_LABEL, untilDay, type Equipment, type Me, type Problem } from '../api.js';

// Owner 2026-11-14 (D-43): "Problems and exceptions" on an item's page. A missed limit or a reported problem waits for QA,
// who either sends it to Deviations or handles it here as a Logbook exception (justification, impact assessment, action,
// e-signature; for an overdue PM, calibration or requalification optionally continued use until a date, at most 7 days).

interface Data { mayDecide: boolean; linked: boolean; problems: Problem[] }
const DEV_STEP: Record<string, string> = { classification: 'awaiting QA classification', approval: 'awaiting approval', investigation: 'under investigation', closure: 'awaiting closure', closed: 'closed', rejected: 'rejected' };

export function ProblemsPanel({ me, equipment, reload }: { me: Me; equipment: Equipment; reload: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null);
  const [reporting, setReporting] = useState(false);
  const [deciding, setDeciding] = useState<Problem | null>(null);
  const load = async () => setData(await api<Data>('GET', `/api/equipment/${equipment.id}/problems`));
  useEffect(() => { void load(); }, [equipment.id]);
  const done = async () => { setReporting(false); setDeciding(null); await load(); await reload(); };
  const open = data?.problems.filter((p) => !p.decision) ?? [];
  const exceptions = data?.problems.filter((p) => p.decision?.route === 'exception') ?? [];
  const deviations = data?.problems.filter((p) => p.decision?.route === 'deviation') ?? [];
  const problemLine = (p: Problem) => (
    <>
      <strong>{p.label}</strong> · {plantTime(p.createdAt)}{p.reportedBy && <> · reported by {p.reportedBy}</>}
      <div>{p.title}</div>
      {p.whatHappened && <div className="muted">Impact: {p.impact}</div>}
    </>
  );
  return (
    <section className="card problems" aria-label="Problems and exceptions">
      <div className="panel-head">
        <h2>Problems and exceptions</h2>
        {open.length > 0 && <span className="pill warn">{open.length} waiting for QA</span>}
        <button type="button" className="report-problem" onClick={() => setReporting(true)}>Report a problem</button>
      </div>
      {data && data.problems.length === 0 && <p className="muted">No problem recorded on this item.</p>}
      {open.length > 0 && (
        <div className="problem-group">
          <h3>Waiting for a QA decision</h3>
          {open.map((p) => (
            <div key={p.id} className="problem-row waiting">
              <div>{problemLine(p)}{p.severity && <div className="muted">Severity: {SEVERITY_LABEL[p.severity]}</div>}</div>
              {data?.mayDecide && can(me, 'exception.decide') && <button type="button" onClick={() => setDeciding(p)}>Decide the route</button>}
            </div>
          ))}
        </div>
      )}
      {exceptions.length > 0 && (
        <div className="problem-group">
          <h3>Logbook exceptions</h3>
          {exceptions.map((p) => {
            const d = p.decision!;
            return (
              <div key={p.id} className={`problem-row exception${d.active ? ' active' : ''}`}>
                <div>
                  <strong>{d.exceptionNumber}</strong> · {p.label} · approved by {d.decidedBy}, {plantTime(d.decidedAt)}
                  <div>{p.title}</div>
                  <div className="muted">Justification: {d.justification}</div>
                  <div className="muted">Impact assessment: {d.impactAssessment}</div>
                  <div className="muted">Action: {d.action}</div>
                  <div>
                    {d.useAllowedUntil
                      ? <span className={d.active ? 'chip chip-ok' : 'chip chip-info'}>{d.active ? 'Use allowed' : 'Use was allowed'} until {untilDay(d.useAllowedUntil)} (end of day)</span>
                      : <span className="chip chip-info">Documented; use not allowed under this exception</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {deviations.length > 0 && (
        <div className="problem-group">
          <h3>Sent to Deviations</h3>
          {deviations.map((p) => {
            const d = p.decision!;
            return (
              <div key={p.id} className="problem-row deviation">
                <div>
                  {problemLine(p)}
                  <div className="muted">Sent by {d.decidedBy}, {plantTime(d.decidedAt)} ·{' '}
                    {d.deviation ? <strong>{d.deviation.number} ({DEV_STEP[d.deviation.status] ?? d.deviation.status})</strong>
                      : data?.linked ? 'waiting for Deviations to file it' : 'Deviations not linked'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {reporting && <ReportProblemDialog equipment={equipment} onCancel={() => setReporting(false)} onDone={done} />}
      {deciding && <DecideDialog problem={deciding} equipment={equipment} onCancel={() => setDeciding(null)} onDone={done} />}
    </section>
  );
}

// Anyone may report a problem on an item: what happened, the impact and the severity.
function ReportProblemDialog({ equipment, onCancel, onDone }: { equipment: Equipment; onCancel: () => void; onDone: () => Promise<void> }) {
  const [whatHappened, setWhat] = useState('');
  const [impact, setImpact] = useState('');
  const [severity, setSeverity] = useState('minor');
  const [problems, setProblems] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    try {
      await api('POST', `/api/equipment/${equipment.id}/problems`, { whatHappened, impact, severity });
      await onDone();
    } catch (err) {
      setProblems([(err as Error).message, ...(err instanceof ApiError ? err.problems : [])]);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>Report a problem · {equipment.code}</h2>
        <p className="muted">QA then decides: send it to the Deviations system, or handle it here as a Logbook exception.</p>
        <label>What happened<textarea value={whatHappened} onChange={(e) => setWhat(e.target.value)} required maxLength={2000} /></label>
        <label>Impact (product, equipment, people)<textarea value={impact} onChange={(e) => setImpact(e.target.value)} required maxLength={2000} /></label>
        <label>Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="minor">Minor: no effect on product quality or safety</option>
            <option value="major">Major: could affect product quality; needs assessment</option>
            <option value="critical">Critical: likely effect on product quality or patient safety (always a deviation)</option>
          </select>
        </label>
        {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit">Report</button>
        </div>
      </form>
    </div>
  );
}

// QA's decision, signed: "Route decided" when sent to Deviations, "Approved" for a Logbook exception.
function DecideDialog({ problem: p, equipment, onCancel, onDone }: { problem: Problem; equipment: Equipment; onCancel: () => void; onDone: () => Promise<void> }) {
  const [route, setRoute] = useState<'deviation' | 'exception'>(p.severity === 'critical' ? 'deviation' : 'exception');
  const [justification, setJustification] = useState('');
  const [impactAssessment, setImpact] = useState('');
  const [action, setAction] = useState('');
  const [allowUse, setAllowUse] = useState(false);
  const today = plantDay(new Date().toISOString());
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const [until, setUntil] = useState(today);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const exception = route === 'exception';
  const meaning = exception ? 'approved' : 'decided';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    setBusy(true);
    try {
      const proof = await getSignProof([meaning]);
      await api('POST', `/api/problems/${p.id}/decide`, {
        route, contentHash: p.contentHash, signature: { proof },
        ...(exception ? { justification, impactAssessment, action, ...(allowUse && p.mayAllowUse ? { useAllowedUntil: until } : {}) } : {}),
      });
      await onDone();
    } catch (err) {
      const msg: Record<string, string> = {
        wrong_credentials: 'Your password was not confirmed for this signature. Try again.',
        already_decided: 'This problem has its decision already. Close and look again.',
        content_changed: 'The problem changed while this dialog was open. Close it and look again.',
        check_failed: 'The decision cannot be recorded as given:',
      };
      setProblems([msg[(err as ApiError).code] ?? (err as Error).message, ...(err instanceof ApiError ? err.problems : [])]);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog wide decide" onSubmit={submit}>
        <h2>Decide the route · {equipment.code}</h2>
        <div className="summary-box">
          <strong>{p.label}</strong> · {plantTime(p.createdAt)}{p.reportedBy && <> · reported by {p.reportedBy}</>}
          <div>{p.title}</div>
          {p.whatHappened && <div>What happened: {p.whatHappened}</div>}
          {p.impact && <div>Impact as reported: {p.impact}</div>}
          {p.severity && <div>Severity: {SEVERITY_LABEL[p.severity]}</div>}
        </div>
        <fieldset className="checklist routes">
          <legend>Route</legend>
          <label className="check route">
            <input type="radio" name="route" checked={route === 'deviation'} onChange={() => setRoute('deviation')} />
            <span><strong>Send to Deviations</strong><small>The Deviations system files it as a deviation and runs the investigation and CAPA there. Nothing more is recorded in the Logbook. A critical problem always takes this route.</small></span>
          </label>
          <label className="check route">
            <input type="radio" name="route" checked={exception} disabled={p.severity === 'critical'} onChange={() => setRoute('exception')} />
            <span><strong>Handle here as a Logbook exception</strong><small>For a small problem: you record the justification, the impact assessment and the action, and approve them with your signature. The exception gets a number (EXC-year-number) and stays on this item's record.{p.severity === 'critical' ? ' Not available: the problem is critical.' : ''}</small></span>
          </label>
        </fieldset>
        {exception && (
          <>
            <label>Justification<textarea value={justification} onChange={(e) => setJustification(e.target.value)} required maxLength={2000} placeholder="Why this does not need a deviation" /></label>
            <label>Impact assessment<textarea value={impactAssessment} onChange={(e) => setImpact(e.target.value)} required maxLength={2000} placeholder="Effect on product, equipment and records; batches concerned" /></label>
            <label>Action<textarea value={action} onChange={(e) => setAction(e.target.value)} required maxLength={2000} placeholder="What is done, by whom and by when" /></label>
            {p.mayAllowUse ? (
              <fieldset className="checklist">
                <legend>Continued use</legend>
                <label className="check"><input type="checkbox" checked={allowUse} onChange={(e) => setAllowUse(e.target.checked)} />Allow use of {equipment.code} although the {p.label.toLowerCase().replace(' overdue', '')} is overdue</label>
                {allowUse && <label>Until (end of day, at most 7 days)<input type="date" value={until} min={today} max={last} onChange={(e) => setUntil(e.target.value)} required /></label>}
                <p className="muted">While the exception is valid the item shows "Use allowed under exception {'EXC-…'}, until …". The due stays open: do the {p.label.toLowerCase().replace(' overdue', '')} and record it.</p>
              </fieldset>
            ) : p.source === 'overdue' ? (
              <p className="notice">Cleaning cannot be waived: this exception documents the miss, and the item stays blocked until it is cleaned and the cleaning verified.</p>
            ) : null}
          </>
        )}
        <div className="signbox">
          <strong>Sign: {exception ? 'Approved' : 'Route decided'}</strong>
          <p className="muted">Your electronic signature is the legally binding equivalent of your handwritten signature. It records your name, the date and time and the meaning.</p>
          <p className="muted">“Sign and save” opens a small window where you enter your password again.</p>
        </div>
        {problems.length > 0 && <ul className="error">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Sign and save</button>
        </div>
      </form>
    </div>
  );
}
