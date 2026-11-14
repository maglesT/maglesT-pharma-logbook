import { useEffect, useState, type ReactNode } from 'react';
import { api, daysLeft, DEADLINE_LABEL, plantTime, timeLeft, TYPE_LABEL, type Due, type Entry, type Equipment, type EquipmentStatus, type Me } from '../api.js';

// Owner 2026-11-13 (D-41): the home dashboard in three parts.
//  1. Compliance: on-time completion of scheduled activities; dues in four columns (cleaning, PM, calibration,
//     requalification; due once 85 % of the allowed time has passed); a graph in four sections (cleaning status,
//     lifecycle management, change over, in use) that zooms into each section.
//  2. Pending review and approval: mine (green normal, yellow getting late) and, for senior people, others' by department.
//  3. Open exceptions and abnormalities from the batch records (Batchwright), with an analysis and suggestions.

interface Item { eq: Equipment; st: EquipmentStatus }
type Tab = 'compliance' | 'review' | 'exceptions';
interface Compliance { days: number; total: number; onTime: number; percent: number | null;
  byKind: Record<'cleaning' | 'pm' | 'calibration' | 'requalification', { total: number; onTime: number; missed: number; percent: number | null }> }
interface Pending { kind: 'verify' | 'release' | 'approve'; id: number; equipmentId: number | null; code: string; name: string; what: string; by: string;
  byMe: boolean; since: string; ageHours: number; late: boolean; department: string }
interface PendingData { lateAfterHours: number; total: number; forMe: Pending[]; mine: Pending[]; others: Pending[] | null;
  byDepartment: { department: string; normal: number; late: number }[] | null }
interface Exc { batchNumber: string; exceptionId: string; type: string; category: string; severity: string; step: string | null; stepTitle: string | null;
  description: string | null; status: string; disposition: string | null; raisedAt: string }
interface ExcData { linked: boolean; days?: number; exceptions?: Exc[];
  ipc?: { batchNumber: string; stepTitle: string | null; checkKind: string; item: string | null; value: string | null; unit: string | null; lower: string | null; upper: string | null; result: string; recordedAt: string }[];
  process?: { batchNumber: string; step: string | null; tag: string; value: string | null; unit: string | null; lower: string | null; upper: string | null; recordedAt: string }[];
  alarms?: { code: string; source: string; subject: string | null; raisedAt: string }[];
  analysis?: { open: number; openExceptions: number; abnormalReadings: number; bySeverity: { key: string; n: number }[]; byCategory: { key: string; n: number }[];
    byType: { key: string; n: number }[]; byBatch: { key: string; n: number }[]; oldOpen: number; insights: { level: 'high' | 'medium' | 'info'; text: string }[] } }
interface Overdue { linked: boolean; events: { id: number; equipmentId: number; code: string; name: string; label: string; dueAt: string; deviation: { number: string; status: string } | null }[] }

const C = { ready: '#17803d', dirty: '#b7791f', due: '#f0b429', over: '#c0352b', life: '#a3195b', co: '#6b4fbb', use: '#1f63b8', grey: '#8a8f96' };
const shortTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const age = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);

