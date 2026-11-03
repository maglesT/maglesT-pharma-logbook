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
5. **Rehearsal** on a test server with the platform installed and the Logbook licensed (the move needs the Logbook's
   permissions in core's catalogue and the `--by` core administrator): steps 2–6 below on last night's backup, the
   real move and its checks, not only `--dry-run`; then discard that server's databases. The move must end "moved" with
   no problems. Logins that start with a digit are refused (core needs a letter first): agree with the owner what
   those people get (a new core login; their history stays under the old one).
6. Tell users the window, the new address, and that their login and password stay the same.

## On the day

Record every step's time, who did it, and its output (the change record, with the customer's change reference).
Database tools run inside containers (the hosts need no PostgreSQL client): `old` below is
`docker compose -f ops/docker-compose.yml` in the old installation's folder, `plat` is
`docker compose -f /opt/medhanta/current/deploy/compose.yml`.

1. **Freeze.** Stop the old app, leave its database running: `old stop app`. From here nobody can add records.
2. **Check, then back up the frozen data.** First the integrity check (it adds its own `integrity.passed` row to the
   audit trail, so it runs before the dump): `old run --rm app node dist/db/integrity.js` (exit 0 required). Then the
   dump and its checksum:
   `old exec -T db pg_dump -U logbook_owner --format=custom logbook > /backups/logbook-freeze.dump && sha256sum /backups/logbook-freeze.dump`.
   From here the old database is not touched again.
3. **Restore the dump into a scratch database on the platform server** (the move reads this copy):
   ```sh
   plat exec -T db createdb -U <superuser> logbook_move_source
   plat exec -T db psql -U <superuser> -c "revoke all on database logbook_move_source from public"
   plat exec -T db pg_restore -U <superuser> --no-owner --no-privileges -d logbook_move_source < /backups/logbook-freeze.dump
   ```
4. **Licence on.** Commit the prepared config; apply runs the Logbook's migrations and starts it. **Nobody opens the
   Logbook address until step 6**: a sign-on attempt, even a refused one, writes a `users` and an audit row, and the
   move needs an empty database. (Nobody holds a Logbook permission in core yet, and the scheduled integrity check skips
   a database without users.) Check it is empty:
   `plat exec -T db psql -U <superuser> -d logbook -Atc "select (select count(*) from users) + (select count(*) from audit_log)"` → `0`.
   If it is not (someone opened the address), note the rows in the change record, licence the Logbook off, drop the
   `logbook` database and apply again: it holds no records yet.
5. **Dry run, then the move**, inside the Logbook image at the pinned commit, on the platform's network:
   ```sh
   export LOGBOOK_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/logbook/manifest.json)
   plat run --name lb-move --no-deps \
     -e SOURCE_DATABASE_URL=postgres://<superuser>:<pw>@db:5432/logbook_move_source \
     -e PLATFORM_DATABASE_URL=postgres://<superuser>:<pw>@db:5432 \
     logbook node dist/db/move-to-platform.js --by <core admin login> \
     --verified-by "<who>" --verified-how "<how>" --report /tmp/move.csv --dry-run
   docker cp lb-move:/tmp/move.csv ./move-dry-run.csv && docker rm lb-move
   ```
   then the same without `--dry-run` (report `./move.csv`). Exit 0 and "moved" are required. A failed check writes
   nothing: the three platform databases commit only after every check passed (one after the other; should the server
   fail between those commits, the run reports it and the old site stays the live one). Keep both reports with the
   change record.
6. **Check on the platform** (as a moved QA person, with their own password):
   - sign in at the Logbook address; open two logbooks, an entry's versions and signatures, a history card;
   - Review → Audit trail shows the old entries; run the integrity check (QA): passed;
   - in core, the people screen shows the moved people with their permissions; master data shows the items.
7. **Records of the move**: the freeze dump and its SHA-256, the old site's integrity output, both move reports, the
   platform's integrity result, the checks of step 6, with times and names.
8. **Owner go / no-go.** On "no-go": rollback below.
9. **Switch.** Point the public Logbook address at the platform (core's address and the Logbook's are set by the
   config's `domain`: `https://<domain>` and `https://logbook.<domain>`); tell users. Drop the scratch database:
   `plat exec -T db dropdb -U <superuser> logbook_move_source`.

## Rollback

Until the owner signs off, the old installation (containers, database volume, `standalone` image) stays as it was
at the freeze. To go back: licence the Logbook off in the config (apply stops it), start the old app (`old start app`),
point the address back. The old database is exactly as frozen, apart from the integrity check's own audit row; the
records made on the platform in between are only the step-6 checks.

A second move after a rollback is refused as it stands: the platform's `logbook` database keeps the moved rows (a
licence off keeps data) and core keeps the moved people (its records are insert-only). Before trying again, decide
with the owner how to continue (fix forward on the platform, or a fresh `logbook` database and a move that recognises
the people it created itself); do not edit core's tables by hand.

## After sign-off

Keep the old database volume and the freeze backup for the retention period (LB-23); then remove the old
containers. Old site branch `standalone` stays as the record of the software that made the old records.
