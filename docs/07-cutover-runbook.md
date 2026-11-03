# Cutover runbook: the live Logbook onto the Medhanta platform (B1-6)

Status: draft for the owner. **The cutover itself runs only with the owner's approval**, on the owner's server, in a
window the owner sets (D-29: timing later, with owner approval). Platform PL-13 (data moves checked), PL-10 (changes
through the config, with a change reference), A11 10 / CP-07 (change control).

What moves: every record of the live Logbook (logbook.187-126-126-5.sslip.io, branch `standalone`). People keep
their logins and passwords and sign in at core from then on; items and products become core master data; signed
records, audit trail and versions are copied unchanged and checked (`db/move-to-platform.ts`, README "Moving a
standalone Logbook…").

## Before the day

1. **Platform installed** on the owner's server (databsee README "Server setup"), with the first core administrator.
   Decide with the owner how the public address reaches the platform's Caddy (ports 80/443) while the old site still
   runs; the old site keeps its own address until step 9.
2. **Platform release with the Logbook pin** at the latest Logbook merge (`apps/logbook/manifest.json` in databsee),
   and the Actions secret `PRODUCT_SOURCE_TOKEN` (read-only token for this repo).
3. **Customer config ready, not yet applied**: `licences` gains `logbook`, `links.logbook: { master_data:
   [equipment_v1, instrument_v1, room_v1, product_v1] }`; secrets `logins.logbook_app`, `oidc.clients.logbook`,
   `env.logbook` (`SARVAM_API_KEY`, `GEMINI_API_KEY` as on the old site).
4. **Identity verification text** from the site (21 CFR 11.100(b), CP-03, D-29 5): who verified the moved people's
   identity and how (for example "Site HR", "employee ID card checked at hiring, SOP-HR-003").
5. **Rehearsal** on last night's backup (steps 4–6 below on a scratch copy, with `--dry-run`): the report must show
   no problems. Logins that start with a digit are refused (core needs a letter first): agree with the owner what
   those people get (a new core login; their history stays under the old one).
6. Tell users the window, the new address, and that their login and password stay the same.

## On the day

Record every step's time, who did it, and its output (the change record, with the customer's change reference).

1. **Freeze.** Stop the old app, leave its database running:
   `docker compose -f ops/docker-compose.yml stop app` (in the old installation's folder). From here nobody can add
   records.
2. **Back up and check the frozen data.**
   `DATABASE_URL=postgres://logbook_owner:<pw>@<db>/logbook BACKUP_DIR=/backups ops/backup.sh` (dump + `.sha256`), then
   the integrity check on the frozen database:
   `docker compose -f ops/docker-compose.yml run --rm app node dist/db/integrity.js` (exit 0 required).
3. **Restore the backup into a scratch database on the platform server** (the move reads it; the old database stays
   untouched for rollback):
   `createdb logbook_move_source && pg_restore --no-owner --no-privileges -d logbook_move_source <dump>`
   (as the platform's PostgreSQL superuser; `revoke all on database logbook_move_source from public`).
4. **Licence on.** Commit the prepared config; apply runs the Logbook's migrations and starts it. Nobody holds a
   Logbook permission in core yet, so nobody can sign in, and the scheduled integrity check leaves the empty database
   alone (it skips a database without users).
5. **Dry run, then the move**, inside the Logbook image on the platform's network:
   ```sh
   docker compose -f /opt/medhanta/current/deploy/compose.yml run --rm --no-deps \
     -e SOURCE_DATABASE_URL=postgres://<superuser>:<pw>@db:5432/logbook_move_source \
     -e PLATFORM_DATABASE_URL=postgres://<superuser>:<pw>@db:5432 \
     logbook node dist/db/move-to-platform.js --by <core admin login> \
     --verified-by "<who>" --verified-how "<how>" --report /tmp/move.csv --dry-run
   ```
   then the same without `--dry-run`. Exit 0 and "moved" are required; on any problem nothing is written (the three
   databases commit together only after all checks passed). Copy the report out of the container (`docker cp`) and
   keep it with the change record.
6. **Check on the platform** (as a moved QA person, with their own password):
   - sign in at the Logbook address; open two logbooks, an entry's versions and signatures, a history card;
   - Review → Audit trail shows the old entries; run the integrity check (QA): passed;
   - in core, the people screen shows the moved people with their permissions; master data shows the items.
7. **Records of the move**: backup file and its SHA-256, the old site's integrity output, the move report, the
   platform's integrity result, the checks of step 6, with times and names.
8. **Owner go / no-go.** On "no-go": rollback below.
9. **Switch.** Point the public Logbook address at the platform; tell users. Drop the scratch database
   (`dropdb logbook_move_source`).

## Rollback

Until the owner signs off, the old installation (containers, database volume, `standalone` image) stays as it was
at the freeze. To go back: licence the Logbook off in the config (apply stops it), start the old app
(`docker compose -f ops/docker-compose.yml start app`), point the address back. No record was added on either side
in between, so nothing is lost.

Core keeps the moved people (its records are insert-only): a second move after a rollback refuses their logins.
Before trying again, decide with the owner how to continue (fix forward on the platform, or let the move recognise
the people it created itself); do not edit core's tables by hand.

## After sign-off

Keep the old database volume and the freeze backup for the retention period (LB-23); then remove the old
containers. Old site branch `standalone` stays as the record of the software that made the old records.
