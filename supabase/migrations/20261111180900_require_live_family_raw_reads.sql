begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regprocedure('app_private.current_student_id()') is null
    or to_regprocedure('app_private.current_parent_id()') is null
    or to_regprocedure('app_private.has_live_school_session()') is null then
    raise exception 'family identity helpers are missing';
  end if;
end;
$preflight$;

-- The raw-table family policies resolve the pupil/guardian through these helpers, so a
-- removed family role, disabled profile or revoked session must end the match here.
create or replace function app_private.current_student_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select s.id
  from public.students s
  join public.profiles p on p.id = s.profile_id and p.is_active
  join public.user_roles r on r.user_id = p.id and r.school_id = s.school_id and r.role = 'student'::public.app_role
  where s.profile_id = (select auth.uid()) and (select app_private.has_live_school_session())
  limit 1;
$$;

create or replace function app_private.current_parent_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select g.id
  from public.parents g
  join public.profiles p on p.id = g.profile_id and p.is_active
  join public.user_roles r on r.user_id = p.id and r.school_id = g.school_id and r.role = 'parent'::public.app_role
  where g.profile_id = (select auth.uid()) and (select app_private.has_live_school_session())
  limit 1;
$$;

revoke all on function app_private.current_student_id() from public, anon;
revoke all on function app_private.current_parent_id() from public, anon;
grant execute on function app_private.current_student_id() to authenticated;
grant execute on function app_private.current_parent_id() to authenticated;

-- Each policy reads the helpers once per statement (initPlan) instead of once per row, so
-- office and teacher reads no longer pay for the permissive family policies row by row.
drop policy if exists students_student_own on public.students;
create policy students_student_own on public.students for select to authenticated
using (id = (select app_private.current_student_id()));
drop policy if exists students_parent_children on public.students;
create policy students_parent_children on public.students for select to authenticated
using (exists (select 1 from public.student_parents sp
  where sp.student_id = students.id and sp.parent_id = (select app_private.current_parent_id())));

drop policy if exists attendance_student_read on public.attendance;
create policy attendance_student_read on public.attendance for select to authenticated
using (student_id = (select app_private.current_student_id()));
drop policy if exists attendance_parent_read on public.attendance;
create policy attendance_parent_read on public.attendance for select to authenticated
using (exists (select 1 from public.student_parents sp
  join public.parents p on p.id = sp.parent_id
  join public.students s on s.id = sp.student_id and s.school_id = p.school_id
  where p.id = (select app_private.current_parent_id()) and sp.student_id = attendance.student_id and s.school_id = attendance.school_id));

drop policy if exists student_fees_student_read on public.student_fees;
create policy student_fees_student_read on public.student_fees for select to authenticated
using (student_id = (select app_private.current_student_id()));
drop policy if exists student_fees_parent_read on public.student_fees;
create policy student_fees_parent_read on public.student_fees for select to authenticated
using (exists (select 1 from public.student_parents sp
  where sp.student_id = student_fees.student_id and sp.parent_id = (select app_private.current_parent_id())));

drop policy if exists fee_payments_student_read on public.fee_payments;
create policy fee_payments_student_read on public.fee_payments for select to authenticated
using (student_id = (select app_private.current_student_id()));
drop policy if exists fee_payments_parent_read on public.fee_payments;
create policy fee_payments_parent_read on public.fee_payments for select to authenticated
using (exists (select 1 from public.student_parents sp
  where sp.student_id = fee_payments.student_id and sp.parent_id = (select app_private.current_parent_id())));

drop policy if exists enrollments_student_own on public.enrollments;
create policy enrollments_student_own on public.enrollments for select to authenticated
using (status <> all (array['staged', 'cancelled']) and student_id = (select app_private.current_student_id()));
drop policy if exists enrollments_parent_children on public.enrollments;
create policy enrollments_parent_children on public.enrollments for select to authenticated
using (status <> all (array['staged', 'cancelled']) and exists (select 1 from public.student_parents sp
  where sp.student_id = enrollments.student_id and sp.parent_id = (select app_private.current_parent_id())));

drop policy if exists timetables_student_read on public.timetables;
create policy timetables_student_read on public.timetables for select to authenticated
using (exists (select 1 from public.enrollments e
  where e.student_id = (select app_private.current_student_id()) and e.class_id = timetables.class_id
    and (timetables.section_id is null or e.section_id = timetables.section_id) and e.academic_year_id = timetables.academic_year_id));
drop policy if exists timetables_parent_read on public.timetables;
create policy timetables_parent_read on public.timetables for select to authenticated
using (exists (select 1 from public.student_parents sp join public.enrollments e on e.student_id = sp.student_id
  where sp.parent_id = (select app_private.current_parent_id()) and e.class_id = timetables.class_id
    and (timetables.section_id is null or e.section_id = timetables.section_id) and e.academic_year_id = timetables.academic_year_id));

drop policy if exists parents_parent_own on public.parents;
create policy parents_parent_own on public.parents for select to authenticated
using (id = (select app_private.current_parent_id()));
drop policy if exists student_parents_parent_own on public.student_parents;
create policy student_parents_parent_own on public.student_parents for select to authenticated
using (parent_id = (select app_private.current_parent_id()));

do $postcondition$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in ('current_student_id', 'current_parent_id')
      and (not p.prosecdef or p.proconfig is distinct from array['search_path=""'])
  ) then
    raise exception 'family identity helpers must be security definer with an empty search_path';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and regexp_replace(coalesce(qual, ''), 'SELECT app_private\.current_(student|parent)_id\(\) AS', '', 'g')
        ~ 'app_private\.current_(student|parent)_id\(\)'
  ) then
    raise exception 'family raw-read policies must call the identity helpers as initPlans';
  end if;
end;
$postcondition$;
commit;
