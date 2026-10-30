import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { parseId, requireRole } from '../auth.js';
import { PLANT_TZ } from '../status.js';
import { present, type EntryRow } from './entries.js';
import { auditFor, batchVersions, periodQuery, periodVersions, plantRange, reviewsFor, type AuditRow } from './review.js';

// LB-22: one PDF layout and one CSV, for a logbook period and for a batch view. Every version is
// included, corrected versions are marked, signatures, reviews and the audit trail are part of the copy.

type Presented = Awaited<ReturnType<typeof present>>[number];
type Review = Awaited<ReturnType<typeof reviewsFor>>[number];

// Embedded Unicode fonts, so names and symbols print exactly as entered (review S5-2). Characters
// neither font has are printed as a visible code point, never silently changed.
const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = [path.resolve(here, '../fonts'), path.resolve(here, '../../../server/fonts')].find((d) => existsSync(path.join(d, 'NotoSans-Regular.ttf')))!;
const font = (f: string) => path.join(FONTS, f);
const printer = new PdfPrinter({
  Noto: { normal: font('NotoSans-Regular.ttf'), bold: font('NotoSans-Bold.ttf'), italics: font('NotoSans-Regular.ttf'), bolditalics: font('NotoSans-Bold.ttf') },
  NotoMath: { normal: font('NotoSansMath-Regular.ttf'), bold: font('NotoSansMath-Regular.ttf'), italics: font('NotoSansMath-Regular.ttf'), bolditalics: font('NotoSansMath-Regular.ttf') },
});
const fontkit = createRequire(import.meta.url)('@foliojs-fork/fontkit') as { openSync: (f: string) => { hasGlyphForCodePoint: (c: number) => boolean } };
const mainGlyphs = fontkit.openSync(font('NotoSans-Regular.ttf'));
const mathGlyphs = fontkit.openSync(font('NotoSansMath-Regular.ttf'));

// Splits text into runs per font; unknown characters become [U+XXXX].
export function runs(text: string): { text: string; font?: string }[] {
  const out: { text: string; font?: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const ctrl = cp === 10 || cp === 9;
    const [t, f] = ctrl || mainGlyphs.hasGlyphForCodePoint(cp) ? [ch, undefined] : mathGlyphs.hasGlyphForCodePoint(cp) ? [ch, 'NotoMath'] : [`[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`, undefined];
    const last = out.at(-1);
    if (last && last.font === f) last.text += t;
    else out.push(f ? { text: t, font: f } : { text: t });
  }
  return out;
}
const cellText = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 7, ...extra }) as Content;

export const plant = (d: Date | string | null) =>
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
  reviews: Review[];
  codes: Map<number, string>;
}

// D-26: the signed English text is the record; the copy says that original voice data exists.
export const voiceNoteText = (e: { voiceNotes: { field: string; language: string | null; edited: boolean; carried: boolean }[] }) =>
  e.voiceNotes.map((v) => `Voice note for ${v.field}: signed English text; original ${v.language ?? 'language'} audio and transcript kept${v.edited ? ' (translation edited by the speaker)' : ''}`).join('\n');

function versionNote(e: Presented, all: EntryRow[]) {
  const next = all.find((v) => v.supersedes === e.id);
  const voice = voiceNoteText(e);
  const note = next ? `Superseded by version ${next.version} (${next.change})`
    : e.change === 'corrected' ? `Corrected: ${e.correctionReason}` : e.change === 'completed' ? 'Completed' : '';
  return [note, voice].filter(Boolean).join('\n');
}

const signatureText = (e: Presented) =>
  e.signatures.map((s) => `${s.meaning}: ${s.printedName}, ${plant(s.signedAt)}${s.valid ? '' : ' [INVALID: content changed]'}`).join('\n');
const reviewText = (r: Review) =>
  `Reviewed by ${r.reviewedBy ?? '—'}, ${plant(r.reviewedAt)} · period ${plant(r.periodFrom)} to ${plant(r.periodTo)}` +
  `${r.superseded ? ' · SUPERSEDED: entries changed after the review' : ''}${r.valid ? '' : ' · INVALID: review content changed'}`;

// Spreadsheet formula triggers, also after leading spaces (review S5-4).
const FORMULA = /^[\s]*[=+\-@\t\r]/;

