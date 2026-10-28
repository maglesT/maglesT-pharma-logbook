# Deliverable (c) — Minimum compliance register (draft 1)

Status: draft for verification and owner approval · 2026-10-28

Rules are paraphrased; citations give document and clause. "Strictest wins" is noted
where sources differ. Every product rule gets automated tests whose names start with
the rule ID (e.g. `LB-07: correction keeps original value`).

**Source keys**

| Key | Document (version read) |
|-----|-------------------------|
| 211 | 21 CFR Part 211, eCFR as of 26 Oct 2026 (owner upload) |
| P11 | 21 CFR Part 11, eCFR as of 26 Oct 2026 (owner upload) |
| SA | FDA Guidance, Part 11 Scope and Application, Aug 2003 (fda.gov) |
| DI | FDA Guidance, Data Integrity and Compliance With Drug CGMP Q&A, Dec 2018 (owner upload) |
| C3 / C4 / C5 | EudraLex Vol 4 Part I Ch 3 (rev. eff. 1 Mar 2015), Ch 4 (eff. 30 Jun 2011), Ch 5 (rev. 2015) |
| A11 | EudraLex Vol 4 Annex 11 (2011, owner upload) |
| A1 | EudraLex Vol 4 Annex 1 (2022, owner upload) |
| SchM | India Revised Schedule M, G.S.R. 922(E) — **not yet received; column pending** |

## A. Product rules (the software must do these)

### Logbook content and use

| ID | Rule (paraphrase) | Sources | How the product meets it | Test |
|----|-------------------|---------|--------------------------|------|
| LB-01 | Keep an individual log per major equipment item recording use, cleaning and non-routine maintenance, with date, time, product and batch/lot of each batch processed. | 211.182; C4 4.31; SchM pending | One logbook per equipment; *use* template requires product + batch, start/end time from server. Dedicated-equipment exemption in 211.182 is not used (C4 4.31 has none — strictest wins). | Entry rejected without product/batch; log lists entries with server times. |
| LB-02 | Keep logbooks also for critical analytical instruments and for areas/rooms where product is processed, covering use, calibration, maintenance, cleaning and repair. | C4 4.31; 211.67(c); SchM pending | Logbook owners can be equipment, instrument or area; templates for area cleaning, maintenance, calibration. | Area and instrument logbooks accept their template entries. |
| LB-03 | Entries are in chronological order and identify who did the work and when. | 211.182; C4 4.31; A11 12.4 | Entries appended with server timestamp and logged-in user; display ordered by activity time with entry time shown. | Order and attribution checked on list and export. |
| LB-04 | Cleaning and maintenance are signed by the person performing and double-checked (signed) by a second person. | 211.182; A11 6 | Cleaning and maintenance templates require a *Performed* and a *Verified* signature by different users. | Same user cannot verify; entry stays "awaiting verification" until signed. |
| LB-05 | Records are made at the time of the action (contemporaneous). | C4 4.8; DI Q12; DI 1.a (ALCOA); 211.160(a) for lab instruments | Time fields default to server "now"; activity time cannot be in the future; a time earlier than a configurable window (default 30 min) makes it a *late entry* requiring a reason, flagged in log and export. | Future time refused; late entry needs reason and is flagged. |
| LB-06 | Calibration/checks of instruments and equipment at defined intervals, with records; out-of-calibration instruments must not be used. | 211.68(a); 211.160(b)(4); C3 3.41; C4 4.29 | Calibration template records result and next due date; due date shown; *overdue* or *failed* status blocks new use entries. | Use refused when overdue/failed; allowed after passing calibration. |
| LB-07 | Equipment status (clean/dirty, defective, in use) is clearly indicated; defective equipment labelled or removed. | C5 5.12, 5.13, 5.21(viii); C3 3.44; 211.67(b)(5)-(6) | Status computed from entries and shown on every screen and on the QR page; breakdown sets *Out of service* until QA release; *Dirty* blocks a new use until cleaned and verified. | Status transitions; use blocked when dirty / out of service. |
| LB-08 | Before an operation starts, the area/line and equipment are checked clean and clear of previous materials and documents (line clearance), using a checklist; results documented. | C5 5.40, 5.50; 211.130(e); 211.67(b)(6) | Line-clearance template with a configurable checklist and QA verification; a *use* entry for a new product/batch on that line requires a verified clearance. | Use on line blocked without verified clearance. |
| LB-09 | Enforce the permitted sequence of steps. | P11 11.10(f) | Server-side checks: end after start; verify only after performed; no use while in use/dirty/out of service; clearance before use (LB-08). | One test per sequencing rule. |
| LB-10 | Critical manually entered data get an accuracy check (second person or validated electronic means); input checked for accuracy. | A11 6; 211.68(b) | Typed fields with ranges/limits per template; out-of-limit values flagged; second-person verification on critical templates (LB-04). | Out-of-range value flagged; type errors refused. |

