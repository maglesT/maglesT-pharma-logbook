import { useEffect, useState } from 'react';
import { api, daysLeft, DEADLINE_LABEL, DUE_LABEL, plantTime, timeLeft, TYPE_LABEL, type Due, type Entry, type Equipment, type EquipmentStatus, type Me } from '../api.js';
import { StatusChip } from '../components/StatusChip.js';

// Owner 2026-11-12: the home dashboard. A summary strip; the dues (PM, calibration, requalification) overdue or due within
// 15 days; then four parts (equipment, instruments, operation-based rooms, frequency-based rooms), each with a ring and
// counts (a count opens its items; "due soon" is counted, point 1) and its cleaning deadlines, overdue and due soon
// (point 2); then what is in use (point 3). Every row opens the item.

// Owner 2026-11-12: the graph also shows change over, breakdown, requalification needed and PM due, each item in one
// group, the first that applies in this order: in use, change over, breakdown, requalification, PM, cleaning overdue,
// other out of service (calibration), dirty, due soon, ready.
const GROUPS = [
  { key: 'ready', label: 'Clean / ready', color: '#17803d' },
  { key: 'soon', label: 'Due soon', color: '#f0b429' },
  { key: 'in_use', label: 'In use', color: '#1f63b8' },
  { key: 'change_over', label: 'Change over', color: '#6b4fbb' },
  { key: 'dirty', label: 'Dirty', color: '#b7791f' },
  { key: 'late', label: 'Cleaning overdue', color: '#c0352b' },
  { key: 'pm', label: 'PM due', color: '#d9622b' },
  { key: 'requal', label: 'Requalification needed', color: '#a3195b' },
  { key: 'breakdown', label: 'Breakdown', color: '#7a1f1f' },
  { key: 'out', label: 'Out of service (calibration)', color: '#5f5f5f' },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];
const CLEANING_LATE = ['dirty_expired', 'clean_expired', 'cleaning_due'];
const OUT = ['calibration_overdue', 'calibration_failed', 'not_calibrated'];
const dueOf = (s: EquipmentStatus, kind: Due['kind']) => s.dues.find((d) => d.kind === kind && (d.overdue || d.soon));
function groupOf(s: EquipmentStatus): GroupKey {
  if (s.state === 'in_use') return 'in_use';
  if (s.state === 'in_change_over') return 'change_over';
  if (s.state === 'out_of_service') return 'breakdown';
  if (s.state === 'requalification_overdue' || s.state === 'not_qualified' || s.qualification === 'requalification_needed'
    || dueOf(s, 'requalification')) return 'requal';
  if (s.state === 'pm_overdue' || dueOf(s, 'pm')) return 'pm';
  if (CLEANING_LATE.includes(s.state) || s.deadline?.overdue) return 'late';
  if (OUT.includes(s.state)) return 'out';
  if (s.state === 'dirty') return 'dirty';
  if (s.deadline?.soon || s.dues.some((d) => d.soon)) return 'soon';
  return 'ready';
}
const isOverdue = (s: EquipmentStatus) => Boolean(s.deadline?.overdue) || s.dues.some((d) => d.overdue)
  || [...CLEANING_LATE, 'pm_overdue', 'requalification_overdue', 'calibration_overdue'].includes(s.state);

interface Item { eq: Equipment; st: EquipmentStatus }
const isDue = (i: Item) => Boolean(i.st.deadline && (i.st.deadline.soon || i.st.deadline.overdue));
const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
function shortTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  return day(d) === day(new Date()) ? `today ${time}` : `${d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}, ${time}`;
}

function Ring({ counts, total }: { counts: { key: string; color: string; n: number }[]; total: number }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const ready = counts.filter((x) => x.key === 'ready' || x.key === 'soon').reduce((a, x) => a + x.n, 0);
  let offset = 0;
  return (
    <svg className="ring" viewBox="0 0 128 128" role="img" aria-label={`${total} items, ${ready} ready`}>
      <circle cx="64" cy="64" r={r} fill="none" stroke="var(--line)" strokeWidth="12" />
      {total > 0 && counts.filter((x) => x.n > 0).map((x) => {
        const len = (x.n / total) * c;
        const seg = (
          <circle key={x.key} cx="64" cy="64" r={r} fill="none" strokeWidth="12" stroke={x.color}
            strokeDasharray={`${Math.max(len - 2, 0.5)} ${c - Math.max(len - 2, 0.5)}`} strokeDashoffset={-offset} transform="rotate(-90 64 64)" />
        );
        offset += len;
        return seg;
      })}
      <text x="64" y="64" textAnchor="middle" className="ring-big">{total ? Math.round((ready / total) * 100) : 0}%</text>
      <text x="64" y="82" textAnchor="middle" className="ring-sub">ready</text>
    </svg>
  );
}

