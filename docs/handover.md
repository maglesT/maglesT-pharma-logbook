# Handover

Updated: 2026-10-28, after slice S2.

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

## Done: S2, master data, e-signatures and logbook settings (LB-19, LB-20, LB-24)
- **Database (migration 0004):** `site` (single row), `equipment` (equipment/instrument/area; code unique and never changeable; clean-hold hours), `products`, `logbook_settings` (versioned per type), `signatures` (insert-only, with the time set by the database).
- **Signing (`server/signatures.ts`):** `authenticateSigner()` runs in its own transaction, so failures count towards lockout. It returns a proof object that `sign()` requires. `sign()` stores the printed name, meaning and a SHA-256 of the canonical content, and Admin can never sign.
- **Logbook types are code (`server/logbook-types.ts`):** 10 types. Settings are drafted by Admin and approved by QA with an e-signature. A version is in force once approved and its effective date has passed; an effective date already past at approval becomes the approval time.
- **UI:** Master data (equipment, products, site), Logbook settings, and the reusable SignDialog.

## Next: S3, entries (LB-01–04, LB-10, LB-11, LB-17, LB-26)
- **Table:** `entries` (insert-only), one row per version, with `supersedes`. Each entry stores the settings version in force when it was made.
- **Types:** a zod schema per type in `logbook-types.ts`.
- **Signatures:** *Performed* at save; *Verified* by a different user (cleaning, maintenance, area cleaning and sterile cycles always; others where settings say so); *Corrected* on a correction, which also requires a reason.
- **Times:** late-entry window of 30 min, with a reason when late. Activity time cannot be in the future.
- **Batch view:** query entries by batch, ahead of S5.

## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
