import type { Sql } from './db.js';
import { ConnectionOff } from './master.js';

// Owner 2026-11-12: the batch of a use or change over is chosen from the batch records, never typed. The Logbook reads
// Batchwright's report views through the platform link (report.batch_fact_v1: batches with product and status;
// report.equipment_use_v1: which equipment a batch uses), live, with its own login. Nothing is copied or written.
// Without the link (no Batchwright on the site) the batch is typed as before.

export interface Batch {
  batchNumber: string;
  productCode: string;
  strength: string | null;
  status: string;
  issuedAt: string | null;
  completedAt: string | null;
  released: boolean;
  inProduction: boolean;
}
export interface Batches {
  /** Batches in production, and those finished in the last `recentDays` days (for "from batch" of a change over). */
  list(recentDays: number): Promise<Batch[]>;
  get(batchNumber: string): Promise<Batch | null>;
  /** Batch numbers Batchwright records as using one of these equipment or room codes. */
  usedOn(codes: string[]): Promise<Set<string>>;
}

export const BATCHWRIGHT_OFF = 'Connection to Batchwright (batch records) is off. Ask your administrator.';
export class BatchwrightOff extends ConnectionOff {
  constructor() { super(); this.message = BATCHWRIGHT_OFF; }
}
const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '42P01', '28000', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

// A batch is in production until Batchwright records it complete, reviewed, released, rejected or cancelled.
const IN_PRODUCTION = `(completed_at is null and not coalesce(released, false)
  and status !~* '(complete|review|releas|reject|cancel|clos|destroy|abort)')`;
const COLS = `batch_number, product_code, strength, status, issued_at::text, completed_at::text, coalesce(released, false) as released,
  ${IN_PRODUCTION} as in_production`;
type Row = { batch_number: string; product_code: string; strength: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean; in_production: boolean };
const toBatch = (r: Row): Batch => ({ batchNumber: r.batch_number, productCode: r.product_code, strength: r.strength, status: r.status,
  issuedAt: r.issued_at, completedAt: r.completed_at, released: r.released, inProduction: r.in_production });

export function sqlBatches(q: Sql, schema = 'report'): Batches {
  const read = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (isCut(e)) throw new BatchwrightOff(); throw e; } };
  const v = (name: string) => q(`${schema}.${name}`);
  return {
    list: (recentDays) => read(async () => (await q<Row[]>`
      select ${q.unsafe(COLS)} from ${v('batch_fact_v1')}
      where ${q.unsafe(IN_PRODUCTION)} or completed_at > now() - make_interval(days => ${recentDays})
      order by issued_at desc nulls last, batch_number limit 500`).map(toBatch)),
    get: (batchNumber) => read(async () => {
      const [r] = await q<Row[]>`select ${q.unsafe(COLS)} from ${v('batch_fact_v1')} where batch_number = ${batchNumber} limit 1`;
      return r ? toBatch(r) : null;
    }),
    usedOn: (codes) => read(async () => new Set((await q<{ batch_number: string }[]>`
      select distinct batch_number from ${v('equipment_use_v1')}
      where upper(equipment_code) = any(${codes.map((c) => c.toUpperCase())}) or upper(room_code) = any(${codes.map((c) => c.toUpperCase())})`)
      .map((r) => r.batch_number))),
  };
}
