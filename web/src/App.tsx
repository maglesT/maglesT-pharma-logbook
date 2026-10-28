import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.js';
import { Login, ChangePassword } from './pages/Login.js';
import { Home } from './pages/Home.js';
import { Users } from './pages/Users.js';

type Page = 'home' | 'users' | 'password';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');

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
        {page === 'home' && <Home me={me} />}
        {page === 'users' && <Users me={me} />}
        {page === 'password' && <ChangePassword me={me} onDone={() => setPage('home')} />}
      </main>
    </>
  );
}
