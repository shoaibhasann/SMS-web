begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Absence alerts stay in their original table, with their IDs and read timestamps.
-- This table contains only recipients who were eligible when a new decision committed.
create table app_private.family_notifications(
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in('result_published','leave_decision')),
  source_id uuid not null,
  school_id uuid not null references public.schools(id),
  student_id uuid not null references public.students(id),
  recipient_user_id uuid not null references public.profiles(id),
  recipient_role text not null check(recipient_role in('student','parent')),
  created_at timestamptz not null,
  read_at timestamptz,
  unique(kind,source_id,student_id,recipient_user_id,recipient_role)
);
alter table app_private.family_notifications enable row level security;
revoke all on table app_private.family_notifications from public,anon,authenticated,service_role;
create index family_notifications_recipient_time on app_private.family_notifications
  (recipient_user_id,recipient_role,created_at desc,kind collate "C" desc,id desc);
create index family_notifications_school on app_private.family_notifications(school_id);
create index family_notifications_student on app_private.family_notifications(student_id);
create index family_notifications_source on app_private.family_notifications(kind,source_id);

create function app_private.family_notification_actor(p_role text)
returns uuid language plpgsql security definer set search_path=''
as $$
declare actor uuid;
begin
  if p_role is null or p_role not in('parent','student') then
    raise exception 'Choose a valid family role.' using errcode='22023';
  end if;
  actor:=app_private.guardian_hybrid_actor();
  perform 1 from public.profiles p join public.user_roles r on r.user_id=p.id and r.school_id=p.school_id
    join public.schools s on s.id=p.school_id
    where p.id=actor and p.is_active and r.role=p_role::public.app_role for share of p,r;
  if not found then raise exception 'Current family school access is required.' using errcode='42501'; end if;
  return actor;
end;
$$;

