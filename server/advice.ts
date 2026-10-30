import { z } from 'zod';
import type { Sql } from './db.js';
import { breakdowns, type Breakdown } from './breakdowns.js';
import { downtimeText } from './routes/history.js';

// S12 breakdown suggestions (D-27): when a machine breaks down, the related past breakdowns are
// found by plain rules (same machine, same make and model, same machine type) and, if the site has
// switched it on, a language model reads them and suggests causes, checks and parts. Advice only:
// nothing from it enters a logbook entry; the engineer records and signs what was actually done.

export type Relation = 'same_machine' | 'same_model' | 'same_type';
export const RELATION_LABEL: Record<Relation, string> = {
  same_machine: 'same machine',
  same_model: 'same make and model',
  same_type: 'same machine type',
};

export interface Similar {
  entryId: number;
  equipmentId: number;
  code: string;
  name: string;
  relation: Relation;
  occurredAt: Date;
  failureCategory: string | null;
  description: string;
  rootCause: string;
  workDone: string;
  partsText: string;
  doneBy: string;
  downtime: string;
  postRepairChecks: string;
  status: Breakdown['status'];
}

const YEARS_BACK = 3;
const MAX_SIMILAR = 40;

// "Rotary tablet compression machine (standby)" and "Rotary tablet compression machine" are one type.
const machineType = (name: string) => name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+\d+\s*$/, '').replace(/\s+/g, ' ').trim();
const makeModel = (d: Record<string, unknown> | undefined) => {
  const m = `${String(d?.manufacturer ?? '').trim()} ${String(d?.model ?? '').trim()}`.trim().toLowerCase();
  return m || null;
};

async function latestDetails(sql: Sql) {
  const rows = await sql<{ equipment_id: number; details: Record<string, unknown> }[]>`
    select distinct on (equipment_id) equipment_id::int, details from equipment_details order by equipment_id, version desc`;
  return new Map(rows.map((r) => [r.equipment_id, r.details]));
}

// Past breakdowns related to this one, closest relation first, newest first within a relation.
export async function similarBreakdowns(sql: Sql, entryId: number, equipmentId: number, now = new Date()): Promise<Similar[]> {
  const [eq] = await sql<{ name: string }[]>`select name from equipment where id = ${equipmentId}`;
  if (!eq) return [];
  const [items, details, recent] = await Promise.all([
    sql<{ id: number; name: string }[]>`select id::int, name from equipment`,
    latestDetails(sql),
    breakdowns(sql, new Date(now.getTime() - YEARS_BACK * 365 * 864e5), now, {}, now),
  ]);
  const names = new Map(items.map((i) => [i.id, i.name]));
  const ownModel = makeModel(details.get(equipmentId));
  const ownType = machineType(eq.name);
  const relationOf = (b: Breakdown): Relation | null => {
    if (b.equipmentId === equipmentId) return 'same_machine';
    if (ownModel && makeModel(details.get(b.equipmentId)) === ownModel) return 'same_model';
    if (machineType(names.get(b.equipmentId) ?? '') === ownType) return 'same_type';
    return null;
  };
  const rank: Record<Relation, number> = { same_machine: 0, same_model: 1, same_type: 2 };
  return recent
    .filter((b) => b.entryId !== entryId)
    .map((b) => ({ b, relation: relationOf(b) }))
    .filter((x): x is { b: Breakdown; relation: Relation } => x.relation !== null)
    .sort((x, y) => rank[x.relation] - rank[y.relation] || y.b.occurredAt.getTime() - x.b.occurredAt.getTime())
    .slice(0, MAX_SIMILAR)
    .map(({ b, relation }) => ({
      entryId: b.entryId, equipmentId: b.equipmentId, code: b.code, name: b.name, relation, occurredAt: b.occurredAt,
      failureCategory: b.failureCategory, description: b.description, rootCause: b.rootCause, workDone: b.workDone,
      partsText: b.partsText, doneBy: b.doneBy, downtime: downtimeText(b), postRepairChecks: b.postRepairChecks, status: b.status,
    }));
}

// What the model returns. Each point names the past entries (#entry numbers) it rests on.
export const adviceSchema = z.object({
  summary: z.string().max(2000),
  likelyCauses: z.array(z.object({ cause: z.string().max(500), basis: z.array(z.number().int()) })).max(8),
  checks: z.array(z.object({ step: z.string().max(500), basis: z.array(z.number().int()) })).max(12),
  parts: z.array(z.object({ name: z.string().max(200), partNumber: z.string().max(80), basis: z.array(z.number().int()) })).max(12),
  preventive: z.string().max(1000),
  confidence: z.enum(['low', 'medium', 'high']),
  enoughHistory: z.boolean(),
});
export type Advice = z.infer<typeof adviceSchema>;

