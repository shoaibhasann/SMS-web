begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.family_push_jobs
  drop constraint family_push_jobs_kind_check,
  add constraint family_push_jobs_kind_check check (
    kind in ('absence', 'result_published', 'leave_decision', 'exam_schedule', 'homework_assigned', 'announcement')
  );

-- Internal dispatch must validate targets without borrowing an authenticated user's identity.
create function app_private.notice_audience_matches_school(p_school_id uuid, p_audience jsonb)
returns boolean
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  roles jsonb := p_audience->'roles';
  target_class_id uuid;
  target_section_id uuid;
  target_teacher_id uuid;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_audience = '[]'::jsonb then
    return true;
  end if;
  if jsonb_typeof(p_audience) is distinct from 'object'
     or jsonb_typeof(roles) is distinct from 'array' then
    return false;
  end if;
  if roles = '[]'::jsonb
     or not (roles <@ '["student","parent","teacher","staff"]'::jsonb)
     or (p_audience - array['roles','class_id','section_id','teacher_id']) <> '{}'::jsonb then
    return false;
  end if;

  if p_audience ? 'class_id' then
    if not coalesce(p_audience->>'class_id' ~* uuid_pattern, false) then return false; end if;
    target_class_id := (p_audience->>'class_id')::uuid;
  end if;
  if p_audience ? 'section_id' then
    if not coalesce(p_audience->>'section_id' ~* uuid_pattern, false) then return false; end if;
    target_section_id := (p_audience->>'section_id')::uuid;
  end if;
  if p_audience ? 'teacher_id' then
    if not coalesce(p_audience->>'teacher_id' ~* uuid_pattern, false) then return false; end if;
    target_teacher_id := (p_audience->>'teacher_id')::uuid;
  end if;

  if target_class_id is not null or target_section_id is not null or target_teacher_id is not null then
    if not (roles <@ '["student","parent"]'::jsonb) then return false; end if;
  end if;

  return (target_class_id is null or exists (
    select 1 from public.classes c where c.id = target_class_id and c.school_id = p_school_id
  )) and (target_section_id is null or exists (
    select 1
    from public.sections s
    join public.classes c on c.id = s.class_id and c.school_id = s.school_id
    where s.id = target_section_id and s.school_id = p_school_id
      and (target_class_id is null or s.class_id = target_class_id)
  )) and (target_teacher_id is null or (
    target_class_id is null and target_section_id is null and exists (
      select 1 from public.teachers t where t.id = target_teacher_id and t.school_id = p_school_id
    )
  ));
end;
$$;

create or replace function app_private.notice_audience_is_valid(p_school_id uuid, p_audience jsonb)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case when auth.uid() is not null
    then app_private.notice_audience_matches_school(p_school_id, p_audience)
    else false
  end;
$$;

create function app_private.family_notice_matches_placement(
  p_audience jsonb, p_role text, p_year_id uuid, p_class_id uuid, p_section_id uuid
)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select (p_audience = '[]'::jsonb or (p_audience->'roles') ? p_role)
    and (not (p_audience ? 'class_id') or lower(p_audience->>'class_id') = p_class_id::text)
    and (not (p_audience ? 'section_id') or lower(p_audience->>'section_id') = p_section_id::text)
    and (not (p_audience ? 'teacher_id') or exists (
      select 1 from public.teacher_subject_assignments assignment
      where assignment.teacher_id::text = lower(p_audience->>'teacher_id')
        and assignment.academic_year_id = p_year_id and assignment.class_id = p_class_id
        and (assignment.section_id is null or assignment.section_id = p_section_id)
    ));
$$;

