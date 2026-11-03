-- PL-12: the links and outside logins that are on, across all databases, as recorded by the last apply, for the
-- access review report in core. apply.ts (the installer) replaces these rows at every apply; the full history stays in each
-- database's platform.link_log (PL-02). core_app may only read them.
create table link_state (
  provider text not null,       -- database the views belong to
  consumer text not null,       -- <product>_app or ext_<name>
  view_name text not null,
  switched_on_at timestamptz,  -- when this link was last switched on, from the provider's platform.link_log
  change_ref text,             -- under which change reference
  primary key (provider, consumer, view_name)
);
revoke insert, update, delete, truncate on link_state from core_app;
