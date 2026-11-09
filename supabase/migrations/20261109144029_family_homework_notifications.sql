begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Keep a single effective publication per homework activity without copying
-- academic content or generating historical rows for existing published work.
create table app_private.family_homework_publications (
  activity_id uuid primary key references public.class_activities(id) on delete cascade,
  class_log_id uuid not null,
  school_id uuid not null,
  published_at timestamptz not null check (isfinite(published_at))
);
create table app_private.family_homework_reads (
  activity_id uuid not null references app_private.family_homework_publications(activity_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('student', 'parent')),
  read_at timestamptz not null,
  primary key (activity_id, recipient_user_id, recipient_role)
);
create index family_homework_publications_school on app_private.family_homework_publications(school_id, activity_id);
create index family_homework_reads_recipient on app_private.family_homework_reads(recipient_user_id, recipient_role);
alter table app_private.family_homework_publications enable row level security;
alter table app_private.family_homework_reads enable row level security;
revoke all on table app_private.family_homework_publications, app_private.family_homework_reads from public, anon, authenticated, service_role;

create function app_private.record_published_log_homework()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into app_private.family_homework_publications(activity_id, class_log_id, school_id, published_at)
  select activity.id, new.id, new.school_id,
    case when isfinite(new.published_at) then new.published_at else statement_timestamp() end
  from public.class_activities activity where activity.class_log_id = new.id and activity.activity_type = 'homework'
  order by activity.id
  on conflict (activity_id) do nothing;
  return new;
end;
$$;
create trigger record_published_log_homework after update of status on public.class_logs
for each row when (old.status is distinct from 'published' and new.status = 'published')
execute function app_private.record_published_log_homework();

create function app_private.record_new_published_homework()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.activity_type <> 'homework' or (tg_op = 'UPDATE' and (
    old.activity_type = 'homework' or new.class_log_id is distinct from old.class_log_id
  )) then return new; end if;
  insert into app_private.family_homework_publications(activity_id, class_log_id, school_id, published_at)
  select new.id, log.id, log.school_id, greatest(log.published_at, statement_timestamp())
  from public.class_logs log where log.id = new.class_log_id and log.status = 'published'
    and (log.published_at is null or isfinite(log.published_at))
  on conflict (activity_id) do nothing;
  return new;
end;
$$;
create trigger record_new_published_homework after insert or update of activity_type on public.class_activities
for each row execute function app_private.record_new_published_homework();

