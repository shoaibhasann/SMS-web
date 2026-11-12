-- After a mid-term handover the teacher who now holds the class/section/subject
-- assignment must be able to read and grade the earlier teacher's PUBLISHED
-- homework. Authoring, editing and deleting a log stay with its author, drafts
-- stay private, and a teacher whose assignment was removed stays cut off.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Every caller-teacher lookup below filters teachers by profile_id.
create index teachers_profile_id_idx on public.teachers (profile_id);

-- teachers.profile_id is not unique, so match any of the caller's teacher rows.
create function app_private.caller_teacher_academic_scope(
  p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_subject_id uuid, p_write boolean default false
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teachers caller
    where caller.profile_id = (select auth.uid()) and caller.school_id = p_school_id
      and app_private.teacher_academic_scope(caller.id, p_school_id, p_year_id, p_class_id, p_section_id, p_subject_id, p_write));
$$;
revoke all on function app_private.caller_teacher_academic_scope(uuid, uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function app_private.caller_teacher_academic_scope(uuid, uuid, uuid, uuid, uuid, boolean) to authenticated;

-- The caller's own teacher row that holds the scope now, else the log author
-- (which keeps the existing 42501 from lock_academic_write_scope).
create function app_private.current_scope_teacher_id(
  p_fallback uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_subject_id uuid
) returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select caller.id from public.teachers caller
    where caller.profile_id = (select auth.uid()) and caller.school_id = p_school_id
      and app_private.teacher_academic_scope(caller.id, p_school_id, p_year_id, p_class_id, p_section_id, p_subject_id, true)
    order by caller.id limit 1), p_fallback);
$$;
revoke all on function app_private.current_scope_teacher_id(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app_private.teacher_academic_activity(p_activity_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    where activity.id=p_activity_id and (
      app_private.teacher_academic_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,p_write)
      or (log.status='published' and app_private.caller_teacher_academic_scope(log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,p_write))));
$$;

-- Same successor read as the policy below, for any caller still gated by it.
create or replace function app_private.can_read_academic_log(p_log_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_logs log where log.id=p_log_id and (
    app_private.academic_office_read(log.school_id)
    or app_private.teacher_academic_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,false)
    or (log.status='published' and app_private.caller_teacher_academic_scope(log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,false))
    or (log.status='published' and app_private.academic_family_scope(log.school_id,log.academic_year_id,log.class_id,log.section_id))));
$$;

