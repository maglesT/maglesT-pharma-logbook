# Handover

Updated: 2026-10-28, after slice S0.

## State
- Planning deliverables (a)–(d) are approved: decisions D-01 to D-05 in `decisions.md`.
- **S0 (skeleton) done:**
  - Fastify server with `/api/health`, serving the built React UI;
  - SQL migration runner (`db/migrate.ts`);
  - Vitest on real PostgreSQL, one schema per test file;
  - Docker + compose; GitHub Actions CI.

## Next: S1, accounts and access (LB-18, LB-20 IDs, LB-21)
- **Tables:** `users`, `user_roles`, `sites`, `audit_log`.
- **App DB role:** `logbook_app` with no UPDATE/DELETE on `audit_log`. It is created by an ops script, because roles are cluster-wide; migrations grant to it.
- **Behaviour:** login with argon2id passwords; server-side sessions with 15-min idle timeout; lockout after 5 failures with an email (SMTP from config); password expiry at 90 days; temporary password changed at first login; user IDs never reused or renamed.
- **Admin rights:** Admin manages users but cannot sign or create entries.
- **Audit:** every user/role change writes an audit row in the same transaction.

## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
