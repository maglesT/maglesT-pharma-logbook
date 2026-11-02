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
}

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
// A cut link: the grant is gone (42501) or the login is off (28000).
const isCut = (e: unknown) => ['42501', '28000'].includes((e as { code?: string }).code ?? '');

/** Reads master_data's views; a cut link throws ConnectionOff and nothing is served from a copy (platform D-02). */
export function sqlMaster(md: Sql): Master {
  const read = async <T>(q: () => Promise<T>) => {
    try { return await q(); } catch (e) { if (isCut(e)) throw new ConnectionOff(); throw e; }
  };
  const row = (kind: Kind) => (r: Record<string, unknown>): MasterItem => ({
    itemId: r.id as string, code: r.code as string, name: r.name as string, version: r.version as number, active: r.active as boolean, kind,
    room: (r.room_code as string | null) ?? null, make: (r.make as string | null) ?? null, model: (r.model as string | null) ?? null,
    serial: (r.serial as string | null) ?? null, needsCalibration: Boolean(r.needs_calibration),
  });
  return {
    items: () => read(async () => [
      ...(await md`select id, code, name, version, active, room_code, make, model, serial from report.equipment_v1`).map(row('equipment')),
      ...(await md`select id, code, name, version, active, room_code, make, model, serial, needs_calibration from report.instrument_v1`).map(row('instrument')),
      ...(await md`select id, code, name, version, active from report.room_v1`).map(row('area')),
    ]),
    products: () => read(async () => (await md<MasterProduct[]>`
      select id as "itemId", code, name, version, active from report.product_v1`).map((p) => ({ ...p }))),
  };
}

export interface LogbookItem extends MasterItem {
  id: number;                   // local id
  sterile: boolean;
  classified: boolean;
  cleanHoldHours: number | null;
  needsCalibration: boolean;    // the Logbook's own setting
}

/**
 * Every master equipment, instrument and room with its local id and Logbook settings. A master item seen for the
 * first time gets its local row here (the id map); a code still held by a local item not yet moved (B1-5) is skipped.
 * The row's old name and location columns get the values at first sight: only report.equipment_v1 shows them,
 * documented as "as at the move or first sight" (D-29 4).
 */
export async function logbookItems(sql: Sql | Tx, master: Master): Promise<LogbookItem[]> {
  const items = await master.items();
  if (items.length) {
    await sql`
      insert into equipment (item_id, code, name, kind, location, needs_calibration)
      select m.item_id::uuid, m.code, m.name, m.kind, coalesce(m.room, ''), m.needs_calibration
      from jsonb_to_recordset(${sql.json(items.map((i) => ({ item_id: i.itemId, code: i.code, name: i.name, kind: i.kind, room: i.room,
        needs_calibration: i.kind === 'instrument' && i.needsCalibration })) as never)})
        as m(item_id text, code text, name text, kind text, room text, needs_calibration boolean)
      where not exists (select 1 from equipment e where e.item_id = m.item_id::uuid or lower(e.code) = lower(m.code))
      on conflict do nothing`;
  }
  const local = new Map((await sql<{ id: number; item_id: string; sterile: boolean; classified: boolean; clean_hold_hours: number | null; needs_calibration: boolean }[]>`
    select id::int, item_id::text, sterile, classified, clean_hold_hours, needs_calibration from equipment where item_id is not null`)
    .map((r) => [r.item_id, r]));
  return items.flatMap((m) => {
    const l = local.get(m.itemId);
    return l ? [{ ...m, id: l.id, sterile: l.sterile, classified: l.classified, cleanHoldHours: l.clean_hold_hours, needsCalibration: l.needs_calibration }] : [];
  }).sort((a, b) => a.code.localeCompare(b.code));
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
