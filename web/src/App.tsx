import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.js';
import { Login, ChangePassword } from './pages/Login.js';
import { Home } from './pages/Home.js';
import { Users } from './pages/Users.js';
import { MasterData } from './pages/MasterData.js';
import { LogbookSettings } from './pages/LogbookSettings.js';
import { EquipmentPage } from './pages/EquipmentPage.js';
import { Review } from './pages/Review.js';

type Page = 'home' | 'users' | 'password' | 'masterdata' | 'settings' | 'equipment' | 'review';

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
  if (me === null) return <Login onLoggedIn={refresh} />;
  if (me.passwordChangeRequired) return <ChangePassword me={me} forced onDone={refresh} />;

  const logout = async () => {
    await api('POST', '/api/logout');
    setMe(null);
  };

  return (
    <>
      <header className="bar">
        <strong>Pharma Logbook</strong>
        <nav>
          <button className={page === 'home' ? 'tab on' : 'tab'} onClick={() => setPage('home')}>Home</button>
          <button className={page === 'equipment' ? 'tab on' : 'tab'} onClick={() => { setOpenId(undefined); setPage('equipment'); }}>Logbooks</button>
          {me.roles.some((r) => r === 'qa' || r === 'supervisor' || r === 'admin') && (
            <button className={page === 'review' ? 'tab on' : 'tab'} onClick={() => setPage('review')}>{me.roles.some((r) => r === 'qa' || r === 'supervisor') ? 'Review' : 'Audit trail'}</button>
          )}
          <button className={page === 'masterdata' ? 'tab on' : 'tab'} onClick={() => setPage('masterdata')}>Master data</button>
          {(me.roles.includes('admin') || me.roles.includes('qa')) && (
            <button className={page === 'settings' ? 'tab on' : 'tab'} onClick={() => setPage('settings')}>Logbook settings</button>
          )}
          {me.roles.includes('admin') && (
            <button className={page === 'users' ? 'tab on' : 'tab'} onClick={() => setPage('users')}>Users</button>
          )}
        </nav>
        <span className="who">
          {me.fullName}
          <button className="link" onClick={() => setPage('password')}>Change password</button>
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        {page === 'home' && <Home me={me} onOpen={(id) => { setOpenId(id); setPage('equipment'); }} />}
        {page === 'equipment' && <EquipmentPage me={me} openId={openId} />}
        {page === 'review' && <Review me={me} />}
        {page === 'users' && <Users me={me} />}
        {page === 'masterdata' && <MasterData me={me} />}
        {page === 'settings' && <LogbookSettings me={me} />}
        {page === 'password' && <ChangePassword me={me} onDone={() => setPage('home')} />}
      </main>
    </>
  );
}
