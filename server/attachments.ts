import type { Sql, Tx } from './db.js';

// Owner 2026-11-14 (D-44): documents attached to calibration, requalification and maintenance (breakdown, preventive)
// entries: the certificate, the service report, the requalification report. Kept in this database, insert-only, linked
// to the entry across its versions (entries.entry_id) so a correction keeps them.

export const ATTACHMENT_TYPES = new Set(['calibration', 'requalification', 'maintenance']);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTRY = 10;
export type MediaType = 'application/pdf' | 'image/png' | 'image/jpeg';
export const MEDIA_TYPES: MediaType[] = ['application/pdf', 'image/png', 'image/jpeg'];

// The file's real type, from its first bytes; the name and the declared type are not trusted.
export function sniff(buf: Buffer): MediaType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

// A file name safe for a Content-Disposition header: no quotes, control characters or path separators.
export const safeFileName = (name: string) => name.replace(/[\\/"\r\n\t\x00-\x1f\x7f]/g, '_').trim().slice(0, 200) || 'document';

export interface Attachment {
  id: number;
  entryId: number;
  entryVersionId: number;
  fileName: string;
  mediaType: MediaType;
  size: number;
  sha256: string;
  reason: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

/** The documents of these entries (entries.entry_id), oldest first, without their content. */
export async function attachmentsFor(q: Sql | Tx, entryIds: number[]): Promise<Map<number, Attachment[]>> {
  const out = new Map<number, Attachment[]>();
  if (!entryIds.length) return out;
  const rows = await q<{ id: number; entry_id: number; entry_version_id: number; file_name: string; media_type: MediaType; size_bytes: number; sha256: string; reason: string | null; uploaded_by: string; uploaded_at: Date }[]>`
    select a.id::int, a.entry_id::int, a.entry_version_id::int, a.file_name, a.media_type, a.size_bytes, a.sha256, a.reason, u.full_name as uploaded_by, a.uploaded_at
    from entry_attachments a join users u on u.id = a.uploaded_by
    where a.entry_id = any(${[...new Set(entryIds)]}::bigint[]) order by a.id`;
  for (const r of rows) {
    out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), { id: r.id, entryId: r.entry_id, entryVersionId: r.entry_version_id, fileName: r.file_name,
      mediaType: r.media_type, size: r.size_bytes, sha256: r.sha256, reason: r.reason, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at }]);
  }
  return out;
}
