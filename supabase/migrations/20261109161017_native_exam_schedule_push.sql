begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.family_push_jobs
  drop constraint family_push_jobs_kind_check,
  add constraint family_push_jobs_kind_check check (kind in ('absence', 'result_published', 'leave_decision', 'exam_schedule'));

create function app_private.family_exam_schedule_push_recipients(p_event_id uuid, p_user_id uuid, p_role text)
returns table (user_id uuid, recipient_role text, school_id uuid, expires_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  select distinct recipient.recipient_user_id, recipient.recipient_role, event.school_id,
    least(event.created_at + interval '24 hours', (assessment.assessment_date + 1)::timestamp at time zone 'Asia/Kolkata')
  from app_private.family_exam_schedule_events event
  join public.schools school on school.id = event.school_id and school.is_active
  join public.teacher_assessments assessment on assessment.id = event.assessment_id and assessment.school_id = school.id
  join public.teachers teacher on teacher.id = assessment.teacher_id and teacher.school_id = school.id
  join public.academic_years year on year.id = assessment.academic_year_id and year.school_id = school.id and year.is_current
  join public.classes class on class.id = assessment.class_id and class.school_id = school.id and class.is_active
  join public.subjects subject on subject.id = assessment.subject_id and subject.school_id = school.id and subject.is_active
  join public.enrollments enrollment on enrollment.academic_year_id = year.id and enrollment.class_id = class.id
    and enrollment.status = 'active' and (assessment.section_id is null or enrollment.section_id = assessment.section_id)
  join public.students pupil on pupil.id = enrollment.student_id and pupil.school_id = school.id and pupil.status = 'active'
  left join public.sections section on section.id = enrollment.section_id and section.school_id = school.id and section.class_id = class.id
  cross join lateral app_private.family_notification_recipients(school.id, pupil.id) recipient
  where event.id = p_event_id and assessment.status = 'scheduled' and assessment.name ~ '[^[:space:]]'
    and assessment.assessment_date between (statement_timestamp() at time zone 'Asia/Kolkata')::date and date '9999-12-31'
    and assessment.assessment_date between year.start_date and year.end_date
    and (enrollment.section_id is null or section.id is not null)
    and (p_user_id is null or (
      recipient.recipient_user_id = p_user_id and recipient.recipient_role = p_role
      and (
        (p_role = 'student' and pupil.profile_id = p_user_id)
        or (p_role = 'parent' and exists (
          select 1 from public.student_parents link
          join public.parents guardian on guardian.id = link.parent_id and guardian.school_id = school.id
          where link.student_id = pupil.id and guardian.profile_id = p_user_id
        ))
      )
    ));
$$;

revoke all on function app_private.family_exam_schedule_push_recipients(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function app_private.family_push_job_eligible(p_job app_private.family_push_jobs)
returns boolean language sql volatile security invoker set search_path = ''
as $$
  select p_job.expires_at > statement_timestamp() and exists (
    select 1 from app_private.family_push_devices device
    join app_private.family_push_preferences pref on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
    join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
      and (session.not_after is null or session.not_after > statement_timestamp())
    join public.profiles profile on profile.id = device.user_id and profile.school_id = device.school_id and profile.is_active
    where device.id = p_job.device_id and device.generation = p_job.device_generation and device.user_id = p_job.user_id
      and device.recipient_role = p_job.recipient_role and device.school_id = p_job.school_id and device.revoked_at is null
      and device.last_seen_at > statement_timestamp() - interval '90 days'
      and case p_job.kind
        when 'absence' then pref.absence
        when 'result_published' then pref.result_published
        when 'leave_decision' then pref.leave_decision
        when 'exam_schedule' then true
        else false
      end
      and case when p_job.kind = 'exam_schedule' then exists (
        select 1 from app_private.family_exam_schedule_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) else exists (
        select 1 from app_private.family_push_event(p_job.kind, p_job.event_id) event
        where event.user_id = device.user_id and event.recipient_role = device.recipient_role and event.school_id = device.school_id
      ) end
  );
$$;

create or replace function app_private.enqueue_family_push_event()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare event_kind text;
begin
  if tg_table_name = 'guardian_absence_alerts' then
    event_kind := 'absence';
  elsif tg_table_name = 'family_exam_schedule_events' then
    event_kind := 'exam_schedule';
  else
    event_kind := new.kind;
  end if;

  insert into app_private.family_push_jobs(kind, event_id, device_id, device_generation, user_id, recipient_role, school_id, expires_at)
  select event_kind, new.id, device.id, device.generation, event.user_id, event.recipient_role, event.school_id, event.expires_at
  from (
    select original.user_id, original.recipient_role, original.school_id, original.event_time + interval '24 hours' as expires_at
    from app_private.family_push_event(event_kind, new.id) original
    where event_kind <> 'exam_schedule'
    union all
    select exam.user_id, exam.recipient_role, exam.school_id, exam.expires_at
    from app_private.family_exam_schedule_push_recipients(new.id, null, null) exam
    where event_kind = 'exam_schedule'
  ) event
  join app_private.family_push_devices device on device.user_id = event.user_id and device.recipient_role = event.recipient_role
    and device.school_id = event.school_id and device.revoked_at is null
  join app_private.family_push_preferences pref on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
  join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
    and (session.not_after is null or session.not_after > statement_timestamp())
  where event.expires_at > statement_timestamp()
    and device.last_seen_at > statement_timestamp() - interval '90 days'
    and case event_kind
      when 'absence' then pref.absence
      when 'result_published' then pref.result_published
      when 'leave_decision' then pref.leave_decision
      when 'exam_schedule' then true
      else false
    end
  on conflict (kind, event_id, device_id, device_generation) do nothing;
  return new;
end;
$$;

create trigger enqueue_native_exam_schedule_push after insert on app_private.family_exam_schedule_events
  for each row execute function app_private.enqueue_family_push_event();

commit;
