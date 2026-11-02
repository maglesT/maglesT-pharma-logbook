import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole } from '../auth.js';
import { mayRecord } from '../entries.js';
import { LOGBOOK_TYPES, settingsSchema, typeByKey } from '../logbook-types.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';

const draftBody = z.object({
  logbookType: z.string(),
  settings: settingsSchema,
  effectiveFrom: z.coerce.date(),
});
const editBody = z.object({ settings: settingsSchema, effectiveFrom: z.coerce.date(), reason: z.string().trim().min(1).max(500) });

export interface SettingsRow {
  id: number;
  logbook_type: string;
  version: number;
  settings: unknown;
  effective_from: Date;
  created_by: number;
  created_at: Date;
}

// What the QA approval signature covers (LB-24 + LB-19).
export const signedContent = (r: SettingsRow) => ({
  logbookType: r.logbook_type,
  version: r.version,
  settings: r.settings,
  effectiveFrom: r.effective_from,
});

// The version in force for a type: the latest approved one whose effective date has passed.
export async function settingsInForce(q: Sql | Tx, logbookType: string) {
  const [row] = await q<SettingsRow[]>`
    select s.id::int, s.logbook_type, s.version, s.settings, s.effective_from, s.created_by::int, s.created_at
    from logbook_settings s
    join signatures g on g.object_type = 'settings' and g.object_id = s.id and g.meaning = 'approved'
    where s.logbook_type = ${logbookType} and s.effective_from <= now()
    order by s.version desc limit 1`;
  return row ?? null;
}

