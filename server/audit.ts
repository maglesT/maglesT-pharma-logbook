import type { Sql, Tx } from './db.js';

export interface AuditEvent {
  actorId: number | null;
  action: string;
  objectType: string;
  objectId?: string | number | null;
  old?: unknown;
  new?: unknown;
  reason?: string | null;
}

// LB-18: called inside the same transaction as the change it records.
export async function audit(tx: Tx | Sql, e: AuditEvent): Promise<void> {
  await tx`
    insert into audit_log (actor_id, action, object_type, object_id, old_value, new_value, reason)
    values (${e.actorId}, ${e.action}, ${e.objectType}, ${e.objectId == null ? null : String(e.objectId)},
            ${e.old === undefined ? null : tx.json(e.old as never)},
            ${e.new === undefined ? null : tx.json(e.new as never)},
            ${e.reason ?? null})`;
}
