# Deliverable (c) — Minimum compliance register (draft 2)

Status: draft for owner approval · 2026-10-28. Draft 1 was verified clause by clause by three
independent checks; every mismatch and how this draft handles it is in
`04-register-verification.md`.

## How rules got in (owner's test)
1. **Binding source required:** 21 CFR 211 / Part 11 ("shall"), EudraLex Vol 4 chapters and
   annexes, or Revised Schedule M. FDA guidance (SA, DI) only narrows or explains *how*; it
   never creates a rule on its own.
2. **Logbook relevance:** the clause governs equipment/area use, cleaning, maintenance,
   calibration/status, or the e-records and e-signatures of those entries.
3. **Strictest requirement, simplest implementation**, one mechanism per need.
4. **Removability:** "Why required" names the clause that would break if the rule were
   dropped. Candidates that failed this test are listed in section D.

**Result: 24 product rules (LB), 9 customer-procedure rules (CP).**

**Source keys:**
- **211** and **P11**: 21 CFR Part 211 and Part 11, eCFR as of 26 Oct 2026.
- **C3 / C4 / C5**: EudraLex Vol 4 Part I, Chapters 3, 4 and 5.
- **A11**: EudraLex Vol 4 Annex 11 (2011).
- **A1**: EudraLex Vol 4 Annex 1 (2022).
- **SchM**: Revised Schedule M, G.S.R. 922(E), Part I. Read from the gazette text extracted in the eBMR repo.
- **Guidance (non-binding):** **SA**, FDA Part 11 Scope and Application (2003); **DI**, FDA Data Integrity Q&A (2018).

SchM clause labels in the extract are column-scrambled. Where a number was matched by
position rather than read beside its text, it is marked † — to confirm against the gazette PDF.

## A. Product rules

### Logbook content

| ID | Rule | Binding clauses | Why required (breaks if dropped) | Least-strict implementation | Test |
|----|------|-----------------|-----------------------------|----------------------------|------|
| LB-01 | Each major/critical equipment item and each processing area has a log of its use, in chronological order. Use entries show date, time, product and batch. | 211.182; C4 4.31; SchM 17.3.10.17† | 211.182 (date, time, product, lot); C4 4.31 and SchM (areas and chronological order). | One logbook per equipment/area. The *use* entry needs product, batch, start and end; times come from the server. The dedicated-equipment exemption in 211.182 is not used, because C4 and SchM have none. | Use entry refused without product/batch; list is in chronological order. |
| LB-02 | Cleaning, maintenance/repair, calibration (and qualification where recorded) of major/critical equipment, and cleaning of areas, are logged with dates and the identity of who did them. | 211.67(c), 211.182; 211.194(d) (lab instruments); C4 4.31; C3 3.2, 3.41; SchM 17.3.10.16, 18.4.9 | All listed. | Templates: equipment cleaning, maintenance/breakdown, calibration, area cleaning. Every entry carries the logged-in user and the server time. | Each template saves with user and time. |
| LB-03 | Equipment cleaning and maintenance are signed by the person who did it and double-checked and signed by a second person. | 211.182 | 211.182 (the only clause requiring a second person for these). | Cleaning and maintenance entries need a *Performed* and a *Verified* e-signature from two different users. Other entry types need no second person unless LB-09 applies. | Same user cannot verify; entry shows "awaiting verification" until signed. |
| LB-04 | Records are made at the time of the action. | 211.100(b), 211.160(a); C4 4.8; SchM 17.2.8† | All listed. | Activity time defaults to server "now" and cannot be in the future. An earlier time beyond a site-set window (default 30 min) is a *late entry*: it needs a reason and is flagged in views and exports. | Future time refused; late entry flagged and needs a reason. |

