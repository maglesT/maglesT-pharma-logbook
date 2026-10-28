# Register verification report (draft 1 → draft 2)

Date: 2026-10-28.

**Method.** Three independent read-only checks compared every citation in register draft 1
with the official text:
- US: 211, P11, SA and DI (68 citations);
- EU: C3, C4, C5 and A11 (51 citations);
- sterile: A1, plus the 211 sterile clauses.

Each check asked: does the clause exist; does it say what we claimed; is our measure
adequate; what is missing? After that:
- Schedule M wording was checked by me against the gazette text extracted in the eBMR repo;
- every clause newly added in draft 2 was spot-checked against the source text.

**Overall.** Every cited clause number exists. The problems were over- or mis-attributed
citations, some measures that fell short, and missing clauses. None was silently fixed:
each is listed below with how draft 2 handles it. **Please confirm or object.**

## 1. Wrong or overstated citations (fixed in draft 2)

| Draft-1 rule | Finding | Draft 2 |
|--------------|---------|---------|
| LB-01 | C4 4.31 asks only for dates and identity; time, product and batch come from 211.182. | Attribution split in LB-01/LB-02. |
| LB-02 | 211.67(c) covers equipment, not rooms or calibration. | Area/calibration now cite C4 4.31, C3 3.2, C3 3.41, SchM. |
| LB-03 | 211.182 requires attribution only for cleaning and maintenance. | Use attribution rests on C4 4.31 and SchM 17.3.10.17. |
| LB-04 | A11 6 is about accuracy checks, not second-person verification of cleaning. | Now 211.182 only (LB-03). |
| LB-06 | C4 4.29 is only about procedures. Only 211.160(b)(4) says "not used". | Citations corrected (LB-05); SchM 18.4.9 added. |
| LB-07 | Several citations were wrong or overstated: 211.67(b)(5)-(6) is SOP content, not labelling; C5 5.12 is about product and batch, not clean or dirty; 5.13 colours are optional; 5.21 is risk-based and has two lists. | Draft 2 cites 211.105(a) and C5 5.12/5.13 for identification, and SchM 18.4.3/18.4.4 for withdrawal and clean-hold. 5.21 dropped. |
| LB-08 | C5 5.40 has no checklist; 5.50 (packaging) does. 211.130(e) applies to packaging and must go into the BPR. Clearance was required only on product change, which is too narrow. | Clearance is now before **every** new use (SchM 18.4.1, C5 5.40). Checklist kept. BPR filing → CP-05. |
| LB-11 | 211.113(b) covers procedures and validation, not per-cycle records. A1 8.45 says "reviewed and approved as part of batch certification", not only "reviewed". | 211.113(b) removed. Logbook *verifies* the cycle; approval stays in release (LB-12). |
| LB-13/14 | 211.42(c)(10)(iv)/(v) are facility-design clauses. | Removed as support. |
| LB-14 | **A1 4.16 misstated.** Non-critical differentials must be monitored *and recorded at regular intervals*, not just "indicated". | LB-16: reading interval, missed-reading flag, and non-critical classification approved with a CCS reference. |
| LB-15 | P11 11.10(e) does not require a reason or forbid deletion; those come from C4 4.9 / SchM / A11 9. C4 4.9 says alterations are *signed* and dated. | LB-17: citations corrected; a correction now needs an e-signature (*Corrected*). |
| LB-16 | We wrote that P11 11.10(e) "is not risk-based". The 2003 guidance (SA III.C.2) gives enforcement discretion on audit trails. | Corrected. Audit trail stays mandatory because **SchM** requires a record of changes and deletions without a risk qualifier. |
| LB-17/27 | DI Q8: where a regulation sets the review frequency (before release), review the audit trail then too. 211.192 is about release timing, not a periodic review. | LB-25: periodic logbook review (A11 9) plus a batch view so the release reviewer sees entries and audit rows. |
| LB-20 | A11 14(a) is about "same impact as handwritten", not the two components. No guard against reusing user IDs. | Citations corrected; user IDs can never be reused or renamed. |
| LB-22 | 11.300(d) wants *immediate and urgent* reporting; an in-app alert is too weak. | Email to the site security contact on lockout. |
| LB-24 | "C4 4.11 is the longest period" was wrong (4.11/4.12 have longer special cases). The A11 7.1 readability check and A11 17 retrieval test were missing. | Wording fixed; built-in integrity-check job; migration checks under CP-01. |
| LB-25 | A CI restore test of a sample database is not a check of real backups. Rotating backups are not "secure from loss". | Monthly archive copy kept indefinitely; periodic restore of real backups → CP-03. |
| LB-26 | P11 11.10(k) covers system documentation, not templates. | Now C4 4.1/4.3, SchM, A11 10, 211.100(a); effective date added. |
| CP-01 | Customer-configured templates also need customer validation (DI Q3 / A11 4). | Stated in CP-01. |
| §C A11 8.2 | Wrongly "not applicable": logbook entries support batch review. | Now applies; printouts flag changed entries (LB-22). |
| §C P11 11.10(h) | SA lists device checks as enforced; tablets and QR are input sources. | Kept not applicable, with the argument (the QR only navigates; the user enters and confirms). **Owner to accept.** |
| §C P11 11.30 | The closed-system claim needs an argument if the system is hosted by a third party. | Tied to the CP-06 quality agreement. |

## 2. Missing clauses (added where the removability test kept them)
- **Added:**
  - 211.100(b), contemporaneous production records;
  - 211.105(a), equipment identification;
  - 211.194(d), lab instrument calibration records;
  - 211.22(a), QC unit review before release;
  - C4 4.3, effective date on templates;
  - C5 5.43, environmental controls recorded;
  - A1 5.6/5.7, release after maintenance and impact assessment;
  - A1 8.60/8.61, steriliser leak and air-removal tests;
  - A1 8.88/8.89, vent filters;
  - A1 4.21, glove integrity;
  - A1 4.22, VHP cycles.
- **Schedule M (read from the gazette text):**
  - 17.3.10.16/17, equipment records and chronological use;
  - 18.4.1, check before any processing;
  - 18.4.2, environmental controls;
  - 18.4.3, defective equipment withdrawn, which is **stricter** than EU C3 3.44;
  - 18.4.4, clean-hold time limits, which are **new and binding**;
  - 18.4.9, calibration due date shown;
  - 17.2 EDP paragraph, independent check of critical data entry and a record of changes and deletions;
  - 18.5.12, production records reviewed before release.
- **Not added:** see register section D (dropped candidates), one line each.

## 3. Still open
- Schedule M clause numbers marked † (extracted text is column-scrambled; wording verified,
  numbers inferred from position and the WHO GMP ordering that Schedule M follows).
- Schedule M sterile-products provisions not yet mapped clause by clause.
- A second independent pass over draft 2 is planned after owner feedback, limited to the
  rows that changed.