### Sterile templates (enabled per site)

| ID | Rule | Sources | How met | Test |
|----|------|---------|---------|------|
| LB-11 | Each sterilisation run has a record with a unique cycle identifier, reviewed as part of batch release. | A1 8.45; 211.113(b) | Autoclave/steriliser template with unique cycle ID per equipment (enforced), load, programme, result; batch view (LB-23) lists cycles for QA. | Duplicate cycle ID refused. |
| LB-12 | Sterilising filter integrity tested before use (post-sterilisation) and after use; results recorded. | A1 8.87 | Filter-integrity template (pre-use/post-use, method, result); failed test flags the filter and the referenced batch. | Fail result flagged; pre/post captured. |
| LB-13 | Cleanrooms cleaned and disinfected to a written programme, incl. periodic sporicide. | A1 4.33; 211.42(c)(10)(v) | Area cleaning template for classified rooms records agent and type (incl. sporicidal); schedule reminder. | Agent/type required for classified rooms. |
| LB-14 | Pressure differences between cleanrooms: critical ones continuously monitored **and recorded** with alarms; others indicated. | A1 4.16; 211.42(c)(10)(iv) | **Manual readings only** for non-critical differentials (with limits, out-of-limit flagged). Critical differentials need a continuous monitoring system (BMS/EMS) — **out of scope**; the logbook does not replace it. | Out-of-limit manual reading flagged. |

### Records, audit trail, signatures

| ID | Rule | Sources | How met | Test |
|----|------|---------|---------|------|
| LB-15 | Changes never obscure the original; altered entries show who, when and reason. No deletion of entries. | C4 4.9; P11 11.10(e); A11 9 | Entries are append-only versions; a correction creates a new version with mandatory reason; *void* is a correction with reason, never physical deletion; DB constraint prevents UPDATE/DELETE on entry and audit tables for the app user. | Correction keeps old value visible; DB rejects delete. |
| LB-16 | Secure, computer-generated, time-stamped audit trail of creation, modification (and deletion) of records, users' identity, date/time; reason for GMP changes; kept as long as the record; available for review. | P11 11.10(e); A11 9, 12.4; DI 1.c; SA III.C.2 | Single audit table written by the server in the same transaction as each change (who, server UTC time, action, old/new values, reason); covers entries, signatures, status, templates, master data, users/roles. Users cannot edit it. | Every action produces an audit row; audit table not writable. A11 9 is risk-based, P11 11.10(e) is not — strictest wins. |
| LB-17 | Audit trail reviewed regularly by the people who review the records; readable form. | A11 9; DI Q7, Q8 | QA logbook review (LB-22) shows the audit trail for the period alongside entries; audit trail viewer with filters and export. | Review screen includes audit rows for the period. |
| LB-18 | Signed records show printed name, date/time and meaning; the same in every display and printout. | P11 11.50(a)-(b); A11 14(c) | Signature stores user's full name, server time and meaning (*Performed, Verified, Released, Reviewed, Approved*); rendered on screen, PDF and CSV. | Signature fields present in view and export. |
| LB-19 | Signatures are permanently linked to their record and cannot be copied to another. | P11 11.70; A11 14(b) | Signature row references the exact entry version and stores a hash of that version's content; a later correction requires new signatures; signature table append-only. | Changing entry invalidates verification; hash checked. |
| LB-20 | E-signature: unique to one person, two components (ID + password), used only by its owner. | P11 11.100(a), 11.200(a)(1)-(3); A11 14(a) | Each signing re-asks user ID + password (satisfies both 11.200(a)(1)(i) and (ii)); passwords hashed, admins cannot see or set a usable password (temporary password must be changed at first login). | Signing fails with wrong password or another user's ID. |

### Access, security, data retention