### Equipment and area status (fit for use)

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|----------------------------|------|
| LB-05 | Instruments and equipment are calibrated at set intervals. Out-of-calibration items are not used, and the due date is clearly indicated. | 211.68(a), 211.160(b)(4); C3 3.41; SchM 18.4.9 | 211.160(b)(4) (must not be used); SchM 18.4.9 (due date shown). | The calibration entry stores the result and the next due date. *Overdue* or *failed* blocks new use entries. The due date is shown on the equipment page and on a printable status label. The physical label is the site's job (CP-04). | Use refused when overdue/failed; allowed after a passed calibration. |
| LB-06 | Defective equipment is withdrawn from use until fixed. Repair must not put product at risk, and return to use after maintenance is approved. | SchM 18.4.3; C3 3.35, 3.44; A1 5.6–5.7 (sterile) | SchM 18.4.3 (withdrawn, which is stricter than C3 3.44 "labelled"); A1 5.6. | A breakdown entry sets *Out of service* and blocks use. Return to service needs a *Released* signature (role configurable, default QA). For sterile-flagged equipment, an impact-assessment field is also required. | Use blocked while out of service; release needs signature (+ impact field when sterile). |
| LB-07 | Equipment is cleaned after use, and the time limit for clean equipment before use is respected. | 211.67(a); SchM 18.4.3, 18.4.4 | SchM 18.4.4 (clean-hold limit must be stated); 211.67(a) (cleaning at appropriate intervals). | The end of a use entry sets *Dirty*, which blocks the next use until a verified cleaning. Each equipment item has a clean-hold time; when it passes, the status becomes *Clean expired* (blocks use). No dirty-hold timer (see D). | Dirty and clean-expired both block use. |
| LB-08 | Major equipment and rooms are identified with what is in them (product, batch, stage) and with their status. | 211.105(a); C5 5.12, 5.13 | 211.105(a), C5 5.12. | The status shown everywhere is *In use: product / batch / stage*, *Clean*, *Dirty*, *Clean expired*, *Out of service* or *Calibration due*. A printable status label is available. Physical labels are the site's job (CP-04). | Status shows product/batch while in use. |
| LB-09 | Before any processing or packaging operation, the area and equipment are checked clear of previous materials and documents, and the check is recorded (by checklist for packaging). | SchM 18.4.1, 18.5.2; C5 5.40, 5.50; C4 4.18(c), 4.19(f)-(g); 211.130(e) (packaging) | SchM 18.4.1 and C5 5.40 (every operation); C5 5.50 (checklist). | A *line clearance* entry with a site checklist must exist after the last use ended before a new use can start on that equipment/line. One signature by the performer. A second-person check is optional per site (no binding clause requires it outside FDA batch-record steps). The clearance is visible in the batch view so it can be filed in the BPR (CP-05). | Use refused without a clearance since the last use. |
| LB-10 | Steps happen in their permitted order. | P11 11.10(f) | 11.10(f). | Server checks: end after start; verify only after performed; LB-05 to LB-09 blocks. | One test per check. |
| LB-11 | Critical manually entered data are checked independently or by validated electronic means; input is checked for accuracy. | SchM 17.2 EDP para†; A11 6; 211.68(b) | SchM (independent check of critical data, not risk-based). | Typed fields with limits in each template. Fields marked *critical* in the template (defaults: calibration result, filter test value, sterilisation result) need a *Verified* signature. An out-of-limit value needs a comment and a deviation reference. | Critical field unverified → entry incomplete; out-of-limit needs comment. |

