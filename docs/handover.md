# Handover

Updated: 2026-10-28, after slice S1.

## State
- Planning deliverables (a)–(d) are approved: decisions D-01 to D-05 in `decisions.md`.
- **S0 (skeleton) done:**
  - Fastify server with `/api/health`, serving the built React UI;
  - SQL migration runner (`db/migrate.ts`);
  - Vitest on real PostgreSQL, one schema per test file;
  - Docker + compose; GitHub Actions CI.

## Done: S1, accounts and audit trail (LB-18, LB-20, LB-21)
- **Database (migration 0002):** `users`, `user_roles`, `sessions`, `alerts`, `audit_log`. The app runs as `logbook_app`: `audit_log` is insert-only, `username` cannot be updated, and users cannot be deleted.
- **Login:** scrypt passwords (D-14), server-side sessions with a 15-min idle timeout, SameSite=Strict cookie, JSON-only writes.
- **Lockout:** after 5 failures the account locks and an on-screen alert goes to Admin and QA (D-10), with an audit entry.
- **Passwords:** temporary passwords must be changed at first login; passwords expire at 90 days.
- **Admin API:** list, create, edit (reason required), reset password.
- **UI:** login, change password, home with alerts, users admin. `npm run create-admin` handles first-time setup.

## Next: S2, master data, e-signatures and logbook settings (LB-19, LB-20, LB-24)
- **Master data:** the `site` record; `equipment` (kind: equipment/instrument/area; sterile/classified flags; clean-hold limit); `products`.
- **E-signatures:** `signatures` with user ID + password at every signing (reuse `verifyPassword`), meaning, server time and a SHA-256 of the signed content.
- **Logbook settings:** `logbook_settings` versions per built-in type, with QA *Approved* and an effective date.
- **Admin role:** Admin may not sign. Enforce this in the sign service.

## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
