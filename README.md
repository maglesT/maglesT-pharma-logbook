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
npm run migrate
npm run create-admin -- admin "Site Admin"   # prints a temporary password
npm run dev        # API on :3000
npm run dev:web    # UI on :5173 (proxies /api)
npm run ci         # typecheck, tests, build — run before pushing
```

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

## Conventions
- One app: `server/` (Fastify), `web/` (React), `db/migrations/` (plain SQL), `test/`, `ops/`, `docs/`.
- A test that proves a register rule starts its name with the rule ID, e.g. `LB-17: correction keeps the original visible`.
- Paraphrase regulations; never paste more than a short phrase.
- Work on a branch, CI green, one review pass, then squash-merge.
