import type { Sql } from './db.js';
import { ConnectionOff } from './master.js';

// Owner 2026-11-12: the batch of a use or change over is chosen from the batch records, never typed. The Logbook reads
// Batchwright's report views through the platform link (report.batch_fact_v1: batches with product and status;
// report.equipment_use_v1: which equipment a batch uses), live, with its own login. Nothing is copied or written.
// Without the link (no Batchwright on the site) the batch is typed as before.
// D-45 (owner 15 Nov 2026): TrueBatch Tablets publishes views of the same names and columns (batch_fact_v1,
// equipment_use_v1), read the same way through its own link (TRUEBATCH_DATABASE_URL). Either or both may be linked; the
// batch lists are merged. The abnormal records (Home, D-41) are Batchwright's only.
// D-61: TrueBatch Injectables' batches (its batch_fact_v1) and the packing products' batches (report.packing_batch_v1:
// the same columns without a strength) are in the list too, so a packing line's use or change over picks its TP batch.

export interface Batch {
  batchNumber: string;
  productCode: string;
  strength: string | null;
  status: string;
  issuedAt: string | null;
  completedAt: string | null;
  released: boolean;
  inProduction: boolean;
  /** The product that keeps the batch record (Batchwright or TrueBatch). */
  source: BatchSource;
}
export type BatchSource = 'Batchwright' | 'TrueBatch' | 'TrueBatch Packing' | 'TrueBatch Injectables' | 'TrueBatch Injectables Packing';
export interface Batches {
  /** The linked batch-record products, in words (for messages). */
  source: string;
  /** Batches in production, and those finished in the last `recentDays` days (for "from batch" of a change over). */
  list(recentDays: number): Promise<Batch[]>;
  get(batchNumber: string): Promise<Batch | null>;
  /** Batch numbers the batch records show as using one of these equipment or room codes. */
  usedOn(codes: string[]): Promise<Set<string>>;
  /** Owner 2026-11-13: only the abnormal records of the batch records, of the last `days` days (and every open one). */
  abnormal?(days: number): Promise<Abnormal>;
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
export const TRUEBATCH_OFF = 'Connection to TrueBatch (batch records) is off. Ask your administrator.';
export class TrueBatchOff extends ConnectionOff {
  constructor(source = 'TrueBatch') { super(); this.message = `Connection to ${source} (batch records) is off. Ask your administrator.`; }
}
const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '42P01', '28000', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

// A batch is in production until Batchwright records it complete, reviewed, released, rejected or cancelled.
const IN_PRODUCTION = `(completed_at is null and not coalesce(released, false)
  and status !~* '(complete|review|releas|reject|cancel|clos|destroy|abort)')`;
const COLS = `batch_number, product_code, strength as strength, status, issued_at::text, completed_at::text, coalesce(released, false) as released,
  ${IN_PRODUCTION} as in_production`;
type Row = { batch_number: string; product_code: string; strength: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean; in_production: boolean };
const toBatch = (source: BatchSource) => (r: Row): Batch => ({ batchNumber: r.batch_number, productCode: r.product_code, strength: r.strength,
  status: r.status, issuedAt: r.issued_at, completedAt: r.completed_at, released: r.released, inProduction: r.in_production, source });

/** Batchwright's batch records (with its abnormal records), or a TrueBatch product's (the same two views; a packing
 * product's batches are its `packing_batch_v1`, D-61). */
export function sqlBatches(q: Sql, schema = 'report', source: BatchSource = 'Batchwright', batchView = 'batch_fact_v1'): Batches {
  const read = async <T>(f: () => Promise<T>) => {
    try { return await f(); } catch (e) { if (isCut(e)) throw source === 'Batchwright' ? new BatchwrightOff() : new TrueBatchOff(source); throw e; }
  };
  const v = (name: string) => q(`${schema}.${name}`);
  const batch = toBatch(source);
  // A packing batch has no strength of its own.
  const cols = batchView === 'packing_batch_v1' ? COLS.replace('strength as strength', 'null::text as strength') : COLS;
  const common: Batches = {
    source,
    list: (recentDays) => read(async () => (await q<Row[]>`
      select ${q.unsafe(cols)} from ${v(batchView)}
      where ${q.unsafe(IN_PRODUCTION)} or completed_at > now() - make_interval(days => ${recentDays})
      order by issued_at desc nulls last, batch_number limit 500`).map(batch)),
    get: (batchNumber) => read(async () => {
      const [r] = await q<Row[]>`select ${q.unsafe(cols)} from ${v(batchView)} where batch_number = ${batchNumber} limit 1`;
      return r ? batch(r) : null;
    }),
    usedOn: (codes) => read(async () => new Set((await q<{ batch_number: string }[]>`
      select distinct batch_number from ${v('equipment_use_v1')}
      where upper(equipment_code) = any(${codes.map((c) => c.toUpperCase())}) or upper(room_code) = any(${codes.map((c) => c.toUpperCase())})`)
      .map((r) => r.batch_number))),
  };
  if (source !== 'Batchwright') return common;
  return {
    ...common,
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

/**
 * D-46 (owner 15 Nov 2026): a machine or room use recorded in TrueBatch (equipment_use_v1), read live for the status as if
 * the use had been entered in the Logbook. The item is TrueBatch's equipment_code (a room's row names the room there).
 * Open while the batch is not done with the item (ended_at null; D-49: since TrueBatch 1.6.0, until the last stage using it
 * closes, or the batch is approved or terminated); an open use counts only while its batch is in production, so a
 * step left open in a finished or cancelled batch never holds an item.
 * D-47: TrueBatch Tablets Packing publishes the same view, read the same way through its own link; its batches are not
 * read (`batchView` null), so an open packing use holds the item until packing ends it.
 * D-48: the step is shown by its readable name (`step_name`, "Stage › Step", a column both products append to the view)
 * when there is one, else by its key (`step`, "stage/step"). Read through the row as JSON, so a view without the column
 * (a product not yet updated) still answers.
 */
export type UseSource = 'TrueBatch' | 'TrueBatch Packing' | 'TrueBatch Injectables' | 'TrueBatch Injectables Packing';
export interface TrueBatchUse { code: string; batchNumber: string; step: string; startedAt: Date; endedAt: Date | null; source: UseSource }
export interface TrueBatchUses {
  /** The product that records the uses (for messages). */
  source: UseSource;
  /** Per item code (upper case): the newest open use and the newest ended use, at most one of each. */
  latest(codes: string[]): Promise<TrueBatchUse[]>;
}
/** The uses of one product could not be read: its link is off. */
export class UsesOff extends ConnectionOff {
  constructor(readonly source: UseSource) { super(); this.message = `Connection to ${source} (machine and room uses) is off. Ask your administrator.`; }
}
export function sqlTrueBatchUses(q: Sql, schema = 'report', source: UseSource = 'TrueBatch', batchView: string | null = 'batch_fact_v1'): TrueBatchUses {
  const v = (name: string) => q(`${schema}.${name}`);
  return {
    source,
    latest: async (codes) => {
      const inProduction = batchView
        ? q`exists (select 1 from ${v(batchView)} b where b.batch_number = u.batch_number and ${q.unsafe(IN_PRODUCTION)})` : q`true`;
      try {
        return (await q<{ code: string; batch_number: string; step: string; started_at: Date; ended_at: Date | null }[]>`
          select distinct on (upper(u.equipment_code), u.ended_at is null) upper(u.equipment_code) as code, u.batch_number,
            coalesce(nullif(to_jsonb(u)->>'step_name', ''), u.step) as step,
            coalesce(u.started_at, u.data_as_of) as started_at, u.ended_at
          from ${v('equipment_use_v1')} u
          where upper(u.equipment_code) = any(${codes.map((c) => c.toUpperCase())})
            and (u.ended_at is not null or ${inProduction})
          order by upper(u.equipment_code), u.ended_at is null, coalesce(u.ended_at, u.started_at) desc nulls last`)
          .map((r) => ({ code: r.code, batchNumber: r.batch_number, step: r.step ?? '', startedAt: r.started_at, endedAt: r.ended_at, source }));
      } catch (e) { if (isCut(e)) throw new UsesOff(source); throw e; }
    },
  };
}

/**
 * D-45: the batch records of every linked product as one (null when none is linked). A batch number is looked up in
 * each; the first product (in the order given) that has it wins. The list and "used on" need every linked product to
 * answer: one that does not stops them with its own "connection off" (PL-08), as a single link does. A batch found in
 * one product is used even while another does not answer; a batch found in none while one does not answer is that
 * product's "connection off", never "unknown".
 */
export function mergeBatches(sources: (Batches | null)[]): Batches | null {
  const all = sources.filter((s): s is Batches => s !== null);
  if (all.length <= 1) return all[0] ?? null;
  const abnormal = all.find((s) => s.abnormal)?.abnormal;
  return {
    source: all.map((s) => s.source).join(', '),
    list: async (recentDays) => {
      const seen = new Set<string>();
      return (await Promise.all(all.map((s) => s.list(recentDays)))).flat()
        .filter((b) => !seen.has(b.batchNumber) && seen.add(b.batchNumber));
    },
    get: async (batchNumber) => {
      const got = await Promise.allSettled(all.map((s) => s.get(batchNumber)));
      for (const g of got) if (g.status === 'fulfilled' && g.value) return g.value;
      const off = got.find((g) => g.status === 'rejected');
      if (off) throw (off as PromiseRejectedResult).reason;
      return null;
    },
    usedOn: async (codes) => new Set((await Promise.all(all.map((s) => s.usedOn(codes)))).flatMap((u) => [...u])),
    ...(abnormal ? { abnormal } : {}),
  };
}
