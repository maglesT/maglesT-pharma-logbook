import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from './db.js';

export const ROLES = ['operator', 'supervisor', 'engineering', 'qa', 'admin'] as const;
export type Role = (typeof ROLES)[number];

// Product defaults (register LB-21); not regulatory numbers.
export const POLICY = {
  sessionIdleMinutes: 15,
  maxFailedAttempts: 5,
  passwordMaxAgeDays: 90,
  temporaryPasswordHours: 24,
};

// Background polls send this header; they must not keep an idle session alive.
export const BACKGROUND_HEADER = 'x-background-poll';

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

// Only a hash of the session id is stored, so reading the table does not reveal live sessions.
export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url');
}

// Strict positive integer for :id route parameters.
export function parseId(raw: string): number | null {
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
}

// Loads the session and enforces the idle timeout; user-initiated requests refresh last_seen_at.
export async function loadSession(sql: Sql, sessionId: string, touch = true): Promise<SessionUser | null> {
  const key = sessionKey(sessionId);
  const [row] = await sql<
    { id: number; username: string; full_name: string; roles: Role[]; change: boolean }[]
  >`
    update sessions s set last_seen_at = case when ${touch} then now() else s.last_seen_at end
    from users u
    where s.id = ${key} and u.id = s.user_id and u.active and u.locked_at is null
      and s.last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning u.id::int as id, u.username, u.full_name,
      coalesce((select array_agg(role order by role) from user_roles r where r.user_id = u.id), '{}') as roles,
      (u.must_change_password
        or u.password_changed_at < now() - make_interval(days => ${POLICY.passwordMaxAgeDays})) as change`;
  if (!row) {
    await sql`delete from sessions where id = ${key}`;
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
