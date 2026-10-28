-- S1 review fixes.
-- Audit timestamps and ids come only from the database (LB-18): the app may not choose them.
revoke insert on audit_log from logbook_app;
grant insert (actor_id, action, object_type, object_id, old_value, new_value, reason) on audit_log to logbook_app;

-- Temporary passwords expire (S1 review finding 2).
alter table users add column temp_password_expires_at timestamptz;
grant update (temp_password_expires_at) on users to logbook_app;
