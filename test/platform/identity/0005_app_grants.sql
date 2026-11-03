-- Least privilege (D-17): by default the app login gets only SELECT and INSERT on new tables (db/server/database.sql).
-- These are the only identity tables core_app changes or removes rows of. All of them hold current state, not
-- history: the history is in the insert-only tables (credential_event, employee_version, permission_grant, ...).
-- Tables created before D-17 got UPDATE/DELETE by default: take that back first, then grant exactly what is needed.
revoke update, delete, truncate on all tables in schema public from core_app;
grant update on credential, alert to core_app;          -- password, failed count, lock; alert acknowledgement
grant update, delete on session to core_app;           -- idle timeout, sign-out, deactivation ends sessions
grant update, delete on oidc_payload to core_app;      -- sign-on state of the OIDC provider (consumed, expired)
