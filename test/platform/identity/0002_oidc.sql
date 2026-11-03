-- Sign-on (slice A3): what the OIDC provider must remember between requests (sessions, interactions, codes,
-- refresh tokens, grants). Short-lived technical state, not GMP records; expired rows are deleted.
create table oidc_payload (
  model text not null,
  id text not null,
  payload jsonb not null,
  grant_id text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  primary key (model, id)
);
create index oidc_payload_grant on oidc_payload (grant_id);
create index oidc_payload_uid on oidc_payload (uid);
