import { useEffect, useState, type ReactNode } from 'react';
import { explainException, explainReading } from './explain.js';
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
    byType: { key: string; n: number }[]; byBatch: { key: string; n: number }[]; oldOpen: number;
    insights: { level: 'high' | 'medium' | 'info'; text: string; batches?: string[]; filter?: { kind: string; value?: string; step?: string } }[] } }
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
// Owner 2026-11-14: dues divided by equipment, instruments and areas (a filter on top, groups inside each column).
const KINDS: { key: 'equipment' | 'instrument' | 'area'; label: string }[] = [
  { key: 'equipment', label: 'Equipment' }, { key: 'instrument', label: 'Instruments' }, { key: 'area', label: 'Areas' }];
function DueColumns({ items, onOpen }: { items: Item[]; onOpen: (id: number) => void }) {
  const [kind, setKind] = useState<'all' | 'equipment' | 'instrument' | 'area'>('all');
  const cleaning = items.filter((i) => i.st.deadline && (i.st.deadline.overdue || i.st.deadline.soon))
    .map((i) => ({ i, over: i.st.deadline!.overdue, when: i.st.deadline!.at, text: `${DEADLINE_LABEL[i.st.deadline!.kind]} · ${i.st.deadline!.overdue ? `overdue by ${timeLeft(i.st.deadline!.at)}` : `ends in ${timeLeft(i.st.deadline!.at)}`}` }));
  const col = (k: Due['kind']) => items.flatMap((i) => i.st.dues.filter((d) => d.kind === k && (d.overdue || d.soon))
    .map((d) => ({ i, over: d.overdue, when: d.due, text: `${d.due} · ${daysLeft(d.due)}` })));
  const cols = [
    { key: 'cleaning', title: 'Cleaning', rows: cleaning }, { key: 'pm', title: 'Preventive maintenance', rows: col('pm') },
    { key: 'cal', title: 'Calibration', rows: col('calibration') }, { key: 'rq', title: 'Requalification', rows: col('requalification') },
  ];
  const all = cols.flatMap((c) => c.rows);
  const n = (k: string) => all.filter((r) => k === 'all' || r.i.eq.kind === k).length;
  const row = (r: (typeof cleaning)[number], key: string) => (
    <button key={key} className={r.over ? 'due-row over' : 'due-row'} onClick={() => onOpen(r.i.eq.id)}>
      <span className="due-code">{r.i.eq.code}</span><span className="due-name">{r.i.eq.name}</span><span className="due-when">{r.text}</span>
    </button>
  );
  return (
    <section className="dash-panel" aria-label="Dues">
      <div className="panel-head"><h2>Dues</h2><span className="muted">due once 85 % of the allowed time has passed</span>
        <div className="chips" role="tablist" aria-label="Dues of">
          {(['all', ...KINDS.map((k) => k.key)] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'scope-chip on' : 'scope-chip'} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : KINDS.find((x) => x.key === k)!.label} <b className="chip-n">{n(k)}</b></button>))}
        </div></div>
      <div className="due-cols">
        {cols.map((c) => {
          const rows = [...c.rows].filter((r) => kind === 'all' || r.i.eq.kind === kind).sort((a, b) => Number(b.over) - Number(a.over) || a.when.localeCompare(b.when));
          const over = rows.filter((r) => r.over).length;
          const groups = KINDS.filter((k) => kind === 'all' || k.key === kind).map((k) => ({ ...k, rows: rows.filter((r) => r.i.eq.kind === k.key) })).filter((g) => g.rows.length);
          return (
            <div key={c.key} className="due-col" aria-label={`${c.title} dues`}>
              <div className="due-col-head"><h3>{c.title}</h3>
                <span className="pill bad" hidden={!over}>{over} overdue</span><span className="pill warn" hidden={rows.length - over === 0}>{rows.length - over} due</span></div>
              {rows.length === 0 ? <p className="all-good small"><span aria-hidden="true">✓</span> Nothing due</p> : groups.map((g) => (
                <div key={g.key} className="due-group">
                  <h4>{g.label} <span>{g.rows.length}</span></h4>
                  {g.rows.map((r, i) => row(r, `${g.key}-${i}`))}
                </div>
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
// Owner 2026-11-14: everything is clickable: a batch number opens what happened to that batch; a card, a bar or a
// suggestion filters the lists to the records behind it.
const SEV_COLOR = (s: string) => (/CRITICAL/i.test(s) ? C.over : /ACTION|MAJOR/i.test(s) ? '#d9622b' : C.due);
const words = (s: string) => s.toLowerCase().replaceAll('_', ' ');
type ExFilter = { kind: 'open' | 'severity' | 'type' | 'repeat' | 'ipc' | 'process' | 'old' | 'category' | 'batch' | 'readings' | 'alarms'; value?: string; step?: string; label?: string };
const isOpen = (e: Exc) => e.status !== 'DISPOSITIONED' && e.status !== 'CLOSED';
const OLD_MS = 3 * 86_400_000;
function BatchLink({ n, onBatch }: { n: string; onBatch: (b: string) => void }) {
  return <button className="batch-link" onClick={(e) => { e.stopPropagation(); onBatch(n); }}>{n}</button>;
}
function filterLabel(f: ExFilter): string {
  switch (f.kind) {
    case 'open': return 'Open exceptions';
    case 'old': return 'Open more than 3 days';
    case 'ipc': return 'Failed in-process checks';
    case 'process': return 'Process values out of limits';
    case 'readings': return 'Abnormal readings';
    case 'alarms': return 'GMP alarms not acknowledged';
    case 'severity': return `Severity: ${words(f.value ?? '')}`;
    case 'category': return `Category: ${words(f.value ?? '')}`;
    case 'type': return `Type: ${words(f.value ?? '')}`;
    case 'repeat': return `Repeat: ${words(f.value ?? '')}${f.step ? ` at "${f.step}"` : ''}`;
    case 'batch': return `Batch ${f.value}`;
  }
}

function Exceptions({ d, onBatch }: { d: ExcData | null; onBatch: (b: string) => void }) {
  const [f, setF] = useState<ExFilter | null>(null);
  if (!d) return null;
  if (!d.linked) return <section className="dash-panel"><p className="muted">The batch records (Batchwright) are not linked on this site.</p></section>;
  const a = d.analysis!;
  const now = Date.now();
  const pick = (x: ExFilter | null) => { setF(x); setTimeout(() => document.getElementById('ex-lists')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  const exMatch = (e: Exc) => {
    if (!f) return isOpen(e);
    switch (f.kind) {
      case 'open': return isOpen(e);
      case 'old': return isOpen(e) && now - Date.parse(e.raisedAt) > OLD_MS;
      case 'severity': return e.severity === f.value;
      case 'category': return e.category === f.value;
      case 'type': return e.type === f.value;
      case 'repeat': return e.type === f.value && (e.stepTitle ?? e.step ?? '') === (f.step ?? '');
      case 'batch': return e.batchNumber === f.value;
      default: return false;
    }
  };
  const showReadings = !f || ['ipc', 'process', 'readings', 'batch'].includes(f.kind);
  const ipc = d.ipc!.filter((r) => !f || f.kind === 'ipc' || f.kind === 'readings' || (f.kind === 'batch' && r.batchNumber === f.value));
  const proc = d.process!.filter((r) => !f || f.kind === 'process' || f.kind === 'readings' || (f.kind === 'batch' && r.batchNumber === f.value));
  const exs = d.exceptions!.filter(exMatch);
  const showEx = !f || !['ipc', 'process', 'readings', 'alarms'].includes(f.kind);
  const card = (cls: string, n: number, label: string, x: ExFilter, meaning: string) => (
    <button className={`kpi ${cls} kpi-btn${f?.kind === x.kind ? ' on' : ''}`} onClick={() => pick(f?.kind === x.kind ? null : x)}><b>{n}</b><span>{label}</span><small className="kpi-meaning">{meaning}</small></button>
  );
  return (
    <>
      <div className="kpis">
        {card(a.openExceptions ? 'bad' : 'ok', a.openExceptions, 'Open exceptions', { kind: 'open' }, 'Problems in batch records that QA has not decided yet')}
        {card(a.abnormalReadings ? 'warn' : 'ok', a.abnormalReadings, `Abnormal readings (${d.days} days)`, { kind: 'readings' }, 'Checks or machine values outside their limits')}
        {card(d.alarms!.length ? 'bad' : 'ok', d.alarms!.length, 'GMP alarms not acknowledged', { kind: 'alarms' }, 'Critical alarms nobody has acknowledged yet')}
        {card(a.oldOpen ? 'warn' : 'ok', a.oldOpen, 'Open more than 3 days', { kind: 'old' }, 'Open exceptions waiting too long: they hold up release')}
      </div>
      <section className="dash-panel" aria-label="Analysis">
        <div className="panel-head"><h2>Analysis and suggestions</h2><span className="muted">fixed rules over the abnormal records only · click one to see its records</span></div>
        <ul className="insights">{a.insights.map((x, n) => (
          <li key={n} className={`${x.level}${x.filter ? ' clickable' : ''}`} onClick={() => x.filter && pick(x.filter as ExFilter)}>
            <span className="ins-tag">{x.level === 'high' ? 'Act now' : x.level === 'medium' ? 'Look into' : 'OK'}</span>{x.text}
            {x.batches && x.batches.length > 0 && <span className="ins-batches">{x.batches.slice(0, 8).map((b) => <BatchLink key={b} n={b} onBatch={onBatch} />)}</span>}
          </li>))}</ul>
        <div className="three-col">
          <div><h4>By category</h4><Bars rows={a.byCategory.map((r) => ({ key: r.key, label: words(r.key), n: r.n, color: C.life }))} onPick={(k) => pick({ kind: 'category', value: k })} /></div>
          <div><h4>By severity</h4><Bars rows={a.bySeverity.map((r) => ({ key: r.key, label: words(r.key), n: r.n, color: SEV_COLOR(r.key) }))} onPick={(k) => pick({ kind: 'severity', value: k })} /></div>
          <div><h4>Batches with most abnormal records</h4><Bars rows={a.byBatch.map((r) => ({ key: r.key, label: r.key, n: r.n, color: C.use, hint: 'click: show its records' }))} onPick={(k) => pick({ kind: 'batch', value: k })} /></div>
        </div>
      </section>
      <div id="ex-lists" />
      {f && (
        <div className="filter-bar">Showing: <strong>{filterLabel(f)}</strong>
          {f.kind === 'batch' && <button className="link" onClick={() => onBatch(f.value!)}>Open batch {f.value} →</button>}
          <button className="link dark" onClick={() => setF(null)}>Clear ✕</button></div>
      )}
      {f?.kind === 'alarms' && (
        <section className="dash-panel" aria-label="Alarms">
          <div className="panel-head"><h2>GMP alarms not acknowledged</h2><span className="pill bad">{d.alarms!.length}</span></div>
          {d.alarms!.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> None.</p> : (
            <table className="plain-table"><thead><tr><th>Alarm</th><th>Source</th><th>Subject</th><th>Raised</th></tr></thead>
              <tbody>{d.alarms!.map((r, n) => <tr key={n}><td><strong>{r.code}</strong></td><td>{r.source}</td><td>{r.subject ?? '—'}</td><td>{shortTime(r.raisedAt)}</td></tr>)}</tbody></table>)}
        </section>
      )}
      {showEx && (
        <section className="dash-panel" aria-label="Open exceptions">
          <div className="panel-head"><h2>{f && !['open', 'old'].includes(f.kind) ? 'Exceptions' : 'Open exceptions'}</h2><span className="pill bad">{exs.length}</span>
            <span className="muted">click a row to see the batch</span></div>
          {exs.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> None.</p> : (
            <div className="ex-cards">{exs.map((e) => { const x = explainException(e); return (
              <article key={e.exceptionId} className={`ex-card ${x.tone}`} onClick={() => onBatch(e.batchNumber)}>
                <header><strong>{x.problem}</strong><BatchLink n={e.batchNumber} onBatch={onBatch} />
                  <button className="sev sev-btn" style={{ background: SEV_COLOR(e.severity) }} onClick={(ev) => { ev.stopPropagation(); pick({ kind: 'severity', value: e.severity }); }}>{words(e.severity)}</button>
                  <span className="ex-when">{shortTime(e.raisedAt)}</span></header>
                <p><b>What happened:</b> {x.happened}</p>
                <p><b>Why it matters:</b> {x.why}</p>
                <p className="ex-todo"><b>What to do:</b> {x.todo}</p>
                <footer><span className={`ex-status ${x.tone}`}>{x.status}</span>{e.description && <small className="cell-sub" title="As recorded in the batch record">Record: {e.description}</small>}</footer>
              </article>); })}</div>
          )}
        </section>
      )}
      {showReadings && (
        <section className="dash-panel" aria-label="Abnormal readings">
          <div className="panel-head"><h2>Abnormal readings</h2><span className="muted">in-process checks failed or on alert, process values out of limits · last {d.days} days</span></div>
          {ipc.length + proc.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> None.</p> : (
            <div className="ex-cards">{[...ipc.map((r) => ({ r, b: r.batchNumber, at: r.recordedAt, x: explainReading(r) })), ...proc.map((r) => ({ r: { ...r, withinLimits: false }, b: r.batchNumber, at: r.recordedAt, x: explainReading({ ...r, withinLimits: false }) }))].map((y, n) => (
              <article key={n} className="ex-card bad" onClick={() => onBatch(y.b)}>
                <header><strong>{y.x.problem}</strong><BatchLink n={y.b} onBatch={onBatch} /><span className="ex-when">{shortTime(y.at)}</span></header>
                <p><b>What happened:</b> {y.x.happened}</p>
                <p><b>Why it matters:</b> {y.x.why}</p>
                <p className="ex-todo"><b>What to do:</b> {y.x.todo}</p>
              </article>))}</div>
          )}
        </section>
      )}
    </>
  );
}

// ---- one batch: what happened (Batchwright record, deviations, Logbook entries) ----
interface BatchDetailData {
  batch: { batchNumber: string; productCode: string; strength: string | null; status: string; issuedAt: string | null; completedAt: string | null; released: boolean };
  equipment: { step: string | null; equipmentCode: string | null; equipmentType: string | null; roomCode: string | null; startedAt: string | null; endedAt: string | null }[];
  exceptions: Exc[];
  ipc: { stepTitle: string | null; checkKind: string; item: string | null; value: string | null; unit: string | null; lower: string | null; upper: string | null; aggregate: string | null; result: string; recordedAt: string }[];
  process: { step: string | null; tag: string; value: string | null; unit: string | null; lower: string | null; upper: string | null; withinLimits: boolean | null; recordedAt: string }[];
  deviations: { number: string; status: string; title: string | null; openedAt: string | null; closedAt: string | null }[] | null;
  logbook: { id: number; equipmentId: number; code: string; name: string; what: string; start: string; end: string | null; by: string }[];
}
const stepName = (s: string | null) => (s ?? '').replace(/^p-/, '').replace(/@$/, '').replaceAll('-', ' ');
function BatchDrawer({ number, onClose, onOpen }: { number: string; onClose: () => void; onOpen: (id: number) => void }) {
  const [d, setD] = useState<BatchDetailData | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'abnormal' | 'checks' | 'equipment' | 'logbook'>('abnormal');
  useEffect(() => { setD(null); setErr(''); api<BatchDetailData>('GET', `/api/dashboard/batches/${encodeURIComponent(number)}`).then(setD).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, [number]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const open = d ? d.exceptions.filter(isOpen) : [];
  const failed = d ? d.ipc.filter((r) => r.result === 'FAIL' || r.result === 'ALERT') : [];
  const outOfLimits = d ? d.process.filter((p) => p.withinLimits === false) : [];
  return (
    <div className="drawer-wrap" role="dialog" aria-modal="true" aria-label={`Batch ${number}`} onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div><span className="pt-title">Batch</span><h2>{number}</h2>
            {d && <p className="muted">{d.batch.productCode}{d.batch.strength ? ` ${d.batch.strength}` : ''} · {words(d.batch.status)}{d.batch.released ? ' · released' : ''} · issued {d.batch.issuedAt ? shortTime(d.batch.issuedAt) : '—'}{d.batch.completedAt ? ` · completed ${shortTime(d.batch.completedAt)}` : ''}</p>}</div>
          <button className="link dark" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {err && <p className="error">{err}</p>}
        {!d && !err && <p className="muted">Loading the batch record…</p>}
        {d && (
          <>
            <div className="drawer-kpis">
              <div className={open.length ? 'mk bad' : 'mk ok'}><b>{open.length}</b><span>open exceptions</span></div>
              <div className="mk"><b>{d.exceptions.length}</b><span>exceptions in all</span></div>
              <div className={failed.length ? 'mk warn' : 'mk ok'}><b>{failed.length}</b><span>checks failed / alert</span></div>
              <div className={outOfLimits.length ? 'mk warn' : 'mk ok'}><b>{outOfLimits.length}</b><span>values out of limits</span></div>
              <div className={d.deviations?.length ? 'mk warn' : 'mk ok'}><b>{d.deviations?.length ?? '—'}</b><span>deviations</span></div>
            </div>
            {(() => {
              // Owner 2026-11-14: the batch's problems in plain words, grouped, with what to do; the details below.
              const groups = new Map<string, { problem: string; n: number; open: number; steps: Set<string>; why: string; todo: string; happened: string }>();
              for (const e of d.exceptions) { const x = explainException(e); const g = groups.get(x.problem) ?? { problem: x.problem, n: 0, open: 0, steps: new Set<string>(), why: x.why, todo: x.todo, happened: x.happened };
                g.n++; if (isOpen(e)) g.open++; if (e.stepTitle) g.steps.add(e.stepTitle); groups.set(x.problem, g); }
              for (const r of failed) { const x = explainReading(r); const g = groups.get(x.problem) ?? { problem: x.problem, n: 0, open: 0, steps: new Set<string>(), why: x.why, todo: x.todo, happened: '' };
                g.n++; g.open++; g.happened = g.happened ? `${g.happened} ${x.happened}` : x.happened; if (r.stepTitle) g.steps.add(r.stepTitle); groups.set(x.problem, g); }
              const list = [...groups.values()].sort((a, b) => b.open - a.open || b.n - a.n);
              if (!list.length) return <p className="all-good"><span aria-hidden="true">✓</span> Nothing abnormal in this batch record.</p>;
              return (
                <div className="summary-box">
                  <h3>What the problems are</h3>
                  {list.map((g) => (
                    <div key={g.problem} className={g.open ? 'sum-item open' : 'sum-item'}>
                      <strong>{g.problem}</strong> <span className="muted">· {g.n} time{g.n > 1 ? 's' : ''}{g.open ? `, ${g.open} still open` : ', all closed by QA'}{g.steps.size ? ` · at ${[...g.steps].slice(0, 3).map((x) => `"${x}"`).join(', ')}` : ''}</span>
                      {g.n === 1 || g.problem.includes('out of limits') ? <p>{g.happened}</p> : null}
                      <p><b>Why it matters:</b> {g.why}</p>
                      <p className="ex-todo"><b>What to do:</b> {g.todo}</p>
                    </div>))}
                </div>
              );
            })()}
            {d.deviations && d.deviations.length > 0 && (
              <div className="drawer-devs">{d.deviations.map((x) => <span key={x.number} className="dev-chip"><strong>{x.number}</strong> · {words(x.status)}{x.title ? ` · ${x.title}` : ''}</span>)}</div>
            )}
            <div className="chips drawer-tabs" role="tablist">
              {([['abnormal', 'What went wrong'], ['checks', `Checks and values (${d.ipc.length + d.process.length})`], ['equipment', `Equipment and rooms (${d.equipment.length})`], ['logbook', `Logbook entries (${d.logbook.length})`]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'scope-chip on' : 'scope-chip'} onClick={() => setTab(k)}>{l}</button>))}
            </div>
            {tab === 'abnormal' && (
              <div className="timeline">
                {[...d.exceptions.map((e) => ({ at: e.raisedAt, kind: 'ex' as const, e })), ...failed.map((r) => ({ at: r.recordedAt, kind: 'ipc' as const, r })), ...outOfLimits.map((p) => ({ at: p.recordedAt, kind: 'pv' as const, p }))]
                  .sort((x, y) => x.at.localeCompare(y.at)).map((x, n) => (
                    <div key={n} className={`tl-item ${x.kind === 'ex' ? (isOpen(x.e) ? 'open' : 'closed') : 'reading'}`}>
                      <span className="tl-time">{shortTime(x.at)}</span>
                      {x.kind === 'ex' && <div><strong>{explainException(x.e).problem}</strong> <span className="sev" style={{ background: SEV_COLOR(x.e.severity) }}>{words(x.e.severity)}</span> <span className="muted">· {words(x.e.status)}{x.e.disposition ? ` · ${words(x.e.disposition)}` : ''}</span>
                        <small className="cell-sub">{explainException(x.e).happened}</small></div>}
                      {x.kind === 'ipc' && <div><strong>{x.r.item ?? words(x.r.checkKind)}</strong> <span className="sev" style={{ background: x.r.result === 'FAIL' ? C.over : C.due }}>{x.r.result.toLowerCase()}</span> {x.r.value}{x.r.unit ? ` ${x.r.unit}` : ''} <span className="muted">(limits {x.r.lower ?? '–'} to {x.r.upper ?? '–'})</span><small className="cell-sub">{x.r.stepTitle}</small></div>}
                      {x.kind === 'pv' && <div><strong>{x.p.tag}</strong> <span className="sev" style={{ background: C.over }}>out of limits</span> {x.p.value}{x.p.unit ? ` ${x.p.unit}` : ''} <span className="muted">(limits {x.p.lower ?? '–'} to {x.p.upper ?? '–'})</span><small className="cell-sub">{stepName(x.p.step)}</small></div>}
                    </div>))}
                {d.exceptions.length + failed.length + outOfLimits.length === 0 && <p className="all-good"><span aria-hidden="true">✓</span> Nothing abnormal recorded for this batch.</p>}
              </div>
            )}
            {tab === 'checks' && (
              <table className="plain-table"><thead><tr><th>Check / value</th><th>Result</th><th>Limits</th><th>Recorded</th></tr></thead>
                <tbody>
                  {d.ipc.map((r, n) => <tr key={`i${n}`}><td>{r.item ?? words(r.checkKind)}{r.aggregate ? ` (${r.aggregate})` : ''}<small className="cell-sub">{r.stepTitle}</small></td>
                    <td><span className="sev" style={{ background: r.result === 'PASS' ? C.ready : r.result === 'FAIL' ? C.over : C.due }}>{r.result.toLowerCase()}</span> {r.value}{r.unit ? ` ${r.unit}` : ''}</td><td>{r.lower ?? '–'} to {r.upper ?? '–'}</td><td>{shortTime(r.recordedAt)}</td></tr>)}
                  {d.process.map((p, n) => <tr key={`p${n}`}><td>{p.tag}<small className="cell-sub">{stepName(p.step)}</small></td>
                    <td><span className="sev" style={{ background: p.withinLimits === false ? C.over : C.ready }}>{p.withinLimits === false ? 'out of limits' : 'in limits'}</span> {p.value}{p.unit ? ` ${p.unit}` : ''}</td><td>{p.lower ?? '–'} to {p.upper ?? '–'}</td><td>{shortTime(p.recordedAt)}</td></tr>)}
                </tbody></table>
            )}
            {tab === 'equipment' && (
              <table className="plain-table"><thead><tr><th>Step</th><th>Equipment / room</th><th>From</th><th>To</th></tr></thead>
                <tbody>{d.equipment.map((x, n) => <tr key={n}><td>{stepName(x.step)}</td><td><strong>{x.equipmentCode ?? '—'}</strong> {x.equipmentType ? <span className="muted">{x.equipmentType}</span> : null}{x.roomCode ? <small className="cell-sub">room {x.roomCode}</small> : null}</td>
                  <td>{x.startedAt ? shortTime(x.startedAt) : '—'}</td><td>{x.endedAt ? shortTime(x.endedAt) : <span className="muted">open</span>}</td></tr>)}</tbody></table>
            )}
            {tab === 'logbook' && (d.logbook.length === 0 ? <p className="muted">No Logbook entry names this batch.</p> : (
              <table className="plain-table"><thead><tr><th>Item</th><th>Activity</th><th>From</th><th>To</th><th>By</th></tr></thead>
                <tbody>{d.logbook.map((x) => <tr key={x.id} className="clickable" onClick={() => onOpen(x.equipmentId)}><td><strong>{x.code}</strong> {x.name}</td><td>{x.what}</td><td>{shortTime(x.start)}</td><td>{x.end ? shortTime(x.end) : <span className="muted">in progress</span>}</td><td>{x.by}</td></tr>)}</tbody></table>
            ))}
          </>
        )}
      </aside>
    </div>
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
  const [batch, setBatch] = useState<string | null>(null);

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
      {tab === 'exceptions' && <Exceptions d={exc} onBatch={setBatch} />}
      {batch && <BatchDrawer number={batch} onClose={() => setBatch(null)} onOpen={(id) => { setBatch(null); onOpen(id); }} />}
    </>
  );
}
