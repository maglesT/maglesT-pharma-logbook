import { createContext, useContext, useEffect, useState } from 'react';
import { api, DEADLINE_LABEL, plantTime, timeLeft, TYPE_LABEL, type Alert, type Entry, type Equipment, type EquipmentStatus, type Me } from '../api.js';
import { StatusChip } from '../components/StatusChip.js';

// S16: the home dashboard, with equipment and areas apart. A summary strip on top; each part shows how its items
// stand (ring chart and counts; a count opens the list of those items) and the cleaning deadlines that are close or
// past: dirty hold, clean hold, or the cleaning frequency of a frequency-based room. Every row opens the item.

const GROUPS = [
  { key: 'ready', label: 'Clean / ready', color: '#17803d', states: ['clean', 'available'] },
  { key: 'in_use', label: 'In use', color: '#1f63b8', states: ['in_use'] },
  { key: 'dirty', label: 'Dirty', color: '#e0a800', states: ['dirty'] },
  { key: 'late', label: 'Overdue', color: '#c0352b', states: ['dirty_expired', 'clean_expired', 'cleaning_due'] },
  { key: 'out', label: 'Out of service', color: '#5f5f5f', states: ['out_of_service', 'calibration_overdue', 'calibration_failed', 'not_calibrated'] },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];
const groupOf = (state: string): GroupKey => GROUPS.find((g) => (g.states as readonly string[]).includes(state))?.key ?? 'ready';

interface Item { eq: Equipment; st: EquipmentStatus }
// S16b (D-34): deviations raised automatically for missed cleaning limits.
interface AutoDeviation { equipmentId: number; kind: string; deadlineAt: string; deviationNumber: string | null; lastError: string | null }
interface AutoDeviations { enabled: boolean; deviationsUrl: string | null; items: AutoDeviation[] }
const AutoDevs = createContext<AutoDeviations>({ enabled: false, deviationsUrl: null, items: [] });
const isDue = (i: Item) => Boolean(i.st.deadline && (i.st.deadline.soon || i.st.deadline.overdue));
// Plant time, short: "7:17 pm" today, "13 Nov, 7:17 pm" another day.
const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
function shortTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  return day(d) === day(new Date()) ? `today ${time}` : `${d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}, ${time}`;
}

function Ring({ counts, total }: { counts: { key: string; color: string; n: number }[]; total: number }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const ready = counts.find((x) => x.key === 'ready')?.n ?? 0;
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
  const auto = useContext(AutoDevs);
  const dev = auto.enabled && d.overdue && d.kind !== 'clean_hold'
    ? auto.items.find((a) => a.equipmentId === eq.id && a.kind === d.kind && Date.parse(a.deadlineAt) === Date.parse(d.at)) ?? null : undefined;
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
      {dev !== undefined && (
        <span className="dl-dev">
          {dev?.deviationNumber ? (
            <>Deviation <a href={auto.deviationsUrl ?? '#'} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{dev.deviationNumber}</a> raised automatically</>
          ) : dev?.lastError ? `Deviation not reported yet (retrying): ${dev.lastError}` : 'Raising a deviation…'}
        </span>
      )}
      <span className="dl-bar" aria-hidden="true"><i style={{ width: `${used * 100}%` }} /></span>
    </div>
  );
}

