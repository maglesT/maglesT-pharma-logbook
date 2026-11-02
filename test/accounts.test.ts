import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY, sessionKey } from '../server/auth.js';
import { call, directory, freshApp, login, seedUser, type TestApp } from './helpers.js';

// B1-2 (D-29): people, passwords, lockout and the permission register are Medhanta core's; the Logbook signs people
// on through core (stand-in: helpers.fakeSignOn) and keeps sessions, per-action authority checks and its audit trail.

let t: TestApp;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'admin1', ['admin']);
  await seedUser(t.owner, 'qa1', ['qa']);
});
afterAll(() => t.close());

const auditRows = (action: string, objectId?: number) =>
  objectId === undefined
    ? t.owner`select * from audit_log where action = ${action} order by id`
    : t.owner`select * from audit_log where action = ${action} and object_id = ${String(objectId)} order by id`;
const sid = (cookie: string) => sessionKey(cookie.slice(4));

describe('sign-on through core', () => {
  it('LB-21: API refuses requests without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('PL-01: /login sends the browser to core with PKCE; sign-on opens a session with the roles from core and is audited', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const username = `op${n}`;
    const start = await t.app.inject({ method: 'GET', url: `/login?login_hint=${username}` });
    expect(start.statusCode).toBe(302);
    const { res, cookie } = await login(t.app, username);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect((await call(t.app, cookie, 'GET', '/api/me')).json()).toEqual({ id, username, fullName: username.toUpperCase(), roles: ['operator'] });
    expect(await auditRows('login', id)).toHaveLength(1);
  });

  it('PL-01: the oidc client asks core for a code with PKCE and, for a signature, a fresh password (prompt=login)', async () => {
    const { oidcSignOn } = await import('../server/signon.js');
    const s = oidcSignOn({ issuer: 'https://site.test/oidc', clientId: 'logbook', clientSecret: 'x', redirectUri: 'https://logbook.site.test/cb' });
    const url = new URL(s.authUrl({ state: 'st', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://site.test/oidc/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'logbook', response_type: 'code', code_challenge: 'ch',
      code_challenge_method: 'S256', state: 'st', redirect_uri: 'https://logbook.site.test/cb' });
    expect(new URL(s.authUrl({ state: 'st', challenge: 'ch', prompt: 'login' })).searchParams.get('max_age')).toBe('0');
  });

  it('PL-01: a person without a Logbook role is refused and the refusal is audited', async () => {
    const id = await seedUser(t.owner, uniq('nobody'), []);
    const { res, cookie } = await login(t.app, `nobody${n}`);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('no right to use the Pharma Logbook');
    expect(cookie).toBe('');
    expect(await auditRows('login.failed', id)).toHaveLength(1);
  });

  it('PL-01: roles come from core only; a role stored in the old local table gives no right', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    await t.owner`insert into user_roles (user_id, role) values (${id}, 'admin')`;
    const { cookie } = await login(t.app, `op${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().roles).toEqual(['operator']);
  });

  it('PL-01: a sign-in this browser did not start is refused (no login CSRF)', async () => {
    const made = await t.app.inject({ method: 'GET', url: '/cb?code=admin1&state=made-up' });
    expect(made.statusCode).toBe(400);
    // Someone else's started sign-in, sent to this browser (which holds no matching sign-in cookie).
    const theirs = await t.app.inject({ method: 'GET', url: '/login?login_hint=admin1' });
    const res = await t.app.inject({ method: 'GET', url: String(theirs.headers.location) });
    expect(res.statusCode).toBe(400);
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
  });

  it(`PL-01: a revoked role or a deactivated person is out within ${POLICY.roleCheckMinutes} minutes (renewal through core)`, async () => {
    await seedUser(t.owner, uniq('sup'), ['supervisor', 'operator']);
    const username = `sup${n}`;
    const { cookie } = await login(t.app, username);
    directory.get(username)!.roles = ['operator'];
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().roles).toEqual(['operator', 'supervisor']);
    await t.owner`update sessions set checked_at = now() - interval '6 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().roles).toEqual(['operator']);

    directory.get(username)!.active = false;
    await t.owner`update sessions set checked_at = now() - interval '6 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect(await t.owner`select 1 from sessions where id = ${sid(cookie)}`).toHaveLength(0);
  });

  it('PL-01: a login that cannot be mapped to the Logbook (taken by a local account not yet moved) is refused', async () => {
    await t.owner`insert into users (username, full_name, password_hash) values ('oldie', 'Old Local', '-')`;
    directory.set('oldie', { sub: crypto.randomUUID(), name: 'Old Local', roles: ['operator'], active: true });
    const { res, cookie } = await login(t.app, 'oldie');
    expect(res.statusCode).toBe(403);
    expect(cookie).toBe('');
  });

  it('PL-05: /sign asks core for the signed-in person\'s password again and hands the sign window a signing proof', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    expect((await t.app.inject({ method: 'GET', url: '/sign?meanings=performed' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/sign?meanings=anything', headers: { cookie } })).statusCode).toBe(400);
    const start = await t.app.inject({ method: 'GET', url: '/sign?meanings=performed,voice_confirmed', headers: { cookie } });
    expect(start.statusCode).toBe(302);
    expect(new URL(String(start.headers.location), 'http://x').searchParams.get('code')).toBe(`op${n}`);   // login_hint: this person
    const pending = start.cookies.find((c) => c.name === 'signon')!;
    expect(pending.value).toMatch(/\.sign\.\d+\.performed,voice_confirmed$/);
    const page = await t.app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie: `signon=${pending.value}` } });
    expect(page.body).toMatch(/"signProof":"[^"]+"/);
    expect(page.body).toContain('location.origin');   // posted only to the Logbook's own window
    expect(page.cookies.find((c) => c.name === 'sid')).toBeUndefined();   // a signature never opens a session
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('PL-05: a signature is refused when core did not ask for the password again after it started (auth_time)', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    const start = await t.app.inject({ method: 'GET', url: '/sign?meanings=performed', headers: { cookie } });
    const pending = start.cookies.find((c) => c.name === 'signon')!;
    // As if core answered from its existing session: the password was last entered before this signature started.
    const old = pending.value.replace(/\.sign\.\d+\./, `.sign.${Date.now() + 60_000}.`);
    const page = await t.app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie: `signon=${old}` } });
    expect(page.body).toContain('Your password was not asked for again');
    expect(page.body).not.toContain('signProof');
  });

  it(`LB-21: session expires after ${POLICY.sessionIdleMinutes} idle minutes`, async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    await t.owner`update sessions set last_seen_at = now() - interval '16 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('PL-01: logout ends the session and sends the browser to end the core session too', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    const out = await call(t.app, cookie, 'POST', '/api/logout');
    expect(out.json().logoutUrl).toBe(`/?signed-out=id-op${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('writes without a JSON body type are refused', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(415);
  });

  it('LB-21: session ids are stored only as hashes', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    const raw = cookie.slice(4);
    expect(await t.owner`select 1 from sessions where id = ${raw}`).toHaveLength(0);
    expect(await t.owner`select 1 from sessions where id = ${sessionKey(raw)}`).toHaveLength(1);
  });

  it('LB-21: background polling does not keep an idle session alive', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa']);
    const { cookie } = await login(t.app, `qa${n}`);
    await t.owner`update sessions set last_seen_at = now() - interval '14 minutes' where id = ${sid(cookie)}`;
    const bg = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie, 'x-background-poll': '1' } });
    expect(bg.statusCode).toBe(200);
    const [row] = await t.owner`select now() - last_seen_at > interval '13 minutes' as stale from sessions where id = ${sid(cookie)}`;
    expect(row!.stale).toBe(true);
  });
});

describe('user ids and audit trail', () => {
  it('LB-20: the application database role cannot rename a user or delete one', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    await expect(t.sql`update users set username = 'renamed' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`update users set employee_id = gen_random_uuid() where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from users where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('LB-20: the API never returns password hashes and the audit trail never contains them', async () => {
    const admin = await login(t.app, 'admin1');
    expect((await call(t.app, admin.cookie, 'GET', '/api/me')).body).not.toContain('scrypt$');
    const rows = await t.owner`select 1 from audit_log where concat(old_value::text, new_value::text, reason) like '%scrypt$%'`;
    expect(rows).toHaveLength(0);
  });

  it('LB-18: the application cannot change or delete audit rows', async () => {
    await expect(t.sql`update audit_log set action = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from audit_log`).rejects.toThrow(/permission denied/);
  });

  it('LB-18: audit rows carry the actor and a server timestamp', async () => {
    await login(t.app, 'admin1');
    const [row] = await t.owner`select a.*, u.username from audit_log a join users u on u.id = a.actor_id
                                where action = 'login' order by a.id desc limit 1`;
    expect(row!.username).toBe('admin1');
    expect(Math.abs(Date.now() - new Date(row!.at).getTime())).toBeLessThan(60_000);
  });

  it('LB-18: the application cannot choose the audit timestamp', async () => {
    await expect(
      t.sql`insert into audit_log (at, action, object_type) values (now() - interval '1 year', 'x', 'y')`,
    ).rejects.toThrow(/permission denied/);
  });
});
