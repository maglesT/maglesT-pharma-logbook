-- Owner 2026-11-14 (D-44): documents attached to calibration, requalification and maintenance (breakdown, preventive)
-- entries: the certificate, the service report, the requalification report. PDF, PNG or JPEG, at most 10 MB each and
-- 10 per entry, kept in this database. A document is attached to the entry (entries.entry_id, shared by all its
-- versions), so a correction keeps it. Insert-only, audited; the database checks the size and the SHA-256 itself.
create table entry_attachments (
  id bigint generated always as identity primary key,
  -- entries.entry_id: the entry across its versions.
  entry_id bigint not null,
  -- The version that was current when the document was attached.
  entry_version_id bigint not null references entries(id),
  file_name text not null check (length(trim(file_name)) between 1 and 200),
  media_type text not null check (media_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 = encode(sha256(content), 'hex')),
  content bytea not null check (octet_length(content) = size_bytes),
  -- Why the document was added after the entry was saved; null when attached with the save.
  reason text check (reason is null or length(trim(reason)) > 0),
  uploaded_by bigint not null references users(id),
  uploaded_at timestamptz not null default now()
);
create index entry_attachments_entry on entry_attachments (entry_id, id);
revoke all on entry_attachments from logbook_app;   -- the platform's default grants (0000)
grant select on entry_attachments to logbook_app;
grant insert (entry_id, entry_version_id, file_name, media_type, size_bytes, sha256, content, reason, uploaded_by) on entry_attachments to logbook_app;
revoke all on sequence entry_attachments_id_seq from logbook_app;

-- Only on the entry types that carry a report, on the entry the version belongs to, and at most 10 per entry.
create function check_entry_attachment() returns trigger language plpgsql as $$
declare v entries%rowtype;
begin
  select * into v from entries where id = new.entry_version_id;
  if not found or v.entry_id <> new.entry_id then
    raise exception 'the attachment does not belong to the entry of this version' using errcode = 'P0001';
  end if;
  if v.logbook_type not in ('calibration', 'requalification', 'maintenance') then
    raise exception 'documents are attached to calibration, requalification and maintenance entries only' using errcode = 'P0001';
  end if;
  if (select count(*) from entry_attachments a where a.entry_id = new.entry_id) >= 10 then
    raise exception 'an entry carries at most 10 documents' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger entry_attachments_rules before insert on entry_attachments for each row execute function check_entry_attachment();