function Part({ title, icon, items, note, onOpen }: { title: string; icon: string; items: Item[]; note: string; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState<GroupKey | null>(null);
  const counts = GROUPS.map((g) => ({ ...g, n: items.filter((i) => groupOf(i.st.state) === g.key).length }));
  const due = items.filter(isDue).sort((a, b) => Date.parse(a.st.deadline!.at) - Date.parse(b.st.deadline!.at));
  const shown = open ? items.filter((i) => groupOf(i.st.state) === open) : [];
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
        <h3>Cleaning deadlines</h3>
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

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [open, setOpen] = useState<Entry[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [autoDevs, setAutoDevs] = useState<AutoDeviations>({ enabled: false, deviationsUrl: null, items: [] });
  const watches = me.roles.includes('admin') || me.roles.includes('qa');

  const loadStatus = async (background = false) => {
    const [s, e] = await Promise.all([
      api<EquipmentStatus[]>('GET', '/api/equipment/status', undefined, background),
      api<Equipment[]>('GET', '/api/equipment', undefined, background),
    ]);
    setStatuses(s);
    setEquipment(e);
    setAutoDevs(await api<AutoDeviations>('GET', '/api/auto-deviations', undefined, background));
    setUpdated(new Date().toISOString());
  };
  useEffect(() => {
    void loadStatus();
    void api<Entry[]>('GET', '/api/entries/open').then(setOpen);
    // Deadlines move with the clock: refresh every minute.
    const timer = setInterval(() => void loadStatus(true).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, []);

  const loadAlerts = async (background = false) => setAlerts(await api<Alert[]>('GET', '/api/alerts', undefined, background));
  useEffect(() => {
    if (!watches) return;
    void loadAlerts();
    const timer = setInterval(() => void loadAlerts(true).catch(() => window.location.reload()), 30_000);
    return () => clearInterval(timer);
  }, [watches]);
  const ack = async (id: number) => {
    await api('POST', `/api/alerts/${id}/ack`);
    await loadAlerts();
  };

  const byId = new Map(equipment.map((e) => [e.id, e]));
  const items: Item[] = statuses.flatMap((st) => {
    const eq = byId.get(st.equipmentId);
    return eq?.active ? [{ eq, st }] : [];
  });
  // Four parts (owner): equipment, instruments, operation-based rooms, frequency-based rooms.
  const equipmentItems = items.filter((i) => i.eq.kind === 'equipment');
  const instruments = items.filter((i) => i.eq.kind === 'instrument');
  const operationRooms = items.filter((i) => i.eq.kind === 'area' && i.eq.cleaningBasis !== 'frequency');
  const frequencyRooms = items.filter((i) => i.eq.kind === 'area' && i.eq.cleaningBasis === 'frequency');
  const code = (id: number) => byId.get(id)?.code ?? '';
  const overdue = items.filter((i) => i.st.deadline?.overdue || groupOf(i.st.state) === 'late').length;
  const soon = items.filter((i) => i.st.deadline?.soon).length;
  const inUse = items.filter((i) => i.st.state === 'in_use').length;
  const ready = items.filter((i) => groupOf(i.st.state) === 'ready').length;
  const hour = new Date().getHours();

  return (
    <>
      {alerts.map((a) => (
        <div key={a.id} className="alert" role="alert">
          <span>
            <strong>Security alert</strong> · {plantTime(a.createdAt)} · {a.message}
          </span>
          <button onClick={() => ack(a.id)}>Acknowledge</button>
        </div>
      ))}
      <div className="home-head">
        <div>
          <h1>Home</h1>
          <p className="greeting">Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.fullName.split(' (')[0]}. Here is how the plant stands right now.</p>
        </div>
        {updated && <span className="updated">Updated {plantTime(updated)}</span>}
      </div>
      <div className="kpis">
        <div className={overdue ? 'kpi bad' : 'kpi'}><b>{overdue}</b><span>Overdue cleaning</span></div>
        <div className={soon ? 'kpi warn' : 'kpi'}><b>{soon}</b><span>Due soon</span></div>
        <div className="kpi info"><b>{inUse}</b><span>In use</span></div>
        <div className="kpi ok"><b>{ready}<small> / {items.length}</small></b><span>Ready for use</span></div>
      </div>
      <AutoDevs.Provider value={autoDevs}>
      <div className="dash">
        <Part title="Equipment" icon="⚙" items={equipmentItems} onOpen={onOpen} note="dirty hold after use, clean hold after cleaning" />
        <Part title="Instruments" icon="⚖" items={instruments} onOpen={onOpen} note="cleaning holds and calibration" />
        <Part title="Operation-based rooms" icon="▦" items={operationRooms} onOpen={onOpen} note="processing rooms: dirty hold after use, clean hold after cleaning" />
        <Part title="Frequency-based rooms" icon="↻" items={frequencyRooms} onOpen={onOpen} note="cleaned on a schedule (daily, weekly…)" />
      </div>
      </AutoDevs.Provider>
      <section className="dash-panel">
        <div className="dash-sub"><h3>Open items</h3>{open.length > 0 && <span className="count info">{open.length}</span>}</div>
        {open.length === 0 ? (
          <p className="all-good"><span aria-hidden="true">✓</span> Nothing open: no equipment in use and nothing awaiting verification.</p>
        ) : (
          <table className="plain-table">
            <thead><tr><th>Equipment</th><th>Entry</th><th>Since</th><th>Open because</th></tr></thead>
            <tbody>
              {open.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                  <td><strong>{code(e.equipmentId)}</strong></td>
                  <td>{TYPE_LABEL[e.logbookType]}{e.batch && ` · batch ${e.batch}`}</td>
                  <td>{plantTime(e.activityStart)}</td>
                  <td>{e.inProgress ? (e.logbookType === 'maintenance' ? 'Repair not finished' : 'In use (not ended)') : 'Awaiting verification'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
