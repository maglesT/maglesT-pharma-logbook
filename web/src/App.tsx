import { useEffect, useState } from 'react';

interface Health {
  status: string;
  version: string;
  db: string;
  serverTime?: string;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  return (
    <main className="page">
      <h1>Pharma Logbook</h1>
      {error && <p className="chip chip-bad">Server unreachable</p>}
      {health && (
        <p className={`chip ${health.db === 'ok' ? 'chip-ok' : 'chip-bad'}`}>
          Version {health.version} · database {health.db}
        </p>
      )}
    </main>
  );
}
