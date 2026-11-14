-- Owner 2026-11-14 (D-43 amended): how long an approved Logbook exception allows continued use is QA's choice when they
-- approve it — no fixed maximum (was 7 days, enforced as 8 days from the decision). The date must still be after the
-- decision; cleaning limits are still never waived and critical problems still go to Deviations (unchanged).
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'problem_decisions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%8 days%' loop
    execute format('alter table problem_decisions drop constraint %I', c);
  end loop;
end $$;
alter table problem_decisions add constraint problem_decisions_use_until_after_decision
  check (use_allowed_until is null or use_allowed_until > decided_at);
