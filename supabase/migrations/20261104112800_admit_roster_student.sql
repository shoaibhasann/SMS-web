begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.admit_roster_student(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_admission_no text,
  p_first_name text,
  p_last_name text
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  admission_number text := pg_catalog.btrim(p_admission_no);
  first_name text := pg_catalog.btrim(p_first_name);
  last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  new_student_id uuid;
begin
  perform 1
  from public.user_roles role_row
  join public.profiles profile on profile.id = role_row.user_id and profile.is_active
  where role_row.user_id = (select auth.uid())
    and ((role_row.role = 'super_admin' and role_row.school_id is null)
      or (role_row.school_id = p_school_id and role_row.role in ('school_admin', 'principal')))
  for share of role_row, profile;

  if not found then
    raise exception 'You cannot admit students for this school.' using errcode = '42501';
  end if;

  if admission_number is null or pg_catalog.length(admission_number) not between 1 and 64
    or admission_number ~ '[[:cntrl:]]'
    or first_name is null or pg_catalog.length(first_name) not between 1 and 100
    or first_name ~ '[[:cntrl:]]'
    or pg_catalog.length(last_name) > 100 or last_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid admission number and student name.' using errcode = '22023';
  end if;

  perform 1
  from public.academic_years year_row
  join public.classes class_row on class_row.school_id = year_row.school_id
  join public.sections section_row
    on section_row.class_id = class_row.id and section_row.school_id = class_row.school_id
  where year_row.id = p_academic_year_id and year_row.school_id = p_school_id
    and year_row.is_current and class_row.is_active
    and class_row.id = p_class_id and section_row.id = p_section_id
    and not exists (
      select 1 from public.academic_years other_year
      where other_year.school_id = p_school_id and other_year.is_current and other_year.id <> year_row.id
    )
  for share of year_row, class_row, section_row;

  if not found then
    raise exception 'Choose a valid class and section in the current academic year.' using errcode = '22023';
  end if;

  insert into public.students (school_id, admission_no, first_name, last_name, admission_date, status)
  values (p_school_id, admission_number, first_name, last_name, (current_timestamp at time zone 'Asia/Kolkata')::date, 'active')
  on conflict (school_id, admission_no) do nothing
  returning id into new_student_id;

  if new_student_id is null then
    raise exception 'This admission number is already used in this school.' using errcode = '23505';
  end if;

  insert into public.enrollments (student_id, academic_year_id, class_id, section_id, status)
  values (new_student_id, p_academic_year_id, p_class_id, p_section_id, 'active');

  return new_student_id;
end;
$function$;

create function public.admit_roster_student(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_admission_no text,
  p_first_name text,
  p_last_name text
)
returns uuid
language sql security invoker set search_path = ''
as $function$
  select app_private.admit_roster_student(
    p_school_id, p_academic_year_id, p_class_id, p_section_id, p_admission_no, p_first_name, p_last_name
  );
$function$;

revoke all on function app_private.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text)
  to authenticated;
grant execute on function public.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text)
  to authenticated;

commit;
