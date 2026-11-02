-- B1-4 (D-29, platform PL-05): each signing proof from core's re-authentication is spent by the save that stores its
-- signature(s): once, in one transaction (tx). One save may carry two signatures of the same person (an entry and its
-- voice-note confirmation).
create table signing_proofs (
  nonce text primary key,
  user_id bigint not null references users(id),
  tx bigint not null default txid_current(),
  used_at timestamptz not null default now()
);
revoke all on signing_proofs from logbook_app;   -- the platform's default grants (0000)
grant select, insert on signing_proofs to logbook_app;
grant update (used_at) on signing_proofs to logbook_app;
-- Passwords and lockout are core's now (B1-2, B1-4): the app no longer writes them.
revoke update (password_hash, must_change_password, password_changed_at, failed_attempts, locked_at, active) on users from logbook_app;
