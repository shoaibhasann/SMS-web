begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $contracts$begin
 if to_regclass('app_private.gate_events') is null
  or to_regprocedure('app_private.eligible_family_notifications(text)') is null
  or to_regprocedure('app_private.family_notification_actor(text)') is null
  or to_regprocedure('app_private.staff_mfa_allowed()') is null then
  raise exception 'Governed gate, family inbox and native MFA contracts are required.';
 end if;
end;$contracts$;

create index gate_events_guardian_daily_source on app_private.gate_events(school_id,student_id,direction,received_at,id) where status='accepted';

create table app_private.gate_guardian_preferences(
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null,parent_id uuid not null,
 recipient_user_id uuid references public.profiles(id),
 arrival_enabled boolean not null default false,exit_enabled boolean not null default false,
 version integer not null default 0 check(version>=0),
 unique(student_id,parent_id),
 foreign key(student_id,parent_id) references public.student_parents(student_id,parent_id) on delete cascade
);
create index gate_guardian_preferences_parent on app_private.gate_guardian_preferences(parent_id);
create index gate_guardian_preferences_owner on app_private.gate_guardian_preferences(recipient_user_id,student_id);
create table app_private.gate_guardian_notifications(
 id uuid primary key default gen_random_uuid(),kind text not null check(kind in('gate_arrival','gate_exit')),
 source_id uuid not null references app_private.gate_events(id),
 school_id uuid not null references public.schools(id),student_id uuid not null references public.students(id),
 parent_id uuid not null references public.parents(id),recipient_user_id uuid not null references public.profiles(id),
 preference_id uuid not null,event_date date not null,created_at timestamptz not null,read_at timestamptz,
 unique(kind,student_id,event_date,recipient_user_id)
);
create index gate_guardian_notifications_recipient on app_private.gate_guardian_notifications(recipient_user_id,created_at desc,kind collate "C" desc,id desc);
create index gate_guardian_notifications_parent on app_private.gate_guardian_notifications(parent_id,student_id);
create index gate_guardian_notifications_source on app_private.gate_guardian_notifications(source_id);
alter table app_private.gate_guardian_preferences enable row level security;
alter table app_private.gate_guardian_notifications enable row level security;
revoke all on app_private.gate_guardian_preferences,app_private.gate_guardian_notifications from public,anon,authenticated,service_role;

-- Each relationship gets a new consent epoch; deleting/recreating a link cannot revive old consent or alerts.
create function app_private.seed_gate_guardian_preference()
returns trigger language plpgsql security definer set search_path=''
as $$begin
 insert into app_private.gate_guardian_preferences(student_id,parent_id,recipient_user_id)
  select new.student_id,new.parent_id,parent.profile_id from public.parents parent join public.students student on student.id=new.student_id and student.school_id=parent.school_id
  where parent.id=new.parent_id on conflict(student_id,parent_id) do nothing;
 return new;
end;$$;
create trigger seed_gate_guardian_preference after insert on public.student_parents for each row execute function app_private.seed_gate_guardian_preference();
create function app_private.reset_gate_guardian_owner()
returns trigger language plpgsql security definer set search_path=''
as $$begin
 delete from app_private.gate_guardian_preferences where parent_id=new.id;
 insert into app_private.gate_guardian_preferences(student_id,parent_id,recipient_user_id)
  select link.student_id,new.id,new.profile_id from public.student_parents link join public.students student on student.id=link.student_id and student.school_id=new.school_id
  where link.parent_id=new.id;
 return new;
end;$$;
create trigger reset_gate_guardian_owner after update of profile_id on public.parents for each row
 when(old.profile_id is distinct from new.profile_id) execute function app_private.reset_gate_guardian_owner();
insert into app_private.gate_guardian_preferences(student_id,parent_id,recipient_user_id)
 select link.student_id,link.parent_id,parent.profile_id from public.student_parents link
 join public.parents parent on parent.id=link.parent_id join public.students student on student.id=link.student_id and student.school_id=parent.school_id;

create function app_private.gate_notification_actor(p_role text)
returns uuid language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.family_notification_actor(p_role);begin
 if not app_private.has_live_school_session() or not app_private.staff_mfa_allowed() then
  raise exception 'A current verified family session is required.' using errcode='42501';end if;
 perform 1 from public.profiles profile join public.schools school on school.id=profile.school_id and school.is_active
  where profile.id=actor and profile.is_active for share of profile,school;
 if not found then raise exception 'Current family school access is required.' using errcode='42501';end if;
 return actor;