// The same shape for the model, in the OpenAPI subset its structured output accepts.
const basis = { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Entry numbers (#) of the past breakdowns this rests on' };
export const ADVICE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Two or three sentences: what the history suggests for this breakdown' },
    likelyCauses: { type: 'ARRAY', items: { type: 'OBJECT', properties: { cause: { type: 'STRING' }, basis }, required: ['cause', 'basis'] } },
    checks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { step: { type: 'STRING' }, basis }, required: ['step', 'basis'] } },
    parts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, partNumber: { type: 'STRING' }, basis }, required: ['name', 'partNumber', 'basis'] } },
    preventive: { type: 'STRING', description: 'Repeat-failure pattern and a preventive measure, or empty' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    enoughHistory: { type: 'BOOLEAN' },
  },
  required: ['summary', 'likelyCauses', 'checks', 'parts', 'preventive', 'confidence', 'enoughHistory'],
};

export const ADVICE_INSTRUCTIONS = `You help maintenance engineers in a GMP pharmaceutical plant when a machine breaks down.
You get the new breakdown and the plant's own records of related past breakdowns, each with an entry number (#).
Use only these records: do not add causes, parts or part numbers that are not in them. Every cause, check and part
names the entry numbers it rests on. Prefer what fixed the problem on the same machine, then on the same make and
model, then on the same machine type. Point out repeat failures. If the records do not cover this failure, say so,
set enoughHistory to false and keep the lists short or empty. Write plain, short English for an engineer on the shop floor.
This is advice only: the engineer decides, and the repair is recorded and signed in the logbook as usual.`;

const line = (label: string, v: string | null | undefined) => (v ? `${label}: ${v}\n` : '');

// No people's names leave the plant: only machines, failures and repairs.
export function advicePrompt(current: { code: string; name: string; location: string; details?: Record<string, unknown>; data: Record<string, unknown> }, similar: Similar[]) {
  const d = current.details ?? {};
  let text = 'NEW BREAKDOWN\n'
    + `Machine: ${current.code} · ${current.name} · ${current.location}\n`
    + line('Make / model', `${String(d.manufacturer ?? '')} ${String(d.model ?? '')}`.trim())
    + line('Failure category', String(current.data.failureCategory ?? ''))
    + line('What failed', String(current.data.description ?? ''))
    + line('Root cause so far', String(current.data.rootCause ?? ''))
    + line('Work done so far', String(current.data.workDone ?? ''))
    + '\nPAST BREAKDOWNS\n';
  for (const s of similar) {
    text += `\n#${s.entryId} · ${s.code} · ${s.name} (${RELATION_LABEL[s.relation]}) · occurred ${s.occurredAt.toISOString().slice(0, 10)}\n`
      + line('Category', s.failureCategory) + line('What failed', s.description) + line('Root cause', s.rootCause)
      + line('Work done', s.workDone) + line('Parts', s.partsText) + line('Done by', s.doneBy.startsWith('Vendor') ? 'external vendor' : s.doneBy)
      + line('Post-repair checks', s.postRepairChecks) + line('Downtime', s.downtime);
  }
  return text;
}

// Keeps only entry numbers that were really given, and drops points left with no text.
export function cleanAdvice(a: Advice, known: Set<number>): Advice {
  const keep = (ids: number[]) => [...new Set(ids)].filter((i) => known.has(i));
  return {
    ...a,
    likelyCauses: a.likelyCauses.filter((c) => c.cause.trim()).map((c) => ({ ...c, basis: keep(c.basis) })),
    checks: a.checks.filter((c) => c.step.trim()).map((c) => ({ ...c, basis: keep(c.basis) })),
    parts: a.parts.filter((p) => p.name.trim()).map((p) => ({ ...p, basis: keep(p.basis) })),
  };
}

export interface AdviceResult { json: unknown; modelVersion: string; responseId: string | null }
export interface AdviceProvider {
  name: string;
  model: string;
  advise(instructions: string, prompt: string): Promise<AdviceResult>;
}

export class AdviceError extends Error {
  constructor(public code: 'unavailable' | 'timeout' | 'rejected', message: string) {
    super(message);
  }
}

// Google Gemini generateContent with a JSON response schema (checked against the live API 2026-10-30).
export function geminiProvider(opts: { apiKey: string; baseUrl: string; model: string; timeoutMs: number }): AdviceProvider {
  return {
    name: 'gemini',
    model: opts.model,
    async advise(instructions, prompt) {
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: ADVICE_RESPONSE_SCHEMA },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (e) {
        const name = (e as Error).name;
        throw name === 'TimeoutError' || name === 'AbortError'
          ? new AdviceError('timeout', 'The suggestion service did not answer in time.')
          : new AdviceError('unavailable', 'The suggestion service cannot be reached.');
      }
      const body = (await res.json().catch(() => ({}))) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        modelVersion?: string; responseId?: string; error?: { message?: string };
      };
      if (res.status >= 500 || res.status === 429) throw new AdviceError('unavailable', `The suggestion service is not available (${res.status}).`);
      if (!res.ok) throw new AdviceError('rejected', body.error?.message ?? `The suggestion service refused the request (${res.status}).`);
      const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdviceError('rejected', `The suggestion service gave no usable answer (${body.candidates?.[0]?.finishReason ?? 'empty'}).`);
      }
      return { json, modelVersion: body.modelVersion ?? opts.model, responseId: body.responseId ?? null };
    },
  };
}