// ---- graph sections ----
type Section = 'cleaning' | 'lifecycle' | 'change_over' | 'in_use';
const SECTIONS: { key: Section; label: string; color: string; note: string }[] = [
  { key: 'cleaning', label: 'Cleaning status', color: C.ready, note: 'clean / ready, dirty, cleaning due and overdue' },
  { key: 'lifecycle', label: 'Lifecycle management', color: C.life, note: 'breakdown, PM, calibration, requalification' },
  { key: 'change_over', label: 'Change over', color: C.co, note: 'change over in progress' },
  { key: 'in_use', label: 'In use', color: C.use, note: 'in use for a batch' },
];
const CAL_BAD = ['calibration_overdue', 'calibration_failed', 'not_calibrated'];
const due = (s: EquipmentStatus, k: Due['kind']) => s.dues.find((d) => d.kind === k);
const lifecycle = (s: EquipmentStatus) => ({
  breakdown: s.state === 'out_of_service',
  pmOver: Boolean(due(s, 'pm')?.overdue), pmDue: Boolean(due(s, 'pm')?.soon),
  calOver: CAL_BAD.includes(s.state) || Boolean(due(s, 'calibration')?.overdue), calDue: Boolean(due(s, 'calibration')?.soon),
  rqOver: Boolean(due(s, 'requalification')?.overdue) || s.qualification === 'not_qualified' || s.qualification === 'requalification_needed' || s.state === 'not_qualified',
  rqDue: Boolean(due(s, 'requalification')?.soon),
});
function sectionOf(s: EquipmentStatus): Section {
  if (s.state === 'in_use') return 'in_use';
  if (s.state === 'in_change_over') return 'change_over';
  if (Object.values(lifecycle(s)).some(Boolean)) return 'lifecycle';
  return 'cleaning';
}
type CleanKey = 'ready' | 'dirty' | 'due' | 'overdue';
function cleanOf(s: EquipmentStatus): CleanKey {
  if (s.deadline?.overdue || ['dirty_expired', 'clean_expired', 'cleaning_due'].includes(s.state)) return 'overdue';
  if (s.deadline?.soon) return 'due';
  if (s.state === 'dirty') return 'dirty';
  return 'ready';
}

