# Deliverable (a) — Source documents

Status: draft for owner approval · 2026-10-28

These are the official texts the compliance register will cite. Only clauses that a
logbook needs are used; the rest of each document is out of scope. Official PDFs are
kept **out of git**; the repo stores only titles, version/date, URL, and short
paraphrases (`compliance/sources.yaml`, created with deliverable (c)).

| # | Document | Version to use | Why the logbook needs it | Who supplies |
|---|----------|----------------|--------------------------|--------------|
| 1 | **21 CFR Part 211** (cGMP for finished pharmaceuticals) — eCFR | Current eCFR text, date-stamped when fetched | The core logbook rule: §211.182 equipment cleaning and use log. Also §211.67 (cleaning/maintenance records), §211.68 (computerised systems: access control, backup), §211.160(b)(4) (instrument calibration), §211.180 (record retention, availability for inspection), §211.194(d) where instrument calibration records apply, §211.42/211.113 for sterile areas. | I fetch (public) |
| 2 | **21 CFR Part 11** (electronic records; electronic signatures) — eCFR | Current eCFR text | Audit trail, access control, system checks, signature manifestation (name, date/time, meaning), signature–record linking, ID/password controls (§11.10, 11.50, 11.70, 11.100, 11.200, 11.300). | I fetch (public) |
| 3 | **FDA Guidance: Part 11, Electronic Records; Electronic Signatures — Scope and Application** (Aug 2003) | Final | Tells us which Part 11 controls FDA enforces and which it applies with discretion (validation, audit trail, legacy, copies, retention) — this is what lets us keep the register *minimal*. | I fetch (public) |
| 4 | **FDA Guidance: Data Integrity and Compliance With Drug CGMP — Q&A** (Dec 2018) | Final | ALCOA; contemporaneous entries; no shared logins; audit-trail review by QA; "blank forms"/control of templates; when electronic data is the record. | I fetch (public) |
| 5 | **EudraLex Vol 4, Part I, Chapter 4 — Documentation** (2011) | In force | Logbooks for major equipment and areas, chronological entries with date and identity (Ch 4 logbook clause); records made at the time of action; corrections traceable with reason; retention. | I fetch (public) |
| 6 | **EudraLex Vol 4, Part I, Chapter 3 — Premises and Equipment** | In force | Calibration at defined intervals with records; defective equipment removed or labelled; cleaning of equipment — basis for "status blocks use". | I fetch (public) |
| 7 | **EudraLex Vol 4, Annex 11 — Computerised Systems** (2011) | In force | Validation, data checks, backups, printouts/readable copies, audit trail, security, e-signatures, periodic review, archiving, business continuity. | I fetch (public) |
| 8 | **EudraLex Vol 4, Annex 1 — Manufacture of Sterile Medicinal Products** (2022, effective Aug 2023) | In force | Only for the optional sterile templates: room pressure differentials, sterilisation cycle records, filter integrity testing, cleanroom cleaning/disinfection. | I fetch (public) |
| 9 | **India Revised Schedule M** — G.S.R. 922(E), 28 Dec 2023 (Drugs Rules 1945) | As notified | Indian equipment logbook, cleaning, calibration, documentation and data-integrity/computerised-system provisions; checked wherever it is stricter than FDA/EU. | **Owner please** — official e-Gazette copy (CDSCO mirrors are not always reachable from here) |
| 10 | *(Optional)* **EudraLex Annex 11 revision — draft for consultation** (Jul 2025), with draft Ch 4 | Draft | Informative only: shows where EU is heading (e.g. stricter audit-trail review, e-signature rules), so we don't build something that will need redesign. Not cited as a requirement. | I fetch if owner wants it |
| 11 | *(Optional)* **PIC/S PI 041-1 — Good Practices for Data Management and Integrity** (2021) | Final | Practical interpretation of ALCOA+ for logbooks (e.g. sequential entries, review of logbooks). Used only to settle ambiguity; not a binding source. | I fetch (public) |

Deliberately **not** used (to keep the register minimal): ICH Q9/Q10, GAMP 5, WHO TRS
annexes, MHRA GxP DI guidance, 21 CFR 210/212/600 series. They can be added later if
an inspection or customer asks.

## What I need from the owner
1. **Schedule M (G.S.R. 922(E))** — the official Gazette PDF (or a link that opens).
   Needed because it is the only binding text I cannot reliably fetch, and the brief
   says the stricter rule wins, so I must read it, not recall it.
2. **Decision:** cite only in-force texts (my default), and treat the 2025 Annex 11 /
   Ch 4 drafts as informative? Reply "yes" or say otherwise.
3. **Repository:** please create the empty private repo `maglesT/pharma-logbook` and
   allow this session to attach it (the attach attempt was blocked by this session's
   permission settings). Until then the documents live locally in this session.
