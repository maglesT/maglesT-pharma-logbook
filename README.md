# Pharma Logbook

An electronic logbook for equipment, instruments and areas in pharmaceutical plants (tablets,
capsules, injectables), built to the minimum rules of US FDA (21 CFR 211, Part 11), EU GMP
(Vol 4, Annex 11, Annex 1) and India's Revised Schedule M.

- What it does: `docs/02-functional-requirements.md`
- Compliance rules (LB-xx / CP-xx) and their clauses: `docs/03-compliance-register.md`
- Architecture and slice plan: `docs/05-architecture-and-slices.md`
- Owner decisions: `docs/decisions.md` · Current state: `docs/handover.md`

## Develop
Needs Node 22 and PostgreSQL 16.

```sh
npm install
export DATABASE_URL=postgres://logbook_owner:dev@localhost:5432/logbook_dev DB_APP_ROLE=logbook_app
# Medhanta core (D-29): people, passwords and Logbook roles, and master data (items, products), are managed there
export MASTER_DATA_DATABASE_URL=postgres://logbook_app:...@<core db>:5432/master_data   # read through its report views
export OIDC_ISSUER=https://<core domain>/oidc OIDC_CLIENT_SECRET=... OIDC_REDIRECT_URI=http://localhost:3000/cb
npm run migrate
npm run dev        # API on :3000
npm run dev:web    # UI on :5173 (proxies /api)
npm run ci         # typecheck, tests, build — run before pushing
npm run test:e2e   # browser tests of the main flows (Playwright; once: npx playwright install chromium)
```

Demo data (D-28): the shared investigation scenario of the Deviations system (FBD-01, PRESS-01, HT-01, rooms GRAN-1 and COMP-1, product RAB-GR-20, batches RAB26002/RAB26004),
created through the API on a separate, migrated database whose name contains `demo` or `test`; it refuses a database with approved
settings, with users other than one initial admin, or (unless `--force`) with entries:
`DEMO_DATABASE_URL=postgres://logbook_owner:dev@localhost:5432/logbook_demo npm run demo:seed` (prints the demo users and password;
`DEMO_PASSWORD` overrides it). Never run it against a production database.

Tests use `TEST_DATABASE_URL` (default `postgres://logbook_owner:dev@localhost:5432/logbook_test`);
each test file gets its own schema.

## Run (single site)
```sh
DB_PASSWORD=... docker compose -f ops/docker-compose.yml up -d --build
```
First time only, create the admin account (prints a temporary password):
`docker compose -f ops/docker-compose.yml exec app node dist/db/create-admin.js admin "Site Admin"`

**Database roles.** Migrations run as the database owner (`MIGRATION_DATABASE_URL`). The app runs as the
restricted role `logbook_app`, which cannot update or delete entries, signatures or the audit trail (LB-18).
Either give it its own login (`ALTER ROLE logbook_app LOGIN PASSWORD '...'`) and point `DATABASE_URL` at it,
or, on a single box, let the owner login switch to it with `DB_APP_ROLE=logbook_app` (compose default).

**Report views on the Medhanta platform (D-29).** Names and locations are master data now; `report.equipment_v1` keeps
showing the name and location each item had when it was moved or first seen by the Logbook. Read current names from
master_data's own views.

**Read-only role for the Deviations system (D-28).** Migration 0013 creates the role `logbook_report` without a login. (On the Medhanta platform, D-29, it is not created: other products read the views through platform links.)
It can read the four views in the schema `report` (`equipment_v1`, `entry_v1`, `calibration_v1`, `logbook_sop_v1`) and
nothing else. Only if the site's Deviations & CAPA system is to read the logbook, give it a login, as the database owner:
```sql
ALTER ROLE logbook_report LOGIN PASSWORD '...' CONNECTION LIMIT 4;   -- a long random password, kept by the Deviations system
-- to withdraw access later: ALTER ROLE logbook_report NOLOGIN;
```
What the compose setup does: the `db` container (image `postgres:16`) publishes no port, so only containers on the
compose network can reach it; SSL is off; and the image's `pg_hba.conf` ends with `host all all all scram-sha-256`, which
admits any role with a password from any address that can reach it. To let the Deviations server in, and only it:
1. Make the database reachable: publish the port on an internal interface only (e.g. `ports: ["10.0.0.5:5432:5432"]`
   under `db`), or run the Deviations system on the same Docker network.
2. If the connection crosses a network you do not fully trust, switch SSL on: put a server certificate and key in the data
   volume (owned by the postgres user, key mode 0600) and add `command: ["postgres", "-c", "ssl=on", "-c",
   "ssl_cert_file=/var/lib/postgresql/data/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/data/server.key"]` under `db`.
