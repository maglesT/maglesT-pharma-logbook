-- S4: equipment status (LB-05–08).
-- Calibration status applies only to items that need calibration (LB-05).
alter table equipment add column needs_calibration boolean not null default false;
update equipment set needs_calibration = true where kind = 'instrument';
grant update (needs_calibration) on equipment to logbook_app;
