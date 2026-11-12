import { useEffect, useState } from 'react';
import { api, DEADLINE_LABEL, plantTime, timeLeft, TYPE_LABEL, type Alert, type Entry, type Equipment, type EquipmentStatus, type Me } from '../api.js';
import { StatusChip } from '../components/StatusChip.js';

// S16: the home dashboard, with equipment and areas apart. Each part shows how its items stand (chart and counts; a
// count opens the list of those items) and the cleaning deadlines that are close or past: dirty hold, clean hold, or
// the cleaning frequency of a frequency-based room. Every row opens the item.

const GROUPS = [
  { key: 'ready', label: 'Clean / ready', cls: 'c-ok', states: ['clean', 'available'] },
  { key: 'in_use', label: 'In use', cls: 'c-info', states: ['in_use'] },
  { key: 'dirty', label: 'Dirty, to be cleaned', cls: 'c-warn', states: ['dirty'] },
  { key: 'late', label: 'Overdue (hold expired, cleaning due)', cls: 'c-late', states: ['dirty_expired', 'clean_expired', 'cleaning_due'] },
  { key: 'out', label: 'Out of service or calibration', cls: 'c-bad', states: ['out_of_service', 'calibration_overdue', 'calibration_failed', 'not_calibrated'] },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];
const groupOf = (state: string): GroupKey => GROUPS.find((g) => (g.states as readonly string[]).includes(state))?.key ?? 'ready';

interface Item { eq: Equipment; st: EquipmentStatus }
const STROKE: Record<string, string> = { 'c-ok': '#17803d', 'c-info': '#1f63b8', 'c-warn': '#e8b400', 'c-late': '#e8500f', 'c-bad': '#8b1d16' };

function Donut({ counts, total }: { counts: { cls: string; n: number }[]; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 132 132" role="img" aria-label={`${total} items`}>
      <circle cx="66" cy="66" r={r} fill="none" stroke="var(--line)" strokeWidth="16" />
      {total > 0 && counts.filter((x) => x.n > 0).map((x) => {
        const len = (x.n / total) * c;
        const seg = (
          <circle key={x.cls} cx="66" cy="66" r={r} fill="none" strokeWidth="16" stroke={STROKE[x.cls]}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 66 66)" />
        );
        offset += len;
        return seg;
      })}
      <text x="66" y="68" textAnchor="middle">{total}</text>
      <text x="66" y="84" textAnchor="middle" className="sub">items</text>
    </svg>
  );
}

