begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Refresh the activity after waiting for its parent lock. Validation must use
-- the locked version, including any concurrently changed maximum marks.
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
    perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
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
commit;