const cell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
  return `"${(FORMULA.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
};
// CSV with formula-safe cells, CRLF line ends and UTC times (D-20).
export const csvText = (head: string[], rows: unknown[][]) => [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';

function csv(r: Report): string {
  const head = ['record', 'equipment', 'entry_id', 'version', 'change', 'note', 'logbook_type', 'activity_start_utc', 'activity_end_utc',
    'batch', 'data', 'late_reason', 'entered_by', 'entered_at_utc', 'signatures', 'audit_at_utc', 'audit_user', 'audit_action', 'audit_old', 'audit_new', 'audit_reason'];
  const rows: unknown[][] = r.entries.map((e) => [
    'entry', r.codes.get(e.equipmentId), e.entryId, e.version, e.change, versionNote(e, r.versions), e.logbookType, e.activityStart, e.activityEnd,
    e.batch, json(e.data), e.lateReason, e.enteredBy, e.enteredAt, signatureText(e).replaceAll('\n', ' | '), '', '', '', '', '', '',
  ]);
  for (const v of r.reviews) rows.push(['review', '', v.id, '', '', reviewText(v), '', v.periodFrom, v.periodTo, '', '', '', v.reviewedBy, v.reviewedAt, '', '', '', '', '', '', '']);
  for (const a of r.audit) rows.push(['audit', '', '', '', '', '', '', '', '', '', '', '', '', '', '', a.at, a.actor ?? 'system', a.action, json(a.oldValue), json(a.newValue), a.reason]);
  return csvText(head, rows);
}

// The common page frame of every PDF copy: site header, title, generated-by footer with page x of y (D-20).
function render(site: { name: string; code: string } | undefined, title: string, by: string, content: Content[]): Promise<Buffer> {
  const def: TDocumentDefinitions = {
    pageOrientation: 'landscape',
    pageSize: 'A4',
    pageMargins: [28, 50, 28, 36],
    defaultStyle: { font: 'Noto', fontSize: 9 },
    header: { text: runs(`${site?.name ?? ''} (${site?.code ?? ''}) · ${title}`), margin: [28, 20, 28, 0], fontSize: 9, bold: true },
    footer: (page, pages) => ({
      text: `Generated ${plant(new Date())} by ${by} · true copy of the electronic record · page ${page} of ${pages}`,
      margin: [28, 10, 28, 0],
      fontSize: 7,
    }),
    content,
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

export interface PdfTable {
  heading: string;
  columns: string[];
  widths: (number | string)[];
  rows: { cells: string[]; highlight?: boolean; grey?: boolean }[];
}

// A PDF copy made of titled tables, with the site header (S9 register and history card).
export async function tablesPdf(sql: Sql, title: string, subtitle: string, tables: PdfTable[], by: string): Promise<Buffer> {
  const [site] = await sql<{ name: string; code: string }[]>`select name, code from site where id = 1`;
  const content: Content[] = [{ text: runs(title), fontSize: 14, bold: true }, { text: runs(subtitle), margin: [0, 2, 0, 10] }];
  for (const t of tables) {
    content.push({ text: runs(t.heading), bold: true, margin: [0, 8, 0, 4] });
    content.push(t.rows.length
      ? { table: { headerRows: 1, widths: t.widths, body: [t.columns.map((c) => ({ text: c, fontSize: 8, bold: true })),
          ...t.rows.map((r) => r.cells.map((c) => cellText(c, r.grey ? { color: '#888888' } : r.highlight ? { fillColor: '#fdecea' } : {})))] }, layout: 'lightHorizontalLines' }
      : { text: 'None.', italics: true });
  }
  return render(site, title, by, content);
}

export function sendCopy(reply: FastifyReply, format: 'csv' | 'pdf', name: string, body: string | Buffer) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return format === 'csv'
    ? reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${safe}.csv"`).send('\ufeff' + body)
    : reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${safe}.pdf"`).send(body);
}

