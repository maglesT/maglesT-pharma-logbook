import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from './db.js';

export const ROLES = ['operator', 'supervisor', 'engineering', 'qa', 'admin'] as const;
export type Role = (typeof ROLES)[number];

// Product defaults (register LB-21); not regulatory numbers.
export const POLICY = {
  sessionIdleMinutes: 15,
  maxFailedAttempts: 5,
  passwordMaxAgeDays: 90,
};

export const SESSION_COOKIE = 'sid';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
  passwordChangeRequired: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

// Loads the session, enforces the idle timeout and refreshes last_seen_at.
export async function loadSession(sql: Sql, sessionId: string): Promise<SessionUser | null> {
  const [row] = await sql<
    { id: number; username: string; full_name: string; roles: Role[]; change: boolean }[]
  >`
    update sessions s set last_seen_at = now()
    from users u
    where s.id = ${sessionId} and u.id = s.user_id and u.active and u.locked_at is null
      and s.last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning u.id::int as id, u.username, u.full_name,
      coalesce((select array_agg(role order by role) from user_roles r where r.user_id = u.id), '{}') as roles,
      (u.must_change_password
        or u.password_changed_at < now() - make_interval(days => ${POLICY.passwordMaxAgeDays})) as change`;
  if (!row) {
    await sql`delete from sessions where id = ${sessionId}`;
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    roles: row.roles,
    passwordChangeRequired: row.change,
    sessionId,
  };
}

// Paths a user with an expired or temporary password may still call.
const PASSWORD_CHANGE_PATHS = new Set(['/api/me', '/api/me/password', '/api/logout']);

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = req.user;
  if (!user) {
    void reply.code(401).send({ error: 'not_logged_in' });
    return null;
  }
  if (user.passwordChangeRequired && !PASSWORD_CHANGE_PATHS.has(req.routeOptions.url ?? '')) {
    void reply.code(403).send({ error: 'password_change_required' });
    return null;
  }
  return user;
}

// LB-21: authority check per action, on the server.
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    if (roles.length && !roles.some((r) => user.roles.includes(r))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
