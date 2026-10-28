import { useEffect, useState } from 'react';
import { api, plantTime, type Alert, type Me } from '../api.js';

export function Home({ me }: { me: Me }) {
  const watches = me.roles.includes('admin') || me.roles.includes('qa');
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const load = async () => setAlerts(await api<Alert[]>('GET', '/api/alerts'));
  useEffect(() => {
    if (!watches) return;
    void load();
    const timer = setInterval(load, 30_000);
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
      <p>Logbooks arrive in the next slices. Blocked equipment and entries awaiting verification will be listed here.</p>
    </>
  );
}
