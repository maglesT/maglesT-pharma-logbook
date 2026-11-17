-- D-71 (owner 17 Nov 2026): only trained people sign. When a logbook type's settings name a training, each "performed" or
-- "verified" signature keeps what the training check found: checked in Recruitment (training_v1) with its valid-until date,
-- or stated by the signer while Recruitment was not linked or not reachable (typed = true, "Training typed by hand").
-- One row per signature, written in the signature's transaction; insert-only like the signatures.
create table signature_training (
  signature_id bigint primary key references signatures(id),
  skill_code text not null,
  skill_title text not null,
  valid_until date,
  typed boolean not null,
  note text not null,
  checked_at timestamptz not null default now()
);
revoke all on signature_training from logbook_app;   -- the platform's default grants (0000)
grant select on signature_training to logbook_app;
grant insert (signature_id, skill_code, skill_title, valid_until, typed, note) on signature_training to logbook_app;
