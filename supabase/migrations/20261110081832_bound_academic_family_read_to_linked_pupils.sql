begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Resolve a family's own pupils before testing a log against its roster.
create or replace function app_private.academic_family_scope(p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select app_private.has_live_school_session()) and exists (
    with actor as materialized (
      select profile.id, membership.role
      from public.profiles profile
      join public.user_roles membership on membership.user_id = profile.id and membership.school_id = p_school_id
        and membership.role in ('student', 'parent')
      where profile.id = (select auth.uid()) and profile.is_active and profile.school_id = p_school_id
    ), pupils as materialized (
      select student.id
      from actor join public.students student on student.profile_id = actor.id and student.school_id = p_school_id
      where actor.role = 'student'
      union all
      select student.id
      from actor
      join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = p_school_id
      join public.student_parents link on link.parent_id = guardian.id
      join public.students student on student.id = link.student_id and student.school_id = p_school_id
      where actor.role = 'parent'
    )
    select 1 from pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status in ('active', 'withdrawn')
    join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = p_school_id
    join public.classes class on class.id = enrollment.class_id and class.school_id = p_school_id
    join public.sections section on section.id = enrollment.section_id and section.school_id = p_school_id and section.class_id = class.id
    where (p_year_id is null or enrollment.academic_year_id = p_year_id)
      and (p_class_id is null or enrollment.class_id = p_class_id)
      and (p_section_id is null or enrollment.section_id = p_section_id)
  );
$$;

-- Activities inherit the already checked log visibility as one set.
alter policy academic_activities_read on public.class_activities
  using (class_log_id in (select log.id from public.class_logs log));
commit;
