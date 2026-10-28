import type { FastifyInstance, FastifyReply } from 'fastify';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { parseId, requireRole } from '../auth.js';
import { PLANT_TZ } from '../status.js';
import { present, type EntryRow } from './entries.js';
import { auditFor, batchVersions, periodVersions, type AuditRow } from './review.js';

// LB-22: one PDF layout and one CSV, for a logbook period and for a batch view. Every version is
// included, corrected versions are marked, signatures and the audit trail are part of the copy.

type Presented = Awaited<ReturnType<typeof present>>[number];

const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

const plant = (d: Date | string | null) =>
  d ? `${new Date(d).toLocaleString('en-GB', { timeZone: PLANT_TZ, dateStyle: 'medium', timeStyle: 'short' })} IST` : '';
const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));
// For the PDF: spaces after separators so long values wrap inside the table column.
const wrapJson = (v: unknown) => json(v).replaceAll(',"', ', "').replaceAll('":', '": ');

interface Report {
  title: string;
  subtitle: string;
  versions: EntryRow[];
  entries: Presented[];
  audit: AuditRow[];
  codes: Map<number, string>;
}

function versionNote(e: Presented, all: EntryRow[]) {
  const next = all.find((v) => v.supersedes === e.id);
  if (next) return `Superseded by version ${next.version} (${next.change})`;
  return e.change === 'corrected' ? `Corrected: ${e.correctionReason}` : e.change === 'completed' ? 'Use ended' : '';
}

const signatureText = (e: Presented) =>
  e.signatures.map((s) => `${s.meaning}: ${s.printedName}, ${plant(s.signedAt)}${s.valid ? '' : ' [INVALID: content changed]'}`).join('\n');

