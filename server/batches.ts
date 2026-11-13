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
  /** Owner 2026-11-13: only the abnormal records of the batch records, of the last `days` days (and every open one). */
  abnormal(days: number): Promise<Abnormal>;
}
export interface BatchException {
  batchNumber: string; exceptionId: string; type: string; category: string; severity: string; step: string | null; stepTitle: string | null;
  description: string | null; status: string; disposition: string | null; disposedAt: string | null; raisedAt: string;
}
export interface IpcAbnormal { batchNumber: string; step: string | null; stepTitle: string | null; checkKind: string; item: string | null; instrumentCode: string | null;
  value: string | null; unit: string | null; lower: string | null; upper: string | null; result: string; recordedAt: string }
export interface ProcessAbnormal { batchNumber: string; step: string | null; tag: string; value: string | null; unit: string | null; lower: string | null; upper: string | null; recordedAt: string }
export interface AlarmAbnormal { code: string; source: string; subject: string | null; batchNumbers: string[]; raisedAt: string }
export interface Abnormal { exceptions: BatchException[]; ipc: IpcAbnormal[]; process: ProcessAbnormal[]; alarms: AlarmAbnormal[] }

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
    abnormal: (days) => read(() => q.begin('read only', async (tx) => {
      await tx`set local statement_timeout = '15s'`;
      const since = tx`now() - make_interval(days => ${days})`;
      const exceptions = (await tx<Record<string, string | null>[]>`
        select batch_number, exception_id::text, exception_type, category, severity, step, step_title, description, status, disposition,
          disposed_at::text, raised_at::text
        from ${v('exception_detail_v1')} where status <> 'DISPOSITIONED' or raised_at > ${since} order by raised_at desc limit 1000`).map((r) => ({
        batchNumber: r.batch_number!, exceptionId: r.exception_id!, type: r.exception_type!, category: r.category ?? '', severity: r.severity ?? '',
        step: r.step, stepTitle: r.step_title, description: r.description, status: r.status ?? '', disposition: r.disposition, disposedAt: r.disposed_at,
        raisedAt: r.raised_at! }));
      const ipc = (await tx<Record<string, string | null>[]>`
        select batch_number, step, step_title, check_kind, item, instrument_code, value_text, unit, lower_text, upper_text, result, recorded_at::text
        from ${v('ipc_result_v1')} where result in ('FAIL', 'ALERT') and recorded_at > ${since} order by recorded_at desc limit 500`).map((r) => ({
        batchNumber: r.batch_number!, step: r.step, stepTitle: r.step_title, checkKind: r.check_kind ?? '', item: r.item, instrumentCode: r.instrument_code,
        value: r.value_text, unit: r.unit, lower: r.lower_text, upper: r.upper_text, result: r.result!, recordedAt: r.recorded_at! }));
      const process = (await tx<Record<string, string | null>[]>`
        select batch_number, step, tag, value_text, unit, lower_text, upper_text, recorded_at::text
        from ${v('process_actual_v1')} where within_limits = false and recorded_at > ${since} order by recorded_at desc limit 500`).map((r) => ({
        batchNumber: r.batch_number!, step: r.step, tag: r.tag ?? '', value: r.value_text, unit: r.unit, lower: r.lower_text, upper: r.upper_text, recordedAt: r.recorded_at! }));
      const alarms = (await tx<{ alarm_code: string; source: string; subject_code: string | null; batch_numbers: string[] | null; raised_at: string }[]>`
        select alarm_code, source, subject_code, batch_numbers, raised_at::text from ${v('alarm_v1')}
        where gmp_critical and acked_at is null order by raised_at desc limit 200`).map((r) => ({
        code: r.alarm_code, source: r.source, subject: r.subject_code, batchNumbers: r.batch_numbers ?? [], raisedAt: r.raised_at }));
      return { exceptions, ipc, process, alarms } as Abnormal;
    })),
  };
}
