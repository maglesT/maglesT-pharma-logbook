import type { Sql } from './db.js';
import { isCut } from './batches.js';
import { ConnectionOff } from './master.js';

// D-79 (owner, 20 Nov 2026: the product that owns a job keeps it; a linked product reads it and does not type it): QMS owns
// the controlled documents. It publishes them in report.document_v1 (number, revision, title, type, effective_date,
// next_review_due, status, ...). With its link on (QMS_DATABASE_URL) the Logbook's SOP references (a logbook type's
// settings, an item's details) are picked from QMS' effective SOPs and cannot be typed. Nothing is copied: the Logbook keeps
// the SOP numbers it records, as before. Link off (standalone): SOP references are typed, as before.

export interface QmsSop {
  number: string;
  revision: string;
  title: string;
  effectiveDate: string | null;     // YYYY-MM-DD
  nextReviewDue: string | null;     // YYYY-MM-DD
}
export interface Sops {
  /** QMS' effective SOPs (type SOP, status effective), by number. */
  effective(): Promise<QmsSop[]>;
}

export const SOPS_OFF = 'Connection to QMS (SOPs) is off: SOPs cannot be picked now and none can be typed. Try again later or ask your administrator.';
export class SopsOff extends ConnectionOff {
  constructor() { super(); this.message = SOPS_OFF; }
}
export const SOPS_FROM_QMS = 'SOPs come from QMS: pick them from the list.';

export function sqlSops(q: Sql, schema = 'report'): Sops {
  const read = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (isCut(e)) throw new SopsOff(); throw e; } };
  const view = q(`${schema}.document_v1`);
  return {
    effective: () => read(async () => (await q<{ number: string; revision: string | null; title: string | null; effective_date: string | null; next_review_due: string | null }[]>`
      select distinct on (number) number, revision::text, title, effective_date::text, next_review_due::text from ${view}
      where upper(type) = 'SOP' and lower(status) = 'effective' and number is not null
      order by number, effective_date desc nulls last`)
      .map((r) => ({ number: r.number, revision: r.revision ?? '', title: r.title ?? '', effectiveDate: r.effective_date, nextReviewDue: r.next_review_due }))),
  };
}

/** The SOP references of a recorded text (split as logbook_sop_v1 and equipment_v1 split them: comma, semicolon, new line). */
export const sopRefsOf = (text: string | undefined | null) => (text ?? '').split(/[,;\n]/).map((r) => r.trim()).filter(Boolean);

/**
 * D-79: checks the SOP references being saved while QMS is linked. References already recorded (`recorded`) stay as they are;
 * each new one must be an effective SOP of QMS and is saved as QMS writes its number. QMS not answering: nothing new can be
 * added (the reference would be typed by hand). Without the link: typed, as before. Returns the text to save, or problems.
 */
export async function pullSops(sops: Sops | null, text: string, recorded: string[]): Promise<{ text: string; problems: string[]; off?: true }> {
  if (!sops) return { text, problems: [] };
  const refs = sopRefsOf(text);
  const known = new Set(recorded.map((r) => r.toUpperCase()));
  const added = refs.filter((r) => !known.has(r.toUpperCase()));
  if (!added.length) return { text, problems: [] };
  let list: QmsSop[];
  try { list = await sops.effective(); } catch (e) { if (e instanceof SopsOff) return { text, problems: [SOPS_OFF], off: true }; throw e; }
  const byNumber = new Map(list.map((s) => [s.number.toUpperCase(), s.number]));
  const problems = added.filter((r) => !byNumber.has(r.toUpperCase())).map((r) => `SOP ${r} is not an effective SOP in QMS: ${SOPS_FROM_QMS}`);
  const out = [...new Set(refs.map((r) => (known.has(r.toUpperCase()) ? r : byNumber.get(r.toUpperCase()) ?? r)))];
  return { text: out.join(', '), problems };
}