end;$$;
create function app_private.gate_guardian_is_eligible(p_school_id uuid,p_student_id uuid,p_parent_id uuid,p_user_id uuid)
returns boolean language sql stable security invoker set search_path=''
as $$select exists(
 select 1 from public.students student join public.schools school on school.id=student.school_id and school.is_active
 join public.student_parents link on link.student_id=student.id and link.parent_id=p_parent_id
 join public.parents parent on parent.id=link.parent_id and parent.school_id=school.id and parent.profile_id=p_user_id
 join public.profiles profile on profile.id=parent.profile_id and profile.school_id=school.id and profile.is_active
 join auth.users account on account.id=profile.id and not coalesce(account.is_anonymous,false) and account.deleted_at is null
  and(account.banned_until is null or account.banned_until<=statement_timestamp())
  and(account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
 join public.user_roles membership on membership.user_id=profile.id and membership.school_id=school.id and membership.role='parent'
 join public.role_permissions grant_row on grant_row.role='parent'
 join public.permissions permission on permission.id=grant_row.permission_id and permission.code='attendance.view'
 where student.id=p_student_id and school.id=p_school_id
);$$;

create function app_private.get_my_gate_alert_preferences()
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor('parent');children jsonb;begin
 if(select count(*) from app_private.gate_guardian_preferences pref join public.parents parent on parent.id=pref.parent_id
  join public.students student on student.id=pref.student_id where pref.recipient_user_id=actor
   and app_private.gate_guardian_is_eligible(student.school_id,student.id,parent.id,actor))>1500 then
  raise exception 'The linked-child list exceeds the supported bound.' using errcode='22023';end if;
 if exists(select pref.student_id from app_private.gate_guardian_preferences pref join public.parents parent on parent.id=pref.parent_id
  join public.students student on student.id=pref.student_id where pref.recipient_user_id=actor
   and app_private.gate_guardian_is_eligible(student.school_id,student.id,parent.id,actor) group by pref.student_id having count(*)<>1) then
  raise exception 'Guardian child mappings need school review.' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('student_id',student.id,'student_name',concat_ws(' ',student.first_name,student.middle_name,student.last_name),
  'preference_id',pref.id,'arrival_enabled',pref.arrival_enabled,'exit_enabled',pref.exit_enabled,'version',pref.version)
  order by student.first_name collate "C",student.id),'[]') into children
 from app_private.gate_guardian_preferences pref join public.parents parent on parent.id=pref.parent_id
 join public.students student on student.id=pref.student_id where pref.recipient_user_id=actor
  and app_private.gate_guardian_is_eligible(student.school_id,student.id,parent.id,actor);
 return jsonb_build_object('user_id',actor,'children',children);
end;$$;
create function app_private.set_my_gate_alert_preferences(p_preference_id uuid,p_expected_version integer,p_arrival_enabled boolean,p_exit_enabled boolean)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor('parent');pref app_private.gate_guardian_preferences%rowtype;student public.students%rowtype;begin
 if p_preference_id is null or p_expected_version is null or p_expected_version<0 or p_arrival_enabled is null or p_exit_enabled is null then
  raise exception 'Enter a preference ID, current version and both choices.' using errcode='22023';end if;
 select * into pref from app_private.gate_guardian_preferences where id=p_preference_id;
 perform 1 from public.parents parent join public.student_parents link on link.parent_id=parent.id and link.student_id=pref.student_id
  where parent.id=pref.parent_id and parent.profile_id=actor for share of parent,link;
 if not found then raise exception 'Current linked-child access is required.' using errcode='42501';end if;
 select * into pref from app_private.gate_guardian_preferences where id=p_preference_id for update;
 select * into student from public.students where id=pref.student_id for share;
 if pref.recipient_user_id is distinct from actor or not app_private.gate_guardian_is_eligible(student.school_id,student.id,pref.parent_id,actor) then
  raise exception 'Current linked-child attendance access is required.' using errcode='42501';end if;
 if pref.version<>p_expected_version then raise exception 'Preferences changed. Reload before saving.' using errcode='PT409';end if;
 if(pref.arrival_enabled,pref.exit_enabled) is distinct from(p_arrival_enabled,p_exit_enabled) then
  if pref.version=2147483647 then raise exception 'Preference revision limit reached. Contact the school.' using errcode='22023';end if;
  update app_private.gate_guardian_preferences set arrival_enabled=p_arrival_enabled,exit_enabled=p_exit_enabled,version=version+1
   where id=pref.id returning * into pref;
 end if;
 return jsonb_build_object('user_id',actor,'student_id',student.id,'student_name',concat_ws(' ',student.first_name,student.middle_name,student.last_name),
  'preference_id',pref.id,'arrival_enabled',pref.arrival_enabled,'exit_enabled',pref.exit_enabled,'version',pref.version);
