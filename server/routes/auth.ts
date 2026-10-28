import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords.js';
import { POLICY, SESSION_COOKIE, newSessionId, requireRole } from '../auth.js';

const loginBody = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });
const passwordBody = z.object({ current: z.string().min(1), new: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, sql: Sql) {
  app.post('/api/login', async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const username = body.data.username.trim().toLowerCase();

    const outcome = await sql.begin(async (tx) => {
      const [u] = await tx<{ id: number; password_hash: string; active: boolean; locked: boolean; failed: number }[]>`
        select id::int, password_hash, active, locked_at is not null as locked, failed_attempts as failed
        from users where username = ${username} for update`;
      if (!u) {
        await audit(tx, { actorId: null, action: 'login.failed', objectType: 'user', objectId: username, reason: 'unknown user' });
        return { ok: false as const };
      }
      const passwordOk = await verifyPassword(body.data.password, u.password_hash);
      if (!u.active || u.locked || !passwordOk) {
        const why = !u.active ? 'inactive' : u.locked ? 'locked' : 'wrong password';
        await audit(tx, { actorId: null, action: 'login.failed', objectType: 'user', objectId: u.id, reason: why });
        if (u.active && !u.locked && !passwordOk) {
          const failed = u.failed + 1;
          if (failed >= POLICY.maxFailedAttempts) {
            // LB-21 / P11 11.300(d): lock and raise an immediate on-screen alert to Admin and QA.
            await tx`update users set failed_attempts = ${failed}, locked_at = now() where id = ${u.id}`;
            await tx`insert into alerts (kind, user_id, message)
              values ('account_locked', ${u.id}, ${`Account ${username} locked after ${failed} failed login attempts.`})`;
            await audit(tx, { actorId: null, action: 'user.locked', objectType: 'user', objectId: u.id, new: { failedAttempts: failed } });
          } else {
            await tx`update users set failed_attempts = ${failed} where id = ${u.id}`;
          }
        }
        return { ok: false as const };
      }
      const sessionId = newSessionId();
      await tx`update users set failed_attempts = 0, last_login_at = now() where id = ${u.id}`;
      await tx`insert into sessions (id, user_id) values (${sessionId}, ${u.id})`;
      await audit(tx, { actorId: u.id, action: 'login', objectType: 'user', objectId: u.id });
      return { ok: true as const, sessionId };
    });

    // One message for every failure, so the response does not reveal which part was wrong.
    if (!outcome.ok) return reply.code(401).send({ error: 'login_failed' });
    void reply.setCookie(SESSION_COOKIE, outcome.sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
    });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.user) {
      await sql.begin(async (tx) => {
        await tx`delete from sessions where id = ${req.user!.sessionId}`;
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
    const [row] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${u.id}`;
    if (!row || !(await verifyPassword(body.data.current, row.password_hash))) {
      return reply.code(400).send({ error: 'wrong_password' });
    }
    const hash = await hashPassword(body.data.new);
    await sql.begin(async (tx) => {
      await tx`update users set password_hash = ${hash}, must_change_password = false, password_changed_at = now()
               where id = ${u.id}`;
      // Never log the password itself; only the event.
      await audit(tx, { actorId: u.id, action: 'password.changed', objectType: 'user', objectId: u.id });
    });
    return { ok: true };
  });
}
