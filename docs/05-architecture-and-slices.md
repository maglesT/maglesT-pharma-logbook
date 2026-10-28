# Deliverable (d) — Architecture and slice plan (draft 1)

Status: draft for owner approval · 2026-10-28

## 1. Shape: one app
```
pharma-logbook/
  server/     Fastify API (TypeScript): routes, services, auth, pdf/csv, email
  web/        React + Vite UI (tablet-first), served by the server in production
  db/         numbered SQL migrations + seed for dev
  test/       Vitest (API + DB, real PostgreSQL) and a few Playwright browser tests
  docs/       requirements, register, decisions, handover notes
  ops/        Dockerfile, docker-compose, backup/restore/integrity scripts
```
- **One `package.json`** with no workspaces or monorepo tooling, one `tsconfig`, and one CI workflow.
- **Libraries:**
  - Fastify, `postgres` (plain SQL, no ORM), zod for input checks;
  - argon2 for password hashing;
  - pdfmake for PDF export;
  - nodemailer (SMTP) for alerts;
  - React with React Router, plus a small set of local components (no UI framework beyond basic CSS).
- **PostgreSQL 16.** Times are stored as `timestamptz` (UTC) and shown as IST with the zone label.

## 2. Data model (simple)
| Table | Purpose |
|-------|---------|
| `users`, `user_roles`, `sites` | Accounts (unique login, never reused or renamed), roles per site, lockout counters, password dates |
| `areas`, `equipment` | Things that have logbooks. Flags: critical, sterile, classified room. Settings: clean-hold time, calibration interval |
| `products` | Product master (batch numbers are free text on entries) |
| `templates`, `template_versions` | A template is a JSON field definition (types, limits, critical flags, required signatures, status effect). Versions have status (draft/approved/superseded) and an effective date |
| `entries` | One row per entry *version*: logbook, template version, activity start/end, data (JSONB), batch, entered by/at, late flag + reason, `supersedes` (previous version) |
| `signatures` | Entry version, user, printed name, meaning, server time, SHA-256 of the signed content |
| `status` | Current status per equipment/area (derived; rewritten in the same transaction as the entry) |
| `audit_log` | One audit trail: who, when, action, object, old/new JSON, reason |

## 3. Where integrity is enforced
- **Server, in one transaction per action:**
  1. lock the equipment row (`SELECT … FOR UPDATE`);
  2. check permissions and the status/sequence rules;
  3. write the entry, signature, status and audit row.

  This covers LB-05 to LB-11 and LB-18. It is a single service function, `recordEntry`, not one guard per table.
- **Database, only where integrity really needs it:**
  - The app's DB role has `INSERT, SELECT` only (no `UPDATE/DELETE`) on `entries`, `signatures` and `audit_log` (LB-17, LB-18).
  - Unique constraints: login, `(equipment, cycle_id)` and one signature per meaning per version.
  - A check constraint `end >= start`.
  - `status` and master data stay updatable, because their history lives in `audit_log`.
- **E-signature:** each signing re-checks user ID + password and stores a hash of the entry version. The integrity job (LB-23) recomputes all hashes and checks that the audit row count matches the entries.

## 4. Security basics
Server-side sessions (httpOnly cookie, 15-min idle timeout), CSRF protection, TLS at the
reverse proxy, role checks in one place (`requireRole`), and rate-limited login.

## 5. Testing and CI
- Every feature ships with tests. Tests that prove a register rule start with its ID, e.g. `LB-17: correction keeps original visible`.
- Vitest runs against a real PostgreSQL (GitHub Actions service container).
- Playwright covers a handful of browser tests for the main flows (use → clean → verify; breakdown → release).
- CI on each push/PR runs typecheck, lint, tests and build. Merge only when green.
- One review pass per slice.
- `docs/traceability.md` is generated from test names (rule → tests) and becomes the core of the validation pack.

## 6. Reuse from eBMR (reference only)
I'll read these and copy only what fits, simplified:
- the audit-row shape and the e-signature manifestation/hash pattern;
- the password and lockout rules;
- the tablet UI kit styles (buttons, status chips).

Not reused: the kernel, the monorepo packages, database guard functions, sandbox/GMP split, mutation targets.

## 7. Slice plan
Each slice is one branch → one PR, with API and UI together, tests, green CI and a review, then merge and an email to the owner.

| # | Slice | Rules | Outcome you can try |
|---|-------|-------|---------------------|
| S0 | Skeleton: app, DB migrations, CI, Docker compose, health page | — | App starts; CI green |
| S1 | Accounts and access: login, roles, session timeout, lockout + email, password expiry, audit trail core | LB-18, LB-20 (IDs), LB-21 | Admin creates users; lockout email arrives |
| S2 | Master data: sites, areas, equipment, products (all audited), QR codes | LB-01 (owners), LB-08 (IDs) | Equipment list with QR codes |
| S3 | E-signatures + controlled templates: sign dialog, template builder, QA approval, effective date, superseding | LB-19, LB-20, LB-24 | QA approves a template version |
| S4 | Entries: use, cleaning, maintenance, calibration, area cleaning; verification by a second person; critical fields; out-of-limit; late entries; corrections | LB-01–04, LB-10, LB-11, LB-17 | Fill and verify a cleaning log; correct an entry |
| S5 | Status and blocking: dirty/clean/clean-expired, out of service + QA release, calibration due, line clearance before each use, status label | LB-05–09 | Start on dirty equipment is refused with the reason |
| S6 | Review and exports: logbook period review, audit-trail viewer, batch view, PDF/CSV with correction flags | LB-22, LB-25 | Export a logbook; QA signs the review |
| S7 | Sterile templates (per-site switch): cycles, steriliser tests, filter integrity, glove integrity, pressure readings with intervals | LB-12–16 | Record an autoclave cycle and a missed pressure reading |
| S8 | Integrity and backup: integrity-check job, backup/archive/restore scripts, validation-pack generator, handover | LB-23, CP-01 support | Restore test passes; validation pack PDF |

Rough size: S0–S2 are small, S4 and S5 are the largest, and S7 is medium. I'll start a fresh session after S2, S5 and S8, with a handover note in `docs/handover.md`.

## 8. Decisions for the owner
1. Approve the stack and one-app layout (TypeScript, Fastify, PostgreSQL, React).
2. Approve the slice order. The default is that UI comes with each slice, not at the end.
3. Email alerts need an SMTP server at the plant. The default is SMTP settings configured per installation, with no external mail service built in.
