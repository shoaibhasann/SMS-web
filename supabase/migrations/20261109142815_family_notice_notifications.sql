begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A source marker records new publications without fan-out or a historical backfill.
create table app_private.family_notice_publications (
  notice_id uuid primary key references public.notices(id) on delete cascade,
  school_id uuid not null
);
create table app_private.family_notice_reads (
  notice_id uuid not null references app_private.family_notice_publications(notice_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('student', 'parent')),
  read_at timestamptz not null,
  primary key (notice_id, recipient_user_id, recipient_role)
);
create index family_notice_publications_school on app_private.family_notice_publications(school_id, notice_id);
create index family_notice_reads_recipient on app_private.family_notice_reads(recipient_user_id, recipient_role);
alter table app_private.family_notice_publications enable row level security;
alter table app_private.family_notice_reads enable row level security;
revoke all on table app_private.family_notice_publications, app_private.family_notice_reads from public, anon, authenticated, service_role;

create function app_private.record_family_notice_publication()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if isfinite(new.published_at) and (tg_op = 'INSERT' or new.published_at is distinct from old.published_at) then
    insert into app_private.family_notice_publications(notice_id, school_id) values (new.id, new.school_id)
    on conflict (notice_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger record_family_notice_publication after insert or update of published_at on public.notices
for each row execute function app_private.record_family_notice_publication();

-- The existing audience validator checks school-owned targets and JSON shape.
-- The selected family role must independently qualify through its own pupils.
create function app_private.eligible_family_notice_sources(p_role text, p_notice_id uuid default null)
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
    and (notice.audience = '[]'::jsonb or (notice.audience->'roles') ? p_role)
    and exists (
      select 1 from placement
      where (not (notice.audience ? 'class_id') or lower(notice.audience->>'class_id') = placement.class_id::text)
        and (not (notice.audience ? 'section_id') or lower(notice.audience->>'section_id') = placement.section_id::text)
        and (not (notice.audience ? 'teacher_id') or exists (
          select 1 from public.teacher_subject_assignments assignment
          where assignment.teacher_id::text = lower(notice.audience->>'teacher_id')
            and assignment.academic_year_id = placement.academic_year_id and assignment.class_id = placement.class_id
            and (assignment.section_id is null or assignment.section_id = placement.section_id)
        ))
    );
$$;

create function app_private.eligible_family_notifications_v4(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v3(p_role) legacy
  union all
  select notice.id, 'announcement', null::uuid, null::text, notice.published_at, receipt.read_at,
    (notice.published_at at time zone 'Asia/Kolkata')::date, notice.id, 'published', notice.title, null::uuid, null::timestamptz, false
  from app_private.eligible_family_notice_sources(p_role) notice
  left join app_private.family_notice_reads receipt on receipt.notice_id = notice.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

create function app_private.get_family_notification_inbox_v4(
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
      or p_before_kind not in ('absence', 'result_published', 'leave_decision', 'gate_arrival', 'gate_exit', 'late', 'announcement'))) then
    raise exception 'Invalid notification page.' using errcode = '22023';
  end if;
  with eligible as materialized (select * from app_private.eligible_family_notifications_v4(p_role)),
  candidates as materialized (
    select * from eligible notice where (not p_unread_only or notice.read_at is null)
      and (p_before_created_at is null or (notice.created_at, notice.kind collate "C", notice.id) < (p_before_created_at, p_before_kind collate "C", p_before_id))
    order by created_at desc, kind collate "C" desc, id desc limit p_limit + 1
  ), page as materialized (select * from candidates order by created_at desc, kind collate "C" desc, id desc limit p_limit)
  select jsonb_build_object('user_id', actor, 'role', p_role,
    'notifications', coalesce((select jsonb_agg(to_jsonb(notice) order by notice.created_at desc, notice.kind collate "C" desc, notice.id desc) from page notice), '[]'::jsonb),
    'unread_count', (select count(*) from eligible where read_at is null),
    'next_cursor', case when (select count(*) from candidates) > p_limit then (
      select jsonb_build_object('created_at', notice.created_at, 'kind', notice.kind, 'id', notice.id)
      from page notice order by notice.created_at, notice.kind collate "C", notice.id limit 1
    ) else null end) into result;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.get_family_notification_unread_count_v4(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result bigint;
begin
  select count(*) into result from app_private.eligible_family_notifications_v4(p_role) where read_at is null;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.mark_family_notification_read_v4(p_role text, p_kind text, p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); marked timestamptz;
begin
  if p_kind is distinct from 'announcement' then
    return app_private.mark_family_notification_read_v3(p_role, p_kind, p_id);
  end if;
  if p_id is null then raise exception 'Choose a valid notification.' using errcode = '22023'; end if;
  insert into app_private.family_notice_reads(notice_id, recipient_user_id, recipient_role, read_at)
  select notice.id, actor, p_role, statement_timestamp() from app_private.eligible_family_notice_sources(p_role, p_id) notice
  on conflict (notice_id, recipient_user_id, recipient_role) do nothing;
  select receipt.read_at into marked from app_private.family_notice_reads receipt
  join app_private.eligible_family_notice_sources(p_role, p_id) notice on notice.id = receipt.notice_id
  where receipt.recipient_user_id = actor and receipt.recipient_role = p_role;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return marked;
end;
$$;

create function app_private.mark_all_family_notifications_read_v4(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); previous bigint; marked bigint;
begin
  previous := app_private.mark_all_family_notifications_read_v3(p_role);
  with inserted as (
    insert into app_private.family_notice_reads(notice_id, recipient_user_id, recipient_role, read_at)
    select notice.id, actor, p_role, statement_timestamp() from app_private.eligible_family_notice_sources(p_role) notice
    where not exists (
      select 1 from app_private.family_notice_reads receipt where receipt.notice_id = notice.id
        and receipt.recipient_user_id = actor and receipt.recipient_role = p_role
    )
    order by notice.id
    on conflict (notice_id, recipient_user_id, recipient_role) do nothing returning notice_id
  ) select count(*) into marked from inserted;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return previous + marked;
end;
$$;

create function app_private.get_family_announcement(p_role text, p_notice_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_notice_id is null then raise exception 'Choose a valid announcement.' using errcode = '22023'; end if;
  select to_jsonb(notice) into result from app_private.eligible_family_notice_sources(p_role, p_notice_id) notice;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.get_family_notification_inbox_v4(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_inbox_v4(p_role, p_unread_only, p_limit, p_before_created_at, p_before_kind, p_before_id); $$;
create function public.get_family_notification_unread_count_v4(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_unread_count_v4(p_role); $$;
create function public.mark_family_notification_read_v4(p_role text, p_kind text, p_id uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_family_notification_read_v4(p_role, p_kind, p_id); $$;
create function public.mark_all_family_notifications_read_v4(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_all_family_notifications_read_v4(p_role); $$;
create function public.get_family_announcement(p_role text, p_notice_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_announcement(p_role, p_notice_id); $$;

revoke all on function app_private.record_family_notice_publication(), app_private.eligible_family_notice_sources(text, uuid),
  app_private.eligible_family_notifications_v4(text) from public, anon, authenticated, service_role;
do $permissions$
declare signature text;
begin
  foreach signature in array array[
    'get_family_notification_inbox_v4(text,boolean,integer,timestamptz,text,uuid)', 'get_family_notification_unread_count_v4(text)',
    'mark_family_notification_read_v4(text,text,uuid)', 'mark_all_family_notifications_read_v4(text)', 'get_family_announcement(text,uuid)'
  ] loop
    execute 'revoke all on function public.' || signature || ',app_private.' || signature || ' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.' || signature || ',app_private.' || signature || ' to authenticated';
  end loop;
end;
$permissions$;
notify pgrst, 'reload schema';
commit;
