-- S16 (owner request): cleaning schedule. Numbered 0018 so that it does not collide with main's 0014-0017.
-- * dirty_hold_hours: maximum time from the end of a use until the cleaning (SchM 18.4.4 / 21 CFR 211.67 SOP limits).
--   Applies to equipment, instruments and operation-based rooms.
-- * cleaning_basis (rooms only):
--   'operation': a room where processing takes place (usually with equipment). It is cleaned after use: dirty hold
--                after a use ends, clean hold after the cleaning, as for equipment.
--   'frequency': a room cleaned on a schedule, every cleaning_frequency_hours (e.g. 24 = daily, 168 = weekly).
alter table equipment
  add column dirty_hold_hours integer check (dirty_hold_hours > 0),
  add column cleaning_basis text check (cleaning_basis in ('operation', 'frequency')),
  add column cleaning_frequency_hours integer check (cleaning_frequency_hours > 0);

-- Existing rooms keep working as before: cleaned after use, with their clean hold.
update equipment set cleaning_basis = 'operation' where kind = 'area';

alter table equipment
  add constraint equipment_basis_rooms_only check ((kind = 'area') = (cleaning_basis is not null)),
  add constraint equipment_frequency_needs_basis check (cleaning_frequency_hours is null or cleaning_basis = 'frequency'),
  add constraint equipment_frequency_given check (cleaning_basis is distinct from 'frequency' or cleaning_frequency_hours is not null);

grant update (dirty_hold_hours, cleaning_basis, cleaning_frequency_hours) on equipment to logbook_app;
