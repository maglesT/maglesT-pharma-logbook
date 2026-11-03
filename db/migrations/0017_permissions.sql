-- B1-2b (platform A10, D-30): a session keeps this product's permission codes from core's token instead of roles.
-- Open sessions hold roles, so they end; everyone signs on again.
delete from sessions;
alter table sessions rename column roles to permissions;
