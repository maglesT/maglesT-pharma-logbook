-- S6 review fix: a sterilisation cycle number is unique per steriliser, enforced in the database
-- too (A1 8.45). Compared case-insensitively without surrounding spaces, against latest versions
-- of other entries.
create function check_cycle_id() returns trigger language plpgsql as $$
begin
  if new.logbook_type = 'steriliser_cycle' and exists (
    select 1 from entries e
    where e.equipment_id = new.equipment_id and e.logbook_type = 'steriliser_cycle' and e.entry_id <> new.entry_id
      and lower(trim(e.data->>'cycleId')) = lower(trim(new.data->>'cycleId'))
      and not exists (select 1 from entries x where x.supersedes = e.id)
  ) then
    raise exception 'cycle number % is already recorded on this steriliser', new.data->>'cycleId' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger entries_cycle_id_unique before insert on entries for each row execute function check_cycle_id();
