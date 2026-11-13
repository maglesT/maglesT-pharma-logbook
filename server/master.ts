import type { Sql, Tx } from './db.js';

// B1-3 (D-29): master data is Medhanta core's. The Logbook reads it live through master_data's report.*_v1 views
// with its own login (platform PL-08) and keeps no copy (platform D-02). Its `equipment` and `products` tables are
// id maps: the local id its records refer to, the master item id, and the immutable code; `equipment` also keeps the
// Logbook's own per-item settings (sterile, classified, clean-hold hours, needs calibration; D-29 3).

export type Kind = 'equipment' | 'instrument' | 'area';

export interface MasterItem {
  itemId: string;
  code: string;
  name: string;
  version: number;
  active: boolean;
  kind: Kind;
  room: string | null;          // located in (room code); null for a room
  make: string | null;
  model: string | null;
  serial: string | null;
  needsCalibration: boolean;    // master's default for a new instrument
  // Owner 2026-11-13: a room's area (department), for the dashboard's grouping; null for equipment and instruments.
  area?: string | null;
  // Platform D-24: maintenance, cleaning and requalification parameters, kept once in master data (null: not set).
  care: Care;
}

export interface Care {
  cleanHoldHours: number | null;
  dirtyHoldHours: number | null;
  cleaningBasis: 'operation' | 'frequency' | null;   // rooms only
  cleaningFrequencyHours: number | null;              // frequency-based rooms
  pmFrequencyDays: number | null;
  calibrationFrequencyDays: number | null;
  requalificationFrequencyMonths: number | null;
}
export const NO_CARE: Care = { cleanHoldHours: null, dirtyHoldHours: null, cleaningBasis: null, cleaningFrequencyHours: null,
  pmFrequencyDays: null, calibrationFrequencyDays: null, requalificationFrequencyMonths: null };
const int = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
// The parameters are read by column name from the row as JSON, so a master_data without them (before its 0003) still works.
const careOf = (j: Record<string, unknown> | null | undefined, kind: Kind): Care => j ? {
  cleanHoldHours: int(j.clean_hold_hours), dirtyHoldHours: int(j.dirty_hold_hours),
  cleaningBasis: kind === 'area' ? (j.cleaning_basis === 'frequency' ? 'frequency' : 'operation') : null,
  cleaningFrequencyHours: kind === 'area' && j.cleaning_basis === 'frequency' ? int(j.cleaning_frequency_hours) : null,
  pmFrequencyDays: int(j.pm_frequency_days), calibrationFrequencyDays: kind === 'area' ? null : int(j.calibration_frequency_days),
  requalificationFrequencyMonths: int(j.requalification_frequency_months),
} : { ...NO_CARE, cleaningBasis: kind === 'area' ? 'operation' : null };

export interface MasterProduct { itemId: string; code: string; name: string; version: number; active: boolean }

export interface Master {
  items(): Promise<MasterItem[]>;
  products(): Promise<MasterProduct[]>;
}

export const CONNECTION_OFF = 'Connection to master data is off. Ask your administrator.';
export class ConnectionOff extends Error {
  statusCode = 503;
  constructor() { super(CONNECTION_OFF); }
}
// A cut link: the grant is gone (42501), the login is off (28000), or master_data cannot be reached (connection
// errors: class 08, admin shutdown 57P01, or the client's own connect errors).
const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '28000', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

/** Reads master_data's views; a cut link throws ConnectionOff and nothing is served from a copy (platform D-02). */
export function sqlMaster(md: Sql): Master {
  const read = async <T>(q: () => Promise<T>) => {
    try { return await q(); } catch (e) { if (isCut(e)) throw new ConnectionOff(); throw e; }
  };
  const row = (kind: Kind) => (r: Record<string, unknown>): MasterItem => ({
    itemId: r.id as string, code: r.code as string, name: r.name as string, version: r.version as number, active: r.active as boolean, kind,
    room: (r.room_code as string | null) ?? null, make: (r.make as string | null) ?? null, model: (r.model as string | null) ?? null,
    serial: (r.serial as string | null) ?? null, needsCalibration: Boolean(r.needs_calibration),
    care: careOf(r.j as Record<string, unknown> | null, kind),
    area: kind === 'area' ? ((r.j as Record<string, unknown> | null)?.area as string | null) ?? null : null,
  });
  return {
    items: () => read(async () => [
      ...(await md`select id, code, name, version, active, room_code, make, model, serial, to_jsonb(v.*) as j from report.equipment_v1 v`).map(row('equipment')),
      ...(await md`select id, code, name, version, active, room_code, make, model, serial, needs_calibration, to_jsonb(v.*) as j from report.instrument_v1 v`).map(row('instrument')),
      ...(await md`select id, code, name, version, active, to_jsonb(v.*) as j from report.room_v1 v`).map(row('area')),
    ].sort((a, b) => a.itemId.localeCompare(b.itemId))),   // one insert order everywhere (no deadlock on first sight)
    products: () => read(async () => (await md<MasterProduct[]>`
      select id as "itemId", code, name, version, active from report.product_v1 order by id`).map((p) => ({ ...p }))),
  };
}