end;$$;

create function app_private.notify_guardian_gate_event()
returns trigger language plpgsql security definer set search_path=''
as $$declare event_day date;event_kind text;candidate record;pref app_private.gate_guardian_preferences%rowtype;begin
 if new.status<>'accepted' or new.student_id is null or new.occurred_at>new.received_at or new.occurred_at>clock_timestamp() or new.received_at>clock_timestamp()
  or(new.occurred_at at time zone 'Asia/Kolkata')::date<>(new.received_at at time zone 'Asia/Kolkata')::date then return new;end if;
 event_day:=(new.occurred_at at time zone 'Asia/Kolkata')::date;
 if event_day<>(clock_timestamp() at time zone 'Asia/Kolkata')::date then return new;end if;
 if new.direction='IN' and new.reason in('marked_present','marked_late','already_marked','earlier_in_applied') then event_kind:='gate_arrival';
 elsif new.direction='OUT' and new.reason='recorded_out' and exists(
  select 1 from app_private.gate_events entry where entry.school_id=new.school_id and entry.student_id=new.student_id
   and entry.status='accepted' and entry.direction='IN' and entry.reason in('marked_present','marked_late','already_marked','earlier_in_applied')
   and entry.occurred_at<=new.occurred_at and entry.occurred_at<=entry.received_at and entry.received_at<=new.received_at
   and entry.received_at>=(event_day::timestamp at time zone 'Asia/Kolkata')
   and(entry.occurred_at at time zone 'Asia/Kolkata')::date=event_day
   and(entry.received_at at time zone 'Asia/Kolkata')::date=event_day
 ) then event_kind:='gate_exit';else return new;end if;
 -- First qualifying direction consumes the day's source even when every guardian opted out.
 if exists(select 1 from app_private.gate_events earlier where earlier.id<>new.id and earlier.school_id=new.school_id and earlier.student_id=new.student_id
  and earlier.status='accepted' and earlier.direction=new.direction and earlier.occurred_at<=earlier.received_at
  and(earlier.received_at,earlier.id)<(new.received_at,new.id) and earlier.received_at>=(event_day::timestamp at time zone 'Asia/Kolkata')
  and(earlier.occurred_at at time zone 'Asia/Kolkata')::date=event_day and(earlier.received_at at time zone 'Asia/Kolkata')::date=event_day
  and((new.direction='IN' and earlier.reason in('marked_present','marked_late','already_marked','earlier_in_applied'))
   or(new.direction='OUT' and earlier.reason='recorded_out' and exists(select 1 from app_private.gate_events entry
    where entry.school_id=earlier.school_id and entry.student_id=earlier.student_id and entry.status='accepted' and entry.direction='IN'
     and entry.reason in('marked_present','marked_late','already_marked','earlier_in_applied') and entry.occurred_at<=earlier.occurred_at
     and entry.occurred_at<=entry.received_at and entry.received_at<=earlier.received_at
     and entry.received_at>=(event_day::timestamp at time zone 'Asia/Kolkata')
     and(entry.occurred_at at time zone 'Asia/Kolkata')::date=event_day and(entry.received_at at time zone 'Asia/Kolkata')::date=event_day)))) then return new;end if;
 for candidate in select preference.id,preference.recipient_user_id,preference.parent_id
  from app_private.gate_guardian_preferences preference where preference.student_id=new.student_id
   and(case event_kind when 'gate_arrival' then preference.arrival_enabled else preference.exit_enabled end)
  order by preference.recipient_user_id,preference.id loop
  -- Link cascade/owner reset deletes this epoch. Avoid acquiring late Auth locks inside gate ingestion.
  select * into pref from app_private.gate_guardian_preferences where id=candidate.id for share;
  if found and pref.recipient_user_id=candidate.recipient_user_id
   and(case event_kind when 'gate_arrival' then pref.arrival_enabled else pref.exit_enabled end)
   and app_private.gate_guardian_is_eligible(new.school_id,new.student_id,pref.parent_id,pref.recipient_user_id) then
   insert into app_private.gate_guardian_notifications(kind,source_id,school_id,student_id,parent_id,recipient_user_id,preference_id,event_date,created_at)
    values(event_kind,new.id,new.school_id,new.student_id,pref.parent_id,pref.recipient_user_id,pref.id,event_day,new.received_at)
    on conflict(kind,student_id,event_date,recipient_user_id) do nothing;
  end if;
 end loop;
 return new;
