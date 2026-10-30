# Handover

Updated: 2026-10-30, after S11b (faster equipment list, readable history card).

## State
- Planning deliverables (a)–(d) are approved: decisions D-01 to D-05 in `decisions.md`.
- **S0 (skeleton) done:**
  - Fastify server with `/api/health`, serving the built React UI;
  - SQL migration runner (`db/migrate.ts`);
  - Vitest on real PostgreSQL, one schema per test file;
  - Docker + compose; GitHub Actions CI.

## Done: S1, accounts and audit trail (LB-18, LB-20, LB-21)
- **Database (migration 0002):** `users`, `user_roles`, `sessions`, `alerts`, `audit_log`. The app runs as `logbook_app`: `audit_log` is insert-only, `username` cannot be updated, and users cannot be deleted.
- **Login:** scrypt passwords (D-14), server-side sessions with a 15-min idle timeout, SameSite=Strict cookie, JSON-only writes.
- **Lockout:** after 5 failures the account locks and an on-screen alert goes to Admin and QA (D-10), with an audit entry.
- **Passwords:** temporary passwords must be changed at first login; passwords expire at 90 days.
- **Admin API:** list, create, edit (reason required), reset password.
- **UI:** login, change password, home with alerts, users admin. `npm run create-admin` handles first-time setup.

## Done: S2, master data, e-signatures and logbook settings (LB-19, LB-20, LB-24)
- **Database (migration 0004):** `site` (single row), `equipment` (equipment/instrument/area; code unique and never changeable; clean-hold hours), `products`, `logbook_settings` (versioned per type), `signatures` (insert-only, with the time set by the database).
- **Signing (`server/signatures.ts`):** `authenticateSigner()` runs in its own transaction, so failures count towards lockout. It returns a proof object that `sign()` requires. `sign()` stores the printed name, meaning and a SHA-256 of the canonical content, and Admin can never sign.
- **Logbook types are code (`server/logbook-types.ts`):** 10 types. Settings are drafted by Admin and approved by QA with an e-signature. A version is in force once approved and its effective date has passed; an effective date already past at approval becomes the approval time.
- **UI:** Master data (equipment, products, site), Logbook settings, and the reusable SignDialog.

## Done: S3, entries (LB-01–04, LB-10, LB-11, LB-17, LB-26)
- **`entries` (migration 0006):** insert-only versions sharing `entry_id`, linked by `supersedes`, which is unique so a history cannot branch. `change` is created, completed or corrected. `entered_at` comes from the database.
- **Locking:** writes lock the equipment row; the app role cannot row-lock entries.
- **Entry rules (`server/entries.ts`):** a zod schema per core type; system checks (`checkData`): checklist confirmed, calibration due date and failed calibration, classified-room agent and lot, sterile breakdown impact assessment; who may record each type.
- **Routes (`server/routes/entries.ts`):** create (performer e-signature for D-16 types), complete a use, correct (reason + *Corrected* e-signature), verify (different person, signs the shown hash), equipment log, versions, open items.
- **Late entries:** activity older than 30 min needs a reason; future times are refused (database clock).
- **UI:** Logbooks (equipment tiles, then the log page with entry forms, verify, correct and history); Home lists open items.

## Done: S4, status and blocking (LB-05–08)
- **`server/status.ts`:** one SQL query gathers the facts per item, and `deriveStatus()` turns them into a state, blockers and warnings (D-18).
- **States:** in use, dirty, clean, clean expired, out of service, calibration failed, overdue or not calibrated.
- **Blocking:** a use is refused while there are blockers; cleaning is refused while the item is in use.
- **Release:** `POST /api/entries/:id/release` (QA, *Released* signature) on a verified breakdown.
- **Equipment field:** `needs_calibration` (migration 0008).
- **UI:** status chips on tiles, a status bar with the reasons on the logbook page, a Release button, and the "Not fit for use" list on Home.

