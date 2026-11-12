-- A same-session roster move rewrites the live enrollment row in place, so
-- cohort checks that only compared the live class/section hid every earlier
-- submission, grade and attachment from the pupil, guardian, teacher and
-- office. Read paths now also accept the placement in force on the log date,
-- taken from the audited move history. Pupil writes stay on the live placement.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Placement on p_on is the source of the first move effective after that day.
create function app_private.placed_in_section_on(p_enrollment_id uuid, p_class_id uuid, p_section_id uuid, p_on date)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select change.source_class_id = p_class_id and (p_section_id is null or change.source_section_id = p_section_id)
    from app_private.roster_placement_changes change
    where change.source_enrollment_id = p_enrollment_id and change.change_kind = 'move' and change.effective_date > p_on
    order by change.effective_date limit 1
  ), false);
$$;
revoke all on function app_private.placed_in_section_on(uuid, uuid, uuid, date) from public, anon, authenticated, service_role;

create or replace function app_private.academic_submission_cohort(p_activity_id uuid, p_student_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.classes class on class.id=log.class_id and class.school_id=log.school_id
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year.id
    join public.sections section on section.id=enrollment.section_id and section.school_id=log.school_id
    where activity.id=p_activity_id and activity.activity_type<>'study_material' and enrollment.status in ('active','withdrawn')
      and ((enrollment.class_id=class.id and section.class_id=class.id and (log.section_id is null or enrollment.section_id=log.section_id))
        or app_private.placed_in_section_on(enrollment.id, log.class_id, log.section_id, log.log_date)));
$$;

-- Placement comes from the cohort check; only writes need the live placement.
create or replace function app_private.student_academic_submission(p_activity_id uuid, p_student_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select app_private.has_live_school_session()) and (
    exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.profiles profile on profile.id=student.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='student'
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year.id
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid())
      and (not p_write or year.is_current and enrollment.status='active' and enrollment.class_id=log.class_id
        and (log.section_id is null or enrollment.section_id=log.section_id))
      and enrollment.status in ('active','withdrawn'))
  );
$$;

create or replace function app_private.guardian_academic_submission(p_activity_id uuid, p_student_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select app_private.has_live_school_session()) and (
    exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=log.academic_year_id
      and enrollment.status in ('active','withdrawn')
    join public.student_parents link on link.student_id=student.id join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=log.school_id
    join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='parent'
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid()))
  );
$$;

create or replace function app_private.list_homework_submissions_for_grading(p_activity_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare activity public.class_activities%rowtype; log public.class_logs%rowtype;
begin
  if not app_private.homework_teacher_scope(p_activity_id,false) then raise exception 'Assigned teacher access is required.' using errcode='42501'; end if;
  select * into activity from public.class_activities where id=p_activity_id;
  select * into log from public.class_logs where id=activity.class_log_id;
  return jsonb_build_object('activity',jsonb_build_object('id',activity.id,'title',activity.title,'max_marks',activity.max_marks),'students',(
    select coalesce(jsonb_agg(jsonb_build_object('student_id',pupil.id,'first_name',pupil.first_name,'middle_name',pupil.middle_name,'last_name',pupil.last_name,'admission_no',pupil.admission_no,
      'submission',case when submission.id is null then null else jsonb_build_object('id',submission.id,'activity_id',submission.activity_id,'student_id',submission.student_id,
        'text_response',submission.text_response,'file_path',submission.file_path,'file_name',submission.file_name,'submitted_at',submission.submitted_at,
        'status',submission.status,'marks',submission.marks,'feedback',submission.feedback,'revision',submission.revision) end) order by pupil.admission_no,pupil.id),'[]'::jsonb)
    from public.enrollments enrollment join public.students pupil on pupil.id=enrollment.student_id and pupil.school_id=log.school_id
    left join public.activity_submissions submission on submission.student_id=pupil.id and submission.activity_id=activity.id
    where enrollment.academic_year_id=log.academic_year_id and enrollment.status='active'
      and ((enrollment.class_id=log.class_id and enrollment.section_id=log.section_id)
        or app_private.placed_in_section_on(enrollment.id, log.class_id, log.section_id, log.log_date))
  ));
end;
$$;

-- Published logs a family's own pupil was placed in on the log date.
create function app_private.academic_family_history_log(p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_log_date date)
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
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.academic_year_id = p_year_id
      and enrollment.status in ('active', 'withdrawn')
    where app_private.placed_in_section_on(enrollment.id, p_class_id, p_section_id, p_log_date)
  );
$$;
revoke all on function app_private.academic_family_history_log(uuid, uuid, uuid, uuid, date) from public, anon, authenticated, service_role;
grant execute on function app_private.academic_family_history_log(uuid, uuid, uuid, uuid, date) to authenticated;

-- The initPlan gate is a necessary condition of the per-row check (a live, active pupil or
-- guardian account), so office and teacher reads skip the per-row family work.
create policy academic_logs_family_history on public.class_logs for select to authenticated
using (
  ((select app_private.current_student_id()) is not null or (select app_private.current_parent_id()) is not null)
  and status = 'published' and app_private.academic_family_history_log(school_id, academic_year_id, class_id, section_id, log_date)
);

commit;
