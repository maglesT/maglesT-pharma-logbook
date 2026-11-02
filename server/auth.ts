import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from './db.js';
import type { SignOn } from './signon.js';

export const ROLES = ['operator', 'supervisor', 'engineering', 'qa', 'admin'] as const;
export type Role = (typeof ROLES)[number];

// Product defaults (register LB-21); not regulatory numbers. Passwords, their ageing and lockout are core's (D-29).
export const POLICY = {
  sessionIdleMinutes: 15,
  maxFailedAttempts: 5,
  // A session's roles are renewed from core at least this often, so a revoked right or a deactivated person is out
  // within this time (platform PL-01).
  roleCheckMinutes: 5,
};

// Background polls send this header; they must not keep an idle session alive.
export const BACKGROUND_HEADER = 'x-background-poll';

export const SESSION_COOKIE = 'sid';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
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

export const asRoles = (roles: string[]): Role[] => ROLES.filter((r) => roles.includes(r));

// Loads the session and enforces the idle timeout; user-initiated requests refresh last_seen_at. Roles older than
// POLICY.roleCheckMinutes are renewed from core first; if core refuses, the session ends (PL-01).
export async function loadSession(sql: Sql, signOn: SignOn, sessionId: string, touch = true): Promise<SessionUser | null> {
  const key = sessionKey(sessionId);
  const fresh = await sql.begin(async (tx) => {
    const [s] = await tx<{ stale: boolean; refresh_token: string | null }[]>`
      select checked_at < now() - make_interval(mins => ${POLICY.roleCheckMinutes}) as stale, refresh_token
      from sessions where id = ${key} and last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
      for update`;
    if (!s) return false;
    if (!s.stale) return true;
    try {
      const id = await signOn.refresh(s.refresh_token ?? '');
      await tx`update sessions set roles = ${asRoles(id.roles)}, refresh_token = ${id.refreshToken ?? null},
                 id_token = coalesce(${id.idToken ?? null}, id_token), checked_at = now()
               where id = ${key}`;
      return true;
    } catch {
      return false;
    }
  });
  const [row] = fresh
    ? await sql<{ id: number; username: string; full_name: string; roles: Role[] }[]>`
        update sessions s set last_seen_at = case when ${touch} then now() else s.last_seen_at end
        from users u where s.id = ${key} and u.id = s.user_id
        returning u.id::int as id, u.username, u.full_name, s.roles`
    : [];
  if (!row || !row.roles.length) {
    await sql`delete from sessions where id = ${key}`;
    return null;
  }
  return { id: row.id, username: row.username, fullName: row.full_name, roles: row.roles, sessionId };
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = req.user;
  if (!user) {
    void reply.code(401).send({ error: 'not_logged_in' });
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
