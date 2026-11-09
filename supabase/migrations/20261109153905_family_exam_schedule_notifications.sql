begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Only the current schedule event is readable. A material edit replaces its
-- opaque identity and drops obsolete read receipts in the same transaction.
create table app_private.family_exam_schedule_events (
  assessment_id uuid primary key references public.teacher_assessments(id) on delete cascade,
  id uuid not null unique default gen_random_uuid(),
  school_id uuid not null,
  status text not null check (status in ('scheduled', 'rescheduled')),
  created_at timestamptz not null
);
create index family_exam_schedule_events_school on app_private.family_exam_schedule_events(school_id, assessment_id);
create table app_private.family_exam_schedule_reads (
  event_id uuid not null references app_private.family_exam_schedule_events(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('student', 'parent')),
  read_at timestamptz not null,
  primary key (event_id, recipient_user_id, recipient_role)
);
create index family_exam_schedule_reads_recipient on app_private.family_exam_schedule_reads(recipient_user_id, recipient_role);
alter table app_private.family_exam_schedule_events enable row level security;
alter table app_private.family_exam_schedule_reads enable row level security;
revoke all on table app_private.family_exam_schedule_events, app_private.family_exam_schedule_reads
  from public, anon, authenticated, service_role;

create function app_private.record_family_exam_schedule()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare event_status text := 'scheduled';
begin
  if new.status <> 'scheduled' then
    if tg_op = 'UPDATE' and old.status = 'scheduled' then
      delete from app_private.family_exam_schedule_events where assessment_id = new.id;
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'scheduled' then
    if (new.assessment_date, btrim(new.name), nullif(btrim(new.description), ''), new.subject_id,
      new.class_id, new.section_id, new.academic_year_id) is not distinct from
      (old.assessment_date, btrim(old.name), nullif(btrim(old.description), ''), old.subject_id,
      old.class_id, old.section_id, old.academic_year_id) then return new; end if;
    event_status := 'rescheduled';
  end if;
  delete from app_private.family_exam_schedule_events where assessment_id = new.id;
  insert into app_private.family_exam_schedule_events(assessment_id, school_id, status, created_at)
  values (new.id, new.school_id, event_status, clock_timestamp());
  return new;
end;
$$;
create trigger record_family_exam_schedule after insert or update of status, assessment_date, name, description,
  subject_id, class_id, section_id, academic_year_id on public.teacher_assessments
for each row execute function app_private.record_family_exam_schedule();

