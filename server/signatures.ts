import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { audit } from './audit.js';
import type { Permission, SessionUser } from './auth.js';
import type { Identity } from './signon.js';

export const MEANINGS = ['performed', 'verified', 'released', 'reviewed', 'approved', 'corrected', 'voice_confirmed'] as const;
export type Meaning = (typeof MEANINGS)[number];

// B1-4 (D-29, platform PL-05): at every signature the signer enters their password again at Medhanta core
// (prompt=login, max_age=0). Core's answer becomes a short signing proof, which the request then carries. Core counts
// wrong passwords towards its lockout and alerts (PL-04); the Logbook never sees a password.
export const proofOnly = z.object({ proof: z.string().min(1).max(2000) });
export const signBody = proofOnly.extend({
  // Hash of the content the signer was shown; signing is refused if the content changed since.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SignInput = z.infer<typeof signBody>;

// A proof is good for this long after the password was entered, and only once.
export const PROOF_SECONDS = 120;

interface ProofBody { sub: string; permissions: string[]; meanings: string[]; at: number; nonce: string }
const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url');

/** Made by /cb right after core re-authenticated the person. */
export function makeProof(key: Buffer, who: Pick<Identity, 'sub' | 'permissions'>, meanings: string[], at = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ sub: who.sub, permissions: who.permissions, meanings, at, nonce: randomBytes(16).toString('base64url') } satisfies ProofBody)).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

function readProof(key: Buffer, proof: string): ProofBody | null {
  const [body, tag] = proof.split('.');
  if (!body || !tag) return null;
  const want = Buffer.from(mac(key, body));
  const got = Buffer.from(tag);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ProofBody; } catch { return null; }
}

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

// Proof that the signer re-entered their password just now; only authenticateSigner creates one.
const AUTHENTICATED: unique symbol = Symbol('authenticated');
export interface AuthenticatedSigner {
  [AUTHENTICATED]: true;
  user: SessionUser;
  nonce: string;      // spent by sign(), in the transaction that stores the signature
}

// PL-05 / LB-20: the signing proof must be core's fresh re-authentication of the signed-in person, its token must
// hold the permission codes this signature needs (A10; D-30: nothing else blocks a signer), and it must be unused.
// A refused proof is audited.
export async function authenticateSigner(
  sql: Sql,
  key: Buffer,
  user: SessionUser,
  input: { proof: string },
  context: { objectType: string; objectId: number; meaning: Meaning; needs: Permission[] },
): Promise<AuthenticatedSigner> {
  const p = readProof(key, input.proof);
  const ok = await sql.begin(async (tx) => {
    const [u] = await tx<{ employee_id: string | null }[]>`select employee_id::text from users where id = ${user.id}`;
    const why = !p ? 'invalid proof'
      : Date.now() - p.at > PROOF_SECONDS * 1000 || p.at > Date.now() + 5_000 ? 'proof expired'
      : !u?.employee_id || p.sub !== u.employee_id ? 'signed by another person'
      : !context.needs.every((c) => p.permissions?.includes(c)) ? `no ${context.needs.join(' + ')} at core`
      : !p.meanings?.includes(context.meaning) ? 'proof for another meaning'
      : null;
    if (!why && !(await tx`select 1 from signing_proofs where nonce = ${p!.nonce}`).length) return true;
    await audit(tx, { actorId: user.id, action: 'signature.failed', objectType: context.objectType,
      objectId: context.objectId, reason: `meaning ${context.meaning}: ${why ?? 'proof already used'}` });
    return false;
  });
  if (!ok) throw new SignError('wrong_credentials');
  return { [AUTHENTICATED]: true, user, nonce: p!.nonce };
}

export interface SignRequest {
  signer: AuthenticatedSigner;
  // The hash the signer was shown (from SignInput); must equal the hash of `content`.
  shownHash: string;
  objectType: 'entry' | 'settings' | 'review' | 'voice_note';
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
  // The proof is spent here: once, by this save only (PL-05).
  const [spent] = await tx`insert into signing_proofs (nonce, user_id) values (${signer.nonce}, ${user.id})
    on conflict (nonce) do update set used_at = excluded.used_at where signing_proofs.tx = txid_current() returning 1`;
  if (!spent) throw new SignError('wrong_credentials');

  const [sig] = await tx<{ id: number; signed_at: Date }[]>`
    insert into signatures (object_type, object_id, user_id, printed_name, meaning, content_hash)
    values (${objectType}, ${objectId}, ${user.id}, ${user.fullName}, ${meaning}, ${hash})
    returning id::int, signed_at`;
  await audit(tx, { actorId: user.id, action: `signed.${meaning}`, objectType, objectId, new: { signatureId: sig!.id, contentHash: hash } });
  return { id: sig!.id, signedAt: sig!.signed_at };
}
