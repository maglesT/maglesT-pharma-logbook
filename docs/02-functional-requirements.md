# Deliverable (b) — Functional requirements (first draft)

Status: draft for owner review · 2026-10-28

## 1. Purpose and scope
An electronic logbook for Indian export pharma plants (tablets, capsules, injectables)
that replaces paper equipment, instrument and area logbooks. One web app, one
database, used on shop-floor PCs/tablets and by QA.

**In scope**
- Master data: sites, areas/rooms, equipment, instruments, products, batches (entered
  or imported as a simple list — no ERP integration in v1).
- Configurable logbook templates per site; sterile templates switched on per site.
- Logbook entries, corrections, verification/review signatures, QA logbook review.
- Equipment/area status (clean/dirty, under maintenance, calibration/qualification due)
  shown everywhere and blocking use when not fit.
- Audit trail, user and role management, readable PDF/CSV export, backups.

**Out of scope (v1)**: batch records (eBMR), deviations/CAPA/change control workflows,
LIMS, preventive-maintenance planning engine, ERP/SCADA/BMS integration, automatic
data capture from autoclaves or pressure sensors (manual entry only), mobile offline
mode, multi-language UI, multi-tenant SaaS. Deviations are recorded as a free-text
reference number only.

## 2. Users and roles
| Role | Can do |
|------|--------|
| Operator | Make entries (use, cleaning, area cleaning, sterile logs); correct own entries |
| Supervisor | All operator actions; verify ("checked by") cleaning and line clearance |
| Engineering | Maintenance, breakdown, calibration/qualification entries; set equipment out of/back in service |
| QA | Verify, release equipment after breakdown, review/approve logbook periods, view audit trail, export |
| Admin | Users, roles, sites, master data, templates. **No** entry or signing rights (segregation) |

A user may hold more than one role; a person may never verify their own entry.

## 3. Logbook types (templates)
Each template = a fixed set of fields, which fields need a second-person
verification signature, and the status effect of the entry.

| Template | Key fields | Verification | Status effect |
|----------|-----------|--------------|---------------|
| Equipment use | product, batch no., start/end time, operator | — | sets *In use* → *Dirty* at end |
| Equipment cleaning | type (batch-to-batch / product changeover / major), procedure ref, start/end, cleaned by | checked by supervisor/QA | *Dirty* → *Clean* (with clean-hold expiry) |
| Maintenance / breakdown | type, description, work done, parts, start/end | engineering sign-off; QA release after breakdown | *Under maintenance* while open |
| Calibration / qualification | instrument/equipment, due date, result (pass/fail), certificate ref | checked by | fail or overdue → *Not fit* |
| Area / room cleaning | room, type (daily/weekly/changeover), agents used | checked by | room *Clean*/*Dirty* |
| Line clearance | room/line, previous product/batch, next product/batch, checklist | QA | required before next *use* on that line |
| Sterile (opt-in): autoclave/steriliser cycle | load, cycle no., programme, result, chart/printout ref | checked by | — |
| Sterile: filter integrity | filter ID, test type, pre/post-use, result | checked by | fail blocks use |
| Sterile: room pressure differentials | room pair, reading, limits, time | — | out-of-limit flagged |

Admins can add fields to a template (text, number with limits, choice, date/time) and
publish a new template version; existing entries keep the version they were made on.

## 4. Main user flows
1. **Use equipment** — operator scans/selects equipment → system shows status → if
   not fit (dirty, clean-hold expired, calibration due/failed, under maintenance,
   line clearance missing) the start is blocked with the reason → otherwise operator
   enters product/batch and starts; ends later; status becomes *Dirty*.
2. **Clean and verify** — operator records cleaning → second person signs "Verified"
   (password re-entry, meaning shown) → status *Clean*.
3. **Breakdown** — anyone raises breakdown → *Under maintenance* (use blocked) →
   engineering records work → QA signs release → back in service.
4. **Calibration** — engineering records calibration with due date; system warns 7
   days ahead (configurable) and blocks use when overdue.
5. **Correct an entry** — entries are never deleted or overwritten; a correction
   creates a new version with mandatory reason; old value stays visible.
6. **QA review** — QA opens a logbook for a period (e.g. monthly), sees entries,
   corrections and open items, and signs "Reviewed"; later changes to that period
   are flagged on the review.
7. **Inspect / export** — any logbook or period exported as a readable PDF (with
   signatures and corrections) and CSV; audit trail filterable and exportable.

## 5. Cross-cutting rules (detail goes in the compliance register, deliverable c)
- Unique named accounts; password policy; session timeout; lockout after failures.
- Times come from the server, shown in plant local time (IST); entries are made
  when the action happens — back-dated entries are not possible, late entries are
  marked late with a reason.
- Audit trail of every create/correct/sign/status change/master-data change (who,
  when, old/new, reason); no one can edit or delete it.
- E-signature = user ID + password re-entry, with printed name, date/time and meaning
  (Performed / Verified / Released / Reviewed), linked to the exact entry version.
- Retention: no deletion; records kept at least as long as the strictest rule
  requires (to be fixed in the register); daily backups with a tested restore.

## 6. Non-functional
- Web app in a browser; works on a 10" tablet; usable with gloves (large targets).
- Single-site or multi-site in one installation; on-premise or private cloud.
- Target: 200 concurrent users per site, entry save < 1 s.
- Validation support: requirements → tests trace, generated test evidence.

## 7. Open questions for the owner
1. Is a barcode/QR label on equipment wanted for v1 (my default: yes, simple QR
   with the equipment ID, scanned with the tablet camera)?
2. Hosting: on-premise at each plant, or one private cloud for all sites (default:
   design for either; deploy with Docker)?
3. Should batch numbers be free text (default) or picked from an imported list?
