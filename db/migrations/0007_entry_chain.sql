-- S3 review fix: the database enforces a proper version chain (LB-17). A new version must follow
-- the latest version of the same entry on the same logbook, numbered one higher.
create function check_entry_version() returns trigger language plpgsql as $$
declare prev entries%rowtype;
begin
  if new.version = 1 then
    if new.change <> 'created' or new.supersedes is not null then
      raise exception 'version 1 must be a created entry without predecessor' using errcode = 'P0001';
    end if;
    return new;
  end if;
  select * into prev from entries where id = new.supersedes;
  if not found or prev.entry_id <> new.entry_id or prev.equipment_id <> new.equipment_id
     or prev.logbook_type <> new.logbook_type or prev.settings_id <> new.settings_id
     or new.version <> prev.version + 1 or new.change = 'created' then
    raise exception 'entry version does not follow its predecessor' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger entries_version_chain before insert on entries for each row execute function check_entry_version();