create or replace function app_private.eligible_family_notice_sources(p_role text, p_notice_id uuid default null)
returns table (id uuid, title text, content text, published_at timestamptz)
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
  ), owned_pupils as materialized (
    select student.id, actor.school_id from actor
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id
    where p_role = 'student' and student.status = 'active'
    union all
    select student.id, actor.school_id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id
    where p_role = 'parent' and student.status = 'active'
  ), placement as materialized (
    select enrollment.academic_year_id, enrollment.class_id, enrollment.section_id
    from owned_pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
    join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = pupil.school_id and year.is_current
    join public.classes class on class.id = enrollment.class_id and class.school_id = pupil.school_id and class.is_active
    left join public.sections section on section.id = enrollment.section_id and section.class_id = class.id and section.school_id = pupil.school_id
    where enrollment.section_id is null or section.id is not null
  )
  select notice.id, regexp_replace(notice.title, '^[[:space:]]+|[[:space:]]+$', '', 'g'), notice.content, notice.published_at
  from actor
  join public.notices notice on notice.school_id = actor.school_id
  join app_private.family_notice_publications publication on publication.notice_id = notice.id and publication.school_id = actor.school_id
  where (p_notice_id is null or notice.id = p_notice_id)
    and isfinite(notice.published_at) and notice.published_at <= statement_timestamp()
    and (notice.expires_at is null or notice.expires_at > statement_timestamp())
    and notice.title ~ '[^[:space:]]'
    and app_private.notice_audience_is_valid(notice.school_id, notice.audience)
    and exists (
      select 1 from placement
      where app_private.family_notice_matches_placement(
        notice.audience, p_role, placement.academic_year_id, placement.class_id, placement.section_id
      )
    );
$$;

create function app_private.family_notice_push_recipients(p_notice_id uuid, p_user_id uuid, p_role text)
returns table (user_id uuid, recipient_role text, school_id uuid, expires_at timestamptz, published_at timestamptz)
language sql volatile security invoker set search_path = ''
as $$
  with event as materialized (
    select notice.school_id, notice.audience, notice.published_at,
      least(notice.published_at + interval '24 hours', notice.expires_at) as expires_at
    from app_private.family_notice_publications publication
    join public.notices notice on notice.id = publication.notice_id and notice.school_id = publication.school_id
    join public.schools school on school.id = notice.school_id and school.is_active
    where publication.notice_id = p_notice_id and isfinite(notice.published_at)
      and (p_user_id is null or notice.published_at <= statement_timestamp())
      and (notice.expires_at is null or notice.expires_at > statement_timestamp())
      and notice.title ~ '[^[:space:]]'
      and app_private.notice_audience_matches_school(notice.school_id, notice.audience)
  )
  select recipient.user_id, recipient.recipient_role, event.school_id, event.expires_at, event.published_at
  from event
  cross join lateral (
    select p_user_id as user_id, p_role as recipient_role where p_user_id is not null
    union all
    select distinct device.user_id, device.recipient_role
    from app_private.family_push_devices device
    join app_private.family_push_preferences pref
      on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
    where p_user_id is null and device.school_id = event.school_id and device.revoked_at is null
      and device.last_seen_at > statement_timestamp() - interval '90 days'
  ) recipient
  join public.profiles profile on profile.id = recipient.user_id and profile.school_id = event.school_id and profile.is_active
  join auth.users account on account.id = profile.id and not account.is_anonymous and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= statement_timestamp())
    and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
  where recipient.recipient_role in ('student', 'parent')
    and exists (
      select 1 from public.user_roles membership
      where membership.user_id = recipient.user_id and membership.school_id = event.school_id
        and membership.role::text = recipient.recipient_role
    )
    and exists (
      select 1
      from (
        select student.id from public.students student
        where recipient.recipient_role = 'student' and student.profile_id = recipient.user_id
          and student.school_id = event.school_id
        union all
        select link.student_id from public.parents guardian
        join public.student_parents link on link.parent_id = guardian.id
        where recipient.recipient_role = 'parent' and guardian.profile_id = recipient.user_id
          and guardian.school_id = event.school_id
      ) owned
      join public.students pupil on pupil.id = owned.id and pupil.school_id = event.school_id and pupil.status = 'active'
      join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
      join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = event.school_id and year.is_current
      join public.classes class on class.id = enrollment.class_id and class.school_id = event.school_id and class.is_active
      left join public.sections section on section.id = enrollment.section_id and section.class_id = class.id and section.school_id = event.school_id
      where (enrollment.section_id is null or section.id is not null)
        and app_private.family_notice_matches_placement(event.audience, recipient.recipient_role, year.id, class.id, section.id)
    );
$$;

