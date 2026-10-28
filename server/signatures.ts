import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { audit } from './audit.js';
import type { SessionUser } from './auth.js';
import { recordFailure } from './lockout.js';
import { verifyPassword } from './passwords.js';

export const MEANINGS = ['performed', 'verified', 'released', 'reviewed', 'approved', 'corrected'] as const;
export type Meaning = (typeof MEANINGS)[number];

// What the signer types: both components, every time (P11 11.200(a)(1); LB-20).
export const signBody = z.object({
  username: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
  // Hash of the content the signer was shown; signing is refused if the content changed since.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SignInput = z.infer<typeof signBody>;

// Stable JSON (sorted keys) so the same content always gives the same hash.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

export function contentHash(objectType: string, objectId: number, content: unknown): string {
  return createHash('sha256').update(canonical({ objectType, objectId, content })).digest('hex');
}

export class SignError extends Error {
  constructor(public code: 'wrong_credentials' | 'not_allowed' | 'already_signed' | 'content_changed') {
    super(code);
  }
}

// Proof that the signer re-entered both components just now; only authenticateSigner creates one.
const AUTHENTICATED: unique symbol = Symbol('authenticated');
export interface AuthenticatedSigner {
  [AUTHENTICATED]: true;
  user: SessionUser;
}

// LB-20: checks user ID + password in its own transaction, so a failed attempt is always
// recorded and counts towards lockout even though the signing itself is refused.
export async function authenticateSigner(
  sql: Sql,
  user: SessionUser,
  input: SignInput,
  context: { objectType: string; objectId: number; meaning: Meaning },
): Promise<AuthenticatedSigner> {
  // The Admin role administers the system and never signs GMP records (DI Q4 segregation).
  if (user.roles.includes('admin')) throw new SignError('not_allowed');
  const ok = await sql.begin(async (tx) => {
    const [row] = await tx<{ password_hash: string; failed: number; usable: boolean }[]>`
      select password_hash, failed_attempts as failed, (active and locked_at is null) as usable
      from users where id = ${user.id} for update`;
    if (row && !row.usable) return false;
    const idMatches = input.username.trim().toLowerCase() === user.username;
    if (row && idMatches && (await verifyPassword(input.password, row.password_hash))) {
      await tx`update users set failed_attempts = 0 where id = ${user.id}`;
      return true;
    }
    await audit(tx, { actorId: user.id, action: 'signature.failed', objectType: context.objectType,
      objectId: context.objectId, reason: `meaning ${context.meaning}` });
    if (row) await recordFailure(tx, user.id, user.username, row.failed);
    return false;
  });
  if (!ok) throw new SignError('wrong_credentials');
  return { [AUTHENTICATED]: true, user };
}

export interface SignRequest {
  signer: AuthenticatedSigner;
  // The hash the signer was shown (from SignInput); must equal the hash of `content`.
  shownHash: string;
  objectType: 'entry' | 'settings' | 'review';
  objectId: number;
  meaning: Meaning;
  content: unknown;
}

// LB-19: stores a signature linked to the exact content. Runs inside the transaction that
// reads (and locks) the content being signed.
export async function sign(tx: Tx, req: SignRequest): Promise<{ id: number; signedAt: Date }> {
  const { signer, objectType, objectId, meaning, content, shownHash } = req;
  const user = signer.user;
  const hash = contentHash(objectType, objectId, content);
  // The signature covers exactly what was on the signer's screen (review finding: S2-1).
  if (hash !== shownHash) throw new SignError('content_changed');
  const [existing] = await tx`select 1 from signatures where object_type = ${objectType} and object_id = ${objectId} and meaning = ${meaning}`;
  if (existing) throw new SignError('already_signed');

  const [sig] = await tx<{ id: number; signed_at: Date }[]>`
    insert into signatures (object_type, object_id, user_id, printed_name, meaning, content_hash)
    values (${objectType}, ${objectId}, ${user.id}, ${user.fullName}, ${meaning}, ${hash})
    returning id::int, signed_at`;
  await audit(tx, { actorId: user.id, action: `signed.${meaning}`, objectType, objectId, new: { signatureId: sig!.id, contentHash: hash } });
  return { id: sig!.id, signedAt: sig!.signed_at };
}
