import type { Sql } from './db.js';
import { ConnectionOff } from './master.js';

// Owner 2026-11-12 (platform D-24): the Logbook pulls an item's qualification status, requalification due date and its
// protocols from the Qualification product's report views (report.qualification_v1, report.protocol_v1), read live
// through the platform link with the Logbook's own login. Nothing is copied. Without the link the Logbook runs without
// requalification data (and cannot check that an item it adds is qualified).

export interface QualStatus {
  masterId: string;
  code: string;
  status: 'not_qualified' | 'qualified' | 'qualified_conditions' | 'requalification_needed';
  nextReviewDue: string | null;      // plant date YYYY-MM-DD
}
export interface QualProtocol {
  number: string;
  masterId: string;
  itemCode: string;
  stage: string;                      // template: iq, oq, pq, iq_oq, periodic_review, ...
  step: string;
  approvedAt: string | null;
  reportOutcome: string | null;
  reportRelease: string | null;
  statusDecided: string | null;
  nextReviewDueDecided: string | null;
  reportApprovedAt: string | null;
}
// D-73: a media fill (aseptic process simulation) is a protocol of stage media_fill on the item it was run on (a barrier
// machine or its room); once QA approved its report: the outcome (pass, pass_conditions, fail) and the next media fill date.
export interface MediaFill {
  number: string;
  masterId: string;
  itemCode: string;
  outcome: string | null;
  approvedAt: string;                 // ISO time QA approved the report
  nextDue: string | null;             // plant date YYYY-MM-DD
}
export interface Qualification {
  statuses(): Promise<Map<string, QualStatus>>;          // by master item id
  protocols(masterId: string): Promise<QualProtocol[]>;
  /** D-73: the newest approved media fill of each item (by master item id). Optional: a reader without it shows none. */
  mediaFills?(): Promise<Map<string, MediaFill>>;
}

const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '42P01', '28000', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};
export const QUAL_OFF = 'Connection to the Qualification system is off. Ask your administrator.';
export class QualificationOff extends ConnectionOff {
  constructor() { super(); this.message = QUAL_OFF; }
}

export function sqlQualification(q: Sql): Qualification {
  const read = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (isCut(e)) throw new QualificationOff(); throw e; } };
  return {
    statuses: () => read(async () => new Map((await q<{ master_id: string; code: string; status: QualStatus['status']; due: string | null }[]>`
      select master_id::text, code, status, next_review_due::text as due from report.qualification_v1 where master_id is not null`)
      .map((r) => [r.master_id, { masterId: r.master_id, code: r.code, status: r.status, nextReviewDue: r.due }]))),
    protocols: (masterId) => read(async () => (await q<Record<string, string | null>[]>`
      select number, master_id::text, item_code, stage, step, approved_at::text, report_outcome, report_release, status_decided,
        next_review_due_decided::text, report_approved_at::text
      from report.protocol_v1 where master_id = ${masterId}::uuid order by number desc`).map((r) => ({
      number: r.number!, masterId: r.master_id!, itemCode: r.item_code!, stage: r.stage!, step: r.step!, approvedAt: r.approved_at ?? null,
      reportOutcome: r.report_outcome ?? null, reportRelease: r.report_release ?? null, statusDecided: r.status_decided ?? null,
      nextReviewDueDecided: r.next_review_due_decided ?? null, reportApprovedAt: r.report_approved_at ?? null }))),
    mediaFills: () => read(async () => new Map((await q<{ number: string; master_id: string; item_code: string | null; outcome: string | null; approved: Date; due: string | null }[]>`
      select distinct on (master_id) number, master_id::text, item_code, report_outcome as outcome, report_approved_at as approved,
        next_review_due_decided::text as due
      from report.protocol_v1 where stage = 'media_fill' and report_approved_at is not null and master_id is not null
      order by master_id, report_approved_at desc`)
      .map((r) => [r.master_id, { number: r.number, masterId: r.master_id, itemCode: r.item_code ?? '', outcome: r.outcome ?? null,
        approvedAt: new Date(r.approved).toISOString(), nextDue: r.due ?? null }]))),
  };
}