3. In `pg_hba.conf` (in the data volume, `/var/lib/postgresql/data/pg_hba.conf`), **above** the final catch-all line, add
   ```
   hostssl logbook logbook_report <deviations-server-ip>/32 scram-sha-256   # with SSL on (step 2)
   # host  logbook logbook_report <deviations-server-ip>/32 scram-sha-256   # instead, without SSL, trusted private network only
   host    all     logbook_report all                         reject
   ```
   The first matching line wins: without the `reject` line the catch-all would still let the role in from anywhere.
   A `hostssl` line never matches while SSL is off. With Docker port publishing the address PostgreSQL sees may be the
   Docker gateway rather than the Deviations server; check `select client_addr from pg_stat_activity` after a first connection.
4. Reload: `docker compose -f ops/docker-compose.yml exec db psql -U logbook_owner -d logbook -c "select pg_reload_conf()"`.

The migration also takes the right to create temporary objects in the database from PUBLIC (and gives it to `logbook_app`),
so the report role cannot define functions of its own. That right belongs to the database, not to a backup: after
restoring a backup into a new database, run, as the owner,
`REVOKE TEMPORARY ON DATABASE <name> FROM PUBLIC; GRANT TEMPORARY ON DATABASE <name> TO logbook_app;`.
List the role in the periodic access review (CP-03). Nothing changes for logbook users.

## Operating the system

**First setup**
1. Start the stack (see *Run*) and create the first admin. It gets a temporary password, valid for 24 hours, which must be changed at first login.
2. As Admin:
   - set the site name and code (Master data → Site);
   - add equipment, instruments and rooms (flags: sterile, classified room, needs calibration, clean-hold hours) and products;
   - create user accounts with their roles. Hand each temporary password directly to its user (D-15).
3. As Admin, draft the settings for each logbook type the site uses. As QA, approve each version with an e-signature (Logbook settings). A type cannot be used until its settings are approved and in force.
4. Clean and verify each item once before its first use: new equipment counts as dirty (D-18). Sterilisers need a verified passed leak or air-removal test before steam cycles (D-22).

**Voice notes (D-26, optional).** Voice notes send the speaker's audio to Sarvam AI for transcription and translation.
Before switching them on, the site must assess the supplier and have a service agreement (Annex 11 section 3, CP-06), and
must have the consent of the staff who record (CP-10). Then:
1. Put the key in `ops/.env` as `SARVAM_API_KEY=...` (never in the repository; the browser never receives it) and restart the app.
   Optional: `SARVAM_MODEL` (default `saaras:v3`), `SARVAM_TIMEOUT_MS` (default 30000).
2. As Admin, draft the *Voice notes (site setting)* with the allowed languages; as QA, approve it.
The microphone works only over HTTPS (or on localhost). Clips are up to 30 seconds; each user may send 20 an hour.
The audio and both texts are stored in the database, so they are in every backup. Without a key, or when the service is
down, entries are typed as before.

**Backups (LB-23).** Run `ops/backup.sh` daily, e.g. from cron on the host:
`15 1 * * * DATABASE_URL=postgres://logbook_owner:...@localhost/logbook BACKUP_DIR=/srv/backups /opt/logbook/ops/backup.sh`.
Backups are kept for 365 days (`KEEP_DAYS`). Copy them to storage outside the server.

**Restore check (CP-03).** Periodically, e.g. monthly, run
`ADMIN_URL=postgres://owner:...@localhost/postgres ops/restore-check.sh /srv/backups/<file>.dump` and file the output.
It restores into a scratch database, checks the schema and runs the integrity check. CI runs the same check on every change.

**Integrity check (LB-23).** The server runs it once a day and writes the result to the audit trail (`integrity.passed` or
`integrity.failed`). QA or Admin can also run it on demand (`POST /api/integrity/run`), or run `npm run integrity` from the command line.
Investigate any failure as a data-integrity incident (CP-07).

**Traceability (CP-01).** `npm run traceability` regenerates `docs/traceability.md`, the rule-to-test list. CI fails if a
rule in force has no test. Together with the CI test report it supports the site's validation.

## Conventions
- One app: `server/` (Fastify), `web/` (React), `db/migrations/` (plain SQL), `test/`, `e2e/` (browser tests), `ops/`, `docs/`.
- A test that proves a register rule starts its name with the rule ID, e.g. `LB-17: correction keeps the original visible`.
- Paraphrase regulations; never paste more than a short phrase.
- Work on a branch, CI green, one review pass, then squash-merge.