create or replace function app_private.grade_homework(p_submission_id uuid,p_marks numeric,p_feedback text,p_expected_revision bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare submission public.activity_submissions%rowtype; activity public.class_activities%rowtype; log public.class_logs%rowtype;
  receipt app_private.homework_write_receipts%rowtype; note text:=nullif(btrim(p_feedback,E' \t\n\r'),''); payload jsonb; result jsonb;
begin
  if auth.uid() is null or p_request_id is null then raise exception 'Sign in with a teacher account and a request identifier.' using errcode='42501'; end if;
  select * into submission from public.activity_submissions where id=p_submission_id;
  if not found or not app_private.homework_teacher_scope(submission.activity_id,false)
    or not app_private.teacher_academic_submission(submission.activity_id,submission.student_id,false) then
    raise exception 'This pupil submission is unavailable to its assigned teacher.' using errcode='42501'; end if;
  payload:=jsonb_build_object('submission_id',p_submission_id,'marks',p_marks,'feedback',note,'expected_revision',p_expected_revision);
  perform pg_advisory_xact_lock(hashtextextended('homework-request:'||p_request_id::text,0));
  select * into receipt from app_private.homework_write_receipts where request_id=p_request_id;
  if found then
    if (receipt.actor_id,receipt.action,receipt.payload) is distinct from (auth.uid(),'grade'::text,payload) then
      raise exception 'This request identifier belongs to another action.' using errcode='23505'; end if;
    return receipt.result;
  end if;
  select * into activity from public.class_activities where id=submission.activity_id;
  select * into log from public.class_logs where id=activity.class_log_id for share;
  select * into activity from public.class_activities where id=submission.activity_id and class_log_id=log.id for share;
  if not found or not app_private.homework_teacher_scope(activity.id,true) then
    raise exception 'Current assigned teacher access is required to grade homework.' using errcode='42501'; end if;
  perform app_private.lock_academic_write_scope(app_private.current_scope_teacher_id(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id),
    log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
  select * into submission from public.activity_submissions where id=p_submission_id for update;
  if not found or p_expected_revision is null or p_expected_revision<>submission.revision then
    raise exception 'The response or grade changed. Reload before grading.' using errcode='PT409'; end if;
  if not app_private.teacher_academic_submission(submission.activity_id,submission.student_id,true) then
    raise exception 'The pupil is outside this teacher homework scope.' using errcode='42501'; end if;
  if p_marks is null and note is null or char_length(coalesce(note,''))>2000 or
    (p_marks is not null and (p_marks<0 or p_marks::text in ('NaN','Infinity','-Infinity') or activity.max_marks is null or p_marks>activity.max_marks)) then
    raise exception 'Enter feedback or finite marks within a configured maximum.' using errcode='22023'; end if;
  update public.activity_submissions set marks=p_marks,feedback=note,status='graded' where id=submission.id returning * into submission;
  result:=jsonb_build_object('id',submission.id,'revision',submission.revision,'status',submission.status);
  insert into app_private.homework_write_receipts(request_id,actor_id,action,payload,result) values(p_request_id,auth.uid(),'grade',payload,result);
  return result;
end;
$$;

create or replace function app_private.guard_academic_submission_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare activity public.class_activities%rowtype; log public.class_logs%rowtype; item public.activity_submissions%rowtype;
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and (new.id,new.activity_id,new.student_id) is distinct from (old.id,old.activity_id,old.student_id) then
    raise exception 'A submission cannot be reassigned.' using errcode='42501';
  end if;
  if tg_op='DELETE' then item:=old; else item:=new; end if;
  select * into activity from public.class_activities where id=item.activity_id;
  select * into log from public.class_logs where id=activity.class_log_id for share;
  select * into activity from public.class_activities where id=item.activity_id and class_log_id=log.id for share;
  if not found then raise exception 'The homework activity is unavailable.' using errcode='42501'; end if;
  if not app_private.academic_submission_cohort(item.activity_id,item.student_id) then
    raise exception 'The pupil is outside this academic scope.' using errcode='42501';
  end if;
  if app_private.academic_manager(log.school_id) then
    perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
  elsif app_private.student_academic_submission(item.activity_id,item.student_id,true) then
    if tg_op='DELETE' then raise exception 'Submission history must be preserved.' using errcode='42501'; end if;
    if new.marks is not null or new.feedback is not null or new.status not in ('pending','submitted')
      or (tg_op='UPDATE' and (old.marks is not null or old.feedback is not null or old.status not in ('pending','submitted'))) then
      raise exception 'A pupil cannot set grades or overwrite reviewed work.' using errcode='42501';
    end if;
    perform 1 from public.students student
    join public.profiles profile on profile.id=student.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='student'
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=log.academic_year_id
      and enrollment.class_id=log.class_id and (log.section_id is null or enrollment.section_id=log.section_id) and enrollment.status='active'
    join public.academic_years year on year.id=enrollment.academic_year_id and year.school_id=log.school_id and year.is_current
    where student.id=new.student_id and profile.id=auth.uid() and log.status='published'
    for share of student, profile, membership, enrollment, year;
    if not found then raise exception 'The pupil homework access changed.' using errcode='42501'; end if;
    new.status:='submitted'; new.submitted_at:=clock_timestamp(); return new;
  else
    if tg_op<>'UPDATE' then raise exception 'Only the pupil may submit work.' using errcode='42501'; end if;
    perform app_private.lock_academic_write_scope(app_private.current_scope_teacher_id(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id),
      log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
    if (new.text_response,new.file_url,new.submitted_at) is distinct from (old.text_response,old.file_url,old.submitted_at) then
      raise exception 'A teacher cannot change a pupil response.' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.status not in ('pending','submitted','graded','returned') or (new.marks is not null and
    (new.marks<0 or new.marks::text in ('NaN','Infinity','-Infinity') or new.marks>activity.max_marks)) then
    raise exception 'Choose valid feedback, status and marks within the activity maximum.' using errcode='22023';
  end if;
  return new;
end;
$$;

-- Read-only: activities inherit log visibility, and the teacher insert/update/
-- delete policies on class_logs still require the author's own assignment.
-- The initPlan gate keeps office and family reads from a per-row definer call.
create policy academic_logs_assigned_teacher_read on public.class_logs for select to authenticated
using ((select app_private.current_teacher_id()) is not null and status = 'published'
  and app_private.caller_teacher_academic_scope(school_id, academic_year_id, class_id, section_id, subject_id, false));

commit;
