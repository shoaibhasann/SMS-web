begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.family_push_jobs
  drop constraint family_push_jobs_kind_check,
  add constraint family_push_jobs_kind_check check (
    kind in ('absence', 'result_published', 'leave_decision', 'exam_schedule', 'homework_assigned')
  );

-- Use the current homework cohort and verified family memberships without impersonating the recipient.
create function app_private.family_homework_push_recipients(p_activity_id uuid, p_user_id uuid, p_role text)
returns table (user_id uuid, recipient_role text, school_id uuid, expires_at timestamptz)
language sql volatile security invoker set search_path = ''
as $$
  select distinct recipient.recipient_user_id, recipient.recipient_role, publication.school_id,
    publication.published_at + interval '24 hours'
  from app_private.family_homework_publications publication
  join public.schools school on school.id = publication.school_id and school.is_active
  join public.class_activities activity on activity.id = publication.activity_id and activity.class_log_id = publication.class_log_id
  join public.class_logs log on log.id = publication.class_log_id and log.school_id = publication.school_id
  join public.academic_years year on year.id = log.academic_year_id and year.school_id = log.school_id and year.is_current
  join public.classes class on class.id = log.class_id and class.school_id = log.school_id
  join public.sections section on section.id = log.section_id and section.school_id = log.school_id and section.class_id = class.id
  join public.subjects subject on subject.id = log.subject_id and subject.school_id = log.school_id
  join public.enrollments enrollment on enrollment.academic_year_id = year.id and enrollment.class_id = class.id
    and enrollment.section_id = section.id and enrollment.status = 'active'
  join public.students pupil on pupil.id = enrollment.student_id and pupil.school_id = school.id and pupil.status = 'active'
  cross join lateral app_private.family_notification_recipients(school.id, pupil.id) recipient
  where publication.activity_id = p_activity_id and log.status = 'published'
    and activity.activity_type = 'homework' and activity.title ~ '[^[:space:]]'
    -- The publishing trigger stamps the marker during the outer save statement.
    and publication.published_at <= clock_timestamp()
    and (p_user_id is null or (recipient.recipient_user_id = p_user_id and recipient.recipient_role = p_role));
$$;

revoke all on function app_private.family_homework_push_recipients(uuid, uuid, text)
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
        when 'homework_assigned' then true
        else false
      end
      and case when p_job.kind = 'exam_schedule' then exists (
        select 1 from app_private.family_exam_schedule_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'homework_assigned' then exists (
        select 1 from app_private.family_homework_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
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
declare event_kind text; source_id uuid;
begin
  if tg_table_name = 'family_homework_publications' then
    event_kind := 'homework_assigned';
    source_id := new.activity_id;
  else
    source_id := new.id;
    if tg_table_name = 'guardian_absence_alerts' then
      event_kind := 'absence';
    elsif tg_table_name = 'family_exam_schedule_events' then
      event_kind := 'exam_schedule';
    else
      event_kind := new.kind;
    end if;
  end if;

  insert into app_private.family_push_jobs(kind, event_id, device_id, device_generation, user_id, recipient_role, school_id, expires_at)
  select event_kind, source_id, device.id, device.generation, event.user_id, event.recipient_role, event.school_id, event.expires_at
  from (
    select original.user_id, original.recipient_role, original.school_id, original.event_time + interval '24 hours' as expires_at
    from app_private.family_push_event(event_kind, source_id) original
    where event_kind not in ('exam_schedule', 'homework_assigned')
    union all
    select exam.user_id, exam.recipient_role, exam.school_id, exam.expires_at
    from app_private.family_exam_schedule_push_recipients(source_id, null, null) exam
    where event_kind = 'exam_schedule'
    union all
    select homework.user_id, homework.recipient_role, homework.school_id, homework.expires_at
    from app_private.family_homework_push_recipients(source_id, null, null) homework
    where event_kind = 'homework_assigned'
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
      when 'homework_assigned' then true
      else false
    end
  on conflict (kind, event_id, device_id, device_generation) do nothing;
  return new;
end;
$$;

create trigger enqueue_native_homework_push after insert on app_private.family_homework_publications
  for each row execute function app_private.enqueue_family_push_event();

commit;
