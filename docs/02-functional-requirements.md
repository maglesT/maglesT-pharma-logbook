# Deliverable (b) — Functional requirements (draft 3)

Status: aligned with the register and decisions D-01 to D-12 · 2026-10-28.
Rule IDs (LB-xx, CP-xx) refer to `03-compliance-register.md`.

## 1. Purpose and scope
An electronic logbook for one Indian export pharma plant (tablets, capsules, injectables). It
replaces paper equipment, instrument and area logbooks. It is one web application used in the
browser on desktop PCs, and on tablets through the browser.

**In scope**
- **One site per installation (D-11).** A single site record (name, code) appears on screens and exports.
- **Master data:** equipment, instruments and areas, each with a unique ID that is never reused, a status and settings. Products come from a pick list. Batch numbers are free text.
- **Logbook types:** fixed, built-in types (D-07). A site switches on the types it uses and sets their settings, which QA approves (LB-24).
- **Entries:** logbook entries, corrections, and *Verified / Released / Reviewed / Approved / Corrected* e-signatures.
- **Status:** equipment and area status blocks use when an item is not fit (LB-05 to LB-07).
- **Records:** audit trail, the five fixed roles, PDF/CSV export of a logbook period and of a batch view, a nightly integrity check, daily backups.

**Out of scope (possible later extensions)**
- native mobile app; offline entry and sync (D-06);
- several sites in one installation (D-11);
- a template or form builder (D-07);
- line clearance, which belongs in the batch record (D-09, CP-05);
- filter integrity, which is per batch and belongs in the batch record (D-08);
- QR codes, label printing and email/SMTP alerts (D-10);
- batch records (eBMR), batch release, deviation/CAPA workflows (a deviation reference number is recorded only), LIMS;
- maintenance planning and cleaning schedules;
- ERP/SCADA/BMS integration, automatic capture from instruments, continuous monitoring of critical pressure differentials (CP-09);
- multi-language UI.

## 2. Roles (fixed permission sets, no role editor)
| Role | Can do |
|------|--------|
| Operator | Use, cleaning, area cleaning, readings, sterile entries; correct own entries |
| Supervisor | Operator actions; *Verified* signatures |
| Engineering | Maintenance/breakdown, calibration, steriliser tests |
| QA | *Verified*, *Released* (return to service), *Reviewed* (logbook period), *Approved* (settings); audit trail; exports; misuse alerts |
| Admin | Users and role assignment, master data, settings drafts; misuse alerts. **No** entries and **no** signatures |

A user may hold several roles but can never verify their own entry.

## 3. Logbook types (built in)
| Type | Key fields | Signatures | Status effect |
|------|-----------|------------|---------------|
| Equipment use | product, batch, stage, start/end | Performed | *In use (product/batch/stage)* → *Dirty* |
| Equipment cleaning | type, SOP ref, start/end | Performed + Verified (2 people) | *Dirty* → *Clean* until the clean-hold limit, then *Clean expired* |
| Maintenance / breakdown | type, description, work done; impact assessment for sterile-flagged items | Performed + Verified; Released to return to service | *Out of service* until Released |
| Calibration / check | result, certificate ref (file allowed), next due | Performed (+ Verified where set) | overdue/failed → blocks use |
| Area cleaning | room, type, agent; disinfectant type and lot for classified rooms | Performed + Verified | room *Clean* / *Dirty* |
| General equipment log | site checklist + notes | Performed (+ Verified where set) | none |
| *Sterile:* cycle record | type (steam/dry heat/SIP/VHP), cycle ID (unique per equipment), programme, load, result, controller record (file allowed) | Performed + Verified | failure flags the equipment |
| *Sterile:* steriliser test | leak / air-removal (Bowie-Dick), result | Performed + Verified | failure blocks the steriliser |
| *Sterile:* glove integrity | glove/port, test, result | Performed | fail blocks the isolator/RABS |
| *Sterile:* pressure reading (non-critical points) | point, value against limits | Performed | out-of-limit flagged |

**Settings per type:** on/off, checklist items, limits, SOP references, clean-hold limit, and
which steps need *Verified*. A settings version needs a QA *Approved* signature and an
effective date. An out-of-limit value always needs a comment and a deviation reference.

## 4. Screens (five)
1. **Home:** what is blocked (dirty, clean-expired, out of service, calibration due/overdue), entries awaiting verification, misuse alerts for Admin/QA.
2. **Equipment / area page:** status, and its log with all entries; buttons to start an entry.
3. **Entry form:** one per logbook type; the sign dialog; correction.
4. **Review:** logbook period with open items and audit trail; batch view; export.
5. **Admin:** users and roles, equipment/areas/products, logbook settings.

## 5. Main flows
1. **Use equipment:** open the equipment page and see the status. Start is refused, with the reason, if the item is dirty, clean-expired, out of service or calibration overdue/failed. Otherwise enter product/batch/stage and start; at the end the status becomes *Dirty*.
2. **Clean, then verify** by a second person → *Clean* (clock starts for the clean-hold limit).
3. **Breakdown** → *Out of service*. Engineering records the work, a second person verifies, and QA signs *Released*.
4. **Calibration:** the due date is shown; overdue blocks use.
5. **Correct an entry:** a new version, reason and *Corrected* e-signature. The original stays visible and verifications must be redone. Nothing is deleted.
6. **Late entry** (activity time older than the site window, default 30 min): needs a reason (e.g. "transcribed from paper form no. …") and is flagged.
7. **QA review:** a logbook for a period, with open items and the audit trail → *Reviewed*. A later correction marks the review *superseded*. Gaps in pressure readings are spotted here.
8. **Batch view and export:** every entry and audit row for a batch. One PDF layout and one CSV for a logbook period or a batch view, with corrections marked.

## 6. Cross-cutting
- **Accounts:** unique named accounts; IDs never reused.
- **Sessions and passwords:** session timeout 15 min; password expiry 90 days.
- **Lockout:** after 5 failures the account locks. An on-screen alert goes to Admin and QA and an audit entry is written.
- **Time:** server time for every entry, stored in UTC and shown as IST with the zone label.
- **E-signature:** user ID + password at every signing. It shows name, time and meaning, and is linked to the exact entry version.
- **Audit trail:** one audit trail, written by the server, append-only for the application.
- **Integrity and backups:** nightly integrity check; daily backup kept 1 year (default); restore script.

## 7. Non-functional
- **Platform:** browser app; usable on a 10" tablet through the browser at no extra cost (large touch targets).
- **Hosting:** on-premise or private cloud via Docker.
- **Performance:** 200 concurrent users; an entry saves in < 1 s.
- **Validation support:** rule-to-test traceability list generated from test names, plus the CI test report (D-10).
