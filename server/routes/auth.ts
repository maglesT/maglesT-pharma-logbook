import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { recordFailure } from '../lockout.js';
import { audit } from '../audit.js';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords.js';
import { SESSION_COOKIE, newSessionId, requireRole, sessionKey } from '../auth.js';

const loginBody = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });
const passwordBody = z.object({ current: z.string().min(1).max(200), new: z.string().min(1).max(200) });

// Compared against when the user does not exist, so response time does not reveal valid user IDs.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export function authRoutes(app: FastifyInstance, sql: Sql) {
  app.post('/api/login', async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const username = body.data.username.trim().toLowerCase();

    const outcome = await sql.begin(async (tx) => {
      const [u] = await tx<
        { id: number; password_hash: string; active: boolean; locked: boolean; failed: number; temp_expired: boolean }[]
      >`
        select id::int, password_hash, active, locked_at is not null as locked, failed_attempts as failed,
          (must_change_password and temp_password_expires_at < now()) as temp_expired
        from users where username = ${username} for update`;
      const passwordOk = await verifyPassword(body.data.password, u?.password_hash ?? DUMMY_HASH);
      if (!u) {
        await audit(tx, { actorId: null, action: 'login.failed', objectType: 'user', objectId: username, reason: 'unknown user' });
        return { ok: false as const };
      }
      if (!u.active || u.locked || !passwordOk || u.temp_expired) {
        const why = !u.active ? 'inactive' : u.locked ? 'locked' : !passwordOk ? 'wrong password' : 'temporary password expired';
        await audit(tx, { actorId: null, action: 'login.failed', objectType: 'user', objectId: u.id, reason: why });
        if (u.active && !u.locked && !passwordOk) await recordFailure(tx, u.id, username, u.failed);
        return { ok: false as const };
      }
      const sessionId = newSessionId();
      await tx`update users set failed_attempts = 0, last_login_at = now() where id = ${u.id}`;
      await tx`insert into sessions (id, user_id) values (${sessionKey(sessionId)}, ${u.id})`;
      await audit(tx, { actorId: u.id, action: 'login', objectType: 'user', objectId: u.id });
      return { ok: true as const, sessionId };
    });

    // One message for every failure, so the response does not reveal which part was wrong.
    if (!outcome.ok) return reply.code(401).send({ error: 'login_failed' });
    void reply.setCookie(SESSION_COOKIE, outcome.sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: app.cookieSecure,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.user) {
      await sql.begin(async (tx) => {
        await tx`delete from sessions where id = ${sessionKey(req.user!.sessionId)}`;
        await audit(tx, { actorId: req.user!.id, action: 'logout', objectType: 'user', objectId: req.user!.id });
      });
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireRole() }, async (req) => {
    const u = req.user!;
    return { id: u.id, username: u.username, fullName: u.fullName, roles: u.roles, passwordChangeRequired: u.passwordChangeRequired };
  });

  app.post('/api/me/password', { preHandler: requireRole() }, async (req, reply) => {
    const body = passwordBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const u = req.user!;
    const problem = passwordProblem(body.data.new, u.username);
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });
    if (body.data.new === body.data.current) {
      return reply.code(400).send({ error: 'weak_password', message: 'The new password must differ from the current one.' });
    }
    const hash = await hashPassword(body.data.new);
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<{ password_hash: string; failed: number; was_temporary: boolean }[]>`
        select password_hash, failed_attempts as failed, must_change_password as was_temporary
        from users where id = ${u.id} for update`;
      if (!row || !(await verifyPassword(body.data.current, row.password_hash))) {
        // A wrong current password counts towards lockout like a failed login (review finding 3).
        await audit(tx, { actorId: u.id, action: 'password.change_failed', objectType: 'user', objectId: u.id, reason: 'wrong current password' });
        if (row) await recordFailure(tx, u.id, u.username, row.failed);
        return 'wrong_password' as const;
      }
      await tx`update users set password_hash = ${hash}, must_change_password = false, password_changed_at = now(),
                 temp_password_expires_at = null, failed_attempts = 0
               where id = ${u.id}`;
      // A changed password ends the user's other sessions.
      await tx`delete from sessions where user_id = ${u.id} and id <> ${sessionKey(u.sessionId)}`;
      // Never log the password itself. Marking a change from a temporary password makes an
      // admin-issued password visible in the audit trail when it is turned into a personal one.
      await audit(tx, { actorId: u.id, action: 'password.changed', objectType: 'user', objectId: u.id,
        new: { fromTemporaryPassword: row.was_temporary } });
      return 'ok' as const;
    });
    if (result === 'wrong_password') return reply.code(400).send({ error: 'wrong_password' });
    return { ok: true };
  });
}
