# Handover

Updated: 2026-11-03, Phase B1 (move onto the Medhanta platform, D-29): see the section "Phase B1" below first.

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
- **Signing (`server/signatures.ts`):** `authenticateSigner()` runs in its own transaction, so failures count towards lockout. It returns a proof object that `sign()` requires. `sign()` stores the printed name, meaning and a SHA-256 of the canonical content, and Admin can never sign (until B1-2b: since D-30 a signature needs only its permission code).
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
- **Voice-note translation (D-27):** with `GEMINI_API_KEY` set, Sarvam only transcribes (spoken language) and Gemini translates the transcript into English, given the machine, logbook and field and told to translate faithfully (numbers, units, IDs kept). If Gemini fails or takes longer than `GEMINI_TRANSLATE_TIMEOUT_MS` (25 s), Sarvam's translate mode is used. The voice note's model reads e.g. `saaras:v3 + gemini-3.1-pro-preview (translation)`. On the seven live notes of 2026-10-30 Gemini was more accurate on technical terms (e.g. "discharge temperature", "vial filling machine", "informed engineering"); it takes 5–20 s.

## S13: Medhanta brand (0.4.1)
- Pharma Logbook is a Medhanta product. White top bar with the Medhanta mark and an orange gradient underline, orange primary buttons and active tab, Medhanta grey text; login page shows the full Medhanta logo; favicon is the mark. Logos are in `web/public/` (`medhanta-logo.png`, `medhanta-mark.png`, `favicon.png`, cut from the logo the owner supplied, white made transparent).
- Status colours stay semantic and distinct from the brand orange: green fit, blue in use, amber needs cleaning, red blocked.
- **Audit trail screen (0.4.2):** shows only plain-language lines (owner's decision: no raw values or code on screen). AI suggestions are shown in full (causes, checks, parts, preventive, with the entries they came from); signature rows say which signature was recorded. The complete stored values stay in the database and in the CSV copies; the PDF copies print them as labelled lines (`recordLines` in `server/changes.ts`), identifiers exactly as stored.

## S15: read-only report views for the Deviations system (0.5.0)
- **Why:** the site's separate Deviations & CAPA system reads logbook data, read-only, to help investigations (owner-approved plan; contract in the Deviations project, `docs/07-data-contracts.md`, section "Logbook"). Nothing changes for logbook users (D-28).
- **Database (migration 0013):** schema `report`, role `logbook_report` (NOLOGIN; the site sets LOGIN and a password, README "Database roles", with the `pg_hba.conf` line). Views `equipment_v1`, `entry_v1` (latest version of each entry, signature meanings on that version), `calibration_v1` (result, `next_due`, certificate) and `logbook_sop_v1` (SOP references of the settings in force), each with `read_at` and `data_as_of`. The views run with the owner's rights; the role has no right on any table. Tests and browser tests get their views in `<schema>_report`.
- **Demo data:** `npm run demo:seed` (`db/demo-seed.ts`, `DEMO_DATABASE_URL`) creates the shared scenario through the API: users `demo.admin`, `qa.priya`, `sup.rakesh`, `op.suresh`, `eng.imran`; FBD-01 (in GRAN-1), tablet press PRESS-01 and hardness tester HT-01 (in COMP-1), rooms GRAN-1 and COMP-1, product RAB-GR-20 "Rabeprazole sodium 20 mg gastro-resistant tablets (DEMO-ONLY)"; batches RAB26002 (normal) and RAB26004 (the deviation batch; on PRESS-01 from 19:00 IST on 31 Oct) on FBD-01 and PRESS-01 with cleanings between; the event is the failed breaking-force check on PRESS-01 / HT-01 for RAB26004 at about 22:00 IST on 31 Oct 2026; PRESS-01 preventive maintenance 40 days before the event and a released breakdown "Upper punch sticking" on 29 Oct; SOP-ENG-010 on PRESS-01 and in the maintenance settings; HT-01 calibrated with next due 30 Oct (overdue at the event). All entries are late entries with the reason "Demo data". Refuses a database not named demo/test, one with approved settings or users other than one initial admin, and (unless `--force`) one with entries.
- **Tests:** `test/report.test.ts` (views from entries made through the API, corrections, signatures, SOP references; the role reads the views and is refused every read and write on every table) and `test/demo-seed.test.ts` (the scenario as the views show it).
- **For the Deviations side:** type keys are the logbook type keys (`equipment_use`, `equipment_cleaning`, `maintenance` with `data.kind` preventive/breakdown/repair, `calibration`, …); equipment codes are exactly as entered (case kept); times are `timestamptz` (stored UTC; plant time is Asia/Kolkata); `next_due` is a plant-local date; `id` and `entry_id` are bigint. `calibration_v1` has no verification flag: a calibration counts for status only when verified, which `entry_v1` shows (`type = 'calibration'`, same equipment code and `coalesce(activity_end, activity_start)` = `performed_at`, `signed` contains `verified`).
- **D-27:** was cited in code and in S12 but had no row in `decisions.md`; the row was added in S15 from the S12 description.
- **Review fixes:** views are security barriers; TEMPORARY taken from PUBLIC on the database; `nextDue` must be a real date (app check, and the view reads a bad stored value as null); the seed refuses non-demo databases, approved settings and existing users; README `pg_hba.conf` steps corrected (SSL off in the image, `reject` line after the allow line); role tests tagged LB-21.

## Phase B1: move onto the Medhanta platform (D-29), state on 2 Nov 2026
Plan: `docs/06-platform-move-plan.md` (approved, D-29). Platform repo `maglesT/databsee` (its `docs/handover.md`,
`docs/05-add-a-product.md`). Lead: session `session_01PybpFurhHU4ktqworXhVvF`; report there with the remote
`send_message` tool after each merge and for owner decisions. Owner rules: rewire only, minimum compliance (cite the
clause), no over-engineering, small slices (branch, tests named by rule ID, CI green, one review pass by a subagent,
squash-merge), commit trailers without a model name. At most 2–3 agents. Hand over at about 400k context.

**The live Logbook** (logbook.187-126-126-5.sslip.io) runs the code of branch `standalone` (commit 7787354; the git
proxy refused a tag). main is not deployable standalone any more. Fixes for the live site before cutover go on
`standalone`. The cutover happens on the owner's server and needs owner approval.

| Slice | PR | What |
|---|---|---|
| plan | #19 | `docs/06-platform-move-plan.md`, D-29 |
| B1-1 | #20 | migrations safe on a platform database: `0000_platform_defaults` takes back the platform init's default grants (else the app could UPDATE audit_log); 0013 leaves out `logbook_report` on the platform; `LOGBOOK_DATABASE_URL`; `test/platform.test.ts` with a copy of the platform's `database.sql` |
| B1-2 | #21 | sign-on through core (OIDC + PKCE, `server/signon.ts`, `/login`, `/cb`); roles from the token only; sessions renew roles every 5 min (one request claims the renewal, core called outside transactions); sign-in state in a short Lax cookie; `users` = id map (`employee_id`, 0014); local login/users/passwords removed |
| B1-4 | #22 | e-signatures re-authenticate at core: `/sign` window (prompt=login, max_age=0), `/cb` checks ID-token `auth_time` ≥ start, HMAC proof (sub, roles, meanings, time, nonce; key derived from the OIDC client secret), spent once in the signature's transaction (`signing_proofs`, 0016); local lockout/alerts removed (core's PL-04) |
| B1-3 | #23 | master data live through master_data's views (`server/master.ts`, `MASTER_DATA_DATABASE_URL`), "connection off" 503, write-time check of item and product, `entry_master_values` (PL-07), `equipment`/`products` = id maps (`item_id`, 0015), Master data screen read-only plus the Logbook's own per-item settings |
| B1-2b | #26 | permissions instead of roles (A10, D-30): `PERMISSIONS` (18 codes) and `ROLE_PERMISSIONS` (old role → codes, for B1-5) in `server/auth.ts`; scope `openid profile permissions`, claim `permissions` (unknown codes ignored); `requirePermission(code)`; sessions keep codes (0017 renames the column and ends open sessions); the signing proof carries the fresh token's codes and `authenticateSigner` needs the signature's own code(s) (`needs`), no admin block; UI flags via `can(me, code)`. databsee `b1-logbook` rebased on A10, manifest lists the 18 codes |
| B1-3b | #27 | make, model and serial are master data (D-29 3): `detailsSchema` no longer takes them (strict: a new version with them is refused; older versions keep theirs); history card, PDF and the details form show/read master `make/model/serial`; advice compares and prompts with master make and model |
| B1-5 | #28 | data move (PL-13), `db/move-to-platform.ts`: dry run first (`--dry-run`, writes nothing). The platform's migrate builds the `logbook` schema (it must be empty); rows are copied data only (common columns; `sessions` and `schema_migrations` not moved), with triggers off (`session_replication_role = replica`), every table's count and checksum compared in the same transaction, and sequences continued. Core: employees with the same login and scrypt hash, the site's identity verification (`--verified-by/--verified-how`, D-29 5), permissions from old roles (D-30) plus `core.people.manage` and `core.masterdata.edit` for admins (D-29 6). Master data: areas → rooms, items with make/model/serial from the last details version, `located_in` where the location names a room, products. Then the id maps and checks: checksums again, every item/product/user mapped (logins not starting with a letter get a `u` prefix in core, D-31 2, listed as "renamed"; one with no room for it is refused and listed), codes and names equal, permissions as planned, integrity check. All three platform databases are written in one unit and commit only after every check passed; any problem rolls them all back. A login core already has stops the move (never linked silently). An expired temporary password stays unusable (`expired-temporary-password`: reset in core). Someone deactivated or locked in the Logbook is created inactive in core with no permissions. The logbook database commits first, then master data and identity (insert-only), so a failed logbook commit leaves core untouched; the moved `users` rows keep no password hash (`-`). The scheduled integrity check skips a database without users, so a freshly licensed Logbook stays empty until the move. Report CSV (`--report`). Demo: seed a demo database, then move it with `--demo-password` (roles from the demo's list, must change at first use). Tests `test/move.test.ts` with core's migrations copied to `test/platform/identity`, `test/platform/master_data` (databsee 539eae6) |
| B1-6 | #29 | cutover runbook `docs/07-cutover-runbook.md`: before the day (platform, pin, config, identity text, rehearsal), on the day (freeze, backup + integrity, restore into a scratch DB on the platform server, licence on, dry run + move, checks, records, owner go/no-go, switch), rollback (old site untouched until sign-off) |

Platform side: branch `b1-logbook` in `maglesT/databsee` (not merged; waiting for the lead's OK): `apps/logbook/manifest.json`
pinned to a Logbook commit (update the pin to the latest merged Logbook commit before merging), `bundle.sh` builds
`medhanta/logbook:<commit>` from this repo and copies `db/migrations` to `db/logbook`, compose service, `productEnv()`,
secrets `env.logbook` (Sarvam/Gemini keys). Owner action at go-live: Actions secret `PRODUCT_SOURCE_TOKEN` (read-only
token for this repo).

### Owner change: permissions instead of roles (platform A10, databsee PR #14, b7e0efd)
Each product declares a permission list in its manifest (`permissions: [{ code: "logbook.…", label }]`, codes
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`, starting with `logbook.`); people get a ticked subset. OIDC scope `openid profile
permissions`; the ID token and userinfo carry `permissions` (this product's codes only); core refuses sign-on without any.
At e-signature check the fresh token's `sub` and that the required code is in its `permissions` (apps/hello/app.ts).
Platform D-17: `<p>_app` gets only SELECT/INSERT on new tables by default; grant UPDATE/DELETE on state tables explicitly
in a Logbook migration, never on audit or signature tables (tests named `PL-06 …`). The lead's message saying "B1-2 waits for
A10" arrived after B1-2 and B1-4 were merged on roles, so they must be switched (B1-2b below).

### Next
0. ~~**B1-2b permissions**~~ done (see the table below; PR in "Slices"). Was: one code per action the app checks today (who may record each logbook type
   (`mayRecord`), correct others' entries (`mayCorrect`, D-17), verify, release, sign reviews, draft and approve settings, read the
   audit trail, see reviews/exports, edit item settings, site record, ask for advice); `asRoles()` → permission codes from
   the claim; `requireRole(...)` → `requirePermission(code)`; the signing proof carries the fresh token's permissions and
   `authenticateSigner` checks the code for the meaning; "Admin never signs" becomes "no signing code"; UI flags from
   `/api/me` permissions. Keep a role → permissions table (docs + code for B1-5). Then rebase databsee `b1-logbook` on main
   (A10), put the permission list in `apps/logbook/manifest.json` instead of `roles`, update the pin, PR, CI, review,
   squash-merge (lead's OK given). Suggest sending the proposed permission list to the lead for the owner first.
1. ~~**B1-3b**~~ done (see Slices). Was: make, model and serial move from the details record to master data (D-29 3): drop them from
   `detailsSchema` for new versions (old versions keep them), history card / PDF / advice read master `make/model/serial`
   (`LogbookItem`), adjust `test/breakdowns.test.ts`, `test/advice.test.ts`, `e2e/breakdowns.spec.ts`.
2. ~~**B1-5 data move**~~ done (see Slices). Changed from the plan above: the schema is not restored from a dump. The
   platform's migrate builds it (0013 was edited after the live site applied it, and a restored schema would bring the
   standalone grants), and the script copies the data only, checked per table in the same transaction.
3. ~~**B1-6 cutover runbook**~~ written: `docs/07-cutover-runbook.md` (draft for the owner). **D-31: no Logbook go-live now**; all products go live on the platform together after every product is moved. The four open points are approved (D-31) and written into the runbook: test at `logbook.<platform domain>` and redirect the old address at the switch (a temporary name cannot work: the sign-on return address is fixed), `u` prefix for logins not starting with a letter (done in the move script, #32), snapshot of the platform databases before the move as rollback, rehearsal on the owner's server. Phase B1 work in this repo is otherwise complete. The cutover itself waits
   for the owner's approval and window. Open points: decided in D-31 (see above).

### Things to know
- Tests: `TEST_DATABASE_URL=postgres://logbook_owner:dev@127.0.0.1:5432/logbook_test npx vitest run`; local PostgreSQL 16
  in this container: `su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/lb -U postgres --auth=trust"`,
  start with `pg_ctl -o '-p 5432 -k /tmp'`, then `create role logbook_owner superuser login password 'dev'` and
  `create database logbook_test owner logbook_owner`. Browser tests: `npm run build && npx playwright test`.
- Stand-ins: `test/helpers.ts` `fakeSignOn` (signs in whoever `login_hint` names), `proofFor`/`sig`, `fakeMaster`,
  `addItem`, `changeItem`, `addProduct`. The e2e server's master stand-in reads table `e2e_master_items`.
- Any new table needs `revoke all on <t> from logbook_app` before its grants (platform default grants; `0000`).
- Signature content hashes must never change: PL-07 values live in their own table, not in `entries`.

### Logbook permission list (B1-2b; approved by the owner, D-30)
One code per action the app checks today (`requireRole`, `RECORDERS`/`mayRecord`, `mayCorrect`, `VERIFIERS` and the
"Admin never signs" rule in `server/signatures.ts`). Reading items, entries, statuses, the breakdown register and the
history card needs any Logbook permission (sign-on itself needs one).

| Code | Label | Today's check |
|---|---|---|
| `logbook.entry.record_use` | Record equipment use | RECORDERS equipment_use |
| `logbook.entry.record_cleaning` | Record equipment and area cleaning | equipment_cleaning, area_cleaning |
| `logbook.entry.record_general` | Record general log entries | general_log |
| `logbook.entry.record_maintenance` | Record maintenance and breakdowns, complete repairs | maintenance |
| `logbook.entry.record_calibration` | Record calibrations | calibration |
| `logbook.entry.record_sterile` | Record steriliser cycles, glove tests and pressure readings | steriliser_cycle, glove_integrity, pressure_reading |
| `logbook.entry.record_steriliser_test` | Record steriliser tests (leak, air removal) | steriliser_test |
| `logbook.entry.correct_others` | Correct entries made by others (D-17) | mayCorrect: supervisor |
| `logbook.entry.verify` | Verify entries (second person) | VERIFIERS |
| `logbook.breakdown.release` | Release equipment after a breakdown | /release: qa |
| `logbook.exception.decide` | Decide the route of a problem (Deviations or a Logbook exception) and approve Logbook exceptions (D-43) | /problems/:id/decide: qa |
| `logbook.review.read` | See period reviews, the batch view and exports | review/exports: qa, supervisor |
| `logbook.review.sign` | Sign period reviews | /reviews: qa |
| `logbook.audit.read` | Read the audit trail and run the integrity check | /audit, /integrity: qa, admin |
| `logbook.settings.draft` | Draft logbook settings | /settings POST/PATCH: admin |
| `logbook.settings.approve` | Approve logbook settings | /approve: qa |
| `logbook.site.manage` | Edit the site record, item settings and equipment details | /site, /equipment PATCH, /details: admin |
| `logbook.voice_note.record` | Record voice notes | /voice-notes: operator, supervisor, engineering |
| `logbook.advice.ask` | Ask for breakdown suggestions | /advice: operator, supervisor, engineering, qa |

Old role → permissions (for the B1-5 data move; each moved user gets exactly these):

| Role | Permissions |
|---|---|
| operator | record_use, record_cleaning, record_general, record_maintenance, record_sterile, record_steriliser_test, voice_note.record, advice.ask |
| supervisor | the operator's, plus correct_others, verify, review.read |
| engineering | record_general, record_maintenance, record_calibration, record_steriliser_test, voice_note.record, advice.ask |
| qa | verify, breakdown.release, exception.decide, review.read, review.sign, audit.read, settings.approve, advice.ask |
| admin | audit.read, settings.draft, site.manage |

Admins (D-30, option a): today the Admin role can never sign. With ticked permissions a person could hold `site.manage`
and a signing code; the Logbook does not block this. Segregation is the site's access procedure (CP-02, CP-03) and the
access review (PL-12). B1-2b drops the "Admin never signs" check: a signature needs only its own permission code.

### Known limits from the B1-3 review (accepted, for the next slices)
- Items and products held locally before the move (`item_id` null) are not shown until the B1-5 move fills `item_id`.
  The move must run before anyone uses the Logbook on the platform. A master code that clashes with an unmapped local
  row, or two master codes differing only in case, are skipped at first sight: the move's mapping report must list them.
- The local `kind` is read for type checks and status; master data never changes an item's kind (databsee `item`).
- Each entry write reads master data two to three times (`logbookItem` in create and in `insertVersion`,
  `logbookProducts`). That is fine for about 300 items; pass the item into `insertVersion` if it ever matters.

## Possible next steps (not planned; owner to decide)
- Validation package for a first site: IQ/OQ protocol templates that use `docs/traceability.md` and the CI report.
- Training material: one-page guides per role.
- Later extensions recorded in decisions: multi-site, mobile app, offline mode, QR codes, ERP or BMS interfaces.


## Notes
- Official PDFs and extracted texts are in `sources/` (git-ignored). The gazette text of Schedule M Part I is in `maglesT/ebmr`, branch `docs/schedule-m-gazette`.
- The session's git proxy refuses branch deletion (HTTP 403). Delete merged branches on GitHub.
