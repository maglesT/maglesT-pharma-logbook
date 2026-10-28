import type { Tx } from './db.js';
import { audit } from './audit.js';
import { POLICY } from './auth.js';

// LB-21 / P11 11.300(d): count a failed password check; at the limit, lock the account and raise
// an immediate on-screen alert to Admin and QA. Used by login, password change and e-signing.
export async function recordFailure(tx: Tx, userId: number, username: string, failedBefore: number): Promise<void> {
  const failed = failedBefore + 1;
  if (failed >= POLICY.maxFailedAttempts) {
    await tx`update users set failed_attempts = ${failed}, locked_at = now() where id = ${userId}`;
    await tx`delete from sessions where user_id = ${userId}`;
    await tx`insert into alerts (kind, user_id, message)
      values ('account_locked', ${userId}, ${`Account ${username} locked after ${failed} failed password attempts.`})`;
    await audit(tx, { actorId: null, action: 'user.locked', objectType: 'user', objectId: userId, new: { failedAttempts: failed } });
  } else {
    await tx`update users set failed_attempts = ${failed} where id = ${userId}`;
  }
}
