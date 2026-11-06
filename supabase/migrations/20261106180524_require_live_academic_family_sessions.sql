-- A still-unexpired JWT must not retain academic access after native sign-out.
-- Keep every existing cohort/assignment/linked-child predicate and API contract.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Private, nonrecursive and fail-closed: guardian_hybrid_actor already calls
-- student_leave_actor, so the legacy actors cannot call back into it.
create function app_private.has_live_school_session()
returns boolean language sql stable security definer set search_path = ''
as $session$
  select coalesce(case
    when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then exists (
      select 1 from auth.sessions session
      join auth.users account on account.id=session.user_id
      join public.profiles profile on profile.id=account.id and profile.is_active
      where session.id=(auth.jwt()->>'session_id')::uuid
        and session.user_id=(select auth.uid())
        and (session.not_after is null or session.not_after>statement_timestamp())
        and not coalesce(account.is_anonymous,false) and account.deleted_at is null
        and (account.banned_until is null or account.banned_until<=statement_timestamp())
        and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
    ) else false end,false);
$session$;
revoke all on function app_private.has_live_school_session() from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.academic_family_scope(p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    exists (
    select 1 from public.enrollments enrollment
    join public.academic_years year on year.id=enrollment.academic_year_id and year.school_id=p_school_id
    join public.classes class on class.id=enrollment.class_id and class.school_id=p_school_id
    join public.sections section on section.id=enrollment.section_id and section.school_id=p_school_id and section.class_id=class.id
    join public.students student on student.id=enrollment.student_id and student.school_id=p_school_id
    where enrollment.status in ('active','withdrawn')
      and (p_year_id is null or enrollment.academic_year_id=p_year_id)
      and (p_class_id is null or enrollment.class_id=p_class_id)
      and (p_section_id is null or enrollment.section_id=p_section_id)
      and (exists (select 1 from public.profiles profile join public.user_roles membership on membership.user_id=profile.id
        where profile.id=student.profile_id and profile.id=(select auth.uid()) and profile.is_active
          and profile.school_id=p_school_id and membership.school_id=p_school_id and membership.role='student')
        or exists (select 1 from public.student_parents link join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=p_school_id
          join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=p_school_id
          join public.user_roles membership on membership.user_id=profile.id and membership.school_id=p_school_id and membership.role='parent'
          where link.student_id=student.id and profile.id=(select auth.uid())))
  )
  );
$function$;

CREATE OR REPLACE FUNCTION app_private.academic_manager(p_school_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    exists (select 1 from public.user_roles membership
    join public.profiles profile on profile.id = membership.user_id and profile.is_active
    where membership.user_id = (select auth.uid()) and (
      (membership.school_id = p_school_id and membership.role in ('school_admin','principal'))
      or (membership.school_id is null and membership.role = 'super_admin')))
  );
$function$;

CREATE OR REPLACE FUNCTION app_private.academic_office_read(p_school_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    exists (select 1 from public.user_roles membership
    join public.profiles profile on profile.id=membership.user_id and profile.is_active
    where membership.user_id=(select auth.uid()) and (
      (membership.school_id=p_school_id and membership.role in ('school_admin','principal','accountant','reception_staff'))
      or (membership.school_id is null and membership.role='super_admin')))
  );
$function$;

CREATE OR REPLACE FUNCTION app_private.guardian_academic_submission(p_activity_id uuid, p_student_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=log.academic_year_id
      and enrollment.class_id=log.class_id and (log.section_id is null or enrollment.section_id=log.section_id) and enrollment.status in ('active','withdrawn')
    join public.student_parents link on link.student_id=student.id join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=log.school_id
    join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='parent'
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid()))
  );
$function$;

CREATE OR REPLACE FUNCTION app_private.result_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=auth.uid();
begin
  perform 1 from auth.users u where u.id=actor and not coalesce(u.is_anonymous,false) and u.deleted_at is null
    and(u.banned_until is null or u.banned_until<=now()) and(u.email_confirmed_at is not null or u.phone_confirmed_at is not null) for share;
  if not found or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then
    raise exception 'An active verified account is required.' using errcode='42501'; end if;
  -- Retain the Auth-first lock order and hold the exact native session while
  -- a governed mutation runs. Missing/malformed/other-user sessions deny.
  if not app_private.has_live_school_session() then
    raise exception 'An active verified session is required.' using errcode='42501';
  end if;
  perform 1 from auth.sessions session
    where session.id=(auth.jwt()->>'session_id')::uuid and session.user_id=actor
      and (session.not_after is null or session.not_after>statement_timestamp()) for share;
  if not found then raise exception 'An active verified session is required.' using errcode='42501'; end if;
  return actor;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.student_academic_submission(p_activity_id uuid, p_student_id uuid, p_write boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.profiles profile on profile.id=student.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='student'
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year.id and enrollment.class_id=log.class_id
      and (log.section_id is null or enrollment.section_id=log.section_id)
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid())
      and (not p_write or year.is_current and enrollment.status='active') and enrollment.status in ('active','withdrawn'))
  );
$function$;

CREATE OR REPLACE FUNCTION app_private.student_leave_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor_id uuid := auth.uid();
begin
  -- Match guardian revoke's Auth-first lock order; profile/role locks keep a
  -- disabled account or removed role from racing an authorized mutation.
  perform 1 from auth.users u where u.id=actor_id and not coalesce(u.is_anonymous,false)
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) for share;
  if not found then raise exception 'An active verified account is required.' using errcode='42501'; end if;
  perform 1 from public.profiles p where p.id=actor_id and p.is_active for share;
  if not found then raise exception 'An active verified account is required.' using errcode='42501'; end if;
  -- Retain the Auth-first lock order and hold the exact native session while
  -- a governed mutation runs. Missing/malformed/other-user sessions deny.
  if not app_private.has_live_school_session() then
    raise exception 'An active verified session is required.' using errcode='42501';
  end if;
  perform 1 from auth.sessions session
    where session.id=(auth.jwt()->>'session_id')::uuid and session.user_id=actor_id
      and (session.not_after is null or session.not_after>statement_timestamp()) for share;
  if not found then raise exception 'An active verified session is required.' using errcode='42501'; end if;
  return actor_id;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.teacher_academic_scope(p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_subject_id uuid, p_write boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select app_private.has_live_school_session()) and (
    p_class_id is not null and p_section_id is not null and p_subject_id is not null and exists (
    select 1 from public.teachers teacher
    join public.profiles profile on profile.id = teacher.profile_id and profile.is_active and profile.school_id = teacher.school_id
    join public.user_roles membership on membership.user_id = profile.id and membership.school_id = teacher.school_id and membership.role = 'teacher'
    join public.teacher_subject_assignments assignment on assignment.teacher_id = teacher.id
    join public.academic_years year on year.id = assignment.academic_year_id and year.school_id = teacher.school_id
    join public.classes class on class.id = assignment.class_id and class.school_id = teacher.school_id
    join public.sections section on section.id = assignment.section_id and section.school_id = teacher.school_id and section.class_id = class.id
    join public.subjects subject on subject.id = assignment.subject_id and subject.school_id = teacher.school_id
    where teacher.id = p_teacher_id and profile.id = (select auth.uid()) and teacher.school_id = p_school_id
      and assignment.class_id = p_class_id and assignment.section_id = p_section_id and assignment.subject_id = p_subject_id
      and (p_year_id is null or assignment.academic_year_id = p_year_id)
      and (not p_write and p_year_id is not null or year.is_current)
      and (not p_write or (class.is_active and subject.is_active))
  )
  );
$function$;

commit;