create function app_private.eligible_family_exam_schedules(p_role text, p_assessment_id uuid default null)
returns table (id uuid, name text, assessment_date date, subject_name text, class_name text, section_name text, description text, school_id uuid)
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
    select student.id, actor.school_id from actor
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id and student.status = 'active'
    where p_role = 'student'
    union
    select student.id, actor.school_id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id and student.status = 'active'
    where p_role = 'parent'
  ), placements as materialized (
    select enrollment.academic_year_id, enrollment.class_id, enrollment.section_id
    from pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
    left join public.sections section on section.id = enrollment.section_id and section.school_id = pupil.school_id and section.class_id = enrollment.class_id
    where enrollment.section_id is null or section.id is not null
  )
  select assessment.id, regexp_replace(assessment.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), assessment.assessment_date,
    coalesce(nullif(regexp_replace(subject.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Subject'),
    coalesce(nullif(regexp_replace(class.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Class'),
    case when section.id is not null then coalesce(nullif(regexp_replace(section.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Section') end,
    nullif(btrim(assessment.description), ''), assessment.school_id
  from actor
  join public.teacher_assessments assessment on assessment.school_id = actor.school_id
  join public.teachers teacher on teacher.id = assessment.teacher_id and teacher.school_id = actor.school_id
  join public.academic_years year on year.id = assessment.academic_year_id and year.school_id = actor.school_id and year.is_current
  join public.classes class on class.id = assessment.class_id and class.school_id = actor.school_id and class.is_active
  join public.subjects subject on subject.id = assessment.subject_id and subject.school_id = actor.school_id and subject.is_active
  left join public.sections section on section.id = assessment.section_id and section.school_id = actor.school_id and section.class_id = class.id
  where (p_assessment_id is null or assessment.id = p_assessment_id) and assessment.status = 'scheduled'
    and assessment.assessment_date between (statement_timestamp() at time zone 'Asia/Kolkata')::date and date '9999-12-31'
    and assessment.assessment_date between year.start_date and year.end_date
    and (assessment.section_id is null or section.id is not null)
    and assessment.name ~ '[^[:space:]]'
    and exists (select 1 from placements placement where placement.academic_year_id = year.id and placement.class_id = class.id
      and (assessment.section_id is null or placement.section_id = section.id));
$$;

create function app_private.eligible_family_exam_schedule_events(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select event.id, 'exam_schedule', null::uuid, null::text, event.created_at, receipt.read_at,
    schedule.assessment_date, schedule.id, event.status, schedule.name, null::uuid, null::timestamptz, false
  from app_private.eligible_family_exam_schedules(p_role) schedule
  join app_private.family_exam_schedule_events event on event.assessment_id = schedule.id and event.school_id = schedule.school_id
  left join app_private.family_exam_schedule_reads receipt on receipt.event_id = event.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

create function app_private.eligible_family_notifications_v8(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v7(p_role) legacy
  union all select event.* from app_private.eligible_family_exam_schedule_events(p_role) event;
$$;

create function app_private.get_family_notification_inbox_v8(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_unread_only is null or p_limit is null or p_limit not between 1 and 50
    or num_nonnulls(p_before_created_at, p_before_kind, p_before_id) not in (0, 3)
    or (p_before_created_at is not null and (not isfinite(p_before_created_at)
      or p_before_kind not in ('absence', 'result_published', 'leave_decision', 'gate_arrival', 'gate_exit', 'late', 'announcement', 'homework_assigned', 'fee_due', 'fee_payment', 'exam_schedule'))) then
    raise exception 'Invalid notification page.' using errcode = '22023';
  end if;
  with eligible as materialized (select * from app_private.eligible_family_notifications_v8(p_role)),
  candidates as materialized (
    select * from eligible notification where (not p_unread_only or notification.read_at is null)
      and (p_before_created_at is null or (notification.created_at, notification.kind collate "C", notification.id) < (p_before_created_at, p_before_kind collate "C", p_before_id))
    order by created_at desc, kind collate "C" desc, id desc limit p_limit + 1
  ), page as materialized (select * from candidates order by created_at desc, kind collate "C" desc, id desc limit p_limit)
  select jsonb_build_object('user_id', actor, 'role', p_role,
    'notifications', coalesce((select jsonb_agg(to_jsonb(notification) order by notification.created_at desc, notification.kind collate "C" desc, notification.id desc) from page notification), '[]'::jsonb),
    'unread_count', (select count(*) from eligible where read_at is null),
    'next_cursor', case when (select count(*) from candidates) > p_limit then (
      select jsonb_build_object('created_at', notification.created_at, 'kind', notification.kind, 'id', notification.id)
      from page notification order by notification.created_at, notification.kind collate "C", notification.id limit 1
    ) else null end) into result;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.get_family_notification_unread_count_v8(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result bigint;
begin
  select count(*) into result from app_private.eligible_family_notifications_v8(p_role) where read_at is null;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.mark_family_notification_read_v8(p_role text, p_kind text, p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); marked timestamptz;
begin
  if p_kind is distinct from 'exam_schedule' then
    return app_private.mark_family_notification_read_v7(p_role, p_kind, p_id);
  end if;
  if p_id is null then raise exception 'Choose a valid notification.' using errcode = '22023'; end if;
  -- Lock the old event identity, never its assessment's possible replacement.
  perform 1 from app_private.family_exam_schedule_events event
  where event.id = p_id and exists (
    select 1 from app_private.eligible_family_exam_schedules(p_role, event.assessment_id) schedule
    where schedule.school_id = event.school_id
  ) for key share of event;
  if found then
    insert into app_private.family_exam_schedule_reads(event_id, recipient_user_id, recipient_role, read_at)
    values (p_id, actor, p_role, statement_timestamp())
    on conflict (event_id, recipient_user_id, recipient_role) do nothing;
    select receipt.read_at into marked from app_private.family_exam_schedule_reads receipt
    join app_private.family_exam_schedule_events event on event.id = receipt.event_id
    where receipt.event_id = p_id and receipt.recipient_user_id = actor and receipt.recipient_role = p_role
      and exists (
        select 1 from app_private.eligible_family_exam_schedules(p_role, event.assessment_id) schedule
        where schedule.school_id = event.school_id
      );
  end if;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return marked;
end;
$$;

create function app_private.mark_all_family_notifications_read_v8(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); previous bigint; marked bigint;
begin
  previous := app_private.mark_all_family_notifications_read_v7(p_role);
  with locked as materialized (
    select event.id from app_private.family_exam_schedule_events event
    join app_private.eligible_family_exam_schedule_events(p_role) eligible on eligible.id = event.id
    where eligible.read_at is null order by event.id for key share of event
  ), inserted as (
    insert into app_private.family_exam_schedule_reads(event_id, recipient_user_id, recipient_role, read_at)
    select id, actor, p_role, statement_timestamp() from locked order by id
    on conflict (event_id, recipient_user_id, recipient_role) do nothing returning event_id
  ) select count(*) into marked from inserted;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return previous + marked;
end;
$$;

create function app_private.get_family_exam_schedule(p_role text, p_assessment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_assessment_id is null then raise exception 'Choose a valid exam schedule.' using errcode = '22023'; end if;
  select to_jsonb(schedule) into result from (
    select id, name, assessment_date, subject_name, class_name, section_name, description
    from app_private.eligible_family_exam_schedules(p_role, p_assessment_id)
  ) schedule;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.list_family_exam_schedules(p_role text, p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_offset is null or p_offset not between 0 and 1000000 then
    raise exception 'Choose a valid exam schedule page.' using errcode = '22023';
  end if;
  with eligible as materialized (select id, name, assessment_date, subject_name, class_name, section_name, description
    from app_private.eligible_family_exam_schedules(p_role)),
  page as (select * from eligible order by assessment_date, id limit 30 offset p_offset)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(schedule) order by schedule.assessment_date, schedule.id) from page schedule), '[]'::jsonb),
    'total_count', (select count(*) from eligible)
  ) into result;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.get_family_notification_inbox_v8(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_inbox_v8(p_role, p_unread_only, p_limit, p_before_created_at, p_before_kind, p_before_id); $$;
create function public.get_family_notification_unread_count_v8(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_unread_count_v8(p_role); $$;
create function public.mark_family_notification_read_v8(p_role text, p_kind text, p_id uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_family_notification_read_v8(p_role, p_kind, p_id); $$;
create function public.mark_all_family_notifications_read_v8(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_all_family_notifications_read_v8(p_role); $$;
create function public.get_family_exam_schedule(p_role text, p_assessment_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_exam_schedule(p_role, p_assessment_id); $$;
create function public.list_family_exam_schedules(p_role text, p_offset integer default 0)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.list_family_exam_schedules(p_role, p_offset); $$;

revoke all on function app_private.record_family_exam_schedule(), app_private.eligible_family_exam_schedules(text, uuid),
  app_private.eligible_family_exam_schedule_events(text), app_private.eligible_family_notifications_v8(text)
  from public, anon, authenticated, service_role;
do $permissions$
declare signature text;
begin
  foreach signature in array array[
    'get_family_notification_inbox_v8(text,boolean,integer,timestamptz,text,uuid)', 'get_family_notification_unread_count_v8(text)',
    'mark_family_notification_read_v8(text,text,uuid)', 'mark_all_family_notifications_read_v8(text)',
    'get_family_exam_schedule(text,uuid)', 'list_family_exam_schedules(text,integer)'
  ] loop
    execute 'revoke all on function public.' || signature || ',app_private.' || signature || ' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.' || signature || ',app_private.' || signature || ' to authenticated';
  end loop;
end;
$permissions$;
notify pgrst, 'reload schema';
commit;