async function pdf(r: Report, site: { name: string; code: string } | undefined, by: string): Promise<Buffer> {
  const entryRows: Content[][] = r.entries.map((e) => {
    const superseded = versionNote(e, r.versions).startsWith('Superseded');
    const grey = superseded ? { color: '#888888' } : {};
    return [
      cellText(`${r.codes.get(e.equipmentId) ?? ''}\n#${e.entryId} v${e.version}`, grey),
      cellText(`${e.logbookType.replaceAll('_', ' ')}\n${versionNote(e, r.versions)}`, grey),
      cellText(`${plant(e.activityStart)}${e.activityEnd ? `\nto ${plant(e.activityEnd)}` : ''}${e.late ? `\nLATE: ${e.lateReason}` : ''}`, grey),
      cellText(`${e.batch ? `Batch ${e.batch}\n` : ''}${wrapJson(e.data)}`, grey),
      cellText(`${e.enteredBy}\n${plant(e.enteredAt)}`, grey),
      cellText(signatureText(e), grey),
    ];
  });
  const auditRows: Content[][] = r.audit.map((a) => [
    cellText(plant(a.at)),
    cellText(a.actor ?? 'system'),
    cellText(`${a.action} ${a.objectType} ${a.objectId ?? ''}`),
    cellText(`${a.reason ? `Reason: ${a.reason}\n` : ''}${a.oldValue ? `Old: ${wrapJson(a.oldValue)}\n` : ''}${a.newValue ? `New: ${wrapJson(a.newValue)}` : ''}`),
  ]);
  const heading = (text: string) => ({ text, fontSize: 8, bold: true });
  return render(site, r.title, by, [
    { text: runs(r.title), fontSize: 14, bold: true },
    { text: runs(r.subtitle), margin: [0, 2, 0, 10] },
    ...(r.reviews.length
      ? [{ text: 'QA reviews', bold: true, margin: [0, 0, 0, 4] } as Content, { ul: r.reviews.map((v) => ({ text: runs(reviewText(v)), fontSize: 8 })), margin: [0, 0, 0, 10] } as Content]
      : []),
    { text: 'Entries (all versions; superseded versions shown in grey)', bold: true, margin: [0, 0, 0, 4] },
    r.entries.length
      ? { table: { headerRows: 1, widths: [55, 75, 90, '*', 70, 150], body: [['Item / entry', 'Type', 'Activity', 'Details', 'Entered', 'Signatures'].map(heading), ...entryRows] }, layout: 'lightHorizontalLines' }
      : { text: 'No entries.', italics: true },
    { text: 'Audit trail', bold: true, margin: [0, 14, 0, 4] },
    r.audit.length
      ? { table: { headerRows: 1, widths: [80, 80, 120, '*'], body: [['When', 'Who', 'Action', 'Details'].map(heading), ...auditRows] }, layout: 'lightHorizontalLines' }
      : { text: 'No audit rows.', italics: true },
  ]);
}

async function build(sql: Sql, title: string, subtitle: string, versions: EntryRow[], reviews: Review[] = []): Promise<Report> {
  const codes = new Map(
    (await sql<{ id: number; code: string }[]>`
      select id::int, code from equipment where id = any(${[...new Set(versions.map((v) => v.equipment_id))]}::bigint[])`).map((c) => [c.id, c.code]),
  );
  return {
    title,
    subtitle,
    versions,
    entries: await present(sql, versions),
    audit: await auditFor(sql, versions, reviews.map((v) => v.id)),
    reviews,
    codes,
  };
}

// Size guard (review S5-6): exports are built in memory.
const MAX_VERSIONS = 20_000;

async function send(sql: Sql, reply: FastifyReply, format: 'csv' | 'pdf', name: string, report: Report, by: string) {
  if (format === 'csv') return sendCopy(reply, format, name, csv(report));
  const [site] = await sql<{ name: string; code: string }[]>`select name, code from site where id = 1`;
  return sendCopy(reply, format, name, await pdf(report, site, by));
}

export function exportRoutes(app: FastifyInstance, sql: Sql) {
  const readers = { preHandler: requireRole('qa', 'supervisor') };
  const fmt = z.enum(['csv', 'pdf']);

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/period.:format', readers, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const id = parseId(req.query.equipmentId ?? '');
    const q = periodQuery.safeParse(req.query);
    if (!format.success || id === null || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const [eq] = await sql<{ code: string; name: string }[]>`select code, name from equipment where id = ${id}`;
    if (!eq) return reply.code(404).send({ error: 'not_found' });
    const { from, to } = await plantRange(sql, q.data.fromDay, q.data.toDay);
    const versions = await periodVersions(sql, id, from, to);
    if (versions.length > MAX_VERSIONS) return reply.code(413).send({ error: 'too_large', message: 'Choose a shorter period.' });
    const report = await build(sql, `Logbook ${eq.code} · ${eq.name}`, `Period ${q.data.fromDay} to ${q.data.toDay} (plant time)`,
      versions, await reviewsFor(sql, id, from, to));
    return send(sql, reply, format.data, `logbook-${eq.code}-${q.data.fromDay}`, report, req.user!.fullName);
  });

  app.get<{ Params: { format: string }; Querystring: Record<string, string> }>('/api/export/batch.:format', readers, async (req, reply) => {
    const format = fmt.safeParse(req.params.format);
    const batch = z.string().trim().min(1).max(60).safeParse(req.query.batch);
    if (!format.success || !batch.success) return reply.code(400).send({ error: 'invalid_request' });
    const versions = await batchVersions(sql, batch.data);
    if (versions.length > MAX_VERSIONS) return reply.code(413).send({ error: 'too_large' });
    const report = await build(sql, `Batch ${batch.data}`, 'All logbook entries referencing this batch', versions);
    return send(sql, reply, format.data, `batch-${batch.data}`, report, req.user!.fullName);
  });
}
