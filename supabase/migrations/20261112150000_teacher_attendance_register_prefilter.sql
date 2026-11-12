begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
-- Deterministic deparse for the exact-text check; every name below is schema-qualified.
set local search_path = public, pg_temp;

-- A teacher's read of attendance ran teacher_owns_attendance_register_on() for every row the read touched, because the
-- once-per-statement gate (the caller has a teacher record) is true for every teacher. The policy now first keeps only
-- rows in a register the caller can own or cover today, computed once per statement; the function still decides.
lock table public.attendance in access exclusive mode;

do $preflight$
begin
  -- The superset argument below was made against these exact bodies; any drift stops the run.
  if exists (
    select 1 from (values
    ('app_private.teacher_owns_attendance_register_on(uuid,uuid,uuid,uuid,date)', '3bedc50837615867b2ef5f896ae8ad23'),
    ('app_private.teacher_owns_attendance_register(uuid,uuid,uuid,uuid)', '68222feb3143ec8b494347d532331fc6'),
    ('app_private.teacher_has_attendance_coverage(uuid,uuid,uuid,uuid,date)', '70c356d02b0f03c4a4ac8cbea9287ba3'),
    ('app_private.my_active_attendance_coverages(date)', '1c0c7ba1af03a58b604a9e44e0920fa2'),
    ('app_private.current_teacher_id()', '97a7cf31e53655e32e7206c5ec501aa0')
    ) as pin(fn, body_md5)
    where to_regprocedure(pin.fn) is null
       or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(pin.fn)) <> pin.body_md5
  ) then
    raise exception 'attendance register helpers differ from the reviewed definitions';
  end if;
  if to_regprocedure('app_private.caller_attendance_register_scopes()') is not null then
    raise exception 'the attendance register scope helper already exists';
  end if;
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'attendance' and p.policyname = 'attendance_class_teacher_manage'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL' and p.roles = array['authenticated']::name[]
      and regexp_replace(p.qual, '\s+', ' ', 'g') = $q$((( SELECT app_private.current_teacher_id() AS current_teacher_id) IS NOT NULL) AND app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date))$q$
      and regexp_replace(p.with_check, '\s+', ' ', 'g') = $q$((( SELECT app_private.current_teacher_id() AS current_teacher_id) IS NOT NULL) AND app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date))$q$
  ) then
    raise exception 'attendance_class_teacher_manage differs from the reviewed definition';
  end if;
end;
$preflight$;

-- Every (school, year, section) register the caller can own as class teacher or cover today. It is a superset of where
-- teacher_owns_attendance_register_on() can be true: that function needs a class-teacher assignment of the caller's
-- teacher record for the same school, year and section, or a caller coverage that is unrevoked and runs today for them.
-- It only states facts about the caller.
create function app_private.caller_attendance_register_scopes()
returns table(school_id uuid, academic_year_id uuid, section_id uuid)
language sql stable security definer set search_path = ''
as $$
  select teacher.school_id, assignment.academic_year_id, assignment.section_id
  from public.teachers teacher
  join public.teacher_subject_assignments assignment on assignment.teacher_id = teacher.id
  where teacher.profile_id = (select auth.uid()) and assignment.is_class_teacher and assignment.section_id is not null
  union
  select coverage.school_id, coverage.academic_year_id, coverage.section_id
  from app_private.substitute_attendance_coverages coverage
  join public.teachers substitute on substitute.id = coverage.substitute_teacher_id and substitute.profile_id = (select auth.uid())
  where coverage.revoked_at is null
    and (statement_timestamp() at time zone 'Asia/Kolkata')::date between coverage.starts_on and coverage.ends_on;
$$;
revoke all on function app_private.caller_attendance_register_scopes() from public, anon;
grant execute on function app_private.caller_attendance_register_scopes() to authenticated;

alter policy attendance_class_teacher_manage on public.attendance
  using ((select app_private.current_teacher_id()) is not null
    and (school_id, academic_year_id, section_id) in (
      select scope.school_id, scope.academic_year_id, scope.section_id from app_private.caller_attendance_register_scopes() scope)
    and app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date))
  with check ((select app_private.current_teacher_id()) is not null
    and (school_id, academic_year_id, section_id) in (
      select scope.school_id, scope.academic_year_id, scope.section_id from app_private.caller_attendance_register_scopes() scope)
    and app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date));

do $postcondition$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'caller_attendance_register_scopes'
      and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
      and not has_function_privilege('anon', p.oid, 'EXECUTE') and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'the attendance register scope helper must be a stable security definer function with an empty search_path';
  end if;
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'attendance' and p.policyname = 'attendance_class_teacher_manage'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL' and p.roles = array['authenticated']::name[]
      and p.qual ~ 'caller_attendance_register_scopes\(\)' and p.with_check ~ 'caller_attendance_register_scopes\(\)'
      and p.qual ~ 'teacher_owns_attendance_register_on\(' and p.with_check ~ 'teacher_owns_attendance_register_on\('
  ) then
    raise exception 'attendance_class_teacher_manage lost its register check or its scope filter';
  end if;
  -- Without a signed-in caller the helper names no register.
  if exists (select 1 from app_private.caller_attendance_register_scopes()) then
    raise exception 'the attendance register scope helper must be empty for a caller without a session';
  end if;
end;
$postcondition$;
commit;
