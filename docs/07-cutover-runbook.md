# Cutover runbook: the live Logbook onto the Medhanta platform (B1-6)

Status: approved approach (D-31), to apply at the **joint go-live**: all products go live on the platform together,
after every product has been moved. **The cutover itself runs only with the owner's approval**, on the owner's server,
in a window the owner sets. Platform PL-13 (data moves checked), PL-10 (changes
through the config, with a change reference), A11 10 / CP-07 (change control).

What moves: every record of the live Logbook (logbook.187-126-126-5.sslip.io, branch `standalone`). People keep
their logins and passwords and sign in at core from then on; items and products become core master data; signed
records, audit trail and versions are copied unchanged and checked (`db/move-to-platform.ts`, README "Moving a
standalone Logbook…").

## Before the day

1. **Platform installed** on the owner's server (databsee README "Server setup"), with the first core administrator.
   Address (D-31 1): the platform serves the Logbook only at `logbook.<platform domain>` (apply fixes its sign-on
   return address and core's client to `https://logbook.<domain>/cb`), so it is tested there, while the old site keeps
   its own address until step 9. If the platform's domain would give the old site's name, the old site needs another
   name first: an owner decision at go-live.
   Logins (D-31 2): the move gives a login that does not start with a letter (a digit, `.`, `_` or `-`) a `u` prefix in
   core (`1ravi` → `u1ravi`) and
   lists it in its report as "renamed"; the Logbook's own records keep the old login. A login that cannot take the
   prefix (40 characters already) or would clash with another person's is reported and stops or is refused.
2. **Platform release with the Logbook pin** at the latest Logbook merge (`apps/logbook/manifest.json` in databsee),
   and the Actions secret `PRODUCT_SOURCE_TOKEN` (read-only token for this repo).
3. **Customer config ready, not yet applied**: `licences` gains `logbook`, `links.logbook: { master_data:
   [equipment_v1, instrument_v1, room_v1, product_v1] }`; secrets `logins.logbook_app`, `oidc.clients.logbook`,
   `env.logbook` (`SARVAM_API_KEY`, `GEMINI_API_KEY` as on the old site).
4. **Identity verification text** from the site (21 CFR 11.100(b), CP-03, D-29 5): who verified the moved people's
   identity and how (for example "Site HR", "employee ID card checked at hiring, SOP-HR-003").
5. **Rehearsal on the owner's own server** (D-31 4), no separate test server: steps 2–6 below on last night's backup,
   the real move and its checks, not only `--dry-run`; then restore the snapshot of step 4a as in "Rollback" steps 1–3, so the platform is as
   before the rehearsal. The move must end "moved" with no problems. Tell the people with a prefixed login (D-31 2)
   their new login.
6. Tell users the window, the new address, and that their login and password stay the same.

## On the day

Record every step's time, who did it, and its output (the change record, with the customer's change reference).
Database tools run inside containers (the hosts need no PostgreSQL client): `old` below is
`docker compose -f ops/docker-compose.yml` in the old installation's folder, `plat` is
`docker compose -f /opt/medhanta/current/deploy/compose.yml`, always with the Logbook's pinned image named first
(compose otherwise looks for `medhanta/logbook:none`):
`export LOGBOOK_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/logbook/manifest.json)`. No cron line of the
cutover uses compose.

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
4a. **Snapshot the platform databases before the move** (D-31 3): `logbook` (still empty), `identity` and
   `master_data`, each with `plat exec -T db pg_dump -U <superuser> --format=custom <db> > /backups/pre-move-<db>.dump`,
   plus `sha256sum`. A rollback or the end of the rehearsal restores them, and the move can then run again. From the
   snapshot until the owner's go (or a rollback), nobody moves another product and nobody administers people or master
   data in core: a restore would take that work back too.
5. **Dry run, then the move**, inside the Logbook image at the pinned commit, on the platform's network:
   ```sh
   export LOGBOOK_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/logbook/manifest.json)   # as above
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
9. **Switch.** Redirect the old address to `https://logbook.<platform domain>` in Caddy (a permanent redirect, so
   bookmarks keep working; D-31 1); tell users. Drop the scratch database:
   `plat exec -T db dropdb -U <superuser> logbook_move_source`.

## Rollback

Until the owner signs off, the old installation (containers, database volume, `standalone` image) stays as it was
at the freeze. To go back (D-31 3), in this order:

1. Stop the Logbook and core: `plat stop logbook core`.
2. Restore the step-4a snapshots of `logbook`, `identity` and `master_data`, each recreated from its dump with
   `--create`, which brings back the owner, the database's own rights (the app logins' and other products' link
   CONNECT grants, PUBLIC revoked) and its settings; a plain `createdb` would leave PUBLIC able to connect:
   `plat exec -T db dropdb --force -U <superuser> <db>`, then
   `plat exec -T db pg_restore -U <superuser> --create -d postgres < /backups/pre-move-<db>.dump`. This takes back the
   moved rows, people and items, so the move can run again later.
3. Start core: `plat start core`.
4. Licence the Logbook off in the config and apply. Apply runs after the restore, so its switch records (PL-10)
   are kept.
5. Start the old app (`old start app`) and point the address back. The old database is exactly as frozen, apart from
   the integrity check's own audit row.

Record each step in the change record.

## After sign-off

Keep the old database volume and the freeze backup for the retention period (LB-23); then remove the old
containers. Old site branch `standalone` stays as the record of the software that made the old records.
