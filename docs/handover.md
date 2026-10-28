# Handover

Updated: 2026-10-29, after slice S4.

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

## Done: S3, entries (LB-01–04, LB-10, LB-11, LB-17, LB-26)
- **`entries` (migration 0006):** insert-only versions sharing `entry_id`, linked by `supersedes`, which is unique so a history cannot branch. `change` is created, completed or corrected. `entered_at` comes from the database.
- **Locking:** writes lock the equipment row; the app role cannot row-lock entries.
- **Entry rules (`server/entries.ts`):** a zod schema per core type; system checks (`checkData`): checklist confirmed, calibration due date and failed calibration, classified-room agent and lot, sterile breakdown impact assessment; who may record each type.
- **Routes (`server/routes/entries.ts`):** create (performer e-signature for D-16 types), complete a use, correct (reason + *Corrected* e-signature), verify (different person, signs the shown hash), equipment log, versions, open items.
- **Late entries:** activity older than 30 min needs a reason; future times are refused (database clock).
- **UI:** Logbooks (equipment tiles, then the log page with entry forms, verify, correct and history); Home lists open items.

## Done: S4, status and blocking (LB-05–08)
- **`server/status.ts`:** one SQL query gathers the facts per item, and `deriveStatus()` turns them into a state, blockers and warnings (D-18).
- **States:** in use, dirty, clean, clean expired, out of service, calibration failed, overdue or not calibrated.
- **Blocking:** a use is refused while there are blockers; cleaning is refused while the item is in use.
- **Release:** `POST /api/entries/:id/release` (QA, *Released* signature) on a verified breakdown.
- **Equipment field:** `needs_calibration` (migration 0008).
- **UI:** status chips on tiles, a status bar with the reasons on the logbook page, a Release button, and the "Not fit for use" list on Home.

## Next: S5, review and exports (LB-22, LB-25)
- **Period review:** QA *Reviewed* signature on a logbook period, as a settings-like object, or a new object type `review` in `signatures.object_type` (needs a migration to the check constraint). It shows open items and the audit trail for the period; a later correction in the period marks the review superseded.
- **Audit-trail viewer:** filters by object, user and date.
- **Batch view:** every entry referencing a batch, plus the audit rows for those entries.
- **Exports:** one PDF layout (pdfmake) and one CSV, for a logbook period and for a batch view. Corrected entries are marked and all versions included.

## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
