-- S10: voice notes in Indian languages, translated to English (D-26). Both tables are
-- insert-only. A voice note keeps the original audio and texts as returned by the speech
-- service; a confirmation links it to one entry version with the English text the speaker
-- signed. An unconfirmed voice note is original data only and never part of an entry.
create table voice_notes (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references equipment(id),
  logbook_type text not null,
  field text not null,
  user_id bigint not null references users(id),
  -- 'unknown' means the speaker asked for automatic detection.
  requested_language text not null,
  detected_language text,
  audio bytea not null,
  audio_mime text not null,
  audio_sha256 text not null check (audio_sha256 ~ '^[0-9a-f]{64}$'),
  duration_ms integer check (duration_ms > 0),
  transcript text not null,
  translation text not null,
  provider text not null,
  model text not null,
  provider_request_ids jsonb not null default '{}',
  requested_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index voice_notes_user on voice_notes (user_id, equipment_id, received_at);

create table voice_note_confirmations (
  id bigint generated always as identity primary key,
  voice_note_id bigint not null unique references voice_notes(id),
  entry_version_id bigint not null references entries(id),
  final_text text not null check (length(trim(final_text)) > 0),
  edited boolean not null,
  confirmed_at timestamptz not null default now()
);
create index voice_note_confirmations_entry on voice_note_confirmations (entry_version_id);

grant select on voice_notes, voice_note_confirmations to logbook_app;
grant insert (equipment_id, logbook_type, field, user_id, requested_language, detected_language, audio, audio_mime, audio_sha256,
  duration_ms, transcript, translation, provider, model, provider_request_ids, requested_at) on voice_notes to logbook_app;
grant insert (voice_note_id, entry_version_id, final_text, edited) on voice_note_confirmations to logbook_app;

alter table signatures drop constraint signatures_object_type_check;
alter table signatures add constraint signatures_object_type_check check (object_type in ('entry', 'settings', 'review', 'voice_note'));
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check
  check (meaning in ('performed', 'verified', 'released', 'reviewed', 'approved', 'corrected', 'voice_confirmed'));
