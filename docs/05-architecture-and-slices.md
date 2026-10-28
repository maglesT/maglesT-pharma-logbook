# Deliverable (d) — Architecture and slice plan (draft 2)

Status: approved (D-05), simplified by D-06 to D-12 · 2026-10-28

## 1. Shape: one app
```
pharma-logbook/
  server/     Fastify API (TypeScript): routes, services, auth, pdf/csv
  web/        React + Vite UI, served by the server in production
  db/         numbered SQL migrations
  test/       Vitest (API + DB, real PostgreSQL) and a few Playwright browser tests
  docs/       requirements, register, decisions, handover, traceability
  ops/        Dockerfile, docker-compose, backup/restore scripts
```
- **One `package.json`**, one CI workflow.
- **Libraries:** Fastify, `postgres` (plain SQL, no ORM), zod, argon2, pdfmake, React with React Router, and plain CSS. No email library (D-10).
- **PostgreSQL 16.** Times are stored as `timestamptz` (UTC) and shown as IST with the zone label.

## 2. Data model
| Table | Purpose |
|-------|---------|
| `site` | The single site record: name, code (D-11) |
| `users`, `user_roles` | Accounts (unique login, never reused or renamed), the fixed roles, lockout counters, password dates |
| `alerts` | Misuse alerts shown to Admin/QA until acknowledged |
| `equipment` | Equipment, instruments and areas in one table (`kind`). Flags: sterile, classified room. Clean-hold limit; calibration due |
| `products` | Pick list |
| `logbook_settings` | Per built-in type: on/off, checklist, limits, SOP refs, which steps need *Verified*. Versioned; QA *Approved* with effective date |
| `entries` | One row per entry *version*: equipment, type, settings version, activity start/end, data (JSONB checked by the type's zod schema), batch, entered by/at, late flag + reason, `supersedes` |
| `signatures` | Entry or settings version, user, printed name, meaning, server time, SHA-256 of the signed content |
| `audit_log` | One audit trail: who, when, action, object, old/new JSON, reason |

Equipment status is **computed** from the latest entries when it is read, with no separate status table. The
built-in logbook types are code: one module per type with its zod schema, its status effect and its form.

## 3. Where integrity is enforced
- **Server, one transaction per action:**
  1. lock the equipment row;
  2. check the role and the status/sequence rules;
  3. write the entry, signatures and audit row.

  This is one service function, `recordEntry`.
- **Database, only where integrity needs it:**
  - The app's DB role has `INSERT, SELECT` only on `entries`, `signatures` and `audit_log`.
  - Unique logins; unique `(equipment, cycle_id)`; one signature per meaning per version; `end >= start`.
- **Integrity check:** a nightly query re-reads all entries and signatures, recomputes the hashes and writes one audit row with the result.

## 4. Security basics
Server-side sessions (httpOnly cookie, 15-min idle timeout), CSRF protection, TLS at the reverse
proxy, one `requireRole` check, and rate-limited login.

## 5. Testing and CI
- Tests with every feature. Rule-proving tests start with the rule ID (e.g. `LB-17: …`).
- Vitest runs on real PostgreSQL; a few Playwright tests cover the main flows.
- CI on every PR runs typecheck, tests and build. Merge when green, after one review pass.
- `docs/traceability.md` is generated from test names and is the validation support (D-10).

## 6. Slice plan (re-estimated after D-06 to D-12)
| # | Slice | Rules | Size | Outcome you can try |
|---|-------|-------|------|---------------------|
| S0 | Skeleton (**done**, PR #1) | — | — | App starts; CI green |
| S1 | Accounts and audit trail: login, fixed roles, session timeout, lockout + on-screen alert, password expiry, user admin, audit trail | LB-18, LB-20 (IDs), LB-21 | M | Admin creates users; lockout raises an alert |
| S2 | Master data, e-signatures and settings: site record, equipment/areas, products; sign dialog; logbook settings with QA approval and effective date | LB-19, LB-20, LB-24 | M | QA approves cleaning settings |
| S3 | Entries: the six core types; second-person verification; limits; late entries; corrections | LB-01–04, LB-10, LB-11, LB-17, LB-26 | L | Fill and verify a cleaning entry; correct it |
| S4 | Status and blocking: dirty/clean/clean-expired, out of service + QA release, calibration due; home screen | LB-05–08 | M | Start on dirty equipment is refused with the reason |
| S5 | Review and exports: period review, audit-trail view, batch view, one PDF + one CSV | LB-22, LB-25 | M | Export a logbook; QA signs the review |
| S6 | Sterile types: cycle record, steriliser test, glove integrity, pressure reading | LB-12, LB-14–16 | S | Record an autoclave cycle |
| S7 | Integrity check, backup/restore scripts, traceability list, handover | LB-23, CP-01 support | S | Restore test and traceability list |

**Total:** 7 slices left after S0, down from 8. Their scope is roughly a third smaller: there is
no template builder, line clearance, filter integrity, pressure scheduling, email, QR, multi-site
or validation-pack generator. That is about **12 working sessions at about 1–2 per slice, down
from about 18.** I'll start a fresh session after S2, S4 and S7, with a handover note in
`docs/handover.md`.
