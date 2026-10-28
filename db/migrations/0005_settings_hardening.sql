-- S2 review fixes.
-- LB-24: an approved settings version is frozen. A trigger is used because the app role needs
-- UPDATE on drafts; this is the one place the database must refuse it.
create function refuse_update_of_approved_settings() returns trigger language plpgsql as $$
begin
  if exists (select 1 from signatures where object_type = 'settings' and object_id = old.id and meaning = 'approved') then
    raise exception 'settings version % is approved and cannot be changed', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger logbook_settings_frozen_when_approved
  before update on logbook_settings for each row execute function refuse_update_of_approved_settings();

-- Codes are unique regardless of case (LB-08).
create unique index equipment_code_ci on equipment (lower(code));
create unique index products_code_ci on products (lower(code));
