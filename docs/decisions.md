# Owner decisions

| # | Date | Decision |
|---|------|----------|
| D-01 | 2026-10-28 | Register draft 2 and all changes in `04-register-verification.md` approved by the owner ("approve"), including: line clearance before every use, clean-hold limit, defective equipment blocked with QA release, manual pressure readings only for non-critical points at set intervals, correction needs an e-signature, lockout email, batch view, optional sterile templates (steriliser tests, vent filters, glove integrity), and the dropped candidates in register section D. |
| D-02 | 2026-10-28 | Cite only texts in force; 2025 Annex 11 / Ch 4 drafts informative only (default, not objected to). |
| D-03 | 2026-10-28 | Project emails are sent from arccra003@gmail.com to the owner (triplerascals03@gmail.com), new thread, subject starting "Logbook:". |
| D-04 | 2026-10-28 | Schedule M numbering corrections and Part I section 20 mapping approved: new LB-26 (no silent data loss); LB-11 relaxed so a system check satisfies the critical-data check (SchM 20.6, A11 6), second person only where no meaningful system check exists or another clause requires one; 20.7/20.8 handled under CP-07. |
| D-05 | 2026-10-28 | Architecture and slice plan approved: one TypeScript app (Fastify, PostgreSQL 16, React), slices S0–S8 with UI in each slice, email alerts via SMTP configured per installation; P11 11.10(h) device checks accepted as not applicable. |
| D-06 | 2026-10-28 | No native mobile app and no offline entry/sync; browser app (tablets via the browser). Later extensions. Confirmed by the owner in this session. |
| D-07 | 2026-10-28 | No template builder: fixed built-in logbook types, including a general equipment log (site checklist + notes), with per-type settings QA-approved with an effective date (LB-24). Confirmed by the owner. |
| D-08 | 2026-10-28 | Sterile set: filter integrity dropped (per-batch, belongs to the batch record); pressure readings record the value with an out-of-limit flag, no interval scheduling (gaps seen at QA review). Cycle records, steriliser tests and glove integrity stay. Confirmed by the owner. |
| D-09 | 2026-10-28 | Line clearance is not in the logbook; it belongs to the batch record (replaces that part of D-01; LB-09 → CP-05). Confirmed by the owner. |
| D-10 | 2026-10-28 | No lockout email/SMTP: on-screen alert to Admin and QA plus audit entry. No QR codes. No validation-pack generator: traceability list from test names plus the CI report. Confirmed by the owner. |
| D-11 | 2026-10-28 | One site per installation; a single site record for headers and exports. Confirmed by the owner. |
| D-12 | 2026-10-28 | Owner mandate for one simplification pass that loses no user function and breaks no register rule; applied as listed below. Confirmed by the owner. |

## Simplifications applied (D-12)
- Equipment, instruments and areas live in one table; equipment status is computed from entries, so there is no status table.
- Logbook types are code (one module per type) instead of stored field definitions.
- The five roles are fixed permission sets; there is no role editor.
- One PDF layout and one CSV format, for a logbook period and for the batch view.
- Five screens: home, equipment/area page, entry form, review, admin.
- Backups: one daily backup kept 1 year plus a restore script. No archive copy, because nothing is deleted from the live database.
- Integrity check: a nightly query that recomputes hashes and logs its result.
- Removed from the plan: template builder, line clearance, filter integrity, pressure scheduling, email, QR codes, label printing, multi-site, validation-pack generator.
| D-13 | 2026-10-28 | Owner: do not ask for decisions; Claude takes the option it judges best, records it here and reports it in the next update email. Compliance-rule mismatches found in verification are still reported, not silently fixed. |
| D-14 | 2026-10-28 | Passwords hashed with scrypt from Node's built-in crypto (N=16384, r=8, p=1) instead of argon2: no native dependency, equally accepted for password storage. Password rule: at least 10 characters, must not contain the user ID. (Claude, under D-13.) |
| D-15 | 2026-10-28 | S1 review residual (Part 11 §11.200(a)(3)): without email (D-10), an Admin sees the temporary password they issue. Mitigations: temporary passwords expire after 24 h, the change to a personal password is marked in the audit trail, and the site SOP (CP-03) requires handing the temporary password directly to the user and forbids Admins logging in as others. Reported to the owner. (Claude, under D-13.) |
| D-16 | 2026-10-28 | Entries: a *Performed* e-signature (user ID + password) is required only where a clause requires the performer to sign: equipment cleaning, maintenance, area cleaning, calibration, sterile cycles and tests (211.182, LB-03, LB-12); use and general-log entries are attributed by login. Calibration always needs a second-person *Verified* signature, because a pass/fail result has no meaningful system check (LB-11, SchM 20.6). An entry version is changed only by appending a new version: completing a use (end time) or correcting (reason + *Corrected* e-signature); verifications apply to one version and must be redone after a correction. (Claude, under D-13.) |
| D-17 | 2026-10-29 | Any user allowed to record equipment use may end a use started by someone else (shift handover); the end is attributed to whoever records it. Corrections need the right to record that logbook type plus being the original author or a supervisor; QA reviews and verifies but does not rewrite entries. (Claude, under D-13.) |
| D-18 | 2026-10-29 | Equipment status is computed from the log, never stored. New equipment counts as dirty until its first verified cleaning (where the site tracks cleaning for that kind of item). Calibration status applies only to items flagged "Needs calibration" (default for instruments); only verified calibrations count; due within 7 days is a warning, overdue or failed blocks use. A breakdown keeps equipment out of service until QA signs *Released* on the verified breakdown entry. (Claude, under D-13.) |
