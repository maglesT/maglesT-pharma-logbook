import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from './db.js';
import type { SignOn } from './signon.js';

// B1-2b (platform A10, D-30): rights are this product's permission codes from core's token, one code per action.
export const PERMISSIONS = {
  'logbook.entry.record_use': 'Record equipment use',
  'logbook.entry.record_cleaning': 'Record equipment and area cleaning',
  'logbook.entry.record_general': 'Record general log entries',
  'logbook.entry.record_maintenance': 'Record maintenance and breakdowns, complete repairs',
  'logbook.entry.record_calibration': 'Record calibrations',
  'logbook.entry.record_requalification': 'Record requalifications',
  'logbook.entry.record_sterile': 'Record steriliser cycles, glove tests and pressure readings',
  'logbook.entry.record_steriliser_test': 'Record steriliser tests (leak, air removal)',
  'logbook.entry.correct_others': 'Correct entries made by others',
  'logbook.entry.verify': 'Verify entries (second person)',
  'logbook.breakdown.release': 'Release equipment after a breakdown',
  'logbook.review.read': 'See period reviews, the batch view and exports',
  'logbook.review.sign': 'Sign period reviews',
  'logbook.audit.read': 'Read the audit trail and run the integrity check',
  'logbook.settings.draft': 'Draft logbook settings',
  'logbook.settings.approve': 'Approve logbook settings',
  'logbook.site.manage': 'Edit the site record, item settings and equipment details',
  'logbook.voice_note.record': 'Record voice notes',
  'logbook.advice.ask': 'Ask for breakdown suggestions',
} as const;
export type Permission = keyof typeof PERMISSIONS;
const CODES = Object.keys(PERMISSIONS) as Permission[];

// The old roles and the permissions each gives (D-30); used for the data move (B1-5) and by the test stand-ins.
export type Role = 'operator' | 'supervisor' | 'engineering' | 'qa' | 'admin';
const OPERATOR: Permission[] = ['logbook.entry.record_use', 'logbook.entry.record_cleaning', 'logbook.entry.record_general',
  'logbook.entry.record_maintenance', 'logbook.entry.record_sterile', 'logbook.entry.record_steriliser_test',
  'logbook.voice_note.record', 'logbook.advice.ask'];
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  operator: OPERATOR,
  supervisor: [...OPERATOR, 'logbook.entry.correct_others', 'logbook.entry.verify', 'logbook.review.read'],
  engineering: ['logbook.entry.record_general', 'logbook.entry.record_maintenance', 'logbook.entry.record_calibration', 'logbook.entry.record_requalification',
    'logbook.entry.record_steriliser_test', 'logbook.voice_note.record', 'logbook.advice.ask'],
  qa: ['logbook.entry.verify', 'logbook.breakdown.release', 'logbook.review.read', 'logbook.review.sign', 'logbook.audit.read',
    'logbook.settings.approve', 'logbook.advice.ask'],
  admin: ['logbook.audit.read', 'logbook.settings.draft', 'logbook.site.manage'],
};
export const permissionsOf = (roles: Role[]): Permission[] => CODES.filter((c) => roles.some((r) => ROLE_PERMISSIONS[r].includes(c)));

// Product defaults (register LB-21); not regulatory numbers. Passwords, their ageing and lockout are core's (D-29).
export const POLICY = {
  sessionIdleMinutes: 15,
  // A session's permissions are renewed from core at least this often, so a revoked right or a deactivated person is out
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
  permissions: Permission[];
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

// Only this product's known codes count; anything else in the claim is ignored.
export const asPermissions = (codes: string[]): Permission[] => CODES.filter((c) => codes.includes(c));

// Loads the session and enforces the idle timeout; user-initiated requests refresh last_seen_at. Permissions older than
// POLICY.roleCheckMinutes are renewed from core first; if core refuses, the session ends (PL-01).
export async function loadSession(sql: Sql, signOn: SignOn, sessionId: string, touch = true): Promise<SessionUser | null> {
  const key = sessionKey(sessionId);
  const end = async () => { await sql`delete from sessions where id = ${key}`; return null; };
  // One request claims a due renewal (others go on with the current permissions); core is called outside any transaction.
  const [due] = await sql<{ refresh_token: string | null }[]>`
    update sessions set checked_at = now()
    where id = ${key} and checked_at < now() - make_interval(mins => ${POLICY.roleCheckMinutes})
      and last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning refresh_token`;
  if (due) {
    try {
      // Core may keep the refresh token and send none back (RFC 6749 6): the stored one then stays.
      const id = await signOn.refresh(due.refresh_token ?? '');
      await sql`update sessions set permissions = ${asPermissions(id.permissions)}, refresh_token = coalesce(${id.refreshToken ?? null}, refresh_token),
                  id_token = coalesce(${id.idToken ?? null}, id_token)
                where id = ${key}`;
    } catch {
      return end();
    }
  }
  const [row] = await sql<{ id: number; username: string; full_name: string; permissions: Permission[] }[]>`
    update sessions s set last_seen_at = case when ${touch} then now() else s.last_seen_at end
    from users u
    where s.id = ${key} and u.id = s.user_id and s.last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning u.id::int as id, u.username, u.full_name, s.permissions`;
  if (!row || !row.permissions.length) return end();
  return { id: row.id, username: row.username, fullName: row.full_name, permissions: row.permissions, sessionId };
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = req.user;
  if (!user) {
    void reply.code(401).send({ error: 'not_logged_in' });
    return null;
  }
  return user;
}

// LB-21: authority check per action, on the server: the session must hold one of the codes (none given: any session).
export function requirePermission(...codes: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    if (codes.length && !codes.some((c) => user.permissions.includes(c))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
