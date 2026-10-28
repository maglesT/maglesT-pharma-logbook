import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POLICY, sessionKey } from '../server/auth.js';
import { call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
let adminCookie: string;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'admin1', ['admin']);
  await seedUser(t.owner, 'qa1', ['qa']);
});
beforeEach(async () => {
  adminCookie = (await login(t.app, 'admin1')).cookie;
});
afterAll(() => t.close());

const auditRows = (action: string, objectId?: number) =>
  objectId === undefined
    ? t.owner`select * from audit_log where action = ${action} order by id`
    : t.owner`select * from audit_log where action = ${action} and object_id = ${String(objectId)} order by id`;

describe('login and sessions', () => {
  it('LB-21: API refuses requests without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('LB-21: login with correct credentials opens a session and is audited', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const username = `op${n}`;
    const { res, cookie } = await login(t.app, username);
    expect(res.statusCode).toBe(200);
    const me = await call(t.app, cookie, 'GET', '/api/me');
    expect(me.json()).toMatchObject({ username, roles: ['operator'], passwordChangeRequired: false });
    expect(await auditRows('login', id)).toHaveLength(1);
  });

  it('LB-21: wrong password and unknown user give the same error and are audited', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const wrong = await login(t.app, `op${n}`, 'not-the-password');
    const unknown = await login(t.app, 'nobody-here', 'whatever-123');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.json()).toEqual(unknown.res.json());
    expect(await auditRows('login.failed', id)).toHaveLength(1);
  });

  it(`LB-21: session expires after ${POLICY.sessionIdleMinutes} idle minutes`, async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    const sid = sessionKey(cookie.slice(4));
    await t.owner`update sessions set last_seen_at = now() - interval '16 minutes' where id = ${sid}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('LB-21: logout ends the session', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    await call(t.app, cookie, 'POST', '/api/logout');
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('writes without a JSON body type are refused', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'username=a&password=b',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('lockout and misuse alert', () => {
  it(`LB-21: ${POLICY.maxFailedAttempts} failed logins lock the account, raise an alert for Admin and QA, and are audited`, async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const username = `op${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    // Even the right password no longer works.
    expect((await login(t.app, username)).res.statusCode).toBe(401);
    expect(await auditRows('user.locked', id)).toHaveLength(1);

    for (const who of ['admin1', 'qa1']) {
      const { cookie } = await login(t.app, who);
      const alerts = (await call(t.app, cookie, 'GET', '/api/alerts')).json();
      expect(alerts.some((a: { message: string }) => a.message.includes(username))).toBe(true);
    }
  });

  it('LB-21: operators cannot see misuse alerts; acknowledging one is audited', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const username = `op${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    await seedUser(t.owner, uniq('op'), ['operator']);
    const op = await login(t.app, `op${n}`);
    expect((await call(t.app, op.cookie, 'GET', '/api/alerts')).statusCode).toBe(403);

    const qa = await login(t.app, 'qa1');
    const alert = (await call(t.app, qa.cookie, 'GET', '/api/alerts')).json().find((a: { message: string }) => a.message.includes(username));
    expect((await call(t.app, qa.cookie, 'POST', `/api/alerts/${alert.id}/ack`)).statusCode).toBe(200);
    expect(await auditRows('alert.acknowledged', alert.id)).toHaveLength(1);
  });

  it('LB-21: a password reset by Admin unlocks the account with a temporary password', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const username = `op${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    const reset = await call(t.app, adminCookie, 'POST', `/api/users/${id}/reset-password`, { reason: 'user locked out' });
    const temp = reset.json().temporaryPassword;
    const { res, cookie } = await login(t.app, username, temp);
    expect(res.statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(true);
    expect(await auditRows('user.password_reset', id)).toHaveLength(1);
  });
});