## Done: S5, review and exports (LB-18 viewer, LB-22, LB-25)
- **`reviews` (migration 0009):** `signatures.object_type` now also allows `review`.
- **Period review (`server/routes/review.ts`):**
  - `GET /api/equipment/:id/period` returns every version, open-item counts, the audit trail and a content hash;
  - `POST /api/equipment/:id/reviews` is the QA *Reviewed* signature on that hash;
  - a review shows as superseded when the versions in its period change.
- **Batch view and audit:** `GET /api/batches/:batch`; `GET /api/audit` with filters (QA/Admin).
- **Exports (`server/routes/exports.ts`):** `/api/export/period.(pdf|csv)` and `/api/export/batch.(pdf|csv)`, using pdfmake with Helvetica.
- **UI:** Review page with logbook review, batch view and audit trail tabs.

## Done: S6, sterile types (LB-12, LB-14–16)
- **Entry rules (`server/entries.ts`):** schemas for steriliser_cycle, steriliser_test, glove_integrity and pressure_reading.
  - Failed results need a comment and deviation reference.
  - The pressure out-of-limit flag is set by the server from the approved point limits.
- **Cycle ID:** unique per steriliser (`checkCycleId` in `routes/entries.ts`), checked under the equipment lock.
- **Status (`status.ts`):** a failed steriliser test or glove port means out of service, and the item also gets `cycleBlockers`, which stop new cycles. A failed last cycle and out-of-limit pressure readings are warnings.
- **UI:** forms for the four types; they show only on sterile equipment and rooms.

## Done: S7, integrity, backup and traceability (LB-23, CP-01 support)
- **`server/integrity.ts`:** recomputes every signature hash, checks version chains and that every entry version has its audit row, and writes `integrity.passed` or `integrity.failed` to the audit trail. It runs daily from the server process (`scheduleIntegrityCheck`); `/api/integrity` and `npm run integrity` are also available.
- **Scripts:** `ops/backup.sh` (pg_dump, SHA-256 file, 365-day retention) and `ops/restore-check.sh` (scratch restore, migrate, integrity). CI runs both.
- **Traceability:** `scripts/traceability.ts` writes `docs/traceability.md`. `--check` runs in CI and in `npm run ci`.
- **README:** "Operating the system" section.

## Done: S8, browser tests (main flows)
- **Playwright (chromium), `e2e/`:** `npm run test:e2e` builds the UI and starts the real server (`e2e/server.ts`) on its own schema `e2e` of the test database, with seeded users (`admin`, `qa1`, `op1`, `sup1`, `eng1`, `locky`, password as in `test/helpers.ts`), a product and approved core settings. Each spec creates its own equipment; set-up that is not the point of a test goes through the API, and time is moved with the owner connection as in the server tests.
- **Flows (10 tests):** log-in and forced password change, lockout with the on-screen alert to QA and Admin (LB-21); use → Dirty → blocked → cleaning signed by the operator and verified in the sign dialog → Clean → use, and clean-hold expiry (LB-07); correction keeps the original with its reason, late entry needs a reason (LB-17, LB-04); breakdown → Out of service → QA release (LB-06); overdue calibration blocks (LB-05); QA period review signed, batch view, PDF exports (LB-25); a failed steriliser test blocks the steriliser (LB-12).
- **Traceability:** `scripts/traceability.ts` also reads `test(` names in `e2e/*.spec.ts`.
- **CI:** job `browser` (`npx playwright install --with-deps chromium`, then `npm run test:e2e`); the HTML report is uploaded on failure.
- **Defect found and fixed (D-24):** a cleaning entered in the same minute as the end of the use (the form enters whole minutes) was accepted and verified, but the equipment stayed Dirty. `status.ts` now counts such a cleaning when it was first entered after the use ended; server test in `status.test.ts`.

