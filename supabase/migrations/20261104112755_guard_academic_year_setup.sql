begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.academic_years
  add constraint academic_years_dates_in_order check (start_date <= end_date);

create unique index academic_years_one_current_per_school
  on public.academic_years (school_id) where is_current;

commit;
