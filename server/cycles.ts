import type { Sql } from './db.js';
import { isCut } from './batches.js';
import { ConnectionOff } from './master.js';
import type { TrueBatchName } from './truebatch-providers.js';

// D-78 (owner, 19 Nov 2026: the product that owns a job keeps it, the linked one reads it): TrueBatch Injectables owns the
// sterilisation cycles run for its batches and publishes them in report.steriliser_cycle_v1 (one row per signed cycle:
// steriliser or isolator, batch, load, printout reference, result and figures). With its link on (the same
// TRUEBATCH_INJECTABLES_DATABASE_URL that gives its batches and uses, D-52) the Logbook reads them live and shows them read
// only in the item's history; it records only cycles not made for a batch. Nothing is copied or written.

export interface SterileCycle {
  cycleId: string;
  batchNumber: string;
  productCode: string | null;
  step: string;
  cycleType: string;
  programme: string | null;
  load: string | null;
  controllerRecordRef: string | null;
  startedAt: Date;
  endedAt: Date | null;
  result: string;
  exposureMin: number | null;
  lowestTempC: number | null;
  lowestF0: number | null;
  maxProductTempC: number | null;
  h2o2Ppm: number | null;
  leakRate: number | null;
  units: number | null;
  biId: string | null;
  useBy: string | null;
  signed: string[];
  source: TrueBatchName;
}
export interface SterileCycles {
  /** The product that records the cycles (for messages). */
  source: TrueBatchName;
  /** Every cycle run on one item (its code) that started in the period [from, to), oldest first. */
  inPeriod(code: string, from: Date, to: Date): Promise<SterileCycle[]>;
  /** The words (upper case) that are batch numbers of the product's batch records. */
  batchesIn(words: string[]): Promise<string[]>;
}
/** The cycles could not be read: the link is off (or the view is not granted yet). */
export class CyclesOff extends ConnectionOff {
  constructor(readonly source: TrueBatchName) { super(); this.message = `Connection to ${source} (sterilisation cycles) is off. Ask your administrator.`; }
}
/** What a product that does not answer leaves out of the history card. */
export const cyclesOffHistoryNote = (source: string) => `Connection to ${source} is off: its sterilisation cycles on this item are not shown.`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function sqlCycles(q: Sql, schema = 'report', source: TrueBatchName = 'TrueBatch Injectables'): SterileCycles {
  const v = (name: string) => q(`${schema}.${name}`);
  const read = async <T>(f: () => Promise<T>) => {
    try { return await f(); } catch (e) { if (isCut(e)) throw new CyclesOff(source); throw e; }
  };
  return {
    source,
    inPeriod: (code, from, to) => read(async () => (await q<Record<string, unknown>[]>`
      select cycle_id, batch_number, product_code, coalesce(nullif(step_name, ''), step_key) as step, cycle_type, programme, load,
        controller_record_ref, started_at, ended_at, result, exposure_min, lowest_temp_c, lowest_f0, max_product_temp_c, h2o2_ppm, leak_rate,
        units, bi_id, use_by::text, signed
      from ${v('steriliser_cycle_v1')}
      where upper(equipment_code) = ${code.toUpperCase()} and started_at < ${to} and coalesce(ended_at, started_at) >= ${from}
      order by started_at, cycle_id limit 5000`).map((r) => ({
      cycleId: String(r.cycle_id), batchNumber: String(r.batch_number), productCode: (r.product_code as string | null) ?? null, step: String(r.step ?? ''),
      cycleType: String(r.cycle_type), programme: (r.programme as string | null) ?? null, load: (r.load as string | null) ?? null,
      controllerRecordRef: (r.controller_record_ref as string | null) ?? null, startedAt: r.started_at as Date, endedAt: (r.ended_at as Date | null) ?? null,
      result: String(r.result), exposureMin: num(r.exposure_min), lowestTempC: num(r.lowest_temp_c), lowestF0: num(r.lowest_f0),
      maxProductTempC: num(r.max_product_temp_c), h2o2Ppm: num(r.h2o2_ppm), leakRate: num(r.leak_rate), units: num(r.units),
      biId: (r.bi_id as string | null) ?? null, useBy: (r.use_by as string | null) ?? null, signed: (r.signed as string[] | null) ?? [], source,
    }))),
    batchesIn: (words) => read(async () => (words.length ? await q<{ b: string }[]>`
      select distinct upper(batch_number) as b from ${v('batch_fact_v1')} where upper(batch_number) = any(${words})` : []).map((r) => r.b)),
  };
}

/** The figures of a cycle, in words, as present (for the history card and its copies). */
export function cycleLines(c: SterileCycle): string[] {
  const fig = (label: string, value: number | null, unit: string) => (value === null ? '' : `${label} ${value}${unit}`);
  return [
    `Batch ${c.batchNumber}${c.productCode ? ` · ${c.productCode}` : ''}`,
    `Cycle ${c.cycleId} · ${c.cycleType.replaceAll('_', ' ')}${c.programme ? ` · ${c.programme}` : ''}`,
    `Result: ${c.result}`,
    c.load ? `Load: ${c.load}` : '',
    c.controllerRecordRef ? `Printout: ${c.controllerRecordRef}` : '',
    [fig('Exposure', c.exposureMin, ' min'), fig('Lowest temp', c.lowestTempC, ' °C'), fig('F0', c.lowestF0, ' min'), fig('Max product temp', c.maxProductTempC, ' °C'),
      fig('H2O2', c.h2o2Ppm, ' ppm'), fig('Leak rate', c.leakRate, ''), fig('Units', c.units, '')].filter(Boolean).join(' · '),
    c.biId ? `BI: ${c.biId}` : '',
    c.useBy ? `Use by ${c.useBy}` : '',
    c.step ? `Step: ${c.step}` : '',
  ].filter(Boolean);
}

/** D-78: the words of a typed text that may be a batch number (upper case, at most 50). */
export const batchWords = (...texts: string[]) =>
  [...new Set(texts.flatMap((t) => t.toUpperCase().split(/[\s,;:()/]+/)).map((w) => w.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '')).filter((w) => w.length >= 3))].slice(0, 50);
