begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The canonical ledger supplies live visibility. Only a family's own read
-- receipt is stored so settlement and reopening never duplicate a reminder.
create table app_private.family_fee_due_reads (
  fee_id uuid not null references public.student_fees(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('student', 'parent')),
  read_at timestamptz not null,
  primary key (fee_id, recipient_user_id, recipient_role)
);
create index family_fee_due_reads_recipient on app_private.family_fee_due_reads(recipient_user_id, recipient_role);
alter table app_private.family_fee_due_reads enable row level security;
revoke all on table app_private.family_fee_due_reads from public, anon, authenticated, service_role;

create function app_private.eligible_family_fee_due_positions(p_role text, p_student_id uuid default null, p_fee_id uuid default null)
returns table (id uuid, student_id uuid, student_name text, fee_name text, due_date date, balance text, status text)
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
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id
    where p_role = 'student' and (p_student_id is null or student.id = p_student_id)
    union
    select student.id, actor.school_id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id
    where p_role = 'parent' and (p_student_id is null or student.id = p_student_id)
  ), school_day as (select (statement_timestamp() at time zone 'Asia/Kolkata')::date as today)
  select position.demand_id, position.student_id,
    coalesce(nullif(regexp_replace(position.student_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Student'),
    coalesce(nullif(regexp_replace(position.fee_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'School fee'),
    position.due_date, trunc(position.balance, 2)::text,
    case when position.due_date = school_day.today then 'due' else 'overdue' end
  from pupils pupil
  cross join school_day
  cross join lateral app_private.office_fee_positions(pupil.school_id, p_fee_id, pupil.id) position
  where position.student_id = pupil.id and position.invalid is false and position.status in ('pending', 'partial')
    and position.balance > 0 and position.balance < 'Infinity'::numeric
    and position.balance = trunc(position.balance, 2)
    -- The first AD day at IST midnight still falls in 1 BC in UTC.
    and position.due_date between date '0001-01-02' and school_day.today;
$$;

create function app_private.eligible_family_notifications_v6(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v5(p_role) legacy
  union all
  select fee.id, 'fee_due', fee.student_id, fee.student_name,
    fee.due_date::timestamp at time zone 'Asia/Kolkata', receipt.read_at,
    fee.due_date, fee.id, fee.status, fee.fee_name, null::uuid, null::timestamptz, false
  from app_private.eligible_family_fee_due_positions(p_role) fee
  left join app_private.family_fee_due_reads receipt on receipt.fee_id = fee.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

create function app_private.get_family_notification_inbox_v6(
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
      or p_before_kind not in ('absence', 'result_published', 'leave_decision', 'gate_arrival', 'gate_exit', 'late', 'announcement', 'homework_assigned', 'fee_due'))) then
    raise exception 'Invalid notification page.' using errcode = '22023';
  end if;
  with eligible as materialized (select * from app_private.eligible_family_notifications_v6(p_role)),
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

create function app_private.get_family_notification_unread_count_v6(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result bigint;
begin
  select count(*) into result from app_private.eligible_family_notifications_v6(p_role) where read_at is null;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.mark_family_notification_read_v6(p_role text, p_kind text, p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); marked timestamptz;
begin
  if p_kind is distinct from 'fee_due' then
    return app_private.mark_family_notification_read_v5(p_role, p_kind, p_id);
  end if;
  if p_id is null then raise exception 'Choose a valid notification.' using errcode = '22023'; end if;
  insert into app_private.family_fee_due_reads(fee_id, recipient_user_id, recipient_role, read_at)
  select fee.id, actor, p_role, statement_timestamp() from app_private.eligible_family_fee_due_positions(p_role, null, p_id) fee
  on conflict (fee_id, recipient_user_id, recipient_role) do nothing;
  select receipt.read_at into marked from app_private.family_fee_due_reads receipt
  join app_private.eligible_family_fee_due_positions(p_role, null, p_id) fee on fee.id = receipt.fee_id
  where receipt.recipient_user_id = actor and receipt.recipient_role = p_role;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return marked;
end;
$$;

create function app_private.mark_all_family_notifications_read_v6(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); previous bigint; marked bigint;
begin
  previous := app_private.mark_all_family_notifications_read_v5(p_role);
  with inserted as (
    insert into app_private.family_fee_due_reads(fee_id, recipient_user_id, recipient_role, read_at)
    select fee.id, actor, p_role, statement_timestamp() from app_private.eligible_family_fee_due_positions(p_role) fee
    where not exists (
      select 1 from app_private.family_fee_due_reads receipt where receipt.fee_id = fee.id
        and receipt.recipient_user_id = actor and receipt.recipient_role = p_role
    )
    order by fee.id
    on conflict (fee_id, recipient_user_id, recipient_role) do nothing returning fee_id
  ) select count(*) into marked from inserted;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return previous + marked;
end;
$$;

create function app_private.get_family_fee_due(p_role text, p_student_id uuid, p_fee_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_student_id is null or p_fee_id is null then raise exception 'Choose a valid pupil and fee.' using errcode = '22023'; end if;
  select to_jsonb(fee) into result from app_private.eligible_family_fee_due_positions(p_role, p_student_id, p_fee_id) fee;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.get_family_notification_inbox_v6(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_inbox_v6(p_role, p_unread_only, p_limit, p_before_created_at, p_before_kind, p_before_id); $$;
create function public.get_family_notification_unread_count_v6(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_unread_count_v6(p_role); $$;
create function public.mark_family_notification_read_v6(p_role text, p_kind text, p_id uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_family_notification_read_v6(p_role, p_kind, p_id); $$;
create function public.mark_all_family_notifications_read_v6(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_all_family_notifications_read_v6(p_role); $$;
create function public.get_family_fee_due(p_role text, p_student_id uuid, p_fee_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_fee_due(p_role, p_student_id, p_fee_id); $$;

revoke all on function app_private.eligible_family_fee_due_positions(text, uuid, uuid), app_private.eligible_family_notifications_v6(text)
  from public, anon, authenticated, service_role;
do $permissions$
declare signature text;
begin
  foreach signature in array array[
    'get_family_notification_inbox_v6(text,boolean,integer,timestamptz,text,uuid)', 'get_family_notification_unread_count_v6(text)',
    'mark_family_notification_read_v6(text,text,uuid)', 'mark_all_family_notifications_read_v6(text)', 'get_family_fee_due(text,uuid,uuid)'
  ] loop
    execute 'revoke all on function public.' || signature || ',app_private.' || signature || ' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.' || signature || ',app_private.' || signature || ' to authenticated';
  end loop;
end;
$permissions$;
notify pgrst, 'reload schema';
commit;
