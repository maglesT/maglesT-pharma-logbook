-- S16d (owner, 2026-11-12): an expired clean hold also raises a deviation automatically (D-35).
alter table auto_deviations drop constraint auto_deviations_kind_check;
alter table auto_deviations add constraint auto_deviations_kind_check check (kind in ('dirty_hold', 'clean_hold', 'frequency'));