### Sterile templates (switched on per site)

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|----------------------------|------|
| LB-12 | Each sterilisation or bio-decontamination cycle has a record with a unique ID, reviewed before batch release. The steriliser's routine tests (leak, air removal) are recorded. | A1 8.45, 8.60, 8.61, 4.22 | A1 8.45 (unique ID, records); 8.60/8.61 (tests); 4.22 (VHP cycles). | One *cycle* template (type: steam, dry heat, SIP, VHP) with: cycle ID unique per equipment, programme, load, result, and a reference to the controller printout or e-record (attachment allowed). It has a *Verified* signature that the record conforms. Approval for release stays in the batch release process. A *steriliser test* template covers leak and Bowie-Dick tests. | Duplicate cycle ID refused; failed test flags the steriliser. |
| LB-13 | Sterilising filters are integrity-tested before use (or a justified alternative applies) and after use before removal from the housing. Vent filters are tested at set intervals. | A1 8.87, 8.88, 8.89 | A1 8.87–8.89. | *Filter integrity* template: filter ID/lot, pre-use or post-use, method, value against limit, result. The pre-use option "not performed – risk assessment ref." is allowed. A fail marks the filter as failed. | Fail flagged; RA ref. required when pre-use skipped. |
| LB-14 | Cleanrooms are cleaned and disinfected to a written programme that includes a sporicidal agent. | A1 4.33; C3 3.2 | A1 4.33. | The area cleaning entry for classified rooms records the agent, its type (incl. sporicidal) and the disinfectant lot. | Agent and type required for classified rooms. |
| LB-15 | Isolator/RABS glove integrity is tested at set times. | A1 4.21 | A1 4.21. | *Glove integrity* template (glove/port ID, test, result); a fail blocks the isolator. Shown only if the site has isolators/RABS. | Fail blocks use. |
| LB-16 | Air pressure differences: critical ones are continuously monitored and recorded with alarms; others are monitored and recorded at regular intervals. Environmental controls are recorded. | A1 4.16; C5 5.43; SchM 18.4.2 | A1 4.16 ("regular intervals"); SchM 18.4.2. | Manual *pressure reading* points are allowed only where the point is classified *non-critical* (classification and contamination control strategy (CCS) reference approved under LB-24). Each point has a reading interval; missed readings are flagged; an out-of-limit value needs a comment and a deviation reference. Critical points belong to the BMS/EMS (CP-09). | Critical point cannot be set to manual; missed reading flagged. |

### Records, audit trail, signatures

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|----------------------------|------|
| LB-17 | Alterations keep the original readable and are signed and dated, with a reason. Nothing is deleted. | C4 4.9; SchM 17.2.7†; P11 11.10(e) (not obscured) | C4 4.9 / SchM (signed, dated, original readable); 11.10(e). | Entries are append-only versions. A correction is a new version that needs a reason and an e-signature with meaning *Corrected*. *Void* is a correction. The DB user of the app has no UPDATE/DELETE on entry, signature and audit tables. | Old value visible after correction; DB refuses delete. |
| LB-18 | A computer-generated, time-stamped audit trail records who created, changed or deleted what and when. It cannot be altered, is kept as long as the record, and is readable. | P11 11.10(e); SchM 17.2 EDP para†; A11 9, 12.4 | 11.10(e) (FDA may use enforcement discretion, SA III.C.2, but SchM requires a "record of changes and deletions" outright, so strictest wins). | One audit table, written by the server in the same transaction: user, UTC time, action, old/new, reason. It covers entries, signatures, statuses, templates, master data, users and roles. | Every action leaves an audit row; table not writable by the app. |
| LB-19 | Signatures show printed name, date/time and meaning on screen and in print. They are permanently linked to their record and have the same impact as handwritten ones. | P11 11.50, 11.70; A11 14 | P11 11.50, 11.70; A11 14(b)-(c). | The signature stores full name, server time and meaning (*Performed, Verified, Released, Reviewed, Approved, Corrected*). It references the exact entry version and a hash of its content; a correction needs fresh signatures. Times are shown with the zone, "IST (UTC+05:30)". | Fields shown in view/PDF; altered content fails hash check. |
| LB-20 | E-signatures are unique to one person and never reused or reassigned. They use two components (ID + password) and only their owner can use them. | P11 11.100(a), 11.200(a) | P11 11.100(a), 11.200(a). | Every signing asks for user ID + password. User IDs can never be renamed or reused (DB unique, including deactivated users). Admins cannot see or set a usable password: a temporary password must be changed at first login. | Wrong password or other user's ID fails; reused ID refused. |
| LB-21 | Only authorised people can use the system, with authority checks per action and unique accounts. Access grants are recorded. Attempted misuse is reported urgently; passwords are periodically revised. | P11 11.10(d), (g), 11.300(a), (b), (d); 211.68(b); A11 12.1, 12.3; SchM 17.2 EDP para† | All listed. | Named accounts; server-side role check on every action; the *Admin* role cannot create entries or sign. User and role changes are audited. Session timeout (default 15 min). Password expiry (default 90 days). 5 failed attempts lock the account and **email** the site's security contact. Access-list report for periodic review. The QR code opens the app behind login, so there is no public page. | Each role refused outside its rights; lockout sends email. |
| LB-22 | Accurate, complete human-readable and electronic copies are available. Printouts show whether data changed since original entry. The audit trail is exportable in readable form. | P11 11.10(b); 211.180(c), (d); A11 8.1, 8.2, 9 | P11 11.10(b); A11 8.2 (logbook entries support batch review). | PDF and CSV export of a logbook/period, of a **batch view** (every entry referencing a batch) and of the audit trail. Corrected entries are marked and their versions are included. | Export contains versions, signatures and correction flags. |
| LB-23 | Records are protected and retrievable for the whole retention period; stored data is checked for readability. Backups are regular, kept secure from loss, and their restore is checked. | P11 11.10(c); 211.68(b), 211.180(a); C4 4.10–4.12; A11 7.1, 7.2, 17; SchM 17.2.8†, 17.2 EDP para† | All listed. | Nothing is ever deleted, which is the simplest way to meet every period (the longest sources are C4 4.11/4.12; SchM ≥ 1 yr after expiry). Daily backup plus a monthly archive copy kept indefinitely. A built-in *integrity check* job re-reads all records and verifies signature hashes, with the result logged. A restore-verification script ships with the product; running it periodically is CP-03. | No delete path; integrity job detects a tampered row; restore script passes in CI. |