function Deadlines({ items, onOpen }: { items: Item[]; onOpen: (id: number) => void }) {
  const due = items
    .filter((i) => i.st.deadline && (i.st.deadline.soon || i.st.deadline.overdue))
    .sort((a, b) => Date.parse(a.st.deadline!.at) - Date.parse(b.st.deadline!.at));
  if (due.length === 0) return <p className="dash-note">No cleaning deadline is close: nothing ends in its warning window.</p>;
  return (
    <div className="deadlines">
      {due.map(({ eq, st }) => {
        const d = st.deadline!;
        const rule = d.kind === 'frequency' ? `${DEADLINE_LABEL[d.kind]} (every ${d.hours} h)` : `${DEADLINE_LABEL[d.kind]} (${d.hours} h)`;
        return (
          <button key={eq.id} className={d.overdue ? 'deadline overdue' : 'deadline'} onClick={() => onOpen(eq.id)}>
            <strong>{eq.code} <span className="muted" style={{ fontWeight: 400 }}>{eq.name}</span></strong>
            <span className="when">{d.overdue ? `Overdue by ${timeLeft(d.at)}` : `Ends in ${timeLeft(d.at)}`}</span>
            <span className="muted">{rule} · {d.overdue ? 'ended' : 'ends'} {plantTime(d.at)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Part({ title, items, note, onOpen }: { title: string; items: Item[]; note?: string; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState<GroupKey | null>(null);
  const counts = GROUPS.map((g) => ({ ...g, n: items.filter((i) => groupOf(i.st.state) === g.key).length }));
  const due = items.filter((i) => i.st.deadline && (i.st.deadline.soon || i.st.deadline.overdue)).length;
  const shown = open ? items.filter((i) => groupOf(i.st.state) === open) : [];
  return (
    <section className="dash-panel" aria-label={title}>
      <h2>{title} <small>{items.length} active</small></h2>
      <div className="dash-chart">
        <Donut counts={counts} total={items.length} />
        <ul className="legend">
          {counts.map((g) => (
            <li key={g.key} className={open === g.key ? 'on' : ''}>
              <button className="legend-row" onClick={() => setOpen(open === g.key ? null : g.key)} aria-pressed={open === g.key}>
                <i className={g.cls} /><span>{g.label}</span><b>{g.n}</b>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {note && <p className="dash-note">{note}</p>}
      {open && (
        <>
          <div className="filter-note">Showing: {GROUPS.find((g) => g.key === open)!.label} <button className="link dark" onClick={() => setOpen(null)}>close</button></div>
          {shown.length === 0 ? <p className="dash-note">None.</p> : (
            <table>
              <tbody>
                {shown.map(({ eq, st }) => (
                  <tr key={eq.id} className="clickable" onClick={() => onOpen(eq.id)}>
                    <td><strong>{eq.code}</strong><br /><span className="muted">{eq.name}</span></td>
                    <td><StatusChip status={st} /></td>
                    <td className="muted">{st.blockers[0] ?? st.warnings[0] ?? (st.cleanUntil ? `Clean until ${plantTime(st.cleanUntil)}` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <h3 style={{ margin: '4px 0 0' }}>Cleaning deadlines {due > 0 && <span className="chip chip-warn">{due}</span>}</h3>
      <Deadlines items={items} onOpen={onOpen} />
    </section>
  );
}

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [open, setOpen] = useState<Entry[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const watches = me.roles.includes('admin') || me.roles.includes('qa');

  const loadStatus = async (background = false) => {
    const [s, e] = await Promise.all([
      api<EquipmentStatus[]>('GET', '/api/equipment/status', undefined, background),
      api<Equipment[]>('GET', '/api/equipment', undefined, background),
    ]);
    setStatuses(s);
    setEquipment(e);
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
  const machines = items.filter((i) => i.eq.kind !== 'area');
  const areas = items.filter((i) => i.eq.kind === 'area');
  const frequencyRooms = areas.filter((i) => i.eq.cleaningBasis === 'frequency').length;
  const code = (id: number) => byId.get(id)?.code ?? '';

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
      <h1>Home</h1>
      <p className="greeting">Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {me.fullName.split(' (')[0]}. Here is how the plant stands right now.</p>
      <div className="dash">
        <Part title="Equipment and instruments" items={machines} onOpen={onOpen}
          note="Cleaned after use: within the dirty hold after a use ends; clean for the clean hold after cleaning." />
        <Part title="Areas (rooms)" items={areas} onOpen={onOpen}
          note={`${areas.length - frequencyRooms} operation-based (dirty hold and clean hold, like equipment) · ${frequencyRooms} frequency-based (cleaned on a schedule).`} />
      </div>
      <h2>Open items</h2>
      {open.length === 0 ? (
        <p className="muted">Nothing open: no equipment in use and nothing awaiting verification.</p>
      ) : (
        <table>
          <thead><tr><th>Equipment</th><th>Entry</th><th>Since</th><th>Open because</th></tr></thead>
          <tbody>
            {open.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                <td>{code(e.equipmentId)}</td>
                <td>{TYPE_LABEL[e.logbookType]}{e.batch && ` · batch ${e.batch}`}</td>
                <td>{plantTime(e.activityStart)}</td>
                <td>{e.inProgress ? (e.logbookType === 'maintenance' ? 'Repair not finished' : 'In use (not ended)') : 'Awaiting verification'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
