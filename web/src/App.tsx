import { useCallback, useEffect, useState } from 'react';
import { api, can, ApiError, DUE_LABEL, type Equipment, type EquipmentStatus, type Me } from './api.js';
import { Login } from './pages/Login.js';
import { Home } from './pages/Home.js';
import { MasterData } from './pages/MasterData.js';
import { LogbookSettings } from './pages/LogbookSettings.js';
import { EquipmentPage } from './pages/EquipmentPage.js';
import { Breakdowns } from './pages/Breakdowns.js';

type Page = 'home' | 'masterdata' | 'settings' | 'equipment' | 'breakdowns';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');
  const [openId, setOpenId] = useState<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/api/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (me === undefined) return <main className="page">Loading…</main>;
  if (me === null) return <Login />;

  // Ends the core session too (shared terminals): the browser goes to core's sign-out page.
  const logout = async () => {
    const r = await api<{ logoutUrl: string | null }>('POST', '/api/logout');
    setMe(null);
    if (r.logoutUrl) window.location.assign(r.logoutUrl);
  };

  return (
    <>
      <header className="bar">
        <span className="brand"><img src="/medhanta-mark.png" alt="Medhanta" /><span><b>Pharma Logbook</b><small>by Medhanta</small></span></span>
        <nav>
          <button className={page === 'home' ? 'tab on' : 'tab'} onClick={() => setPage('home')}>Home</button>
          <button className={page === 'equipment' ? 'tab on' : 'tab'} onClick={() => { setOpenId(undefined); setPage('equipment'); }}>Logbooks</button>
          <button className={page === 'breakdowns' ? 'tab on' : 'tab'} onClick={() => setPage('breakdowns')}>Breakdowns</button>
          <button className={page === 'masterdata' ? 'tab on' : 'tab'} onClick={() => setPage('masterdata')}>Master data</button>
          {(can(me, 'settings.draft') || can(me, 'settings.approve')) && (
            <button className={page === 'settings' ? 'tab on' : 'tab'} onClick={() => setPage('settings')}>Logbook settings</button>
          )}
        </nav>
        <ScanBox onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />
        <span className="who">
          {me.fullName}
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <PendingBanner onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />
      <main className="page">
        {page === 'home' && <Home me={me} onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />}
        {page === 'equipment' && <EquipmentPage me={me} openId={openId} />}
        {page === 'breakdowns' && <Breakdowns onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />}
        {page === 'masterdata' && <MasterData me={me} />}
        {page === 'settings' && <LogbookSettings me={me} />}
      </main>
    </>
  );
}

// Owner 2026-11-12 (slide 4): a barcode scanner types the item's ID and presses Enter; the item opens with its check
// before use. The ID can also be typed.
function ScanBox({ onOpen }: { onOpen: (id: number) => void }) {
  const [code, setCode] = useState('');
  const [miss, setMiss] = useState(false);
  const go = async () => {
    const want = code.trim().toLowerCase();
    if (!want) return;
    const items = await api<Equipment[]>('GET', '/api/equipment');
    const hit = items.find((i) => i.code.toLowerCase() === want);
    setMiss(!hit);
    if (hit) { onOpen(hit.id); setCode(''); }
  };
  return (
    <form className="scan" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <input value={code} onChange={(e) => { setCode(e.target.value); setMiss(false); }} placeholder="Scan or type ID" aria-label="Scan or type the item ID" />
      {miss && <span className="error" role="alert">Not in the Logbook</span>}
    </form>
  );
}

// Owner 2026-11-12 (point 8): everything pending, shown as soon as someone signs in: PM, calibration and requalification
// overdue or due within 15 days (due date - 15 days), and cleanings overdue. Hidden for the session on request.
function PendingBanner({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<{ id: number; text: string; overdue: boolean; sort: string }[]>([]);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem('pending-hidden') === '1'; } catch { return false; } });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void Promise.all([api<EquipmentStatus[]>('GET', '/api/equipment/status', undefined, true), api<Equipment[]>('GET', '/api/equipment', undefined, true)])
      .then(([statuses, items]) => {
        const byId = new Map(items.filter((i) => i.active).map((i) => [i.id, i]));
        setRows(statuses.flatMap((s) => {
          const eq = byId.get(s.equipmentId);
          if (!eq) return [];
          const out = s.dues.filter((d) => d.overdue || d.soon).map((d) => ({ id: eq.id, overdue: d.overdue, sort: d.due,
            text: `${eq.code} · ${DUE_LABEL[d.kind]} ${d.overdue ? 'overdue since' : 'due'} ${d.due}` }));
          if (s.deadline?.overdue) out.push({ id: eq.id, overdue: true, sort: s.deadline.at.slice(0, 10),
            text: `${eq.code} · ${s.deadline.kind === 'frequency' ? 'Scheduled cleaning' : s.deadline.kind === 'dirty_hold' ? 'Cleaning (dirty hold)' : 'Cleaning (clean hold)'} overdue` });
          return out;
        }).sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.sort.localeCompare(b.sort)));
      }).catch(() => {});
  }, []);
  if (hidden || rows.length === 0) return null;
  const overdue = rows.filter((r) => r.overdue).length;
  return (
    <div className={overdue ? 'pending-banner' : 'pending-banner soon'} role="alert">
      <div className="pb-head">
        <strong>⚠ Pending activities: {overdue > 0 && `${overdue} overdue`}{overdue > 0 && rows.length > overdue && ', '}{rows.length > overdue && `${rows.length - overdue} due within 15 days`}</strong>
        <button className="link dark" onClick={() => setOpen(!open)}>{open ? 'Hide the list' : 'Show the list'}</button>
        <button className="link" onClick={() => { setHidden(true); try { sessionStorage.setItem('pending-hidden', '1'); } catch { /* private window */ } }}>Dismiss for this session</button>
      </div>
      {open && (
        <ul>
          {rows.map((r, i) => <li key={i} className={r.overdue ? 'overdue' : ''}><button className="link dark" onClick={() => onOpen(r.id)}>{r.text}</button></li>)}
        </ul>
      )}
    </div>
  );
}