export function settingsRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requireRole() };

  // All versions per type, with their approval signature (printed name, time, meaning: LB-19).
  app.get('/api/logbook-types', anyUser, async (req) => {
    const rows = await sql`
      select s.id::int, s.logbook_type, s.version, s.settings, s.effective_from, s.created_by::int, s.created_at,
        u.full_name as created_by_name, g.printed_name as approved_by, g.signed_at as approved_at,
        (g.id is not null and s.effective_from <= now()) as effective,
        row_number() over (partition by s.logbook_type, (g.id is not null and s.effective_from <= now()) order by s.version desc) as rank
      from logbook_settings s
      join users u on u.id = s.created_by
      left join signatures g on g.object_type = 'settings' and g.object_id = s.id and g.meaning = 'approved'
      order by s.logbook_type, s.version desc`;
    return LOGBOOK_TYPES.map((t) => ({
      ...t,
      // Whether this user may record this type, so screens offer only what the server accepts (S11).
      mayRecord: mayRecord(t.key, req.user!.roles),
      versions: rows
        .filter((r) => r.logbook_type === t.key)
        .map((r) => ({
          id: r.id,
          version: r.version,
          settings: r.settings,
          effectiveFrom: r.effective_from,
          createdAt: r.created_at,
          createdBy: r.created_by_name,
          approvedBy: r.approved_by,
          approvedAt: r.approved_at,
          // Database time decides what is in force (review finding S2-3).
          status: !r.approved_at ? 'draft' : !r.effective ? 'approved, not yet effective' : Number(r.rank) === 1 ? 'in force' : 'superseded',
          contentHash: contentHash('settings', r.id, signedContent(r as unknown as SettingsRow)),
        })),
    }));
  });

  // Admin drafts a new settings version (FRS §2); QA approves it.
  app.post('/api/settings', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = draftBody.safeParse(req.body);
    if (!body.success || !typeByKey(body.data.logbookType)) return reply.code(400).send({ error: 'invalid_request' });
    const { logbookType, settings, effectiveFrom } = body.data;
    const row = await sql.begin(async (tx) => {
      // Serialise version numbering per type.
      await tx`select pg_advisory_xact_lock(hashtext(${'settings:' + logbookType}))`;
      const [n] = await tx<{ next: number }[]>`
        select coalesce(max(version), 0) + 1 as next from logbook_settings where logbook_type = ${logbookType}`;
      const next = n!.next;
      const [r] = await tx<SettingsRow[]>`
        insert into logbook_settings (logbook_type, version, settings, effective_from, created_by)
        values (${logbookType}, ${next}, ${tx.json(settings as never)}, ${effectiveFrom}, ${req.user!.id})
        returning id::int, logbook_type, version, settings, effective_from, created_by::int, created_at`;
      await audit(tx, { actorId: req.user!.id, action: 'settings.drafted', objectType: 'settings', objectId: r!.id, new: signedContent(r!) });
      return r!;
    });
    return reply.code(201).send({ id: row.id, version: row.version });
  });

  // Drafts can be edited until approved; approved versions are fixed.
  app.patch<{ Params: { id: string } }>('/api/settings/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = editBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await sql.begin(async (tx) => {
      const [before] = await tx<SettingsRow[]>`
        select id::int, logbook_type, version, settings, effective_from, created_by::int, created_at
        from logbook_settings where id = ${id} for update`;
      if (!before) return 'not_found' as const;
      const [approved] = await tx`select 1 from signatures where object_type = 'settings' and object_id = ${id}`;
      if (approved) return 'approved' as const;
      const [after] = await tx<SettingsRow[]>`
        update logbook_settings set settings = ${tx.json(body.data.settings as never)}, effective_from = ${body.data.effectiveFrom}
        where id = ${id}
        returning id::int, logbook_type, version, settings, effective_from, created_by::int, created_at`;
      await audit(tx, { actorId: req.user!.id, action: 'settings.edited', objectType: 'settings', objectId: id,
        old: signedContent(before), new: signedContent(after!), reason: body.data.reason });
      return 'ok' as const;
    });
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (result === 'approved') return reply.code(409).send({ error: 'already_approved' });
    return { ok: true };
  });

  // LB-24: QA approves a version with an e-signature (LB-19/LB-20).
  app.post<{ Params: { id: string } }>('/api/settings/:id/approve', { preHandler: requireRole('qa') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const signer = await authenticateSigner(sql, app.proofKey, req.user!, body.data, { objectType: 'settings', objectId: id, meaning: 'approved' });
      const result = await sql.begin(async (tx) => {
        const [row] = await tx<SettingsRow[]>`
          select id::int, logbook_type, version, settings, effective_from, created_by::int, created_at
          from logbook_settings where id = ${id} for update`;
        if (!row) return null;
        const [signed] = await tx`select 1 from signatures where object_type = 'settings' and object_id = ${id} and meaning = 'approved'`;
        if (signed) throw new SignError('already_signed');
        // The signer saw this exact content (draft as displayed).
        const shown = contentHash('settings', id, signedContent(row));
        if (shown !== body.data.contentHash) throw new SignError('content_changed');
        // An effective date already past at approval becomes the approval time (database clock):
        // a version never takes effect before it was approved.
        const [r] = await tx<{ effective_from: Date }[]>`
          update logbook_settings set effective_from = greatest(effective_from, now()) where id = ${id}
          returning effective_from`;
        row.effective_from = r!.effective_from;
        const content = signedContent(row);
        return sign(tx, { signer, objectType: 'settings', objectId: id, meaning: 'approved', content,
          shownHash: contentHash('settings', id, content) });
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return { ok: true, signedAt: result.signedAt };
    } catch (e) {
      if (e instanceof SignError) {
        const status = e.code === 'wrong_credentials' ? 401 : e.code === 'already_signed' || e.code === 'content_changed' ? 409 : 403;
        return reply.code(status).send({ error: e.code });
      }
      throw e;
    }
  });

  // LB-19: signatures on a settings version, each checked against the current content.
  app.get<{ Params: { id: string } }>('/api/settings/:id/signatures', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [row] = await sql<SettingsRow[]>`
      select id::int, logbook_type, version, settings, effective_from, created_by::int, created_at
      from logbook_settings where id = ${id}`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const sigs = await sql<{ printed_name: string; meaning: string; signed_at: Date; content_hash: string }[]>`
      select printed_name, meaning, signed_at, content_hash from signatures
      where object_type = 'settings' and object_id = ${id} order by signed_at`;
    const current = contentHash('settings', id, signedContent(row));
    return sigs.map((s) => ({ printedName: s.printed_name, meaning: s.meaning, signedAt: s.signed_at, valid: s.content_hash === current }));
  });
}
