import { useEffect, useState } from 'react';
import { api, plantTime, TYPE_LABEL, type Alert, type Entry, type Equipment, type Me } from '../api.js';

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [open, setOpen] = useState<Entry[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  useEffect(() => {
    void api<Entry[]>('GET', '/api/entries/open').then(setOpen);
    void api<Equipment[]>('GET', '/api/equipment').then(setEquipment);
  }, []);
  const code = (id: number) => equipment.find((e) => e.id === id)?.code ?? '';
  const watches = me.roles.includes('admin') || me.roles.includes('qa');
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const load = async (background = false) => setAlerts(await api<Alert[]>('GET', '/api/alerts', undefined, background));
  useEffect(() => {
    if (!watches) return;
    void load();
    const timer = setInterval(() => void load(true).catch(() => window.location.reload()), 30_000);
    return () => clearInterval(timer);
  }, [watches]);

  const ack = async (id: number) => {
    await api('POST', `/api/alerts/${id}/ack`);
    await load();
  };

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
                <td>{e.inProgress ? 'In use (not ended)' : 'Awaiting verification'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