export interface LogbookItem extends MasterItem {
  id: number;                   // local id
  sterile: boolean;
  classified: boolean;
  addedAt: Date;                // when the item was added to the Logbook (the start of its PM schedule if none is on record)
}

/**
 * The items of the Logbook: those added to it (owner 2026-11-12, point 4: an item is chosen by its ID, the rest comes
 * from master data), read live from master data with the Logbook's own settings (sterile, classified). Name, location,
 * hold times, frequencies and whether it needs calibration are master data's (platform D-24): the Logbook keeps no copy.
 */
export async function logbookItems(sql: Sql | Tx, master: Master): Promise<LogbookItem[]> {
  const items = await master.items();
  const local = new Map((await sql<{ id: number; item_id: string; sterile: boolean; classified: boolean; created_at: Date }[]>`
    select id::int, item_id::text, sterile, classified, created_at from equipment where item_id is not null`)
    .map((r) => [r.item_id, r]));
  return items.flatMap((m) => {
    const l = local.get(m.itemId);
    return l ? [{ ...m, id: l.id, sterile: l.sterile, classified: l.classified, addedAt: l.created_at }] : [];
  }).sort((a, b) => a.code.localeCompare(b.code));
}

/** Adds a master item to the Logbook (its local row: the id map). Returns the local id, or null when the code is taken. */
export async function addToLogbook(sql: Sql | Tx, m: MasterItem, settings: { sterile: boolean; classified: boolean }): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    insert into equipment (item_id, code, name, kind, location, needs_calibration, sterile, classified)
    select ${m.itemId}::uuid, ${m.code}, ${m.name}, ${m.kind}, ${m.room ?? ''}, ${needsCalibrationOf(m)}, ${settings.sterile}, ${settings.classified}
    where not exists (select 1 from equipment e where e.item_id = ${m.itemId}::uuid or lower(e.code) = lower(${m.code}))
    on conflict do nothing returning id::int`;
  return row?.id ?? null;
}

/** The parameters the status needs, by local id (platform D-24). */
export const needsCalibrationOf = (i: MasterItem) => i.kind !== 'area' && (i.needsCalibration || i.care.calibrationFrequencyDays !== null);
export async function careByLocalId(sql: Sql | Tx, master: Master): Promise<Map<number, Care & { needsCalibration: boolean; addedAt: Date }>> {
  const items = await logbookItems(sql, master);
  // Calibrated when master data says so: marked "needs calibration", or with a calibration frequency. The Logbook's own
  // column only follows master data, for its published equipment_v1 (read by Deviations, D-28); it is never the source.
  const flags = items.map((i) => ({ id: i.id, nc: needsCalibrationOf(i) }));
  if (flags.length) {
    await sql`update equipment e set needs_calibration = f.nc
      from jsonb_to_recordset(${sql.json(flags as never)}) as f(id bigint, nc boolean) where e.id = f.id and e.needs_calibration <> f.nc`;
  }
  return new Map(items.map((i) => [i.id, { ...i.care, addedAt: i.addedAt, needsCalibration: needsCalibrationOf(i) }]));
}

/** One item by local id, read live; undefined if unknown. */
export async function logbookItem(sql: Sql | Tx, master: Master, id: number): Promise<LogbookItem | undefined> {
  return (await logbookItems(sql, master)).find((i) => i.id === id);
}

/** Every master product with its local id (the id map), made on first sight like items. */
export async function logbookProducts(sql: Sql | Tx, master: Master): Promise<(MasterProduct & { id: number })[]> {
  const products = await master.products();
  if (products.length) {
    await sql`
      insert into products (item_id, code, name)
      select m.item_id::uuid, m.code, m.name
      from jsonb_to_recordset(${sql.json(products.map((p) => ({ item_id: p.itemId, code: p.code, name: p.name })) as never)})
        as m(item_id text, code text, name text)
      where not exists (select 1 from products p where p.item_id = m.item_id::uuid or lower(p.code) = lower(m.code))
      on conflict do nothing`;
  }
  const local = new Map((await sql<{ id: number; item_id: string }[]>`select id::int, item_id::text from products where item_id is not null`)
    .map((r) => [r.item_id, r.id]));
  return products.flatMap((p) => (local.has(p.itemId) ? [{ ...p, id: local.get(p.itemId)! }] : [])).sort((a, b) => a.code.localeCompare(b.code));
}