## Done: S9, breakdown history and equipment history card (D-25; extends LB-02, LB-05, LB-06, LB-18, LB-22)
- **Breakdown entry (`server/entries.ts`):** new optional maintenance fields (occurred at, reported by, failure category, root cause, parts rows or "none", tools, in-house/vendor, WO and deviation refs, post-repair checks, re-calibration needed). `checkBreakdown()` requires them for new breakdowns; entries made before S9 keep their old rules.
- **Open repairs (`routes/entries.ts`):** a breakdown without a repair end is open. `POST /api/entries/:id/complete` now also completes a repair: new data plus a *Performed* signature, reported fields unchanged. Verify needs the repair ended.
- **Status:** "re-calibration needed" blocks use until a verified passed calibration after the repair.
- **Equipment details (migration 0011, `server/breakdowns.ts`):** `equipment_details` is insert-only and versioned. `PUT /api/equipment/:id/details` (Admin, reason, `expectedVersion`) writes the next version. The integrity check covers versions and audit rows. Location history is read from the audit trail.
- **Register and history card (`routes/history.ts`):** `GET /api/breakdowns` (filters, sort by downtime, counts per machine and category, MTTR, MTBF), `GET /api/equipment/:id/history` (all entry versions, reviews, master-data changes; type and date filters), and PDF/CSV exports `/api/export/breakdowns.*` and `/api/export/history.*`. The shared PDF frame is in `routes/exports.ts` (`tablesPdf`, `csvText`, `sendCopy`).
- **UI:** maintenance form with a breakdown report section, parts rows and "Repair finished"; a "Complete repair" button; a **Breakdowns** tab (register); a **History card** tab on each equipment page, with details editing for Admin.
- **Tests:** `test/breakdowns.test.ts` (20 tests), and `e2e/breakdowns.spec.ts` (4 browser tests, including the requested flow: breakdown with parts → verify → release → register downtime → history card).
- **Version:** 0.2.0 (shown by `/api/health`).

## Done: S10, voice notes (D-26; LB-17, LB-19, LB-20, LB-23, LB-24; CP-06, CP-10)
- **Speech service (`server/voice.ts`):** `sarvamProvider()` calls Sarvam `/speech-to-text` (`saaras:v3`, transcribe and translate modes) with `SARVAM_API_KEY` from the environment. `buildApp({ speech })` takes any `SpeechProvider`, so tests use a mock.
- **Database (migration 0012):** insert-only `voice_notes` (audio, hash, transcript, translation, languages, model, request time) and `voice_note_confirmations` (entry version, final text, edited). New signature object `voice_note` and meaning `voice_confirmed`.
- **API (`routes/voice.ts`):** `GET /api/voice-notes/config`, `POST /api/voice-notes` (limits, per-user rate limit, clear errors for no key, outage, timeout), `GET /api/voice-notes/:id` and `/:id/audio`. Entry create, correct and complete take `voiceNotes` + `voiceSignature`. `guardVoice` refuses an unconfirmed translation, and `confirmVoiceNotes` links and signs.
- **Site setting:** `voice_notes` in `LOGBOOK_TYPES` (no logbook, `appliesTo: []`) with `voiceLanguages`; drafted by Admin, approved by QA.
- **Integrity and exports:** the audio hash is recomputed in SQL, and confirmation signatures are checked. Period, batch and history exports note the voice note.
- **UI:** `components/VoiceNote.tsx` (MediaRecorder button with language choice and a 30-s stop; viewer with audio and texts). The entry form shows the draft notice, a Discard button and the separate confirmation sign box. Voice-note links appear on entries, history and the history card. The settings screen has a language editor.
- **Tests:** `test/voice.test.ts` (16; mocked service, plus a local fake Sarvam server for the client) and `e2e/voice.spec.ts` (2; fake microphone and mock service).
- **Before a site switches it on:** supplier assessment and agreement with Sarvam AI (CP-06) and staff consent (CP-10).

