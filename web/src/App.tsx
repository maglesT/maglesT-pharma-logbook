import { useCallback, useEffect, useState } from 'react';
import { api, can, ApiError, type Me } from './api.js';
import { Login } from './pages/Login.js';
import { Home } from './pages/Home.js';
import { MasterData } from './pages/MasterData.js';
import { LogbookSettings } from './pages/LogbookSettings.js';
import { EquipmentPage } from './pages/EquipmentPage.js';
import { Review } from './pages/Review.js';
import { Breakdowns } from './pages/Breakdowns.js';

type Page = 'home' | 'masterdata' | 'settings' | 'equipment' | 'review' | 'breakdowns';

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
          {(can(me, 'review.read') || can(me, 'audit.read')) && (
            <button className={page === 'review' ? 'tab on' : 'tab'} onClick={() => setPage('review')}>{can(me, 'review.read') ? 'Review' : 'Audit trail'}</button>
          )}
          <button className={page === 'masterdata' ? 'tab on' : 'tab'} onClick={() => setPage('masterdata')}>Master data</button>
          {(can(me, 'settings.draft') || can(me, 'settings.approve')) && (
            <button className={page === 'settings' ? 'tab on' : 'tab'} onClick={() => setPage('settings')}>Logbook settings</button>
          )}
        </nav>
        <span className="who">
          {me.fullName}
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        {page === 'home' && <Home me={me} onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />}
        {page === 'equipment' && <EquipmentPage me={me} openId={openId} />}
        {page === 'review' && <Review me={me} />}
        {page === 'breakdowns' && <Breakdowns onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />}
        {page === 'masterdata' && <MasterData me={me} />}
        {page === 'settings' && <LogbookSettings me={me} />}
      </main>
    </>
  );
}
