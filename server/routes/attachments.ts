import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { mayRecord } from '../entries.js';
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_ENTRY, MAX_ATTACHMENT_BYTES, MEDIA_TYPES, safeFileName, sniff, type MediaType } from '../attachments.js';
import { LATE_MINUTES } from './entries.js';

// Owner 2026-11-14 (D-44): documents on calibration, requalification and maintenance entries. The app takes JSON writes
// only (server/app.ts), so a document travels as base64 inside JSON, one file per request, with a body limit just above
// the 10 MB file limit; the same session cookie and content-type rules protect it as every other write. The server reads
// the file's type from its first bytes and keeps the SHA-256, which the database checks again.

const uploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  mediaType: z.enum(MEDIA_TYPES as [MediaType, ...MediaType[]]),
  dataBase64: z.string().min(1).max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4),
  // Why a document is added to an entry saved earlier (LB-17); not needed in the minutes after one's own save.
  reason: z.string().trim().max(500).optional(),
});
const BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4_000;

export function attachmentRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  app.post<{ Params: { id: string } }>('/api/entries/:id/attachments', { ...anyUser, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const id = parseId(req.params.id);
    const refuse = (status: number, error: string, message: string) => reply.code(status).send({ error, problems: [message] });
    const raw = (req.body ?? {}) as { dataBase64?: unknown };
    if (typeof raw.dataBase64 === 'string' && raw.dataBase64.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4) return refuse(413, 'file_too_large', 'A document may be at most 10 MB.');
    const body = uploadBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const b = body.data;
    const user = req.user!;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b.dataBase64)) return refuse(400, 'invalid_request', 'The file data is not valid base64.');
    const content = Buffer.from(b.dataBase64, 'base64');
    if (!content.length) return refuse(400, 'invalid_request', 'The file is empty.');
    if (content.length > MAX_ATTACHMENT_BYTES) return refuse(413, 'file_too_large', 'A document may be at most 10 MB.');
    const real = sniff(content);
    if (real !== b.mediaType) return refuse(400, 'file_type', real ? `The file is a ${real.split('/')[1]!.toUpperCase()}, not the type given.` : 'Only PDF, PNG and JPEG documents can be attached.');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fileName = safeFileName(b.fileName);

    const result = await sql.begin(async (tx) => {
      const [v] = await tx<{ entry_id: number; equipment_id: number; logbook_type: string; entered_by: number; entered_at: Date; replaced: boolean }[]>`
        select e.entry_id::int, e.equipment_id::int, e.logbook_type, e.entered_by::int, e.entered_at, exists (select 1 from entries x where x.supersedes = e.id) as replaced
        from entries e where e.id = ${id}`;
      if (!v) return { status: 404, error: 'not_found', message: 'No such entry.' } as const;
      if (v.replaced) return { status: 409, error: 'not_latest_version', message: 'This version has been replaced; open the latest version.' } as const;
      if (!ATTACHMENT_TYPES.has(v.logbook_type)) return { status: 400, error: 'no_attachments', message: 'Documents are attached to calibration, requalification and maintenance entries only.' } as const;
      if (!mayRecord(v.logbook_type, user.permissions)) return { status: 403, error: 'forbidden', message: 'You may not attach documents to this kind of entry.' } as const;
      // Writes to an entry are serialised on its equipment row (as every entry write is).
      await tx`select 1 from equipment where id = ${v.equipment_id} for update`;
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from entry_attachments where entry_id = ${v.entry_id}`;
      if (n!.n >= MAX_ATTACHMENTS_PER_ENTRY) return { status: 409, error: 'too_many_attachments', message: `An entry carries at most ${MAX_ATTACHMENTS_PER_ENTRY} documents.` } as const;
      const [now] = await tx<{ now: Date }[]>`select now() as now`;
      const withSave = v.entered_by === user.id && now!.now.getTime() - v.entered_at.getTime() <= LATE_MINUTES * 60_000;
      if (!withSave && !b.reason) return { status: 400, error: 'reason_required', message: 'Give the reason for adding a document to this entry.' } as const;
      const [a] = await tx<{ id: number; uploaded_at: Date }[]>`
        insert into entry_attachments (entry_id, entry_version_id, file_name, media_type, size_bytes, sha256, content, reason, uploaded_by)
        values (${v.entry_id}, ${id}, ${fileName}, ${b.mediaType}, ${content.length}, ${sha256}, ${content}, ${withSave ? null : b.reason!}, ${user.id})
        returning id::int, uploaded_at`;
      await audit(tx, { actorId: user.id, action: 'attachment.added', objectType: 'entry', objectId: id,
        new: { attachmentId: a!.id, entryId: v.entry_id, fileName, mediaType: b.mediaType, size: content.length, sha256 }, reason: withSave ? null : b.reason! });
      return { status: 201, id: a!.id, uploadedAt: a!.uploaded_at } as const;
    });
    if (result.status !== 201) return refuse(result.status, result.error, result.message);
    return reply.code(201).send({ id: result.id, fileName, mediaType: b.mediaType, size: content.length, sha256, uploadedAt: result.uploadedAt });
  });

  // The document itself, as a download with its own type and name.
  app.get<{ Params: { id: string } }>('/api/attachments/:id', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [a] = await sql<{ content: Buffer; media_type: string; file_name: string; size_bytes: number }[]>`
      select content, media_type, file_name, size_bytes from entry_attachments where id = ${id}`;
    if (!a) return reply.code(404).send({ error: 'not_found' });
    const name = safeFileName(a.file_name);
    return reply
      .header('content-type', a.media_type)
      .header('content-length', String(a.size_bytes))
      .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(a.content);
  });
}