end;$$;
create trigger notify_guardian_gate_event after insert on app_private.gate_events for each row execute function app_private.notify_guardian_gate_event();

create function app_private.eligible_guardian_gate_notifications()
returns table(id uuid,kind text,student_id uuid,student_name text,created_at timestamptz,read_at timestamptz,event_date date,
 source_id uuid,status text,title text,assessment_id uuid,occurred_at timestamptz,delayed boolean)
language sql stable security invoker set search_path=''
as $$select notification.id,notification.kind,student.id,concat_ws(' ',student.first_name,student.middle_name,student.last_name),
 notification.created_at,notification.read_at,notification.event_date,notification.source_id,event.direction,
 case notification.kind when 'gate_arrival' then 'Arrived at school' else 'Left school' end,null::uuid,event.occurred_at,
 event.received_at-event.occurred_at>interval '5 minutes'
 from app_private.gate_guardian_notifications notification
 join app_private.gate_guardian_preferences pref on pref.id=notification.preference_id and pref.parent_id=notification.parent_id and pref.student_id=notification.student_id
  and pref.recipient_user_id=notification.recipient_user_id
 join public.students student on student.id=notification.student_id and student.school_id=notification.school_id
 join app_private.gate_events event on event.id=notification.source_id and event.student_id=notification.student_id and event.school_id=notification.school_id and event.status='accepted'
 where notification.recipient_user_id=auth.uid() and(case notification.kind when 'gate_arrival' then pref.arrival_enabled else pref.exit_enabled end)
  and app_private.gate_guardian_is_eligible(notification.school_id,notification.student_id,notification.parent_id,notification.recipient_user_id);
$$;
create function app_private.eligible_family_notifications_v2(p_role text)
returns table(id uuid,kind text,student_id uuid,student_name text,created_at timestamptz,read_at timestamptz,event_date date,
 source_id uuid,status text,title text,assessment_id uuid,occurred_at timestamptz,delayed boolean)
language sql stable security invoker set search_path=''
as $$select legacy.*,null::timestamptz,false from app_private.eligible_family_notifications(p_role) legacy
 union all select gate.* from app_private.eligible_guardian_gate_notifications() gate where p_role='parent';$$;
create function app_private.get_family_notification_inbox_v2(p_role text,p_unread_only boolean default false,p_limit integer default 30,
 p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path=''
as $$declare result jsonb;begin
 perform app_private.gate_notification_actor(p_role);
 if p_unread_only is null or p_limit is null or p_limit not between 1 and 50
  or num_nonnulls(p_before_created_at,p_before_kind,p_before_id) not in(0,3)
  or(p_before_created_at is not null and(not isfinite(p_before_created_at) or p_before_kind not in('absence','result_published','leave_decision','gate_arrival','gate_exit'))) then
  raise exception 'Invalid notification page.' using errcode='22023';end if;
 with eligible as materialized(select * from app_private.eligible_family_notifications_v2(p_role)),
 candidates as materialized(select * from eligible n where(not p_unread_only or n.read_at is null)
  and(p_before_created_at is null or(n.created_at,n.kind collate "C",n.id)<(p_before_created_at,p_before_kind collate "C",p_before_id))
  order by created_at desc,kind collate "C" desc,id desc limit p_limit+1),
 page as materialized(select * from candidates order by created_at desc,kind collate "C" desc,id desc limit p_limit)
 select jsonb_build_object('notifications',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc,n.kind collate "C" desc,n.id desc) from page n),'[]'::jsonb),
  'unread_count',(select count(*) from eligible where read_at is null),
  'next_cursor',case when(select count(*) from candidates)>p_limit then(select jsonb_build_object('created_at',n.created_at,'kind',n.kind,'id',n.id)
   from page n order by n.created_at,n.kind collate "C",n.id limit 1) else null end) into result;
 return result;
