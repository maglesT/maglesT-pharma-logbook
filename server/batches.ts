import type { Sql } from './db.js';
import { ConnectionOff } from './master.js';

// Owner 2026-11-12: the batch of a use or change over is chosen from the batch records, never typed. The Logbook reads
// the batch-record products' report views through the platform links (report.batch_fact_v1: batches with product and
// status; report.equipment_use_v1: which equipment a batch uses), live, with its own login. Nothing is copied or written.
// Without a link the batch is typed as before. D-69: each linked product is read on its own; a batch none of them lists
// may be typed by hand (its product picked from master data), and the entry is marked "Typed by hand".
// D-45 (owner 15 Nov 2026): TrueBatch Tablets publishes these views (TRUEBATCH_DATABASE_URL). D-68: Batchwright is
// retired; its link, its abnormal records (Home, D-41) and their reader are gone.
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
  /** The TrueBatch product that keeps the batch record. */
  source: BatchSource;
}
export type BatchSource = 'TrueBatch' | 'TrueBatch Packing' | 'TrueBatch Injectables' | 'TrueBatch Injectables Packing';
export interface Batches {
  /** The linked batch-record products, in words (for messages). */
  source: string;
  /** Batches in production, and those finished in the last `recentDays` days (for "from batch" of a change over). */
  list(recentDays: number): Promise<Batch[]>;
  get(batchNumber: string): Promise<Batch | null>;
  /** Batch numbers the batch records show as using one of these equipment or room codes. */
  usedOn(codes: string[]): Promise<Set<string>>;
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

// A batch is in production until its batch record shows it complete, reviewed, released, rejected or cancelled.
const IN_PRODUCTION = `(completed_at is null and not coalesce(released, false)
  and status !~* '(complete|review|releas|reject|cancel|clos|destroy|abort)')`;
const COLS = `batch_number, product_code, strength as strength, status, issued_at::text, completed_at::text, coalesce(released, false) as released,
  ${IN_PRODUCTION} as in_production`;
type Row = { batch_number: string; product_code: string; strength: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean; in_production: boolean };
const toBatch = (source: BatchSource) => (r: Row): Batch => ({ batchNumber: r.batch_number, productCode: r.product_code, strength: r.strength,
  status: r.status, issuedAt: r.issued_at, completedAt: r.completed_at, released: r.released, inProduction: r.in_production, source });

/** A TrueBatch product's batch records (a packing product's batches are its `packing_batch_v1`, D-61). */
export function sqlBatches(q: Sql, schema = 'report', source: BatchSource = 'TrueBatch', batchView = 'batch_fact_v1'): Batches {
  const read = async <T>(f: () => Promise<T>) => {
    try { return await f(); } catch (e) { if (isCut(e)) throw new TrueBatchOff(source); throw e; }
  };
  const v = (name: string) => q(`${schema}.${name}`);
  const batch = toBatch(source);
  // A packing batch has no strength of its own.
  const cols = batchView === 'packing_batch_v1' ? COLS.replace('strength as strength', 'null::text as strength') : COLS;
  return {
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
// D-67: productCode, the batch's product (from the batch view; null without one, e.g. packing).
export interface TrueBatchUse { code: string; batchNumber: string; step: string; startedAt: Date; endedAt: Date | null; source: UseSource; productCode?: string | null }
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
        const product = batchView ? q`(select b.product_code from ${v(batchView)} b where b.batch_number = u.batch_number limit 1)` : q`null::text`;
        return (await q<{ code: string; batch_number: string; step: string; started_at: Date; ended_at: Date | null; product_code: string | null }[]>`
          select distinct on (upper(u.equipment_code), u.ended_at is null) upper(u.equipment_code) as code, u.batch_number,
            coalesce(nullif(to_jsonb(u)->>'step_name', ''), u.step) as step,
            coalesce(u.started_at, u.data_as_of) as started_at, u.ended_at, ${product} as product_code
          from ${v('equipment_use_v1')} u
          where upper(u.equipment_code) = any(${codes.map((c) => c.toUpperCase())})
            and (u.ended_at is not null or ${inProduction})
          order by upper(u.equipment_code), u.ended_at is null, coalesce(u.ended_at, u.started_at) desc nulls last`)
          .map((r) => ({ code: r.code, batchNumber: r.batch_number, step: r.step ?? '', startedAt: r.started_at, endedAt: r.ended_at, source,
            productCode: r.product_code }));
      } catch (e) { if (isCut(e)) throw new UsesOff(source); throw e; }
    },
  };
}

/** The batch records of every linked product, read each on its own (D-69): a product that does not answer is left out. */
export interface BatchRecords {
  /** The linked batch-record products, in words (for messages). */
  source: string;
  /** The batches of the products that answered, and the products that did not. */
  list(recentDays: number): Promise<{ batches: Batch[]; down: BatchSource[] }>;
  /** The batch, from the first product (in the order given) that has it; and the products that did not answer. */
  get(batchNumber: string): Promise<{ batch: Batch | null; down: BatchSource[] }>;
  /** Batch numbers the products that answered show as using one of these equipment or room codes. */
  usedOn(codes: string[]): Promise<Set<string>>;
}
/** D-69: the one-line note for a batch-record product that does not answer. */
export const batchesOffNote = (source: string) => `Connection to ${source} is off: its batches are not listed.`;

/**
 * D-45: the batch records of every linked product as one (null when none is linked). A batch number is looked up in
 * each; the first product (in the order given) that has it wins.
 * D-69 (owner 17 Nov 2026, G2): each product is read on its own. One that does not answer is skipped and named in
 * `down` (the picker says so in one line); the others still answer, so one link down never stops every use.
 */
export function mergeBatches(sources: (Batches | null)[]): BatchRecords | null {
  const all = sources.filter((s): s is Batches => s !== null);
  if (!all.length) return null;
  // Every product's answer, or null for one whose link is off; any other error stops as before.
  const each = async <T>(f: (s: Batches) => Promise<T>) => {
    const got = await Promise.allSettled(all.map(f));
    const down: BatchSource[] = [];
    const values: T[] = [];
    got.forEach((g, i) => {
      if (g.status === 'fulfilled') values.push(g.value);
      else if (g.reason instanceof TrueBatchOff) down.push(all[i]!.source as BatchSource);
      else throw g.reason;
    });
    return { values, down };
  };
  return {
    source: all.map((s) => s.source).join(', '),
    list: async (recentDays) => {
      const { values, down } = await each((s) => s.list(recentDays));
      const seen = new Set<string>();
      return { batches: values.flat().filter((b) => !seen.has(b.batchNumber) && seen.add(b.batchNumber)), down };
    },
    get: async (batchNumber) => {
      const { values, down } = await each((s) => s.get(batchNumber));
      return { batch: values.find((b) => b !== null) ?? null, down };
    },
    usedOn: async (codes) => new Set((await each((s) => s.usedOn(codes))).values.flatMap((u) => [...u])),
  };
}
