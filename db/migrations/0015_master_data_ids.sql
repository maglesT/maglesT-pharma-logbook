-- B1-3 (D-29): master data is Medhanta core's, read live through master_data's views (platform PL-08, D-02).
-- equipment and products become id maps: item_id is the master item. Their code never changes (as in master data).
-- Name, kind, location and active of an item are read from master data; the old columns keep the values from before
-- the move and are no longer written. equipment keeps the Logbook's own per-item settings (D-29 3).
alter table equipment add column item_id uuid unique;
alter table products add column item_id uuid unique;
revoke update (name, location, active) on equipment from logbook_app;
revoke update (name, active) on products from logbook_app;

-- PL-07: each entry version keeps the master values it was made with (item and product, name and master version),
-- so a later rename in master data never changes what a signed record shows. A table of its own, so the content
-- and signature hashes of existing entries stay as they are. Insert-only: the app may only add rows (LB-18).
create table entry_master_values (
  entry_version_id bigint primary key references entries(id),
  item_id uuid not null,
  item_code text not null,
  item_name text not null,
  item_version int not null,
  product_item_id uuid,
  product_code text,
  product_name text,
  product_version int
);
revoke all on entry_master_values from logbook_app;   -- the platform's default grants (0000)
grant select, insert on entry_master_values to logbook_app;