| ID | Rule | Sources | How met | Test |
|----|------|---------|---------|------|
| LB-21 | Access limited to authorised individuals; authority checks per action; unique accounts, no shared logins; admin independent of record content; access grants/changes recorded. | P11 11.10(d), 11.10(g), 11.300(a); 211.68(b); A11 12.1, 12.3; DI Q4, Q5 | Named accounts, role-based permissions checked on the server for every action; *Admin* role cannot create entries or sign; user/role changes audited; user-access list export. Session timeout (default 15 min). | Each role denied actions outside its rights; admin cannot sign. |
| LB-22 | Passwords periodically revised; attempts at unauthorised use detected and reported. | P11 11.300(b), (d) | Password expiry (configurable, default 90 days); lockout after 5 failures with alert to admins in the app and in the audit trail. | Lockout and alert after failures; expired password forces change. |
| LB-23 | Accurate, complete copies in human-readable and electronic form for inspection; clear printouts; audit trail convertible to intelligible form. | P11 11.10(b); 211.180(c); A11 8.1, 9; DI Q9, Q10; SA III.C.4 | PDF and CSV export of any logbook/period and of the audit trail, including corrections and signatures; batch view: all entries referencing a batch. Original electronic records retained (exports are copies). | Export contains all versions, signatures; PDF readable. |
| LB-24 | Records protected and retrievable throughout retention; retention at least as long as the longest applicable period. | P11 11.10(c); 211.180(a), (c); C4 4.10-4.12; A11 7.1, 17; SA III.C.5 | No deletion in the product at all (simplest way to meet every period; the longest is C4 4.11: ≥ 1 yr after batch expiry or 5 yrs after QP certification). Archive = read-only, still searchable. | No delete path exists (API and DB). |
| LB-25 | Regular backups; integrity and restorability checked. | 211.68(b); A11 7.2 | Daily encrypted DB backup + WAL; restore script; restore test documented in validation and repeated periodically (customer SOP). | Automated restore test in CI on a sample DB. |
| LB-26 | Controlled templates and configuration: changes only by authorised persons, controlled and versioned. | C4 4.1; A11 10; DI Q6; P11 11.10(k) | Templates versioned; publishing a version requires QA *Approved* signature; entries keep their template version; configuration changes audited. | Unpublished template unusable; version history kept. |

### Review

| ID | Rule | Sources | How met | Test |
|----|------|---------|---------|------|
| LB-27 | Logbooks (with their audit trail) are reviewed by QA; review signed. | DI Q7, Q8; A11 9; A1 8.45 (sterilisation records reviewed); 211.192 (production records) | QA *Reviewed* signature on a logbook for a period; open items (unverified entries, late entries, out-of-limit values, corrections) listed; later corrections in that period flag the review as superseded. | Review signature; flag after later change. |

## B. Supported by the product, owned by the customer's procedures (SOPs)
These are required but are not software features beyond what is listed.

| ID | Rule | Sources | Product support |
|----|------|---------|-----------------|
| CP-01 | Computerised system validated (risk-based); user requirements traceable. | P11 11.10(a); A11 Principle, 1, 4; 211.68; DI Q3; SA III.C.1 | Supplier validation pack: requirements → rule IDs → test evidence from CI. |
| CP-02 | Training of users, developers, maintainers. | P11 11.10(i); A11 2 | — |
| CP-03 | Written policy holding users accountable for their e-signatures. | P11 11.10(j) | Signature screen shows the meaning and a declaration text. |
| CP-04 | Verify identity before issuing an account/e-signature; certify e-signatures to FDA. | P11 11.100(b), (c) | — |
| CP-05 | Written procedures for cleaning, maintenance, calibration, sanitation; schedules. | 211.67(b); 211.56(b); 211.160(b)(4); C3 3.36; C4 4.29, 4.30 | Templates hold the SOP reference; due-date reminders. |
| CP-06 | Supplier/service-provider agreements and assessment. | A11 3 | — |
| CP-07 | Periodic evaluation, incident management, change control of the system. | A11 10, 11, 13 | Release notes per version; audit trail of configuration. |
| CP-08 | Business continuity (paper fallback when system down). | A11 16 | Late entry with reason "transcribed from paper record no. …" (LB-05). |
| CP-09 | System documentation control. | P11 11.10(k) | Versioned docs in the repo. |
| CP-10 | Continuous monitoring of critical pressure differentials. | A1 4.16 | Out of scope (BMS/EMS). |

## C. Considered and not applicable

| Clause | Why not applicable |
|--------|--------------------|
| P11 11.30 (open systems) | Closed system: access controlled by the manufacturer. TLS used anyway. |
| P11 11.10(h) (device checks) | "As appropriate": no instrument or device input in v1; all entries via authenticated users. |
| P11 11.200(b), 11.300(c), (e) | No biometrics, tokens or cards. |
| A11 5 (electronic data exchange) | No interfaces in v1. Revisit if imports/integrations are added. |
| A11 8.2, A11 15 (batch release) | The logbook does not certify or release batches. |
| 211.182 dedicated-equipment exemption | Not used; we keep logs for all equipment (C4 4.31). |

## D. Open points
1. **Schedule M not yet received** — every row needs a SchM column; anything stricter
   will be added and reported.
2. LB-14: manual pressure logs are only acceptable for non-critical differentials. Owner
   to confirm this scope.
3. LB-05 late-entry window (default 30 min) and LB-21/22 defaults (15-min timeout, 90-day
   password expiry, 5 attempts) are product defaults configurable per site, not
   regulatory numbers.