create function app_private.family_notification_recipients(p_school_id uuid,p_student_id uuid)
returns table(recipient_user_id uuid,recipient_role text)
language sql stable security invoker set search_path=''
as $$
  select distinct receiver.id,receiver.family_role from (
    select st.profile_id as id,'student'::text as family_role
      from public.students st where st.id=p_student_id and st.school_id=p_school_id
    union all
    select parent.profile_id,'parent'::text from public.students st
      join public.student_parents link on link.student_id=st.id
      join public.parents parent on parent.id=link.parent_id and parent.school_id=st.school_id
      where st.id=p_student_id and st.school_id=p_school_id
  ) receiver
  join public.profiles profile on profile.id=receiver.id and profile.is_active and profile.school_id=p_school_id
  join auth.users account on account.id=profile.id and not account.is_anonymous and account.deleted_at is null
    and(account.banned_until is null or account.banned_until<=statement_timestamp())
    and(account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
  where exists(select 1 from public.user_roles r where r.user_id=receiver.id and r.school_id=p_school_id
    and r.role=receiver.family_role::public.app_role);
$$;

create function app_private.notify_published_family_result()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  insert into app_private.family_notifications(kind,source_id,school_id,student_id,recipient_user_id,recipient_role,created_at)
    select distinct 'result_published',new.id,new.school_id,st.id,receiver.recipient_user_id,receiver.recipient_role,new.reviewed_at
    from pg_catalog.jsonb_array_elements(new.payload->'pupils') pupil
    join public.students st on st.id=(pupil.value->>'student_id')::uuid and st.school_id=new.school_id
    cross join lateral app_private.family_notification_recipients(new.school_id,st.id) receiver
    on conflict(kind,source_id,student_id,recipient_user_id,recipient_role) do nothing;
  return new;
end;
$$;
create trigger notify_published_family_result after update of status on app_private.assessment_result_submissions
  for each row when(old.status='pending' and new.status='published') execute function app_private.notify_published_family_result();

create function app_private.notify_family_leave_decision()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  insert into app_private.family_notifications(kind,source_id,school_id,student_id,recipient_user_id,recipient_role,created_at)
    select 'leave_decision',new.id,new.school_id,new.student_id,receiver.recipient_user_id,receiver.recipient_role,new.reviewed_at
    from app_private.family_notification_recipients(new.school_id,new.student_id) receiver
    on conflict(kind,source_id,student_id,recipient_user_id,recipient_role) do nothing;
  return new;
end;
$$;
create trigger notify_family_leave_decision after update of status on app_private.student_leave_requests
  for each row when(old.status='pending' and new.status in('approved','rejected')) execute function app_private.notify_family_leave_decision();

-- Current access is rechecked on every read and write. Linking a new guardian does
-- not backfill past events. A newer published result hides the superseded alert,
-- matching the existing family result reader's latest-revision-per-pupil policy.
create function app_private.eligible_family_notifications(p_role text)
returns table(id uuid,kind text,student_id uuid,student_name text,created_at timestamptz,read_at timestamptz,
  event_date date,source_id uuid,status text,title text,assessment_id uuid)
language sql stable security invoker set search_path=''
as $$
  select alert.id,'absence'::text,alert.student_id,alert.student_name,alert.created_at,alert.read_at,
    alert.attendance_date,original.attendance_id,'absent'::text,'Attendance marked absent'::text,null::uuid
  from app_private.eligible_guardian_absence_alerts(null) alert
  join app_private.guardian_absence_alerts original on original.id=alert.id
  join public.students st on st.id=alert.student_id
  join public.profiles profile on profile.id=auth.uid() and profile.school_id=st.school_id
  where p_role='parent'
  union all
  select event.id,event.kind,event.student_id,pg_catalog.concat_ws(' ',st.first_name,st.middle_name,st.last_name),
    event.created_at,event.read_at,(result.payload#>>'{metadata,assessment_date}')::date,event.source_id,
    'published'::text,pg_catalog.left(coalesce(nullif(result.payload#>>'{metadata,name}',''),'Assessment results'),160),result.assessment_id
  from app_private.family_notifications event
  join public.students st on st.id=event.student_id and st.school_id=event.school_id
  join app_private.assessment_result_submissions result on result.id=event.source_id and result.school_id=event.school_id and result.status='published'
  where event.kind='result_published' and event.recipient_user_id=auth.uid() and event.recipient_role=p_role
    and exists(select 1 from app_private.family_notification_recipients(event.school_id,event.student_id) receiver
      where receiver.recipient_user_id=event.recipient_user_id and receiver.recipient_role=p_role)
    and exists(select 1 from pg_catalog.jsonb_array_elements(result.payload->'pupils') pupil where pupil.value->>'student_id'=st.id::text)
    and not exists(select 1 from app_private.assessment_result_submissions newer
      where newer.school_id=result.school_id and newer.assessment_id=result.assessment_id and newer.status='published' and newer.revision>result.revision
      and exists(select 1 from pg_catalog.jsonb_array_elements(newer.payload->'pupils') pupil where pupil.value->>'student_id'=st.id::text))
  union all
  select event.id,event.kind,event.student_id,pg_catalog.concat_ws(' ',st.first_name,st.middle_name,st.last_name),
    event.created_at,event.read_at,request.start_date,event.source_id,request.status,
    case request.status when 'approved' then 'Leave approved' else 'Leave rejected' end,null::uuid
  from app_private.family_notifications event
  join public.students st on st.id=event.student_id and st.school_id=event.school_id
  join app_private.student_leave_requests request on request.id=event.source_id and request.school_id=event.school_id
    and request.student_id=event.student_id and request.status in('approved','rejected')
  where event.kind='leave_decision' and event.recipient_user_id=auth.uid() and event.recipient_role=p_role
    and exists(select 1 from app_private.family_notification_recipients(event.school_id,event.student_id) receiver
      where receiver.recipient_user_id=event.recipient_user_id and receiver.recipient_role=p_role);
$$;

create function app_private.get_family_notification_inbox(p_role text,p_unread_only boolean default false,p_limit integer default 30,
  p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare result jsonb;
begin
  perform app_private.family_notification_actor(p_role);
  if p_unread_only is null or p_limit is null or p_limit not between 1 and 50
    or pg_catalog.num_nonnulls(p_before_created_at,p_before_kind,p_before_id) not in(0,3)
    or(p_before_created_at is not null and(not pg_catalog.isfinite(p_before_created_at) or p_before_kind not in('absence','result_published','leave_decision'))) then
    raise exception 'Invalid notification page.' using errcode='22023';
  end if;
  with eligible as materialized(select * from app_private.eligible_family_notifications(p_role)),
  candidates as materialized(select * from eligible n where(not p_unread_only or n.read_at is null)
    and(p_before_created_at is null or(n.created_at,n.kind collate "C",n.id)<(p_before_created_at,p_before_kind collate "C",p_before_id))
    order by created_at desc,kind collate "C" desc,id desc limit p_limit+1),
  page as materialized(select * from candidates order by created_at desc,kind collate "C" desc,id desc limit p_limit)
  select pg_catalog.jsonb_build_object(
    'notifications',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(n) order by n.created_at desc,n.kind collate "C" desc,n.id desc) from page n),'[]'::jsonb),
    'unread_count',(select count(*) from eligible where read_at is null),
    'next_cursor',case when(select count(*) from candidates)>p_limit then(select pg_catalog.jsonb_build_object('created_at',n.created_at,'kind',n.kind,'id',n.id)
      from page n order by n.created_at,n.kind collate "C",n.id limit 1) else null end) into result;
  return result;
end;
$$;

create function app_private.get_family_notification_unread_count(p_role text)
returns bigint language plpgsql security definer set search_path=''
as $$
begin
  perform app_private.family_notification_actor(p_role);
  return(select count(*) from app_private.eligible_family_notifications(p_role) where read_at is null);
end;
$$;

create function app_private.mark_family_notification_read(p_role text,p_kind text,p_id uuid)
returns timestamptz language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);marked_at timestamptz;
begin
  if p_kind is null or p_kind not in('absence','result_published','leave_decision') or p_id is null then
    raise exception 'Choose a valid notification.' using errcode='22023';
  end if;
  if p_kind='absence' then
    update app_private.guardian_absence_alerts event set read_at=statement_timestamp()
      where event.id=p_id and event.recipient_user_id=actor and event.read_at is null
        and exists(select 1 from app_private.eligible_family_notifications(p_role) n where n.kind=p_kind and n.id=p_id)
      returning event.read_at into marked_at;
  else
    update app_private.family_notifications event set read_at=statement_timestamp()
      where event.id=p_id and event.kind=p_kind and event.recipient_user_id=actor and event.recipient_role=p_role and event.read_at is null
        and exists(select 1 from app_private.eligible_family_notifications(p_role) n where n.kind=p_kind and n.id=p_id)
      returning event.read_at into marked_at;
  end if;
  if marked_at is null then
    select n.read_at into marked_at from app_private.eligible_family_notifications(p_role) n where n.kind=p_kind and n.id=p_id;
  end if;
  return marked_at;
end;
$$;

create function app_private.mark_all_family_notifications_read(p_role text)
returns bigint language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);marked bigint;
begin
  with eligible as materialized(select n.id,n.kind from app_private.eligible_family_notifications(p_role) n where n.read_at is null),
  absence as(update app_private.guardian_absence_alerts event set read_at=statement_timestamp()
    where event.recipient_user_id=actor and event.read_at is null
      and exists(select 1 from eligible n where n.kind='absence' and n.id=event.id) returning event.id),
  decisions as(update app_private.family_notifications event set read_at=statement_timestamp()
    where event.recipient_user_id=actor and event.recipient_role=p_role and event.read_at is null
      and exists(select 1 from eligible n where n.kind=event.kind and n.id=event.id) returning event.id)
  select(select count(*) from absence)+(select count(*) from decisions) into marked;
  return marked;
end;
$$;

create function app_private.family_notification_student_school(p_role text,p_student_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);school uuid;
begin
  select st.school_id into school from public.students st
    where st.id=p_student_id and exists(select 1 from app_private.family_notification_recipients(st.school_id,st.id) receiver
      where receiver.recipient_user_id=actor and receiver.recipient_role=p_role);
  if school is null then raise exception 'You cannot view this student.' using errcode='42501'; end if;
  return school;
end;
$$;

create function app_private.get_family_notification_result(p_role text,p_student_id uuid,p_assessment_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare school uuid:=app_private.family_notification_student_school(p_role,p_student_id);result jsonb;
begin
  select pg_catalog.jsonb_build_object('id',r.id,'assessment_id',r.assessment_id,'revision',r.revision,
    'published_at',r.reviewed_at,'publisher_name',r.reviewer_name,'metadata',r.payload->'metadata','student_id',p_student_id,
    'student_name',pupil.value->>'student_name','admission_no',pupil.value->>'admission_no','roll_no',pupil.value->>'roll_no',
    'marks_obtained',(pupil.value->>'marks_obtained')::numeric,'maximum_marks',(r.payload#>>'{metadata,maximum_marks}')::numeric,
    'percentage',pg_catalog.round((pupil.value->>'marks_obtained')::numeric*100/(r.payload#>>'{metadata,maximum_marks}')::numeric,2),
    'remarks',pupil.value->>'remarks') into result
  from app_private.assessment_result_submissions r cross join lateral pg_catalog.jsonb_array_elements(r.payload->'pupils') pupil
  where r.school_id=school and r.assessment_id=p_assessment_id and r.status='published' and pupil.value->>'student_id'=p_student_id::text
  order by r.revision desc,r.id desc limit 1;
  return result;
end;
$$;

create function app_private.get_family_notification_leave(p_role text,p_student_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare school uuid:=app_private.family_notification_student_school(p_role,p_student_id);result jsonb;
begin
  select pg_catalog.to_jsonb(row) into result from(
    select r.id,r.school_id,r.student_id,r.student_name,r.admission_no,r.academic_year_id,r.academic_year_name,r.class_name,r.section_name,
      r.start_date,r.end_date,r.reason,r.status,r.requester_id,r.requester_name,r.created_at,r.reviewed_by,r.reviewer_name,r.review_note,r.reviewed_at,1::bigint as total_count
    from app_private.student_leave_requests r where r.id=p_request_id and r.student_id=p_student_id and r.school_id=school and r.status in('approved','rejected')
  ) row;
  return result;
end;
$$;

create function public.get_family_notification_inbox(p_role text,p_unread_only boolean default false,p_limit integer default 30,
  p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.get_family_notification_inbox(p_role,p_unread_only,p_limit,p_before_created_at,p_before_kind,p_before_id); $$;
create function public.get_family_notification_unread_count(p_role text)
returns bigint language sql security invoker set search_path='' as $$ select app_private.get_family_notification_unread_count(p_role); $$;
create function public.mark_family_notification_read(p_role text,p_kind text,p_id uuid)
returns timestamptz language sql security invoker set search_path='' as $$ select app_private.mark_family_notification_read(p_role,p_kind,p_id); $$;
create function public.mark_all_family_notifications_read(p_role text)
returns bigint language sql security invoker set search_path='' as $$ select app_private.mark_all_family_notifications_read(p_role); $$;
create function public.get_family_notification_result(p_role text,p_student_id uuid,p_assessment_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.get_family_notification_result(p_role,p_student_id,p_assessment_id); $$;
create function public.get_family_notification_leave(p_role text,p_student_id uuid,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.get_family_notification_leave(p_role,p_student_id,p_request_id); $$;

revoke all on function app_private.family_notification_actor(text),app_private.family_notification_recipients(uuid,uuid),
  app_private.notify_published_family_result(),app_private.notify_family_leave_decision(),app_private.eligible_family_notifications(text),
  app_private.family_notification_student_school(text,uuid),
  app_private.get_family_notification_inbox(text,boolean,integer,timestamptz,text,uuid),public.get_family_notification_inbox(text,boolean,integer,timestamptz,text,uuid),
  app_private.get_family_notification_unread_count(text),public.get_family_notification_unread_count(text),
  app_private.mark_family_notification_read(text,text,uuid),public.mark_family_notification_read(text,text,uuid),
  app_private.mark_all_family_notifications_read(text),public.mark_all_family_notifications_read(text),
  app_private.get_family_notification_result(text,uuid,uuid),public.get_family_notification_result(text,uuid,uuid),
  app_private.get_family_notification_leave(text,uuid,uuid),public.get_family_notification_leave(text,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function
  app_private.get_family_notification_inbox(text,boolean,integer,timestamptz,text,uuid),public.get_family_notification_inbox(text,boolean,integer,timestamptz,text,uuid),
  app_private.get_family_notification_unread_count(text),public.get_family_notification_unread_count(text),
  app_private.mark_family_notification_read(text,text,uuid),public.mark_family_notification_read(text,text,uuid),
  app_private.mark_all_family_notifications_read(text),public.mark_all_family_notifications_read(text),
  app_private.get_family_notification_result(text,uuid,uuid),public.get_family_notification_result(text,uuid,uuid),
  app_private.get_family_notification_leave(text,uuid,uuid),public.get_family_notification_leave(text,uuid,uuid) to authenticated;

commit;
