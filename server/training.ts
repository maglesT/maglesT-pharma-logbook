import type { Sql, Tx } from './db.js';
import { ConnectionOff } from './master.js';

// D-71 (owner 17 Nov 2026): only trained people sign. A logbook type's settings may name the training a signer needs (a
// skill of the Recruitment product). The Logbook reads Recruitment's report view report.training_v1 (one row per person and
// skill; `qualified` is already false once the training has expired) live through the platform link with its own login
// (RECRUITMENT_DATABASE_URL). Nothing is copied or written. Without the link, or while it does not answer, the signer states
// "I am trained in <skill>" and the signature is marked "Training typed by hand".

export interface Skill { code: string; title: string }
export interface TrainingRecord {
  login: string;
  name: string;
  skillCode: string;
  skillTitle: string;
  trainedOn: string | null;       // plant date YYYY-MM-DD
  validUntil: string | null;
  qualified: boolean;
}
export interface Training {
  /** The skills Recruitment publishes, for the settings picker. */
  skills(): Promise<Skill[]>;
  /** The person's training in one skill, or null when Recruitment has none. */
  of(login: string, skillCode: string): Promise<TrainingRecord | null>;
}

export const TRAINING_OFF = 'Connection to Recruitment (training records) is off. Ask your administrator.';
export class TrainingOff extends ConnectionOff {
  constructor() { super(); this.message = TRAINING_OFF; }
}
const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '42P01', '28000', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

export function sqlTraining(q: Sql, schema = 'report'): Training {
  const read = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (isCut(e)) throw new TrainingOff(); throw e; } };
  const view = q(`${schema}.training_v1`);
  return {
    skills: () => read(async () => (await q<{ code: string; title: string | null }[]>`
      select skill_code as code, max(skill_title) as title from ${view} where skill_code is not null group by skill_code order by skill_code`)
      .map((r) => ({ code: r.code, title: r.title ?? r.code }))),
    of: (login, skillCode) => read(async () => {
      // A person may have more than one row for a skill (should not, but then the best counts: qualified, longest valid).
      const [r] = await q<{ person_login: string; person_name: string | null; skill_code: string; skill_title: string | null; trained_on: string | null;
        valid_until: string | null; qualified: boolean | null }[]>`
        select person_login, person_name, skill_code, skill_title, trained_on::text, valid_until::text, qualified from ${view}
        where lower(person_login) = lower(${login}) and skill_code = ${skillCode}
        order by coalesce(qualified, false) desc, valid_until desc nulls first limit 1`;
      return r ? { login: r.person_login, name: r.person_name ?? r.person_login, skillCode: r.skill_code, skillTitle: r.skill_title ?? r.skill_code,
        trainedOn: r.trained_on, validUntil: r.valid_until, qualified: r.qualified === true } : null;
    }),
  };
}

/** What a signer's training check found: checked in Recruitment, or stated by the signer (typed by hand). */
export interface TrainingResult { skill: Skill; typed: boolean; validUntil: string | null; note: string }
export type TrainingState =
  | { needed: null }
  | { needed: Skill; state: 'trained'; validUntil: string | null; note: string }
  | { needed: Skill; state: 'not_trained'; message: string }
  | { needed: Skill; state: 'typed'; why: string; message: string };

export const skillName = (s: Skill) => (s.title && s.title !== s.code ? `${s.title} (${s.code})` : s.code);
export const notTrained = (name: string, s: Skill) => `${name} has no valid training in ${skillName(s)} (Recruitment): another trained person signs.`;

/** The training a type's settings ask of a signer, as stored (none for settings made before D-71). */
export const trainingNeeded = (settings: { training?: Skill | null } | null | undefined): Skill | null =>
  settings?.training?.code ? { code: settings.training.code, title: settings.training.title || settings.training.code } : null;

/** The check, without signing: what the sign step shows the person and what the server then enforces. */
export async function trainingState(training: Training | null, person: { username: string; fullName: string }, needed: Skill | null): Promise<TrainingState> {
  if (!needed) return { needed: null };
  const typed = (why: string) => ({ needed, state: 'typed' as const, why,
    message: `${why === 'not linked' ? 'Recruitment is not linked' : 'Recruitment is not reachable'}: confirm you are trained in ${skillName(needed)}.` });
  if (!training) return typed('not linked');
  let r: TrainingRecord | null;
  try { r = await training.of(person.username, needed.code); } catch (e) {
    if (e instanceof TrainingOff) return typed('not reachable');
    throw e;
  }
  if (!r?.qualified) return { needed, state: 'not_trained', message: notTrained(person.fullName, needed) };
  return { needed, state: 'trained', validUntil: r.validUntil, note: `Trained: ${skillName(needed)}, ${r.validUntil ? `valid until ${r.validUntil}` : 'no end date'} (Recruitment)` };
}

/** Keeps what the check found with the signature it belongs to (shown with the signature on the entry). */
export async function recordTraining(tx: Tx, signatureId: number, r: TrainingResult) {
  await tx`insert into signature_training (signature_id, skill_code, skill_title, valid_until, typed, note)
    values (${signatureId}, ${r.skill.code}, ${r.skill.title}, ${r.validUntil}::date, ${r.typed}, ${r.note})`;
}
