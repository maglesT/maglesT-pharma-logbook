# Handover

Updated: 2026-10-29, after slice S7 (all planned slices done).

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

## Done: S5, review and exports (LB-18 viewer, LB-22, LB-25)
- **`reviews` (migration 0009):** `signatures.object_type` now also allows `review`.
- **Period review (`server/routes/review.ts`):**
  - `GET /api/equipment/:id/period` returns every version, open-item counts, the audit trail and a content hash;
  - `POST /api/equipment/:id/reviews` is the QA *Reviewed* signature on that hash;
  - a review shows as superseded when the versions in its period change.
- **Batch view and audit:** `GET /api/batches/:batch`; `GET /api/audit` with filters (QA/Admin).
- **Exports (`server/routes/exports.ts`):** `/api/export/period.(pdf|csv)` and `/api/export/batch.(pdf|csv)`, using pdfmake with Helvetica.
- **UI:** Review page with logbook review, batch view and audit trail tabs.

## Done: S6, sterile types (LB-12, LB-14–16)
- **Entry rules (`server/entries.ts`):** schemas for steriliser_cycle, steriliser_test, glove_integrity and pressure_reading.
  - Failed results need a comment and deviation reference.
  - The pressure out-of-limit flag is set by the server from the approved point limits.
- **Cycle ID:** unique per steriliser (`checkCycleId` in `routes/entries.ts`), checked under the equipment lock.
- **Status (`status.ts`):** a failed steriliser test or glove port means out of service, and the item also gets `cycleBlockers`, which stop new cycles. A failed last cycle and out-of-limit pressure readings are warnings.
- **UI:** forms for the four types; they show only on ster## Done: S7, integrity, backup and traceability (LB-23, CP-01 support)
- **`server/integrity.ts`:** recomputes every signature hash, checks version chains and that every entry version has its audit row, and writes `integrity.passed` or `integrity.failed` to the audit trail. It runs daily from the server process (`scheduleIntegrityCheck`); `/api/integrity` and `npm run integrity` are also available.
- **Scripts:** `ops/backup.sh` (pg_dump, SHA-256 file, 365-day retention) and `ops/restore-check.sh` (scratch restore, migrate, integrity). CI runs both.
- **Traceability:** `scripts/traceability.ts` writes `docs/traceability.md`. `--check` runs in CI and in `npm run ci`.
- **README:** "Operating the system" section.

## Possible next steps (not planned; owner to decide)
- Validation package for a first site: IQ/OQ protocol templates that use `docs/traceability.md` and the CI report.
- Training material: one-page guides per role.
- Later extensions recorded in decisions: multi-site, mobile app, offline mode, QR codes, ERP or BMS interfaces.

llation and first setup.

## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
