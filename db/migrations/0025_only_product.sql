-- D-67 (owner 17 Nov 2026, H12): after an antibiotic product, only that product may follow until a verified product
-- changeover (or major) cleaning. TrueBatch records its own uses, so the Logbook publishes the product code that alone may
-- follow: only_product (null: any product, as far as this rule goes). One column is added at the end of the view (readers
-- select named columns; nothing is renamed or removed).
alter table item_status add column only_product text;

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view equipment_status_v1 with (security_barrier) as
select q.item_id as master_id, q.code, q.kind, s.state, s.fit_for_use, s.blockers, s.warnings, s.in_use_batch, s.cleaned_at,
  s.cleaned_by, s.clean_until, s.calibration_due, s.qualification, s.checked_at, now() as read_at, s.checked_at as data_as_of,
  s.last_decontamination, s.sterile_valid_until, s.last_glove_test, s.only_product
from item_status s
join equipment q on q.id = s.equipment_id
where q.item_id is not null;

reset search_path;