### Configuration and review

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|----------------------------|------|
| LB-24 | Templates are controlled documents: approved, signed and dated, uniquely versioned, with an effective date. Superseded versions cannot be used. Configuration changes are controlled. | C4 4.1, 4.3; SchM 17.2 (documents approved, superseded versions)†; A11 10; 211.100(a) | C4 4.3; SchM. | Template versions need a QA *Approved* signature and an effective date. Entries keep their version. The superseded version is closed for new entries. Config changes are audited. | Unapproved/superseded template unusable. |
| LB-25 | Audit trails are reviewed regularly. Logbook data that supports a batch is reviewed (with its audit trail) as part of the production-record review before release. | A11 9; 211.22(a), 211.192; SchM 18.5.12 | A11 9 (regular audit-trail review); 211.192 / SchM 18.5.12 (production records reviewed before release). | (a) A QA *Reviewed* signature on a logbook period, showing entries, open items (unverified, late, out-of-limit, corrected) and the audit trail for the period; a later correction marks the review "superseded". (b) The batch view (LB-22) gives the batch reviewer every logbook entry and audit row for that batch. | Review shows audit rows; later change flags the review. |

## B. Customer procedures (required; the product supports them but cannot do them)

| ID | Rule | Binding clauses | Product support |
|----|------|-----------------|-----------------|
| CP-01 | Validate the system for its intended use (incl. configured templates); test data limits, error handling and data migration on upgrades. | P11 11.10(a); A11 1, 4 (incl. 4.7, 4.8), 17; SchM Part I 5 / 17.2 EDP† | Supplier validation pack: requirements → rule IDs → CI test evidence; upgrade migration checks. |
| CP-02 | Qualified people with defined responsibilities and access; training. | P11 11.10(i); A11 2 | — |
| CP-03 | Policies: signature accountability; identity check before issuing accounts; certification to FDA; periodic access review; periodic restore test. | P11 11.10(j), 11.100(b), (c), 11.300(b); A11 7.2 | Signature declaration text; access-list report; restore script. |
| CP-04 | Written SOPs for cleaning, maintenance, calibration and sanitation, kept near the equipment; physical status and calibration labels. | 211.56(b), 211.67(b), 211.160(b)(4); C3 3.36; C4 4.29, 4.30; SchM 17.3.10.5, 17.3.10.18†, 18.4.9 | Templates carry the SOP reference; printable labels. |
| CP-05 | Line-clearance results and equipment identity filed in the batch production record. | 211.130(e), 211.188(b)(2), (6); C4 4.20, 4.21 | Batch view export (LB-22). |
| CP-06 | Supplier agreement and assessment; supplier documents made available to inspectors; quality agreement on who holds infrastructure access (needed for the "closed system" argument if hosted). | A11 3; P11 11.30 | Supplier documentation pack. |
| CP-07 | Change control, incident management, periodic evaluation; system documentation controlled and available for inspection. | A11 10, 11, 13; P11 11.10(k), 11.1(e) | Release notes; versioned docs. |
| CP-08 | Business continuity: controlled paper forms when the system is down, retained as the original record, then transcribed. Electronic records are the defined official record. | A11 16; C4 Principle and 4.1 (hybrid records defined) | Late entry with reason "transcribed from form no. …" (LB-04). |
| CP-09 | Continuous monitoring and alarms for critical pressure differentials. | A1 4.16 | Out of scope (BMS/EMS). |

