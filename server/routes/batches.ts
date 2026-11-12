import type { FastifyInstance } from 'fastify';
import type { Sql, Tx } from '../db.js';
import { parseId, requirePermission } from '../auth.js';
import { logbookItem, logbookProducts } from '../master.js';
import type { Batch } from '../batches.js';

// Owner 2026-11-12: the batch list of the use and change-over forms, from Batchwright's batch records (platform link).
export const RECENT_DAYS = 60;

export interface BatchChoice extends Batch { productId: number | null; productName: string | null; onThisItem: boolean }

/** Batchwright's batch with the Logbook's product for its product code (null when master data has no such product). */
export async function batchWithProduct(q: Sql | Tx, app: FastifyInstance, batchNumber: string) {
  const batch = await app.batches!.get(batchNumber);
  if (!batch) return null;
  const p = (await logbookProducts(q, app.master)).find((x) => x.code === batch.productCode && x.active);
  return { batch, productId: p?.id ?? null, productLabel: p ? `${p.code} · ${p.name}` : batch.productCode };
}

export function batchRoutes(app: FastifyInstance, sql: Sql) {
  app.get<{ Params: { id: string } }>('/api/equipment/:id/batches', { preHandler: requirePermission() }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    if (!app.batches) return { linked: false, batches: [] };
    const item = await logbookItem(sql, app.master, id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const [list, used, products] = await Promise.all([
      app.batches.list(RECENT_DAYS), app.batches.usedOn([item.code, ...(item.room ? [item.room] : [])]), logbookProducts(sql, app.master)]);
    const byCode = new Map(products.filter((p) => p.active).map((p) => [p.code, p]));
    const batches: BatchChoice[] = list.map((b) => ({ ...b, productId: byCode.get(b.productCode)?.id ?? null,
      productName: byCode.get(b.productCode)?.name ?? null, onThisItem: used.has(b.batchNumber) }))
      .sort((a, b) => Number(b.inProduction) - Number(a.inProduction) || Number(b.onThisItem) - Number(a.onThisItem)
        || (b.issuedAt ?? '').localeCompare(a.issuedAt ?? '') || a.batchNumber.localeCompare(b.batchNumber));
    return { linked: true, batches };
  });
}
