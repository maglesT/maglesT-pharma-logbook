# Deliverable (b) — Functional requirements (draft 2)

Status: draft 2, aligned with the approved compliance register (D-01) · 2026-10-28.
Rule IDs (LB-xx, CP-xx) refer to `03-compliance-register.md`.

## 1. Purpose and scope
An electronic logbook for Indian export pharma plants (tablets, capsules, injectables). It
replaces paper equipment, instrument and area logbooks. It is one web app with one database,
used on shop-floor PCs and tablets and by QA.

**In scope**
- **Master data:** sites, areas/rooms, equipment and instruments (unique, never-reused IDs), products, batches. Batch numbers are free text by default.
- **Templates:** configurable logbook templates per site, controlled as documents (LB-24); sterile templates switched on per site.
- **Entries:** logbook entries, corrections and verification/release/review e-signatures.
- **Status:** equipment and area status that blocks use when the item is not fit (LB-05 to LB-09).
- **Records:** audit trail, users and roles, PDF/CSV exports including a batch view, an integrity check and backups.

**Out of scope (v1):**
- batch records (eBMR), batch release, deviations/CAPA workflows (a deviation reference number is recorded only), LIMS;
- preventive-maintenance planning and cleaning schedules;
- ERP/SCADA/BMS integration and automatic capture from instruments, including continuous monitoring of critical pressure differentials (CP-09);
- offline mode, multi-language UI, multi-tenant SaaS.

## 2. Roles
| Role | Can do |
|------|--------|
| Operator | Use, cleaning, line clearance, area cleaning, readings, sterile entries; correct own entries |
| Supervisor | Operator actions; *Verified* signatures (cleaning, maintenance, critical fields) |
| Engineering | Maintenance/breakdown, calibration, steriliser tests |
| QA | *Verified*, *Released* (return to service), *Reviewed* (logbook period), *Approved* (templates); audit trail; exports |
| Admin | Users, roles, sites, master data, template drafts. **No** entries and **no** signatures |

A user may hold several roles but can never verify their own entry.

## 3. Logbook templates
| Template | Key fields | Signatures | Status effect |
|----------|-----------|------------|---------------|
| Equipment use | product, batch, stage, start/end | Performed | *In use (product/batch/stage)* → *Dirty* |
| Equipment cleaning | type, SOP ref, start/end | Performed + Verified (2 people) | *Dirty* → *Clean* until the clean-hold limit, then *Clean expired* |
| Line clearance | equipment/line, checklist (site-defined) | Performed (+ Verified if the site turns it on) | needed after each use, before the next use |
| Maintenance / breakdown | type, description, work done; impact assessment (sterile-flagged items) | Performed + Verified; Released to return to service | *Out of service* until Released |
| Calibration / check | result, certificate ref, next due | Performed + Verified (result is critical) | overdue/failed → blocks use |
| Area cleaning | room, type, agent; disinfectant type and lot for classified rooms | Performed + Verified | room *Clean* / *Dirty* |
| *Sterile:* cycle record | type (steam/dry heat/SIP/VHP), cycle ID (unique per equipment), programme, load, result, controller record ref/attachment | Performed + Verified | failure flags the equipment |
| *Sterile:* steriliser test | leak / air-removal (Bowie-Dick), result | Performed + Verified | failure blocks the steriliser |
| *Sterile:* filter integrity | filter ID/lot, pre/post-use (or "not performed – RA ref."), method, value vs limit | Performed + Verified | fail marks the filter failed |
| *Sterile:* glove integrity | glove/port, test, result | Performed | fail blocks the isolator/RABS |
| Pressure reading (non-critical points only) | point, value vs limits | Performed | missed interval or out-of-limit flagged |

**Common to all templates:**
- **Field types:** text, number with limits, choice, date/time, checklist, attachment (PDF/image).
- **Critical fields:** fields marked *critical* need a *Verified* signature.
- **Out-of-limit values:** need a comment and a deviation reference.
- **Approval:** a template version needs a QA *Approved* signature and an effective date. Superseded versions take no new entries.

## 4. Main flows
1. **Use equipment.** The operator scans the QR code (it opens the app behind login) and sees the status.
   - Start is refused, with the reason, if the item is dirty, clean-expired, out of service, calibration overdue/failed, or has no line clearance since the last use.
   - Otherwise the operator enters product/batch/stage and starts; at the end the status becomes *Dirty*.
2. **Clean, then verify** by a second person → *Clean* (clock starts for the clean-hold limit).
3. **Line clearance:** the checklist is completed before the next use.
4. **Breakdown** → *Out of service*. Engineering records the work, a second person verifies, and QA signs *Released*.
5. **Calibration:** due date shown and a printable status label; overdue blocks use.
6. **Correct an entry:** a new version, reason and *Corrected* e-signature. The original stays visible and verifications must be redone. Nothing is deleted.
7. **Late entry** (activity time older than the site window, default 30 min): needs a reason (e.g. "transcribed from paper form no. …") and is flagged.
8. **QA review:** a logbook for a period, with open items and the audit trail → *Reviewed*. A later correction marks the review *superseded*.
9. **Batch view and export:** every entry and audit row for a batch, for the batch-record reviewer. Any logbook, period or audit trail exports to PDF/CSV, with corrections marked.

## 5. Cross-cutting
- **Accounts:** unique named accounts; IDs never reused. Session timeout 15 min; password expiry 90 days. Lockout after 5 failures, with an email to the site security contact.
- **Time:** server time for every entry, stored in UTC and shown as IST with the zone label.
- **E-signature:** user ID + password at every signing. It shows name, time and meaning, and is linked to the exact entry version.
- **Audit trail:** one audit trail, written by the server, append-only for the application.
- **Integrity and backups:** a scheduled integrity check, daily backups, a monthly archive copy kept indefinitely, and a restore script.

## 6. Non-functional
- Browser app; works on a 10" tablet with large touch targets (gloves).
- One installation serves one or more sites; on-premise or private cloud via Docker.
- 200 concurrent users per site; an entry saves in < 1 s.
- Validation pack generated from the repo: requirements → rule IDs → CI test evidence.
