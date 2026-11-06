create table if not exists public.school_holidays (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  holiday_date date not null,
  title text not null default 'Holiday',
  remarks text,
  declared_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (school_id, academic_year_id, holiday_date)
);

alter table public.school_holidays enable row level security;

create index if not exists idx_school_holidays_school_year_date
  on public.school_holidays (school_id, academic_year_id, holiday_date);

create policy "school members can view holidays"
on public.school_holidays
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.school_id = school_holidays.school_id
  )
);

create policy "teachers can create holidays"
on public.school_holidays
for insert
to authenticated
with check (
  declared_by = auth.uid()
  and exists (
    select 1
    from public.teachers t
    where t.profile_id = auth.uid()
      and t.school_id = school_holidays.school_id
  )
);

create policy "teachers can update holidays"
on public.school_holidays
for update
to authenticated
using (
  exists (
    select 1
    from public.teachers t
    where t.profile_id = auth.uid()
      and t.school_id = school_holidays.school_id
  )
)
with check (
  exists (
    select 1
    from public.teachers t
    where t.profile_id = auth.uid()
      and t.school_id = school_holidays.school_id
  )
);

create policy "teachers can delete holidays"
on public.school_holidays
for delete
to authenticated
using (
  exists (
    select 1
    from public.teachers t
    where t.profile_id = auth.uid()
      and t.school_id = school_holidays.school_id
  )
);