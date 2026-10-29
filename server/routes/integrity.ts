import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requireRole } from '../auth.js';
import { runIntegrityCheck } from '../integrity.js';

// LB-23: latest integrity-check result, and a manual run for QA/Admin.
export function integrityRoutes(app: FastifyInstance, sql: Sql) {
  const allowed = { preHandler: requireRole('qa', 'admin') };

  app.get('/api/integrity', allowed, async () => {
    const [last] = await sql`
      select at, action, new_value as result from audit_log
      where object_type = 'system' and object_id = 'integrity' order by at desc limit 1`;
    return last ?? null;
  });

  app.post('/api/integrity/run', allowed, async (req) => runIntegrityCheck(sql, req.user!.id));
}