-- The same academic predicates that protect a pupil's own homework and a
-- guardian's linked child also authorize notification metadata and details.
create function app_private.eligible_family_homework_sources(p_role text, p_activity_id uuid default null)
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
  )
  select activity.id, regexp_replace(activity.title, '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    activity.description, activity.due_date, publication.published_at,
    log.school_id, log.academic_year_id, log.class_id, log.section_id, log.subject_id,
    case when p_role = 'student' then authorized.student_id end, activity.max_marks
  from actor
  join app_private.family_homework_publications publication on publication.school_id = actor.school_id
  join public.class_activities activity on activity.id = publication.activity_id and activity.class_log_id = publication.class_log_id
  join public.class_logs log on log.id = publication.class_log_id and log.school_id = publication.school_id
  join public.academic_years year on year.id = log.academic_year_id and year.school_id = log.school_id and year.is_current
  join public.sections section on section.id = log.section_id and section.school_id = log.school_id and section.class_id = log.class_id
  join public.subjects subject on subject.id = log.subject_id and subject.school_id = log.school_id
  cross join lateral (
    select pupil.id as student_id from pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.academic_year_id = log.academic_year_id
      and enrollment.class_id = log.class_id and enrollment.section_id = section.id and enrollment.status = 'active'
    where case when p_role = 'student' then app_private.homework_student_scope(activity.id, pupil.id, false)
      else app_private.guardian_academic_submission(activity.id, pupil.id) end
    order by pupil.id limit 1
  ) authorized
  where (p_activity_id is null or activity.id = p_activity_id)
    and activity.activity_type = 'homework' and log.status = 'published'
    and publication.published_at <= statement_timestamp()
    and activity.title ~ '[^[:space:]]';
$$;

create function app_private.eligible_family_notifications_v5(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v4(p_role) legacy
  union all
  select homework.id, 'homework_assigned', null::uuid, null::text, homework.created_at, receipt.read_at,
    (homework.created_at at time zone 'Asia/Kolkata')::date, homework.id, 'published', homework.title, null::uuid, null::timestamptz, false
  from app_private.eligible_family_homework_sources(p_role) homework
  left join app_private.family_homework_reads receipt on receipt.activity_id = homework.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

create function app_private.get_family_notification_inbox_v5(
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
      or p_before_kind not in ('absence', 'result_published', 'leave_decision', 'gate_arrival', 'gate_exit', 'late', 'announcement', 'homework_assigned'))) then
    raise exception 'Invalid notification page.' using errcode = '22023';
  end if;
  with eligible as materialized (select * from app_private.eligible_family_notifications_v5(p_role)),
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

create function app_private.get_family_notification_unread_count_v5(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result bigint;
begin
  select count(*) into result from app_private.eligible_family_notifications_v5(p_role) where read_at is null;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.mark_family_notification_read_v5(p_role text, p_kind text, p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); marked timestamptz;
begin
  if p_kind is distinct from 'homework_assigned' then
    return app_private.mark_family_notification_read_v4(p_role, p_kind, p_id);
  end if;
  if p_id is null then raise exception 'Choose a valid notification.' using errcode = '22023'; end if;
  insert into app_private.family_homework_reads(activity_id, recipient_user_id, recipient_role, read_at)
  select homework.id, actor, p_role, statement_timestamp() from app_private.eligible_family_homework_sources(p_role, p_id) homework
  on conflict (activity_id, recipient_user_id, recipient_role) do nothing;
  select receipt.read_at into marked from app_private.family_homework_reads receipt
  join app_private.eligible_family_homework_sources(p_role, p_id) homework on homework.id = receipt.activity_id
  where receipt.recipient_user_id = actor and receipt.recipient_role = p_role;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return marked;
end;
$$;

create function app_private.mark_all_family_notifications_read_v5(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); previous bigint; marked bigint;
begin
  previous := app_private.mark_all_family_notifications_read_v4(p_role);
  with inserted as (
    insert into app_private.family_homework_reads(activity_id, recipient_user_id, recipient_role, read_at)
    select homework.id, actor, p_role, statement_timestamp() from app_private.eligible_family_homework_sources(p_role) homework
    where not exists (
      select 1 from app_private.family_homework_reads receipt where receipt.activity_id = homework.id
        and receipt.recipient_user_id = actor and receipt.recipient_role = p_role
    )
    order by homework.id
    on conflict (activity_id, recipient_user_id, recipient_role) do nothing returning activity_id
  ) select count(*) into marked from inserted;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return previous + marked;
end;
$$;

create function app_private.get_family_homework(p_role text, p_activity_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_activity_id is null then raise exception 'Choose valid homework.' using errcode = '22023'; end if;
  select to_jsonb(homework) into result from app_private.eligible_family_homework_sources(p_role, p_activity_id) homework;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.get_family_notification_inbox_v5(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_inbox_v5(p_role, p_unread_only, p_limit, p_before_created_at, p_before_kind, p_before_id); $$;
create function public.get_family_notification_unread_count_v5(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_unread_count_v5(p_role); $$;
create function public.mark_family_notification_read_v5(p_role text, p_kind text, p_id uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_family_notification_read_v5(p_role, p_kind, p_id); $$;
create function public.mark_all_family_notifications_read_v5(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_all_family_notifications_read_v5(p_role); $$;
create function public.get_family_homework(p_role text, p_activity_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_homework(p_role, p_activity_id); $$;

revoke all on function app_private.record_published_log_homework(), app_private.record_new_published_homework(),
  app_private.eligible_family_homework_sources(text, uuid), app_private.eligible_family_notifications_v5(text)
  from public, anon, authenticated, service_role;
do $permissions$
declare signature text;
begin
  foreach signature in array array[
    'get_family_notification_inbox_v5(text,boolean,integer,timestamptz,text,uuid)', 'get_family_notification_unread_count_v5(text)',
    'mark_family_notification_read_v5(text,text,uuid)', 'mark_all_family_notifications_read_v5(text)', 'get_family_homework(text,uuid)'
  ] loop
    execute 'revoke all on function public.' || signature || ',app_private.' || signature || ' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.' || signature || ',app_private.' || signature || ' to authenticated';
  end loop;
end;
$permissions$;
notify pgrst, 'reload schema';
commit;