revoke all on function app_private.notice_audience_matches_school(uuid, jsonb),
  app_private.family_notice_matches_placement(jsonb, text, uuid, uuid, uuid),
  app_private.family_notice_push_recipients(uuid, uuid, text)
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
        when 'announcement' then true
        else false
      end
      and case when p_job.kind = 'exam_schedule' then exists (
        select 1 from app_private.family_exam_schedule_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'homework_assigned' then exists (
        select 1 from app_private.family_homework_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'announcement' then exists (
        select 1 from app_private.family_notice_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
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
  elsif tg_table_name = 'family_notice_publications' then
    event_kind := 'announcement';
    source_id := new.notice_id;
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

  insert into app_private.family_push_jobs(kind, event_id, device_id, device_generation, user_id, recipient_role, school_id, expires_at, next_attempt_at)
  select event_kind, source_id, device.id, device.generation, event.user_id, event.recipient_role, event.school_id,
    event.expires_at, greatest(statement_timestamp(), event.ready_at)
  from (
    select original.user_id, original.recipient_role, original.school_id, original.event_time + interval '24 hours' as expires_at,
      statement_timestamp() as ready_at
    from app_private.family_push_event(event_kind, source_id) original
    where event_kind not in ('exam_schedule', 'homework_assigned', 'announcement')
    union all
    select exam.user_id, exam.recipient_role, exam.school_id, exam.expires_at, statement_timestamp()
    from app_private.family_exam_schedule_push_recipients(source_id, null, null) exam
    where event_kind = 'exam_schedule'
    union all
    select homework.user_id, homework.recipient_role, homework.school_id, homework.expires_at, statement_timestamp()
    from app_private.family_homework_push_recipients(source_id, null, null) homework
    where event_kind = 'homework_assigned'
    union all
    select notice.user_id, notice.recipient_role, notice.school_id, notice.expires_at, notice.published_at
    from app_private.family_notice_push_recipients(source_id, null, null) notice
    where event_kind = 'announcement'
  ) event
  join app_private.family_push_devices device on device.user_id = event.user_id and device.recipient_role = event.recipient_role
    and device.school_id = event.school_id and device.revoked_at is null
  join app_private.family_push_preferences pref on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
  join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
    and (session.not_after is null or session.not_after > statement_timestamp())
  where event.expires_at > greatest(statement_timestamp(), event.ready_at)
    and device.last_seen_at > statement_timestamp() - interval '90 days'
    and case event_kind
      when 'absence' then pref.absence
      when 'result_published' then pref.result_published
      when 'leave_decision' then pref.leave_decision
      when 'exam_schedule' then true
      when 'homework_assigned' then true
      when 'announcement' then true
      else false
    end
  on conflict (kind, event_id, device_id, device_generation) do nothing;
  return new;
end;
$$;

create trigger enqueue_native_announcement_push after insert on app_private.family_notice_publications
  for each row execute function app_private.enqueue_family_push_event();

create function app_private.update_native_announcement_push_timing()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce(isfinite(new.published_at), false) then
    update app_private.family_push_jobs set status = 'cancelled', finished_at = statement_timestamp(), result_code = 'no_longer_eligible'
    where kind = 'announcement' and event_id = new.id and status in ('queued', 'leased');
    return new;
  end if;

  if old.published_at > statement_timestamp() and new.published_at is distinct from old.published_at then
    update app_private.family_push_jobs
    set next_attempt_at = greatest(statement_timestamp(), new.published_at),
      expires_at = least(new.published_at + interval '24 hours', new.expires_at)
    where kind = 'announcement' and event_id = new.id and status = 'queued' and attempts = 0;
  end if;

  if new.expires_at is not null and new.expires_at is distinct from old.expires_at then
    update app_private.family_push_jobs set expires_at = new.expires_at
    where kind = 'announcement' and event_id = new.id and status in ('queued', 'leased')
      and expires_at > new.expires_at;
  end if;
  return new;
end;
$$;

revoke all on function app_private.update_native_announcement_push_timing() from public, anon, authenticated, service_role;
create trigger update_native_announcement_push_timing after update of published_at, expires_at on public.notices
  for each row when (old.published_at is distinct from new.published_at or old.expires_at is distinct from new.expires_at)
  execute function app_private.update_native_announcement_push_timing();

commit;