## Done: S11, screens offer only what the server accepts (D-17, LB-21)
- **Found on the trial installation:** QA saw "+ <type>" buttons and "Correct" on every entry. All of them were refused by the server (403 or a bare `invalid_request`).
- **Server:** `mayCorrect()` in `server/entries.ts` is the one D-17 rule, used by the correct route. `GET /api/equipment/:id/entries` adds `mayCorrect` per entry for the logged-in user, and `GET /api/logbook-types` adds `mayRecord` per type. A refused entry, complete, correct, verify or release body now lists its problems (e.g. "Give the reason for the correction.").
- **UI:** "+ <type>", "Complete repair" and "Correct" follow those flags, so QA and Admin see none. The correction reason is required and blocks "Sign and save" while empty. Forms and sign dialogs show the server's problems instead of the bare code.
- **Tests:** two in `test/entries.test.ts` and one in `e2e/entries.spec.ts` (QA, engineering, supervisor and author views). Version 0.3.1.

## Done: S11b, faster equipment list and readable history card
- **Equipment list:** `allStatuses()` derives the status in groups of 25 items. One query for all 317 items of the trial plant scanned every latest entry once per item and took about 2.3 s, so tiles first showed without a status. Results are identical; about 140 ms on a copy of the trial data. The list shows "Loading status…" until statuses arrive.
- **History card:** master-data events (item created, master data changed, equipment details changed) show the changed fields in words, e.g. "Location: Line A → Line B", from `server/changes.ts`; the history export uses the same text. The audit trail keeps the raw old and new values.
- **Version:** `VERSION` in `server/app.ts` now matches `package.json` (0.3.2); it had stayed at 0.3.0 in S11.
- **Breakdown register (0.3.3):** the register, its PDF and its CSV (`work_done`) now show the repair's "Work done" text next to the failure, so how a machine was repaired is readable without opening the machine.

## S12: breakdown suggestions from history (0.4.0)
- **What:** on a breakdown entry, **💡 Suggest from history** (operator, supervisor, engineering, QA; not Admin) lists related past breakdowns from the last 3 years (same machine, then same make and model from the equipment details, then same machine type by name) and, when switched on, asks a language model for likely causes, checks, parts and a preventive measure. Each point names the past entries it rests on; entry numbers the model was not given are dropped (`server/advice.ts`, `server/routes/advice.ts`).
- **Control (D-27):** site setting `breakdown_advice`, drafted by Admin and approved by QA like voice notes. Without the setting or without `GEMINI_API_KEY` only the related breakdowns are listed. Advice is never written into an entry and is not signed.
- **Model:** Google Gemini `generateContent` with a JSON response schema, `GEMINI_MODEL` default `gemini-pro-latest` (Google's newest Pro; on 2026-10-30 that was `gemini-3.1-pro-preview`; `gemini-2.5-pro` is closed to new keys). The exact model version, response id, records used and the advice are written to the audit trail (`breakdown_advice.generated`). No people's names are sent. 20 requests per user per hour.
- **Readability:** entry details show one labelled field per line in reading order (a breakdown reads failure → root cause → work done → parts → checks). The register, its PDF and CSV have separate columns for failure type, what happened, root cause and work done. The history card has a **Breakdowns only** filter.
- **Related history:** besides same machine / make and model / machine type, up to 12 breakdowns of the same failure category on other machines are given as weaker evidence (`same_failure_type`).
- **Audit trail in words:** each row names what it is about (machine, logbook, entry number, user, settings version; `subject` from `AUDIT_SELECT`), the action in plain words, and the changed fields as "old → new" (`web/src/components/AuditTable.tsx`); the full stored values stay under "Technical details". The period review and batch view show entry data as labelled fields instead of JSON.
- **UI refresh:** new stylesheet (calmer palette, cards, readable tables, soft status chips, sticky top bar), Home overview counts, tiles with a status-coloured edge, a friendlier login page. Field labels and formatting live in `web/src/fields.tsx`.

## Possible next steps (not planned; owner to decide)
- Validation package for a first site: IQ/OQ protocol templates that use `docs/traceability.md` and the CI report.
- Training material: one-page guides per role.
- Later extensions recorded in decisions: multi-site, mobile app, offline mode, QR codes, ERP or BMS interfaces.


## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
