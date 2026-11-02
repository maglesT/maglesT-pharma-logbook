# Phase B1: Pharma Logbook onto the Medhanta platform. Plan, draft 1 (2 Nov 2026)

Status: **approved by the owner on 2 Nov 2026, with every recommendation** (relayed by the lead; D-29). The platform is not yet installed on the owner's server, so B1-1 to B1-5 are built and tested now and the cutover timing is decided later.

Scope (platform D-11): rewire only. The Logbook gets its own database on the shared server. It reads master data through
`master_data.report.*_v1`, signs people on through core OIDC, and re-authenticates e-signatures through core. Its live
data moves with PL-13 checks and a mapping from local items to shared master ids. No new features, no rewrites and no
UI redesign. The live Logbook keeps running unchanged until the owner approves the cutover.

## What maps to what
| Logbook today | On the platform | How |
|---|---|---|
| `users` + `user_roles`, local login, passwords, lockout, users screen | identity `employee` + `grant_event` (product `logbook`) | Users are copied to core with the **same scrypt hash**, because core uses the identical format, so nobody needs a new password. Roles become `logbook` grants. The local login, password, lockout and users screens are removed and core handles them. `users` stays as an **id map** (`employee_id uuid`), because every signed and insert-only table references `users.id`. Rewriting those keys would touch hashed, insert-only records. |
| `equipment` kinds equipment / instrument / area | master `item` kinds equipment / instrument / **room** | Each item becomes a master item with the same code. `equipment` stays as an id map (`item_id uuid`, immutable code) plus the Logbook's own per-item settings: sterile, classified, clean-hold hours, needs calibration. Name, location, active, make, model and serial are read live through the views. |
| free-text `location` | master `located_in` link to a room | The text is matched to an area code or name. Anything that doesn't match goes on the mapping report and the site fixes it in core before cutover. |
| `products` | master `product` | Same pattern: id map with `item_id`. |
| `site`, settings, entries, signatures, reviews, details, voice notes, audit | stay in the Logbook database | Moved unchanged with pg_dump/restore. |
| e-signature (user ID + password in SignDialog) | core re-authentication (`prompt=login`, `max_age=0`) | A popup window, so the half-filled form survives. `authenticateSigner()` accepts a one-use proof whose `sub` must be the signed-in person. `sign()` is unchanged. |

## Slices (each: branch, tests named by rule ID, CI green, one review, squash-merge)
- **B1-1 Platform wiring.** In databsee: `apps/logbook/manifest.json` (roles operator, supervisor, engineering, qa, admin; publishes the 4 views; reads equipment_v1, instrument_v1, room_v1, product_v1), a compose service, and config and secrets template entries. In the Logbook: migrations 0001–0013 run on a platform-initialised `logbook` database as `logbook_owner`. The role creation in 0002/0013 gets guards, and the existing `report` schema is reused.
- **B1-2 Sign-on through core (PL-01).** OIDC code + PKCE. Roles come from the token only, and a person without a logbook role is refused. The local login, password, lockout and users routes and screens are removed. The 15-minute idle timeout stays.
- **B1-3 Master data through views (PL-08, PL-07).** A second pool to master_data. Name, room and active come from the views, with "Connection to master data is off" when the link is cut. **Write-time check:** an unknown or inactive equipment or product is refused. The master version, code and name are kept on the entry at signing (PL-07). The Logbook's own master-data screens shrink to the per-item Logbook settings.
- **B1-4 E-signature re-authentication through core (PL-05).** Popup flow with a one-use proof that is bound to the content hash. The rule that Admin never signs stays.
- **B1-5 Data move (PL-13).** `db/move-to-platform.ts` plus `.check.sql`:
  - It runs dump → restore → move: it creates employees, grants, items and links in core's databases as the installer, then fills the id maps.
  - Checks: row counts and checksums of every Logbook table before and after, every user, item and product mapped, codes and names equal to master, and the existing integrity check (signature hashes, chains) passes.
  - It writes a mapping report (CSV): local id → master id, unmatched locations, logins core refuses.
  - Dry run on a copy of the live data first.
- **B1-6 Cutover runbook. Owner's server, owner approval.**
  1. Freeze the live Logbook.
  2. Back it up.
  3. Move the data and run the checks.
  4. Switch `logbook.<domain>` in Caddy.
  5. Rollback: restart the old container, which is kept read-only and untouched until the owner signs off.

The live Logbook stays on tag `v0.5.0-standalone`. If it needs a fix before cutover, that goes on a `standalone` branch.

## Risks
1. **Logins core refuses.** Core requires `^[a-z]…` and the Logbook allowed a digit or dot first. The mapping report lists them before cutover.
2. **Codes already in master_data.** If master_data already has a code, for example demo items, the move refuses it unless it is the same item.
3. **Free-text locations.** Locations that don't match a room need site cleanup in core.
4. **Deviations reads the Logbook's `report.equipment_v1`.** Name and location can no longer be joined in SQL, because they are in another database. See decision 4.
5. **Popup blockers.** The popup opens on the button click, so it is allowed. Browser tests cover it.
6. **Identity verification for moved users.** 11.100(b) needs a "verified by / how" for each moved user. The site must supply this text.

## Decisions needed (owner)
1. **Code home.** *Recommended:* the Logbook stays in its own repo with its tests and CI, and builds an image. The platform gets the manifest, a compose service with a pinned image, and runs the Logbook's migrations. The alternative is moving the code into databsee `apps/logbook`.
2. **Id maps.** *Recommended:* keep `users`, `equipment` and `products` as id maps with uuid columns, with no master values maintained locally. The alternative is rewriting every foreign key on signed, insert-only tables.
3. **Logbook-only item fields.** *Recommended:* sterile, classified, clean-hold, needs-calibration and the equipment-details record (qualification, SOP references, etc.) stay in the Logbook as its own settings. Make, model and serial move to master.
4. **Logbook `report.equipment_v1` for Deviations.** *Recommended:* keep v1, with name and location as at cutover and documented as such. Deviations reads names from master_data when it moves.
5. **Identity verification text** for moved users, which the site must supply.
6. **Admins.** *Recommended:* Logbook admins also get core `identity_admin` + `master_data_editor`, because they did both jobs before.
7. **Platform on the owner's server.** Is the platform already installed there (customer config, domain)? When is the cutover window?