## C. Considered and not applicable

| Clause | Reason |
|--------|--------|
| P11 11.30 (open systems) | Closed system: access is controlled by the manufacturer (on-premise, or hosted under the CP-06 agreement). |
| P11 11.10(h) (device checks, "as appropriate") | No device or instrument input in v1. The QR code only opens an equipment page; the logged-in user enters and confirms. Revisit if terminals per area are wanted. |
| P11 11.200(b), 11.300(c), (e) | No biometrics, tokens or cards. |
| A11 5 | No data interfaces in v1. |
| A11 15 | The logbook never certifies or releases batches; no "release" meaning applies to batches. |
| 211.182 dedicated-equipment exemption | Not used (C4/SchM have no exemption). |

## D. Dropped candidates (removability test: no binding clause breaks)

| Candidate | Why dropped |
|-----------|-------------|
| Mandatory QA verification of every line clearance | No binding clause requires a second person for clearance; one signature + optional site setting. |
| Dirty-hold time (max time before cleaning) | SchM 18.4.3 says clean "without delay" (a procedure), but no clause sets a timer; only the clean-hold limit is binding (LB-07). |
| Cleaning/maintenance due-date schedules and reminders | 211.67(b)(2) puts schedules in SOPs; nothing requires the software to track them. Calibration due date stays (LB-05). |
| Disinfectant preparation log, sterilised-item hold time, filter usage counter, airlock/access logs (A1 4.34–4.35, 8.46, 8.94–8.95, 4.11, 7.5) | Batch record, material or access-control matters, not equipment/area logbook entries. Sites can add a template if wanted. |
| Water-pipe sanitisation and storage-condition templates (C3 3.43, 3.19) | Covered by SOPs; a site can configure a template; no software rule. |
| Simultaneous-product check in a room (C5 5.9) | Already effectively enforced: an area *In use* blocks a second use (LB-07/LB-08). No separate rule. |
| Device/terminal restriction | See section C. |
| Batch-triggered review workflow inside the logbook | The batch view feeds the existing BPR review (LB-25b); a second review workflow isn't required. |
| Physical label printing as a requirement | The label is a site obligation (CP-04); printing is a convenience. |
| Tracking FDA guidance-only items (DI Q8 frequency, DI 1.e) as separate rules | Guidance only; their substance is already met through LB-23 and LB-25 under binding clauses. |

## E. Open points for the owner
1. **SchM numbers marked †** — extracted text is column-scrambled; please confirm against the
   gazette PDF (or I can do it if you upload the PDF). Wording was verified; numbers are not certain.
2. **SchM sterile provisions** (Part I sterile-products section) are not yet mapped clause by
   clause; Annex 1 is stricter on every sterile row here, so no product change is expected.
3. **Defaults** (late-entry window 30 min, timeout 15 min, password expiry 90 days, 5 attempts,
   QA as releaser after breakdown) are configurable product defaults, not regulatory numbers.
