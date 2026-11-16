-- D-50 (owner 16 Nov 2026, TrueBatch Injectables plan 3b): the sterile facts the Logbook already keeps are published
-- in equipment_status_v1 for TrueBatch Injectables. A steriliser is fit only with a verified passed steriliser test
-- within its validity (default today); an isolator or RABS only with a verified passed VHP decontamination and every
-- glove port tested within theirs (logbook settings, validDays). Each reason is a blocker, in words. Three columns are
-- added at the end of the view (readers select named columns; nothing is renamed or removed).
alter table item_status add column last_decontamination timestamptz, add column sterile_valid_until date,
  add column last_glove_test timestamptz;

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- last_decontamination: the newest verified passed VHP cycle. sterile_valid_until: the last plant day the item is fit
-- on its steriliser test, decontamination and glove tests (the earliest; empty when none applies). last_glove_test:
-- the port whose last test is oldest (the one that expires first).
create or replace view equipment_status_v1 with (security_barrier) as
select q.item_id as master_id, q.code, q.kind, s.state, s.fit_for_use, s.blockers, s.warnings, s.in_use_batch, s.cleaned_at,
  s.cleaned_by, s.clean_until, s.calibration_due, s.qualification, s.checked_at, now() as read_at, s.checked_at as data_as_of,
  s.last_decontamination, s.sterile_valid_until, s.last_glove_test
from item_status s
join equipment q on q.id = s.equipment_id
where q.item_id is not null;

reset search_path;
