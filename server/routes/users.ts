import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { hashPassword, temporaryPassword } from '../passwords.js';
import { POLICY, ROLES, parseId, requireRole } from '../auth.js';

const roleList = z.array(z.enum(ROLES)).min(1).transform((r) => [...new Set(r)].sort());
const createBody = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
  fullName: z.string().trim().min(1).max(120),
  roles: roleList,
});
const updateBody = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  roles: roleList.optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});
const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) });

interface UserRow {
  id: number;
  username: string;
  full_name: string;
  active: boolean;
  locked: boolean;
  roles: string[];
  last_login_at: Date | null;
  created_at: Date;
}

const toApi = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  roles: u.roles,
  active: u.active,
  locked: u.locked,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

export function userRoutes(app: FastifyInstance, sql: Sql) {
  const admin = { preHandler: requireRole('admin') };

  const loadUser = async (q: Sql | Tx, id: number) =>
    (
      await q<UserRow[]>`
        select u.id::int, u.username, u.full_name, u.active, u.locked_at is not null as locked,
          u.last_login_at, u.created_at,
          coalesce((select array_agg(role order by role) from user_roles r where r.user_id = u.id), '{}') as roles
        from users u where u.id = ${id}`
    )[0];

  // Access list for periodic review (LB-21, CP-03); never includes password hashes.
  app.get('/api/users', admin, async () => {
    const rows = await sql<UserRow[]>`
      select u.id::int, u.username, u.full_name, u.active, u.locked_at is not null as locked,
        u.last_login_at, u.created_at,
        coalesce((select array_agg(role order by role) from user_roles r where r.user_id = u.id), '{}') as roles
      from users u order by u.username`;
    return rows.map(toApi);
  });

  app.post('/api/users', admin, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { username, fullName, roles } = body.data;
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    const result = await sql.begin(async (tx) => {
      // LB-20: user IDs are never reused, including those of deactivated users.
      const [taken] = await tx`select 1 from users where username = ${username}`;
      if (taken) return null;
      const [u] = await tx<{ id: number }[]>`
        insert into users (username, full_name, password_hash, temp_password_expires_at)
        values (${username}, ${fullName}, ${hash}, now() + make_interval(hours => ${POLICY.temporaryPasswordHours}))
        returning id::int`;
      for (const role of roles) await tx`insert into user_roles (user_id, role) values (${u!.id}, ${role})`;
      await audit(tx, { actorId: req.user!.id, action: 'user.created', objectType: 'user', objectId: u!.id,
        new: { username, fullName, roles } });
      return u!.id;
    });
    if (result === null) return reply.code(409).send({ error: 'username_taken' });
    // The temporary password is returned once and never stored in clear.
    return reply.code(201).send({ user: toApi((await loadUser(sql, result))!), temporaryPassword: temp });
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', admin, async (req, reply) => {
    const body = updateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const { fullName, roles, active, reason } = body.data;
    if (id === req.user!.id && (active === false || (roles && !roles.includes('admin')))) {
      return reply.code(400).send({ error: 'cannot_remove_own_admin' });
    }
    const updated = await sql.begin(async (tx) => {
      const before = await loadUser(tx, id);
      if (!before) return null;
      if (fullName !== undefined) await tx`update users set full_name = ${fullName} where id = ${id}`;
      if (active !== undefined) {
        await tx`update users set active = ${active} where id = ${id}`;
        if (!active) await tx`delete from sessions where user_id = ${id}`;
      }
      if (roles) {
        await tx`delete from user_roles where user_id = ${id}`;
        for (const role of roles) await tx`insert into user_roles (user_id, role) values (${id}, ${role})`;
      }
      const after = (await loadUser(tx, id))!;
      const pick = (u: UserRow) => ({ fullName: u.full_name, roles: u.roles, active: u.active });
      await audit(tx, { actorId: req.user!.id, action: 'user.updated', objectType: 'user', objectId: id,
        old: pick(before), new: pick(after), reason });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return toApi(updated);
  });

  // Issues a new temporary password and unlocks the account; the admin never learns the user's own password.
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-password', admin, async (req, reply) => {
    const body = reasonBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    const ok = await sql.begin(async (tx) => {
      const [u] = await tx`
        update users set password_hash = ${hash}, must_change_password = true, password_changed_at = now(),
          temp_password_expires_at = now() + make_interval(hours => ${POLICY.temporaryPasswordHours}),
          failed_attempts = 0, locked_at = null
        where id = ${id} returning id`;
      if (!u) return false;
      await tx`delete from sessions where user_id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'user.password_reset', objectType: 'user', objectId: id,
        reason: body.data.reason });
      return true;
    });
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { temporaryPassword: temp };
  });
}
