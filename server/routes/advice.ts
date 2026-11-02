import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { logbookItems } from '../master.js';
import { parseId, requireRole } from '../auth.js';
import { settingsInForce } from './settings.js';
import type { LogbookSettings } from '../logbook-types.js';
import { rateLimiter } from '../voice.js';
import {
  ADVICE_INSTRUCTIONS, AdviceError, RELATION_LABEL, adviceSchema, advicePrompt, cleanAdvice, similarBreakdowns, type AdviceProvider,
} from '../advice.js';

// S12 breakdown suggestions (D-27). Related past breakdowns are always listed; the model's
// suggestion is added only when QA has switched it on and the server has the service key.

// 20 suggestions an hour per person keeps the service cost bounded.
const limit = rateLimiter(20, 3_600_000);

export function adviceRoutes(app: FastifyInstance, sql: Sql, advisor: AdviceProvider | null) {
  // Admin records and reads no breakdown work; everyone who does may ask.
  const askers = { preHandler: requireRole('operator', 'supervisor', 'engineering', 'qa') };

  app.post<{ Params: { id: string } }>('/api/entries/:id/advice', askers, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const user = req.user!;
    const [found] = await sql<{ id: number; entry_id: number; equipment_id: number; logbook_type: string; data: Record<string, unknown>; code: string }[]>`
      select e.id::int, e.entry_id::int, e.equipment_id::int, e.logbook_type, e.data, q.code
      from entries e join equipment q on q.id = e.equipment_id
      where e.entry_id = (select entry_id from entries where id = ${id}) order by e.version desc limit 1`;
    if (!found) return reply.code(404).send({ error: 'not_found' });
    // Name and room are master data, read live (D-29).
    const items = await logbookItems(sql, app.master);
    const item = items.find((i) => i.id === found.equipment_id);
    const row = { ...found, name: item?.name ?? found.code, location: item?.room ?? '' };
    if (row.logbook_type !== 'maintenance' || row.data.kind !== 'breakdown') {
      return reply.code(409).send({ error: 'not_a_breakdown', problems: ['Suggestions are for breakdown entries.'] });
    }
    const similar = await similarBreakdowns(sql, items, row.entry_id, row.equipment_id, (row.data.failureCategory as string | undefined) ?? null);
    const listed = similar.map((s) => ({ ...s, relationLabel: RELATION_LABEL[s.relation] }));

    const s = await settingsInForce(sql, 'breakdown_advice');
    const off = (reason: string) => ({ entryId: row.entry_id, similar: listed, advice: null, adviceNote: reason });
    if (!(s?.settings as LogbookSettings | undefined)?.enabled) return off('Suggestions by the language model are not switched on at this site. The related past breakdowns are listed below.');
    if (!advisor) return off('Suggestions by the language model are not set up on this server. The related past breakdowns are listed below.');
    if (!similar.length) return off('There are no related past breakdowns yet, so there is nothing to suggest from.');
    if (!limit.take(user.id)) return reply.code(429).send({ error: 'rate_limited', problems: ['Too many suggestions in the last hour. Try later.'] });

    const [details] = await sql<{ details: Record<string, unknown> }[]>`
      select details from equipment_details where equipment_id = ${row.equipment_id} order by version desc limit 1`;
    let result;
    try {
      result = await advisor.advise(ADVICE_INSTRUCTIONS, advicePrompt({ ...row, details: details?.details }, similar));
    } catch (e) {
      if (e instanceof AdviceError) {
        if (e.code !== 'rejected') limit.refund(user.id);
        return reply.code(e.code === 'timeout' ? 504 : e.code === 'rejected' ? 502 : 503)
          .send({ error: `advice_${e.code}`, problems: [e.message], entryId: row.entry_id, similar: listed });
      }
      throw e;
    }
    const parsed = adviceSchema.safeParse(result.json);
    if (!parsed.success) {
      return reply.code(502).send({ error: 'advice_rejected', problems: ['The suggestion service gave an answer in the wrong form.'], entryId: row.entry_id, similar: listed });
    }
    const advice = cleanAdvice(parsed.data, new Set(similar.map((x) => x.entryId)));
    // LB-18: what was suggested, by which model, from which records, to whom.
    const [clock] = await sql<{ now: Date }[]>`select now() as now`;
    await audit(sql, { actorId: user.id, action: 'breakdown_advice.generated', objectType: 'entry', objectId: row.id, new: {
      entryId: row.entry_id, provider: advisor.name, model: advisor.model, modelVersion: result.modelVersion, responseId: result.responseId,
      basedOn: similar.map((x) => x.entryId), advice } });
    return { entryId: row.entry_id, similar: listed, advice, adviceNote: null, model: result.modelVersion, generatedAt: clock!.now };
  });
}