describe('passwords', () => {
  it('LB-20: a temporary password must be changed before anything else is allowed', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'New User', roles: ['operator'] });
    const { username } = created.json().user;
    const temp = created.json().temporaryPassword;
    const { cookie } = await login(t.app, username, temp);
    expect((await call(t.app, cookie, 'GET', '/api/alerts')).json()).toEqual({ error: 'password_change_required' });

    const weak = await call(t.app, cookie, 'POST', '/api/me/password', { current: temp, new: 'short' });
    expect(weak.statusCode).toBe(400);
    const ok = await call(t.app, cookie, 'POST', '/api/me/password', { current: temp, new: 'A-much-better-pw-1' });
    expect(ok.statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(false);
  });

  it(`LB-21: a password older than ${POLICY.passwordMaxAgeDays} days must be changed (11.300(b))`, async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    await t.owner`update users set password_changed_at = now() - interval '91 days' where id = ${id}`;
    const { cookie } = await login(t.app, `op${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(true);
  });

  it('LB-20: the API never returns password hashes', async () => {
    const res = await call(t.app, adminCookie, 'GET', '/api/users');
    expect(res.body).not.toContain('scrypt$');
    expect(res.body).not.toContain('password');
  });

  it('LB-20: the audit trail never contains passwords', async () => {
    // Look for password values and hashes, not the word "password" (field names may contain it).
    const rows = await t.owner`select * from audit_log
      where concat(old_value::text, new_value::text, reason) like '%scrypt$%'
         or concat(old_value::text, new_value::text, reason) like '%Correct-Horse-9%'
         or concat(old_value::text, new_value::text, reason) like '%A-much-better-pw-1%'`;
    expect(rows).toHaveLength(0);
  });
});

describe('user administration', () => {
  it('LB-21: only Admin can list and create users', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa', 'supervisor']);
    const { cookie } = await login(t.app, `qa${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await call(t.app, cookie, 'POST', '/api/users', { username: 'x-user', fullName: 'X', roles: ['qa'] })).statusCode).toBe(403);
  });

  it('LB-21: creating a user and changing roles are audited with old and new values and a reason', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Asha Rao', roles: ['operator'] });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;
    expect(await auditRows('user.created', id)).toHaveLength(1);

    const res = await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { roles: ['operator', 'supervisor'], reason: 'promoted' });
    expect(res.json().roles).toEqual(['operator', 'supervisor']);
    const [row] = await auditRows('user.updated', id);
    expect(row!.old_value.roles).toEqual(['operator']);
    expect(row!.new_value.roles).toEqual(['operator', 'supervisor']);
    expect(row!.reason).toBe('promoted');
  });

  it('LB-21: changes to users need a reason', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'No Reason', roles: ['operator'] });
    const res = await call(t.app, adminCookie, 'PATCH', `/api/users/${created.json().user.id}`, { fullName: 'Changed' });
    expect(res.statusCode).toBe(400);
  });

  it('LB-21: a deactivated user cannot log in and loses open sessions', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { active: false, reason: 'left the company' });
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await login(t.app, `op${n}`)).res.statusCode).toBe(401);
  });

  it('LB-20: a user ID is never reused, even after the user is deactivated', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { active: false, reason: 'left' });
    const again = await call(t.app, adminCookie, 'POST', '/api/users', { username: `op${n}`, fullName: 'Someone Else', roles: ['operator'] });
    expect(again.statusCode).toBe(409);
  });

  it('LB-20: the application database role cannot rename a user or delete one', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    await expect(t.sql`update users set username = 'renamed' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from users where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('Admin cannot remove their own admin role or deactivate themselves', async () => {
    const me = (await call(t.app, adminCookie, 'GET', '/api/me')).json();
    const res = await call(t.app, adminCookie, 'PATCH', `/api/users/${me.id}`, { active: false, reason: 'oops' });
    expect(res.statusCode).toBe(400);
  });
});

describe('audit trail', () => {
  it('LB-18: the application cannot change or delete audit rows', async () => {
    await expect(t.sql`update audit_log set action = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from audit_log`).rejects.toThrow(/permission denied/);
  });

  it('LB-18: audit rows carry the actor and a server timestamp', async () => {
    await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Audit Check', roles: ['qa'] });
    const [row] = await t.owner`select a.*, u.username from audit_log a join users u on u.id = a.actor_id
                                where action = 'user.created' order by a.id desc limit 1`;
    expect(row!.username).toBe('admin1');
    expect(Math.abs(Date.now() - new Date(row!.at).getTime())).toBeLessThan(60_000);
  });
});

describe('review fixes (S1)', () => {
  const background = (cookie: string) =>
    t.app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie, 'x-background-poll': '1' } });

  it('LB-21: background alert polling does not keep an idle session alive', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa']);
    const { cookie } = await login(t.app, `qa${n}`);
    const sid = sessionKey(cookie.slice(4));
    await t.owner`update sessions set last_seen_at = now() - interval '14 minutes' where id = ${sid}`;
    expect((await background(cookie)).statusCode).toBe(200);
    const [row] = await t.owner`select now() - last_seen_at > interval '13 minutes' as stale from sessions where id = ${sid}`;
    expect(row!.stale).toBe(true);
  });

  it('LB-21: a wrong current password on password change counts towards lockout and is audited', async () => {
    const id = await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) {
      await call(t.app, cookie, 'POST', '/api/me/password', { current: 'wrong-guess-123', new: 'Another-good-pw-9' });
    }
    expect(await auditRows('password.change_failed', id)).toHaveLength(POLICY.maxFailedAttempts);
    expect(await auditRows('user.locked', id)).toHaveLength(1);
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('LB-21: changing the password ends the user\'s other sessions', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const first = await login(t.app, `op${n}`);
    const second = await login(t.app, `op${n}`);
    await call(t.app, second.cookie, 'POST', '/api/me/password', { current: 'Correct-Horse-9', new: 'Fresh-secret-pw-7' });
    expect((await call(t.app, first.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(t.app, second.cookie, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('LB-20: a temporary password expires after 24 hours', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Late Starter', roles: ['operator'] });
    const { id, username } = created.json().user;
    await t.owner`update users set temp_password_expires_at = now() - interval '1 minute' where id = ${id}`;
    expect((await login(t.app, username, created.json().temporaryPassword)).res.statusCode).toBe(401);
  });

  it('LB-20: turning a temporary password into a personal one is marked in the audit trail', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'First Login', roles: ['operator'] });
    const { cookie } = await login(t.app, created.json().user.username, created.json().temporaryPassword);
    await call(t.app, cookie, 'POST', '/api/me/password', { current: created.json().temporaryPassword, new: 'My-own-secret-42' });
    const [row] = await auditRows('password.changed', created.json().user.id);
    expect(row!.new_value).toEqual({ fromTemporaryPassword: true });
  });

  it('LB-18: the application cannot choose the audit timestamp', async () => {
    await expect(
      t.sql`insert into audit_log (at, action, object_type) values (now() - interval '1 year', 'x', 'y')`,
    ).rejects.toThrow(/permission denied/);
  });

  it('LB-21: session ids are stored only as hashes', async () => {
    await seedUser(t.owner, uniq('op'), ['operator']);
    const { cookie } = await login(t.app, `op${n}`);
    const raw = cookie.slice(4);
    expect(await t.owner`select 1 from sessions where id = ${raw}`).toHaveLength(0);
    expect(await t.owner`select 1 from sessions where id = ${sessionKey(raw)}`).toHaveLength(1);
  });

  it('non-numeric ids are rejected with 400', async () => {
    const res = await call(t.app, adminCookie, 'PATCH', '/api/users/abc', { fullName: 'x', reason: 'y' });
    expect(res.statusCode).toBe(400);
  });
});