function Donut({ parts, center, sub, size = 168, onPick, picked }: { parts: { key: string; color: string; n: number; label: string }[]; center: string; sub: string;
  size?: number; onPick?: (k: string) => void; picked?: string | null }) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  const r = 62, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg className="donut" viewBox="0 0 160 160" width={size} height={size} role="img" aria-label={`${center} ${sub}`}>
      <circle cx="80" cy="80" r={r} fill="none" stroke="var(--line)" strokeWidth="20" />
      {total > 0 && parts.filter((p) => p.n > 0).map((p) => {
        const len = (p.n / total) * c;
        const el = (
          <circle key={p.key} cx="80" cy="80" r={r} fill="none" stroke={p.color} strokeWidth={picked === p.key ? 26 : 20}
            strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${c}`} strokeDashoffset={-off} transform="rotate(-90 80 80)"
            style={{ ['--len' as string]: `${Math.max(len - 1.5, 0.5)}` }}
            className={`${onPick ? 'seg clickable' : 'seg'}${picked && picked !== p.key ? ' dim' : ''}`} onClick={onPick ? () => onPick(p.key) : undefined}><title>{p.label}: {p.n}</title></circle>
        );
        off += len;
        return el;
      })}
      <text x="80" y="80" textAnchor="middle" className="donut-big">{center}</text>
      <text x="80" y="100" textAnchor="middle" className="donut-sub">{sub}</text>
    </svg>
  );
}

function Bars({ rows, onPick }: { rows: { key: string; label: string; n: number; color: string; hint?: string }[]; onPick?: (k: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.key}>
          <button className="bar-row" disabled={!onPick || r.n === 0} onClick={() => onPick?.(r.key)}>
            <i className="dot" style={{ background: r.color }} />
            <span className="bar-label">{r.label}{r.hint && <small>{r.hint}</small>}</span>
            <span className="bar-track"><i style={{ width: `${(r.n / max) * 100}%`, background: r.color }} /></span>
            <b>{r.n}</b>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ItemList({ items, onOpen, note }: { items: Item[]; onOpen: (id: number) => void; note: (i: Item) => ReactNode }) {
  if (!items.length) return <p className="all-good"><span aria-hidden="true">✓</span> None.</p>;
  return (
    <div className="mini-list">
      {items.map((i) => (
        <button key={i.eq.id} className="mini-row" onClick={() => onOpen(i.eq.id)}>
          <strong>{i.eq.code}</strong><span className="mini-name">{i.eq.name}</span><span className="mini-note">{note(i)}</span>
        </button>
      ))}
    </div>
  );
}

const SCOPES: { key: string; label: string; test: (e: Equipment) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'equipment', label: 'Equipment', test: (e) => e.kind === 'equipment' },
  { key: 'instrument', label: 'Instruments', test: (e) => e.kind === 'instrument' },
  { key: 'operation', label: 'Operation-based rooms', test: (e) => e.kind === 'area' && e.cleaningBasis !== 'frequency' },
  { key: 'frequency', label: 'Frequency-based rooms', test: (e) => e.kind === 'area' && e.cleaningBasis === 'frequency' },
];

function StatusGraph({ items, onOpen }: { items: Item[]; onOpen: (id: number) => void }) {
  const [scope, setScope] = useState('all');
  const [zoom, setZoom] = useState<Section | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const shown = items.filter((i) => SCOPES.find((s) => s.key === scope)!.test(i.eq));
  const count = (k: Section) => shown.filter((i) => sectionOf(i.st) === k).length;
  const ready = shown.filter((i) => i.st.blockers.length === 0 && !['in_use', 'in_change_over'].includes(i.st.state)).length;
  const parts = SECTIONS.map((s) => ({ key: s.key, label: s.label, color: s.color, n: count(s.key) }));
  const inZoom = zoom ? shown.filter((i) => sectionOf(i.st) === zoom) : [];
  const pick = (k: string) => { setZoom(zoom === k ? null : (k as Section)); setSub(null); };

  // Zoomed detail. Lifecycle counts flags (an item may have more than one), cleaning counts each item once.
  let detail: ReactNode = null;
  if (zoom === 'lifecycle') {
    const L = inZoom.map((i) => ({ i, l: lifecycle(i.st) }));
    const rows = [
      { key: 'breakdown', label: 'Breakdown', n: L.filter((x) => x.l.breakdown).length, color: '#7a1f1f' },
      { key: 'pmOver', label: 'PM overdue', n: L.filter((x) => x.l.pmOver).length, color: C.over },
      { key: 'pmDue', label: 'PM due', n: L.filter((x) => x.l.pmDue).length, color: C.due },
      { key: 'calOver', label: 'Calibration overdue / failed', n: L.filter((x) => x.l.calOver).length, color: C.over },
      { key: 'calDue', label: 'Calibration due', n: L.filter((x) => x.l.calDue).length, color: C.due },
      { key: 'rqOver', label: 'Requalification overdue / needed', n: L.filter((x) => x.l.rqOver).length, color: C.over },
      { key: 'rqDue', label: 'Requalification due', n: L.filter((x) => x.l.rqDue).length, color: C.due },
    ];
    const list = sub ? L.filter((x) => x.l[sub as keyof ReturnType<typeof lifecycle>]).map((x) => x.i) : [];
    detail = (
      <div className="zoom">
        <div className="zoom-groups">
          {([['Breakdown', rows.slice(0, 1)], ['Preventive maintenance', rows.slice(1, 3)], ['Calibration', rows.slice(3, 5)], ['Requalification', rows.slice(5, 7)]] as const).map(([t, r]) => (
            <div key={t} className="zoom-card"><h4>{t}</h4><Bars rows={[...r]} onPick={(k) => setSub(sub === k ? null : k)} /></div>
          ))}
        </div>
        {sub && <ItemList items={list} onOpen={onOpen} note={(i) => i.st.blockers[0] ?? i.st.warnings[0] ?? ''} />}
      </div>
    );
  } else if (zoom === 'cleaning') {
    const rows: { key: CleanKey; label: string; n: number; color: string }[] = [
      { key: 'ready', label: 'Clean / ready', n: 0, color: C.ready }, { key: 'dirty', label: 'Dirty', n: 0, color: C.dirty },
      { key: 'due', label: 'Cleaning due', n: 0, color: C.due }, { key: 'overdue', label: 'Cleaning overdue', n: 0, color: C.over },
    ];
    for (const i of inZoom) rows.find((r) => r.key === cleanOf(i.st))!.n++;
    const list = sub ? inZoom.filter((i) => cleanOf(i.st) === sub) : [];
    detail = (
      <div className="zoom">
        <div className="zoom-row">
          <Donut parts={rows} center={String(inZoom.length)} sub="items" size={140} onPick={(k) => setSub(sub === k ? null : k)} picked={sub} />
          <Bars rows={rows} onPick={(k) => setSub(sub === k ? null : k)} />
        </div>
        {sub && <ItemList items={list} onOpen={onOpen} note={(i) => i.st.deadline ? `${DEADLINE_LABEL[i.st.deadline.kind]} ${i.st.deadline.overdue ? 'ran out' : 'ends'} ${shortTime(i.st.deadline.at)}` : (i.st.blockers[0] ?? '')} />}
      </div>
    );
  } else if (zoom) {
    detail = <div className="zoom"><ItemList items={inZoom} onOpen={onOpen} note={(i) => i.st.inUse?.batch ? `batch ${i.st.inUse.batch} · since ${shortTime(i.st.inUse.since)}` : i.st.warnings[0] ?? ''} /></div>;
  }
  return (
    <section className="dash-panel" aria-label="Status of the plant">
      <div className="panel-head">
        <h2>Status of the plant</h2>
        <div className="chips" role="tablist">{SCOPES.map((s) => <button key={s.key} role="tab" aria-selected={scope === s.key} className={scope === s.key ? 'scope-chip on' : 'scope-chip'} onClick={() => { setScope(s.key); setSub(null); }}>{s.label}</button>)}</div>
      </div>
      <div className="graph">
        <Donut parts={parts} center={`${shown.length ? Math.round((ready / shown.length) * 100) : 0}%`} sub="ready" onPick={pick} picked={zoom} />
        <div className="section-cards">
          {SECTIONS.map((s) => (
            <button key={s.key} className={zoom === s.key ? 'section-card on' : 'section-card'} onClick={() => pick(s.key)} style={{ borderLeftColor: s.color }}>
              <b>{count(s.key)}</b><span>{s.label}</span><small>{s.note}</small>
            </button>
          ))}
        </div>
      </div>
      {zoom && <div className="zoom-head"><h3>{SECTIONS.find((s) => s.key === zoom)!.label}</h3><button className="link dark" onClick={() => { setZoom(null); setSub(null); }}>Close ✕</button></div>}
      {detail}
    </section>
  );
}

// ---- dues in four columns ----
function DueColumns({ items, onOpen }: { items: Item[]; onOpen: (id: number) => void }) {
  const cleaning = items.filter((i) => i.st.deadline && (i.st.deadline.overdue || i.st.deadline.soon))
    .map((i) => ({ i, over: i.st.deadline!.overdue, when: i.st.deadline!.at, text: `${DEADLINE_LABEL[i.st.deadline!.kind]} · ${i.st.deadline!.overdue ? `overdue by ${timeLeft(i.st.deadline!.at)}` : `ends in ${timeLeft(i.st.deadline!.at)}`}` }));
  const col = (k: Due['kind']) => items.flatMap((i) => i.st.dues.filter((d) => d.kind === k && (d.overdue || d.soon))
    .map((d) => ({ i, over: d.overdue, when: d.due, text: `${d.due} · ${daysLeft(d.due)}` })));
  const cols = [
    { key: 'cleaning', title: 'Cleaning', rows: cleaning }, { key: 'pm', title: 'Preventive maintenance', rows: col('pm') },
    { key: 'cal', title: 'Calibration', rows: col('calibration') }, { key: 'rq', title: 'Requalification', rows: col('requalification') },
  ];
  return (
    <section className="dash-panel" aria-label="Dues">
      <div className="panel-head"><h2>Dues</h2><span className="muted">due once 85 % of the allowed time has passed</span></div>
      <div className="due-cols">
        {cols.map((c) => {
          const rows = [...c.rows].sort((a, b) => Number(b.over) - Number(a.over) || a.when.localeCompare(b.when));
          const over = rows.filter((r) => r.over).length;
          return (
            <div key={c.key} className="due-col" aria-label={`${c.title} dues`}>
              <div className="due-col-head"><h3>{c.title}</h3>
                <span className="pill bad" hidden={!over}>{over} overdue</span><span className="pill warn" hidden={rows.length - over === 0}>{rows.length - over} due</span></div>
              {rows.length === 0 ? <p className="all-good small"><span aria-hidden="true">✓</span> Nothing due</p> : rows.map((r, n) => (
                <button key={n} className={r.over ? 'due-row over' : 'due-row'} onClick={() => onOpen(r.i.eq.id)}>
                  <span className="due-code">{r.i.eq.code}</span><span className="due-name">{r.i.eq.name}</span><span className="due-when">{r.text}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// A semicircle gauge that sweeps in (SVG + CSS animation).
function Gauge({ value, color }: { value: number | null; color: string }) {
  const r = 70, c = Math.PI * r, v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <svg className="gauge" viewBox="0 0 180 110" role="img" aria-label={`${value ?? '—'} %`}>
      <defs><linearGradient id="gauge-g" x1="0" x2="1"><stop offset="0" stopColor="#dd1a10" /><stop offset="0.55" stopColor="#f7941d" /><stop offset="1" stopColor="#17803d" /></linearGradient></defs>
      <path d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="var(--line)" strokeWidth="16" strokeLinecap="round" />
      <path className="gauge-arc" d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="url(#gauge-g)" strokeWidth="16" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} style={{ ['--len' as string]: `${(v / 100) * c}` }} />
      <text x="90" y="86" textAnchor="middle" className="gauge-big" style={{ fill: color }}>{value === null ? '—' : `${value}%`}</text>
      <text x="90" y="104" textAnchor="middle" className="donut-sub">on time</text>
    </svg>
  );
}

function OnTime({ c }: { c: Compliance | null }) {
  if (!c) return null;
  const rows = [['cleaning', 'Cleaning'], ['pm', 'Preventive maintenance'], ['calibration', 'Calibration'], ['requalification', 'Requalification']] as const;
  const color = (p: number | null) => (p === null ? C.grey : p >= 95 ? C.ready : p >= 85 ? C.due : C.over);
  return (
    <section className="dash-panel" aria-label="On-time completion">
      <div className="panel-head"><h2>On-time logbook completion</h2><span className="muted">scheduled activities done before their deadline, last {c.days} days</span></div>
      <div className="ontime">
        <div className="ontime-big"><Gauge value={c.percent} color={color(c.percent)} /><small>{c.onTime} of {c.total} on time</small></div>
        <div className="ontime-rows">
          {rows.map(([k, label]) => { const r = c.byKind[k]; return (
            <div key={k} className="ontime-row">
              <span>{label}</span>
              <span className="bar-track"><i style={{ width: `${r.percent ?? 0}%`, background: color(r.percent) }} /></span>
              <b>{r.percent === null ? '—' : `${r.percent}%`}</b><small>{r.onTime}/{r.total}{r.missed ? ` · ${r.missed} missed` : ''}</small>
            </div>); })}
        </div>
      </div>
      <p className="formula muted">On time ÷ all that fell due × 100. A missed limit counts against it, even if the activity was done later.</p>
    </section>
  );
}

// ---- review and approval ----
function PendingList({ rows, onOpen, empty }: { rows: Pending[]; onOpen: (id: number) => void; empty: string }) {
  if (!rows.length) return <p className="all-good"><span aria-hidden="true">✓</span> {empty}</p>;
  return (
    <div className="pending-list">
      {rows.map((p) => (
        <button key={`${p.kind}-${p.id}`} className={p.late ? 'pending-row late' : 'pending-row'} disabled={p.equipmentId === null} onClick={() => p.equipmentId && onOpen(p.equipmentId)}>
          <span className={p.late ? 'age-dot late' : 'age-dot'} aria-hidden="true" />
          <span className="pending-what"><strong>{p.code}</strong> {p.name}<small>{p.what} · by {p.by} · {p.department}</small></span>
          <span className="pending-age">{age(p.ageHours)}<small>{p.late ? 'getting late' : 'waiting'}</small></span>
        </button>
      ))}
    </div>
  );
}
function Review({ d, onOpen }: { d: PendingData | null; onOpen: (id: number) => void }) {
  if (!d) return null;
  return (
    <>
      <div className="two-col">
        <section className="dash-panel" aria-label="Waiting for me">
          <div className="panel-head"><h2>Waiting for me</h2><span className="pill">{d.forMe.length}</span></div>
          <p className="muted small">Entries to verify, breakdowns to release, settings to approve. <span className="legend-dot" /> normal · <span className="legend-dot late" /> getting late (over {d.lateAfterHours} h)</p>
          <PendingList rows={d.forMe} onOpen={onOpen} empty="Nothing waiting for you." />
        </section>
        <section className="dash-panel" aria-label="My entries waiting for review">
          <div className="panel-head"><h2>My entries waiting for review</h2><span className="pill">{d.mine.length}</span></div>
          <PendingList rows={d.mine} onOpen={onOpen} empty="None of your entries is waiting." />
        </section>
      </div>
      {d.others && d.byDepartment && (
        <section className="dash-panel" aria-label="Waiting with others">
          <div className="panel-head"><h2>Pending reviews and approvals of others</h2><span className="pill">{d.others.length}</span></div>
          <div className="dept-grid">
            {d.byDepartment.map((x) => (
              <div key={x.department} className="dept-card">
                <h4>{x.department}</h4>
                <div className="dept-bar"><i className="ok" style={{ flex: x.normal }} /><i className="late" style={{ flex: x.late }} /></div>
                <span><b className="ok-t">{x.normal}</b> normal · <b className="late-t">{x.late}</b> getting late</span>
              </div>
            ))}
          </div>
          <PendingList rows={d.others} onOpen={onOpen} empty="Nothing pending with others." />
        </section>
      )}
    </>
  );
}

// ---- exceptions from the batch records ----
const SEV_COLOR = (s: string) => (/CRITICAL/i.test(s) ? C.over : /ACTION|MAJOR/i.test(s) ? '#d9622b' : C.due);
const words = (s: string) => s.toLowerCase().replaceAll('_', ' ');
function Exceptions({ d }: { d: ExcData | null }) {
  if (!d) return null;
  if (!d.linked) return <section className="dash-panel"><p className="muted">The batch records (Batchwright) are not linked on this site.</p></section>;
  const a = d.analysis!;
  const open = d.exceptions!.filter((e) => e.status !== 'DISPOSITIONED' && e.status !== 'CLOSED');
  return (
    <>
      <div className="kpis">
        <div className={a.openExceptions ? 'kpi bad' : 'kpi ok'}><b>{a.openExceptions}</b><span>Open exceptions</span></div>
        <div className={a.abnormalReadings ? 'kpi warn' : 'kpi ok'}><b>{a.abnormalReadings}</b><span>Abnormal readings ({d.days} days)</span></div>
        <div className={d.alarms!.length ? 'kpi bad' : 'kpi ok'}><b>{d.alarms!.length}</b><span>GMP alarms not acknowledged</span></div>
        <div className={a.oldOpen ? 'kpi warn' : 'kpi ok'}><b>{a.oldOpen}</b><span>Open more than 3 days</span></div>
      </div>
      <section className="dash-panel" aria-label="Analysis">
        <div className="panel-head"><h2>Analysis and suggestions</h2><span className="muted">fixed rules over the abnormal records only</span></div>
        <ul className="insights">{a.insights.map((x, n) => <li key={n} className={x.level}><span className="ins-tag">{x.level === 'high' ? 'Act now' : x.level === 'medium' ? 'Look into' : 'OK'}</span>{x.text}</li>)}</ul>
        <div className="three-col">
          <div><h4>By category</h4><Bars rows={a.byCategory.map((r) => ({ key: r.key, label: words(r.key), n: r.n, color: C.life }))} /></div>
          <div><h4>By severity</h4><Bars rows={a.bySeverity.map((r) => ({ key: r.key, label: words(r.key), n: r.n, color: SEV_COLOR(r.key) }))} /></div>
          <div><h4>Batches with most abnormal records</h4><Bars rows={a.byBatch.map((r) => ({ key: r.key, label: r.key, n: r.n, color: C.use }))} /></div>
        </div>
      </section>
      <section className="dash-panel" aria-label="Open exceptions">
        <div className="panel-head"><h2>Open exceptions</h2><span className="pill bad">{open.length}</span></div>
        {open.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> No open exception.</p> : (
          <table className="plain-table">
            <thead><tr><th>Batch</th><th>Exception</th><th>Step</th><th>Severity</th><th>Status</th><th>Raised</th></tr></thead>
            <tbody>{open.map((e) => (
              <tr key={e.exceptionId}><td><strong>{e.batchNumber}</strong></td><td>{words(e.type)}<small className="cell-sub">{e.description ?? words(e.category)}</small></td>
                <td>{e.stepTitle ?? e.step ?? '—'}</td><td><span className="sev" style={{ background: SEV_COLOR(e.severity) }}>{words(e.severity)}</span></td>
                <td>{words(e.status)}{e.disposition ? ` · ${words(e.disposition)}` : ''}</td><td>{shortTime(e.raisedAt)}</td></tr>))}</tbody>
          </table>
        )}
      </section>
      <section className="dash-panel" aria-label="Abnormal readings">
        <div className="panel-head"><h2>Abnormal readings</h2><span className="muted">in-process checks failed or on alert, process values out of limits · last {d.days} days</span></div>
        {d.ipc!.length + d.process!.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> None.</p> : (
          <table className="plain-table">
            <thead><tr><th>Batch</th><th>Check / value</th><th>Result</th><th>Limits</th><th>Recorded</th></tr></thead>
            <tbody>
              {d.ipc!.map((r, n) => <tr key={`i${n}`}><td><strong>{r.batchNumber}</strong></td><td>{r.item ?? words(r.checkKind)}<small className="cell-sub">{r.stepTitle}</small></td>
                <td><span className="sev" style={{ background: r.result === 'FAIL' ? C.over : C.due }}>{r.result.toLowerCase()}</span> {r.value}{r.unit ? ` ${r.unit}` : ''}</td><td>{r.lower ?? '–'} to {r.upper ?? '–'}</td><td>{shortTime(r.recordedAt)}</td></tr>)}
              {d.process!.map((r, n) => <tr key={`p${n}`}><td><strong>{r.batchNumber}</strong></td><td>{r.tag}<small className="cell-sub">{r.step}</small></td>
                <td><span className="sev" style={{ background: C.over }}>out of limits</span> {r.value}{r.unit ? ` ${r.unit}` : ''}</td><td>{r.lower ?? '–'} to {r.upper ?? '–'}</td><td>{shortTime(r.recordedAt)}</td></tr>)}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const DEV_STEP: Record<string, string> = { classification: 'awaiting QA classification', approval: 'awaiting approval', investigation: 'under investigation',
  closure: 'awaiting closure', closed: 'closed', rejected: 'rejected' };

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [tab, setTab] = useState<Tab>('compliance');
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
  const [open, setOpen] = useState<Entry[]>([]);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [pending, setPending] = useState<PendingData | null>(null);
  const [exc, setExc] = useState<ExcData | null>(null);
  const [raised, setRaised] = useState<Overdue | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);

  const load = async (background = false) => {
    const get = <T,>(u: string) => api<T>('GET', u, undefined, background);
    const [s, e, o] = await Promise.all([get<EquipmentStatus[]>('/api/equipment/status'), get<Equipment[]>('/api/equipment'), get<Entry[]>('/api/entries/open')]);
    setStatuses(s); setEquipment(e); setOpen(o);
    const [c, p, x, r] = await Promise.all([get<Compliance>('/api/dashboard/compliance').catch(() => null), get<PendingData>('/api/dashboard/pending').catch(() => null),
      get<ExcData>('/api/dashboard/exceptions').catch(() => ({ linked: true, error: true }) as unknown as ExcData), get<Overdue>('/api/overdue').catch(() => null)]);
    setCompliance(c); setPending(p); setExc(x); setRaised(r);
    setUpdated(new Date().toISOString());
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, []);

  const byId = new Map(equipment.map((e) => [e.id, e]));
  const items: Item[] = statuses.flatMap((st) => { const eq = byId.get(st.equipmentId); return eq?.active ? [{ eq, st }] : []; });
  const code = (id: number) => byId.get(id)?.code ?? '';
  const inProgress = open.filter((e) => e.inProgress);
  const hour = new Date().getHours();
  const pct = compliance?.percent;
  const tabs: { key: Tab; title: string; value: string; sub: string; tone: string }[] = [
    { key: 'compliance', title: 'Compliance', value: pct === null || pct === undefined ? '—' : `${pct}%`, sub: 'on-time logbook completion', tone: pct === null || pct === undefined ? '' : pct >= 95 ? 'ok' : pct >= 85 ? 'warn' : 'bad' },
    { key: 'review', title: 'Workflow', value: String(pending ? pending.forMe.length : '—'), sub: `pending review and approval${pending?.others ? ` · ${pending.total} in all` : ''}`, tone: pending?.forMe.some((p) => p.late) ? 'warn' : 'info' },
    { key: 'exceptions', title: 'Open exceptions and abnormalities', value: exc?.linked && exc.analysis ? String(exc.analysis.open) : '—', sub: 'from the batch records', tone: exc?.analysis?.open ? 'bad' : 'ok' },
  ];

  return (
    <>
      <div className="home-head">
        <div>
          <h1>Home</h1>
          <p className="greeting">Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.fullName.split(' (')[0]}. Here is how the plant stands right now.</p>
        </div>
        {updated && <span className="updated">Updated {plantTime(updated)}</span>}
      </div>
      <div className="part-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`part-tab ${t.tone} ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            <span className="pt-title">{t.title}</span><b>{t.value}</b><span className="pt-sub">{t.sub}</span>
          </button>
        ))}
      </div>

      {tab === 'compliance' && (
        <>
          <OnTime c={compliance} />
          <DueColumns items={items} onOpen={onOpen} />
          <StatusGraph items={items} onOpen={onOpen} />
          {raised && raised.events.length > 0 && (
            <section className="dash-panel" aria-label="Deviations raised">
              <div className="panel-head"><h2>Deviations raised for missed limits</h2><span className="pill bad">{raised.events.length}</span></div>
              <table className="plain-table">
                <thead><tr><th>Item</th><th>Missed limit</th><th>Ran out</th><th>Deviation</th></tr></thead>
                <tbody>{raised.events.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                    <td><strong>{e.code}</strong> {e.name}</td><td>{e.label}</td><td>{plantTime(e.dueAt)}</td>
                    <td>{e.deviation ? <><strong>{e.deviation.number}</strong> · {DEV_STEP[e.deviation.status] ?? e.deviation.status}</> : raised.linked ? <span className="muted">being raised in Deviations…</span> : <span className="muted">Deviations not linked</span>}</td>
                  </tr>))}</tbody>
              </table>
            </section>
          )}
          <section className="dash-panel" aria-label="In use">
            <div className="panel-head"><h2>In use</h2><span className="pill">{inProgress.length}</span></div>
            {inProgress.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> Nothing in use: no use, change over or repair in progress.</p> : (
              <table className="plain-table">
                <thead><tr><th>Item</th><th>Activity</th><th>Since</th><th>Done by</th></tr></thead>
                <tbody>{inProgress.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                    <td><strong>{code(e.equipmentId)}</strong></td>
                    <td>{e.logbookType === 'maintenance' ? 'Repair (breakdown)' : TYPE_LABEL[e.logbookType]}{e.batch && ` · batch ${e.batch}`}</td>
                    <td>{plantTime(e.activityStart)}</td><td>{e.enteredBy}</td>
                  </tr>))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
      {tab === 'review' && <Review d={pending} onOpen={onOpen} />}
      {tab === 'exceptions' && <Exceptions d={exc} />}
    </>
  );
}
