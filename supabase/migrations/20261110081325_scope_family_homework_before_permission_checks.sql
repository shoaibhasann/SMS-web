begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Resolve the family's matching placements before running per-homework authorization.
create or replace function app_private.eligible_family_homework_sources(p_role text, p_activity_id uuid default null)
returns table (
  id uuid, title text, description text, due_date date, created_at timestamptz,
  school_id uuid, academic_year_id uuid, class_id uuid, section_id uuid, subject_id uuid,
  student_id uuid, max_marks numeric
)
language sql stable security invoker set search_path = ''
as $$
  with actor as materialized (
    select profile.id, profile.school_id
    from public.profiles profile
    join public.schools school on school.id = profile.school_id and school.is_active
    where profile.id = auth.uid() and profile.is_active
      and p_role in ('student', 'parent')
      and exists (
        select 1 from public.user_roles membership
        where membership.user_id = profile.id and membership.school_id = school.id and membership.role::text = p_role
      )
  ), pupils as materialized (
    select student.id from actor
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id and student.status = 'active'
    where p_role = 'student'
    union all
    select student.id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id and student.status = 'active'
    where p_role = 'parent'
  ), candidates as materialized (
    select activity.id, activity.title, activity.description, activity.due_date, publication.published_at,
      log.school_id, log.academic_year_id, log.class_id, log.section_id, log.subject_id,
      pupil.id as student_id, activity.max_marks
    from actor
    cross join pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
    join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = actor.school_id and year.is_current
    join public.sections section on section.id = enrollment.section_id and section.school_id = actor.school_id and section.class_id = enrollment.class_id
    join public.class_logs log on log.school_id = actor.school_id and log.academic_year_id = year.id
      and log.class_id = enrollment.class_id and log.section_id = section.id and log.status = 'published'
    join public.subjects subject on subject.id = log.subject_id and subject.school_id = log.school_id
    join public.class_activities activity on activity.class_log_id = log.id and activity.activity_type = 'homework'
    join app_private.family_homework_publications publication on publication.school_id = log.school_id
      and publication.activity_id = activity.id and publication.class_log_id = log.id
    where (p_activity_id is null or activity.id = p_activity_id)
      and publication.published_at <= statement_timestamp() and activity.title ~ '[^[:space:]]'
  )
  select distinct on (candidate.id) candidate.id, regexp_replace(candidate.title, '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    candidate.description, candidate.due_date, candidate.published_at,
    candidate.school_id, candidate.academic_year_id, candidate.class_id, candidate.section_id, candidate.subject_id,
    case when p_role = 'student' then candidate.student_id end, candidate.max_marks
  from candidates candidate
  where case when p_role = 'student' then app_private.homework_student_scope(candidate.id, candidate.student_id, false)
    else app_private.guardian_academic_submission(candidate.id, candidate.student_id) end
  order by candidate.id, candidate.student_id;
$$;

commit;