function DeadlineRow({ item: { eq, st }, onOpen }: { item: Item; onOpen: (id: number) => void }) {
  const d = st.deadline!;
  const rule = d.kind === 'frequency' ? `${DEADLINE_LABEL[d.kind]} (every ${d.hours} h)` : `${DEADLINE_LABEL[d.kind]} (${d.hours} h)`;
  const used = Math.min(1, Math.max(0, 1 - (Date.parse(d.at) - Date.now()) / (d.hours * 3_600_000)));
  return (
    <div role="button" tabIndex={0} className={d.overdue ? 'deadline overdue' : 'deadline'} onClick={() => onOpen(eq.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(eq.id); } }}>
      <span className="dl-tag">{d.overdue ? 'Overdue' : 'Due soon'}</span>
      <span className="dl-main">
        <strong className="dl-name">{eq.code} <span>{eq.name}</span></strong>
        <span className="dl-rule">{rule} · {d.overdue ? 'ended' : 'ends'} {shortTime(d.at)} IST</span>
      </span>
      <span className="when">{d.overdue ? `Overdue by ${timeLeft(d.at)}` : `Ends in ${timeLeft(d.at)}`}</span>
      <span className="dl-bar" aria-hidden="true"><i style={{ width: `${used * 100}%` }} /></span>
    </div>
  );
}

