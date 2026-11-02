-- B1-2 (D-29): sign-on through Medhanta core (PL-01). People live in core's identity database; `users` stays as the
-- id map that entries, signatures and the audit trail refer to: one row per core employee (employee_id), created at
-- first sign-on. A session keeps the roles from core's token and the tokens to renew them; renewals re-check the
-- permission register at least every 5 minutes.
alter table users add column employee_id uuid unique;
alter table sessions add column roles text[] not null default '{}',
  add column refresh_token text,
  add column id_token text,
  add column checked_at timestamptz not null default now();