end;$$;
create function app_private.get_family_notification_unread_count_v2(p_role text)
returns bigint language plpgsql security definer set search_path=''
as $$begin perform app_private.gate_notification_actor(p_role);
 return(select count(*) from app_private.eligible_family_notifications_v2(p_role) where read_at is null);end;$$;
create function app_private.mark_family_notification_read_v2(p_role text,p_kind text,p_id uuid)
returns timestamptz language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);marked timestamptz;begin
 if p_kind in('absence','result_published','leave_decision') then return app_private.mark_family_notification_read(p_role,p_kind,p_id);end if;
 if p_kind is null or p_kind not in('gate_arrival','gate_exit') or p_id is null then raise exception 'Choose a valid notification.' using errcode='22023';end if;
 if p_role<>'parent' then return null;end if;
 perform 1 from app_private.gate_guardian_preferences where recipient_user_id=actor order by id for share;
 update app_private.gate_guardian_notifications notification set read_at=statement_timestamp() where notification.id=p_id and notification.kind=p_kind and notification.read_at is null
  and exists(select 1 from app_private.eligible_guardian_gate_notifications() eligible where eligible.id=p_id and eligible.kind=p_kind) returning notification.read_at into marked;
 if marked is null then select eligible.read_at into marked from app_private.eligible_guardian_gate_notifications() eligible where eligible.id=p_id and eligible.kind=p_kind;end if;
 return marked;
end;$$;
create function app_private.mark_all_family_notifications_read_v2(p_role text)
returns bigint language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);legacy bigint;gate bigint:=0;begin
 perform 1 from app_private.gate_guardian_preferences where recipient_user_id=actor order by id for share;
 legacy:=app_private.mark_all_family_notifications_read(p_role);
 if p_role='parent' then
  with updated as(update app_private.gate_guardian_notifications notification set read_at=statement_timestamp() where notification.read_at is null
   and exists(select 1 from app_private.eligible_guardian_gate_notifications() eligible where eligible.id=notification.id) returning notification.id)
  select count(*) into gate from updated;
 end if;
 return legacy+gate;
end;$$;

create function public.get_my_gate_alert_preferences() returns jsonb language sql security invoker set search_path=''
as $$select app_private.get_my_gate_alert_preferences();$$;
create function public.set_my_gate_alert_preferences(p_preference_id uuid,p_expected_version integer,p_arrival_enabled boolean,p_exit_enabled boolean)
returns jsonb language sql security invoker set search_path='' as $$select app_private.set_my_gate_alert_preferences(p_preference_id,p_expected_version,p_arrival_enabled,p_exit_enabled);$$;
create function public.get_family_notification_inbox_v2(p_role text,p_unread_only boolean default false,p_limit integer default 30,
 p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$select app_private.get_family_notification_inbox_v2(p_role,p_unread_only,p_limit,p_before_created_at,p_before_kind,p_before_id);$$;
create function public.get_family_notification_unread_count_v2(p_role text) returns bigint language sql security invoker set search_path=''
as $$select app_private.get_family_notification_unread_count_v2(p_role);$$;
create function public.mark_family_notification_read_v2(p_role text,p_kind text,p_id uuid) returns timestamptz language sql security invoker set search_path=''
as $$select app_private.mark_family_notification_read_v2(p_role,p_kind,p_id);$$;
create function public.mark_all_family_notifications_read_v2(p_role text) returns bigint language sql security invoker set search_path=''
as $$select app_private.mark_all_family_notifications_read_v2(p_role);$$;

revoke all on function app_private.seed_gate_guardian_preference(),app_private.reset_gate_guardian_owner(),app_private.gate_notification_actor(text),
 app_private.gate_guardian_is_eligible(uuid,uuid,uuid,uuid),app_private.notify_guardian_gate_event(),app_private.eligible_guardian_gate_notifications(),
 app_private.eligible_family_notifications_v2(text) from public,anon,authenticated,service_role;
do $permissions$declare signature text;begin
 foreach signature in array array['get_my_gate_alert_preferences()','set_my_gate_alert_preferences(uuid,integer,boolean,boolean)',
  'get_family_notification_inbox_v2(text,boolean,integer,timestamptz,text,uuid)','get_family_notification_unread_count_v2(text)',
  'mark_family_notification_read_v2(text,text,uuid)','mark_all_family_notifications_read_v2(text)'] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';
 end loop;
end;$permissions$;
notify pgrst,'reload schema';
commit;