function Part({ title, icon, items, note, onOpen }: { title: string; icon: string; items: Item[]; note: string; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState<GroupKey | null>(null);
  const counts = GROUPS.map((g) => ({ ...g, n: items.filter((i) => groupOf(i.st) === g.key).length }));
  const due = items.filter(isDue).sort((a, b) => Date.parse(a.st.deadline!.at) - Date.parse(b.st.deadline!.at));
  const shown = open ? items.filter((i) => groupOf(i.st) === open) : [];
  const max = Math.max(1, ...counts.map((g) => g.n));
  return (
    <section className="dash-panel" aria-label={title}>
      <header className="dash-head">
        <span className="dash-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{items.length} active · {note}</p>
        </div>
      </header>
      <div className="dash-chart">
        <Ring counts={counts} total={items.length} />
        <ul className="legend">
          {counts.map((g) => (
            <li key={g.key} className={open === g.key ? 'on' : ''}>
              <button className="legend-row" onClick={() => setOpen(open === g.key ? null : g.key)} aria-pressed={open === g.key} disabled={g.n === 0}>
                <i style={{ background: g.color }} />
                <span className="lg-label">{g.label}</span>
                <span className="lg-bar"><i style={{ width: `${(g.n / max) * 100}%`, background: g.color }} /></span>
                <b>{g.n}</b>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open && (
        <div className="dash-list">
          <div className="dash-list-head">
            <span>{GROUPS.find((g) => g.key === open)!.label} · {shown.length}</span>
            <button className="link dark" onClick={() => setOpen(null)} aria-label="Close the list">✕</button>
          </div>
          {shown.map(({ eq, st }) => (
            <button key={eq.id} className="dash-item" onClick={() => onOpen(eq.id)}>
              <strong className="dl-name">{eq.code} <span>{eq.name}</span></strong>
              <StatusChip status={st} />
              <span className="dl-rule">{st.blockers[0] ?? st.warnings[0] ?? (st.cleanUntil ? `Clean until ${plantTime(st.cleanUntil)}` : '')}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dash-sub">
        <h3>Cleaning deadlines <span className="muted" style={{ fontWeight: 500 }}>(overdue + due soon)</span></h3>
        {due.length > 0 && <span className={due.some((i) => i.st.deadline!.overdue) ? 'count bad' : 'count'}>{due.length}</span>}
      </div>
      {due.length === 0 ? (
        <p className="all-good"><span aria-hidden="true">✓</span> All on schedule: no cleaning deadline is close.</p>
      ) : (
        <div className="deadlines">{due.map((i) => <DeadlineRow key={i.eq.id} item={i} onOpen={onOpen} />)}</div>
      )}
    </section>
  );
}

// Owner (points 7, 8): PM, calibration and requalification overdue or due within 15 days, at one place, stark.
function Dues({ items, onOpen }: { items: Item[]; onOpen: (id: number) => void }) {
  const rows = items.flatMap((i) => i.st.dues.filter((d) => d.overdue || d.soon).map((d) => ({ i, d })))
    .sort((a, b) => Number(b.d.overdue) - Number(a.d.overdue) || a.d.due.localeCompare(b.d.due));
  const overdue = rows.filter((r) => r.d.overdue).length;
  return (
    <section className="dash-panel dues" aria-label="Dues">
      <div className="dash-sub">
        <h2>Dues: preventive maintenance, calibration, requalification</h2>
        {overdue > 0 && <span className="count bad">{overdue} overdue</span>}
        {rows.length - overdue > 0 && <span className="count">{rows.length - overdue} within 15 days</span>}
      </div>
      {rows.length === 0 ? (
        <p className="all-good"><span aria-hidden="true">✓</span> Nothing overdue and nothing due within 15 days.</p>
      ) : (
        <div className="due-grid">
          {rows.map(({ i, d }) => <DueCard key={`${i.eq.id}-${d.kind}`} eq={i.eq} d={d} onOpen={onOpen} />)}
        </div>
      )}
    </section>
  );
}
function DueCard({ eq, d, onOpen }: { eq: Equipment; d: Due; onOpen: (id: number) => void }) {
  return (
    <button className={d.overdue ? 'due-card overdue' : 'due-card'} onClick={() => onOpen(eq.id)}>
      <span className="dl-tag">{d.overdue ? 'Overdue' : 'Due soon'}</span>
      <strong>{DUE_LABEL[d.kind]}</strong>
      <span className="dl-name">{eq.code} <span>{eq.name}</span></span>
      <span className="when">{d.due} · {daysLeft(d.due)}</span>
      <span className="dl-rule">{d.frequency}</span>
    </button>
  );
}

// Owner 2026-11-12 (D-37): every missed limit raises a deviation in the Deviations product; its number shows here.
interface OverdueEvent { id: number; equipmentId: number; code: string; name: string; label: string; dueAt: string; detectedAt: string;
  deviation: { number: string; status: string } | null }
const DEV_STEP: Record<string, string> = { classification: 'awaiting QA classification', approval: 'awaiting approval', investigation: 'under investigation',
  closure: 'awaiting closure', closed: 'closed', rejected: 'rejected' };
function Raised({ data, onOpen }: { data: { linked: boolean; events: OverdueEvent[] } | null; onOpen: (id: number) => void }) {
  if (!data || data.events.length === 0) return null;
  return (
    <section className="dash-panel" aria-label="Deviations raised">
      <div className="dash-sub"><h3>Deviations raised for missed limits</h3><span className="count bad">{data.events.length}</span></div>
      <table className="plain-table">
        <thead><tr><th>Item</th><th>Missed limit</th><th>Ran out</th><th>Deviation</th></tr></thead>
        <tbody>
          {data.events.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
              <td><strong>{e.code}</strong> {e.name}</td>
              <td>{e.label}</td>
              <td>{plantTime(e.dueAt)}</td>
              <td>{e.deviation ? <><strong>{e.deviation.number}</strong> · {DEV_STEP[e.deviation.status] ?? e.deviation.status}</>
                : data.linked ? <span className="muted">being raised in Deviations…</span> : <span className="muted">Deviations not linked</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [open, setOpen] = useState<Entry[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [raised, setRaised] = useState<{ linked: boolean; events: OverdueEvent[] } | null>(null);

  const load = async (background = false) => {
    const [s, e, o] = await Promise.all([
      api<EquipmentStatus[]>('GET', '/api/equipment/status', undefined, background),
      api<Equipment[]>('GET', '/api/equipment', undefined, background),
      api<Entry[]>('GET', '/api/entries/open', undefined, background),
    ]);
    setStatuses(s);
    setEquipment(e);
    setOpen(o);
    setRaised(await api<{ linked: boolean; events: OverdueEvent[] }>('GET', '/api/overdue', undefined, background).catch(() => null));
    setUpdated(new Date().toISOString());
  };
  useEffect(() => {
    void load();
    // Deadlines move with the clock: refresh every minute.
    const timer = setInterval(() => void load(true).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, []);

  const byId = new Map(equipment.map((e) => [e.id, e]));
  const items: Item[] = statuses.flatMap((st) => {
    const eq = byId.get(st.equipmentId);
    return eq?.active ? [{ eq, st }] : [];
  });
  const part = (kind: Equipment['kind'], basis?: 'frequency' | 'operation') =>
    items.filter((i) => i.eq.kind === kind && (!basis || (basis === 'frequency') === (i.eq.cleaningBasis === 'frequency')));
  const code = (id: number) => byId.get(id)?.code ?? '';
  const overdue = items.filter((i) => isOverdue(i.st)).length;
  const soon = items.filter((i) => !isOverdue(i.st) && (Boolean(i.st.deadline?.soon) || i.st.dues.some((d) => d.soon))).length;
  const inUse = items.filter((i) => groupOf(i.st) === 'in_use' || groupOf(i.st) === 'change_over').length;
  const ready = items.filter((i) => groupOf(i.st) === 'ready' || groupOf(i.st) === 'soon').length;
  const hour = new Date().getHours();
  // Point 3: "In use" lists what occupies an item now: uses, change overs and repairs in progress.
  const inProgress = open.filter((e) => e.inProgress);

  return (
    <>
      <div className="home-head">
        <div>
          <h1>Home</h1>
          <p className="greeting">Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.fullName.split(' (')[0]}. Here is how the plant stands right now.</p>
        </div>
        {updated && <span className="updated">Updated {plantTime(updated)}</span>}
      </div>
      <div className="kpis">
        <div className={overdue ? 'kpi bad' : 'kpi'}><b>{overdue}</b><span>Overdue</span></div>
        <div className={soon ? 'kpi warn' : 'kpi'}><b>{soon}</b><span>Due soon</span></div>
        <div className="kpi info"><b>{inUse}</b><span>In use</span></div>
        <div className="kpi ok"><b>{ready}<small> / {items.length}</small></b><span>Ready for use</span></div>
      </div>
      <Dues items={items} onOpen={onOpen} />
      <div className="dash">
        <Part title="Equipment" icon="⚙" items={part('equipment')} onOpen={onOpen} note="dirty hold after use, clean hold after cleaning" />
        <Part title="Instruments" icon="⚖" items={part('instrument')} onOpen={onOpen} note="cleaning holds and calibration" />
        <Part title="Operation-based rooms" icon="▦" items={part('area', 'operation')} onOpen={onOpen} note="processing rooms: dirty hold after use, clean hold after cleaning" />
        <Part title="Frequency-based rooms" icon="↻" items={part('area', 'frequency')} onOpen={onOpen} note="cleaned on a schedule (daily, weekly…)" />
      </div>
      <Raised data={raised} onOpen={onOpen} />
      <section className="dash-panel" aria-label="In use">
        <div className="dash-sub"><h3>In use</h3>{inProgress.length > 0 && <span className="count info">{inProgress.length}</span>}</div>
        {inProgress.length === 0 ? (
          <p className="all-good"><span aria-hidden="true">✓</span> Nothing in use: no use, change over or repair in progress.</p>
        ) : (
          <table className="plain-table">
            <thead><tr><th>Item</th><th>Activity</th><th>Since</th><th>Done by</th></tr></thead>
            <tbody>
              {inProgress.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                  <td><strong>{code(e.equipmentId)}</strong></td>
                  <td>{e.logbookType === 'maintenance' ? 'Repair (breakdown)' : TYPE_LABEL[e.logbookType]}{e.batch && ` · batch ${e.batch}`}</td>
                  <td>{plantTime(e.activityStart)}</td>
                  <td>{e.enteredBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