function csv(r: Report): string {
  const head = ['record', 'equipment', 'entry_id', 'version', 'change', 'note', 'logbook_type', 'activity_start_utc', 'activity_end_utc',
    'batch', 'data', 'late_reason', 'entered_by', 'entered_at_utc', 'signatures', 'audit_at_utc', 'audit_user', 'audit_action', 'audit_old', 'audit_new', 'audit_reason'];
  const cell = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
    // Quote every cell; neutralise spreadsheet formulas.
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = r.entries.map((e) => [
    'entry', r.codes.get(e.equipmentId), e.entryId, e.version, e.change, versionNote(e, r.versions), e.logbookType, e.activityStart, e.activityEnd,
    e.batch, json(e.data), e.lateReason, e.enteredBy, e.enteredAt, signatureText(e).replaceAll('\n', ' | '), '', '', '', '', '', '',
  ]);
  for (const a of r.audit) rows.push(['audit', '', '', '', '', '', '', '', '', '', '', '', '', '', '', a.at, a.actor ?? 'system', a.action, json(a.oldValue), json(a.newValue), a.reason]);
  return [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

async function pdf(r: Report, site: { name: string; code: string } | undefined, by: string): Promise<Buffer> {
  const small = { fontSize: 7 };
  const entryRows: Content[][] = r.entries.map((e) => [
    { text: `${r.codes.get(e.equipmentId) ?? ''}\n#${e.entryId} v${e.version}`, ...small },
    { text: `${e.logbookType.replaceAll('_', ' ')}\n${versionNote(e, r.versions)}`, ...small, color: versionNote(e, r.versions).startsWith('Superseded') ? '#888' : '#000' },
    { text: `${plant(e.activityStart)}${e.activityEnd ? `\nto ${plant(e.activityEnd)}` : ''}${e.late ? `\nLATE: ${e.lateReason}` : ''}`, ...small },
    { text: `${e.batch ? `Batch ${e.batch}\n` : ''}${wrapJson(e.data)}`, ...small },
    { text: `${e.enteredBy}\n${plant(e.enteredAt)}`, ...small },
    { text: signatureText(e), ...small },
  ]);
  const auditRows: Content[][] = r.audit.map((a) => [
    { text: plant(a.at), ...small },
    { text: a.actor ?? 'system', ...small },
    { text: `${a.action} ${a.objectType} ${a.objectId ?? ''}`, ...small },
    { text: `${a.reason ? `Reason: ${a.reason}\n` : ''}${a.oldValue ? `Old: ${wrapJson(a.oldValue)}\n` : ''}${a.newValue ? `New: ${wrapJson(a.newValue)}` : ''}`, ...small },
  ]);
  const def: TDocumentDefinitions = {
    pageOrientation: 'landscape',
    pageSize: 'A4',
    pageMargins: [28, 50, 28, 36],
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    header: { text: `${site?.name ?? ''} (${site?.code ?? ''}) · ${r.title}`, margin: [28, 20, 28, 0], fontSize: 9, bold: true },
    footer: (page, pages) => ({
      text: `Generated ${plant(new Date())} by ${by} · true copy of the electronic record · page ${page} of ${pages}`,
      margin: [28, 10, 28, 0],
      fontSize: 7,
    }),
    content: [
      { text: r.title, fontSize: 14, bold: true },
      { text: r.subtitle, margin: [0, 2, 0, 10] },
      { text: 'Entries (all versions; superseded versions shown in grey)', bold: true, margin: [0, 0, 0, 4] },
      r.entries.length
        ? { table: { headerRows: 1, widths: [55, 75, 90, '*', 70, 150], body: [['Item / entry', 'Type', 'Activity', 'Details', 'Entered', 'Signatures'].map((h) => ({ text: h, bold: true, fontSize: 8 })), ...entryRows] }, layout: 'lightHorizontalLines' }
        : { text: 'No entries.', italics: true },
      { text: 'Audit trail', bold: true, margin: [0, 14, 0, 4] },
      r.audit.length
        ? { table: { headerRows: 1, widths: [80, 80, 120, '*'], body: [['When', 'Who', 'Action', 'Details'].map((h) => ({ text: h, bold: true, fontSize: 8 })), ...auditRows] }, layout: 'lightHorizontalLines' }
        : { text: 'No audit rows.', italics: true },
    ],
  };
  const doc = printer.createPdfKitDocument(def);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function build(sql: Sql, title: string, subtitle: string, versions: EntryRow[]): Promise<Report> {
  const codes = new Map(
    (await sql<{ id: number; code: string }[]>`
      select id::int, code from equipment where id = any(${[...new Set(versions.map((v) => v.equipment_id))]}::bigint[])`).map((c) => [c.id, c.code]),
  );
  return { title, subtitle, versions, entries: await present(sql, versions), audit: await auditFor(sql, versions), codes };
}

async function send(sql: Sql, reply: FastifyReply, format: string, name: string, report: Report, by: string) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (format === 'csv') {
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${safe}.csv"`).send('﻿' + csv(report));
  }
  const [site] = await sql<{ name: string; code: string }[]>`select name, code from site where id = 1`;
  return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${safe}.pdf"`).send(await pdf(report, site, by));
}

export function exportRoutes(app: FastifyInstance, sql: Sql) {
  const readers = { preHandler: requireRole('qa', 'supervisor') };
  const fmt = z.enum(['csv', 'pdf']);

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/period.:format', readers, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const id = parseId(req.query.equipmentId ?? '');
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date() }).safeParse(req.query);
    if (!format.success || id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const [eq] = await sql<{ code: string; name: string }[]>`select code, name from equipment where id = ${id}`;
    if (!eq) return reply.code(404).send({ error: 'not_found' });
    const report = await build(sql, `Logbook ${eq.code} · ${eq.name}`, `Period ${plant(q.data.from)} to ${plant(q.data.to)}`,
      await periodVersions(sql, id, q.data.from, q.data.to));
    return send(sql, reply, format.data, `logbook-${eq.code}-${q.data.from.toISOString().slice(0, 10)}`, report, req.user!.fullName);
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/batch.:format', readers, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const batch = z.string().trim().min(1).max(60).safeParse(req.query.batch);
    if (!format.success || !batch.success) return reply.code(400).send({ error: 'invalid_request' });
    const report = await build(sql, `Batch ${batch.data}`, 'All logbook entries referencing this batch', await batchVersions(sql, batch.data));
    return send(sql, reply, format.data, `batch-${batch.data}`, report, req.user!.fullName);
  });
}
