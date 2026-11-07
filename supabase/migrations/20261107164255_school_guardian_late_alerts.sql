begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- No row means OFF. Each accepted school decision is append-only and never backfills marks.
create table app_private.school_late_alert_policy_versions(
 school_id uuid not null references public.schools(id),
 version bigint not null check(version between 1 and 9007199254740991),
 enabled boolean not null,reason text not null,
 actor_id uuid not null references public.profiles(id),
 request_id uuid not null unique,created_at timestamptz not null default clock_timestamp(),
 primary key(school_id,version)
);
create index school_late_alert_policy_actor on app_private.school_late_alert_policy_versions(actor_id);
create table app_private.guardian_late_alerts(
 id uuid primary key default gen_random_uuid(),
 attendance_id uuid not null references public.attendance(id) on delete cascade,
 school_id uuid not null references public.schools(id),student_id uuid not null,
 parent_id uuid not null,recipient_user_id uuid not null,
 attendance_date date not null,policy_version bigint not null,
 created_at timestamptz not null default clock_timestamp(),read_at timestamptz,
 unique(attendance_id,recipient_user_id),
 foreign key(school_id,policy_version) references app_private.school_late_alert_policy_versions(school_id,version),
 foreign key(student_id,parent_id) references public.student_parents(student_id,parent_id) on delete cascade
);
create index guardian_late_alerts_link on app_private.guardian_late_alerts(student_id,parent_id);
create index guardian_late_alerts_recipient on app_private.guardian_late_alerts(recipient_user_id,created_at desc,id desc);
create index guardian_late_alerts_policy on app_private.guardian_late_alerts(school_id,policy_version);
alter table app_private.school_late_alert_policy_versions enable row level security;
alter table app_private.guardian_late_alerts enable row level security;
revoke all on app_private.school_late_alert_policy_versions,app_private.guardian_late_alerts from public,anon,authenticated,service_role;

create function app_private.guard_school_late_alert_policy_history()
returns trigger language plpgsql security definer set search_path=''
as $$begin raise exception 'School Late alert decisions are immutable.' using errcode='42501';end;$$;
create trigger guard_school_late_alert_policy_history before update or delete on app_private.school_late_alert_policy_versions
 for each row execute function app_private.guard_school_late_alert_policy_history();

create function app_private.get_school_late_alert_settings(p_school_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);result jsonb;begin
 select jsonb_build_object('user_id',actor,'school_id',p_school_id,
  'enabled',coalesce((select enabled from app_private.school_late_alert_policy_versions where school_id=p_school_id order by version desc limit 1),false),
  'version',coalesce((select max(version) from app_private.school_late_alert_policy_versions where school_id=p_school_id),0),
  'history',coalesce((select jsonb_agg(to_jsonb(row) order by row.version desc) from(
   select version,enabled,reason,actor_id,created_at from app_private.school_late_alert_policy_versions
   where school_id=p_school_id order by version desc limit 20)row),'[]'::jsonb)) into result;
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school access changed.' using errcode='42501';end if;
 return result;
end;$$;

create function app_private.set_school_late_alert_settings(p_school_id uuid,p_expected_version bigint,p_enabled boolean,p_reason text,p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);previous app_private.school_late_alert_policy_versions%rowtype;
 current_version bigint;reason text:=btrim(p_reason);replayed boolean:=false;begin
 if p_expected_version is null or p_expected_version not between 0 and 9007199254740990 or p_enabled is null or p_request_id is null
  or reason is null or char_length(reason) not between 5 and 300 or reason ~ '[[:cntrl:]]'
  or reason ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]' then
  raise exception 'Choose the current policy version, an enabled or disabled choice, request ID and a 5 to 300 character reason.' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('school-late-alert-request:'||p_request_id::text,0));
 perform app_private.gate_office_actor(p_school_id);
 perform pg_advisory_xact_lock(hashtextextended('school-late-alert-policy:'||p_school_id::text,0));
 perform app_private.gate_office_actor(p_school_id);
 select * into previous from app_private.school_late_alert_policy_versions where request_id=p_request_id;
 if previous.request_id is not null then
  if(previous.school_id,previous.version-1,previous.enabled,previous.reason,previous.actor_id)
   is distinct from(p_school_id,p_expected_version,p_enabled,reason,actor) then
   raise exception 'This request ID already belongs to a different school decision.' using errcode='PT409';end if;
  replayed:=true;
 else
  select coalesce(max(version),0) into current_version from app_private.school_late_alert_policy_versions where school_id=p_school_id;
  if current_version<>p_expected_version then raise exception 'School Late alert settings changed. Reload before saving.' using errcode='PT409';end if;
  insert into app_private.school_late_alert_policy_versions(school_id,version,enabled,reason,actor_id,request_id)
   values(p_school_id,current_version+1,p_enabled,reason,actor,p_request_id) returning * into previous;
 end if;
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school access changed.' using errcode='42501';end if;
 return jsonb_build_object('user_id',actor,'school_id',p_school_id,'enabled',previous.enabled,'version',previous.version,
  'request_id',previous.request_id,'replayed',replayed);
end;$$;

create function app_private.record_guardian_late_alerts()
returns trigger language plpgsql security definer set search_path=''
as $$declare policy app_private.school_late_alert_policy_versions%rowtype;begin
 if new.status is distinct from 'late' or new.attendance_date<>(clock_timestamp() at time zone 'Asia/Kolkata')::date then return new;end if;
 -- Re-saves, remarks, link changes and policy enablement cannot manufacture a new Late event.
 if tg_op='UPDATE' and old.status='late' then return new;end if;
 -- Settings and creation share a short fence. No Auth, attendance or roster locks are acquired here.
 perform pg_advisory_xact_lock_shared(hashtextextended('school-late-alert-policy:'||new.school_id::text,0));
 if new.attendance_date<>(clock_timestamp() at time zone 'Asia/Kolkata')::date then return new;end if;
 select * into policy from app_private.school_late_alert_policy_versions where school_id=new.school_id order by version desc limit 1;
 if policy.enabled is distinct from true then return new;end if;
 insert into app_private.guardian_late_alerts(attendance_id,school_id,student_id,parent_id,recipient_user_id,attendance_date,policy_version)
  select new.id,new.school_id,new.student_id,link.parent_id,parent.profile_id,new.attendance_date,policy.version
  from public.students student join public.student_parents link on link.student_id=student.id
  join public.parents parent on parent.id=link.parent_id and parent.school_id=student.school_id
  where student.id=new.student_id and student.school_id=new.school_id
   and app_private.gate_guardian_is_eligible(new.school_id,new.student_id,parent.id,parent.profile_id)
  order by link.parent_id for key share of link
  on conflict(attendance_id,recipient_user_id) do nothing;
 return new;
end;$$;
create trigger record_guardian_late_alerts after insert or update of status,school_id,student_id,attendance_date on public.attendance
 for each row execute function app_private.record_guardian_late_alerts();

-- The link FK cascades on revocation, so re-linking cannot revive an old alert.
-- Recovery keeps the parent identity and grants only its bounded former-recipient history.
-- Correcting Late hides the alert without deleting its ID/read state; school OFF controls new events only.
create function app_private.eligible_guardian_late_alerts()
returns table(id uuid,kind text,student_id uuid,student_name text,created_at timestamptz,read_at timestamptz,event_date date,
 source_id uuid,status text,title text,assessment_id uuid,occurred_at timestamptz,delayed boolean)
language sql stable security invoker set search_path=''
as $$select alert.id,'late'::text,student.id,concat_ws(' ',student.first_name,student.middle_name,student.last_name),
 alert.created_at,alert.read_at,alert.attendance_date,alert.attendance_id,'late'::text,'Attendance marked late'::text,null::uuid,null::timestamptz,false
 from app_private.guardian_late_alerts alert
 join public.attendance mark on mark.id=alert.attendance_id and mark.school_id=alert.school_id and mark.student_id=alert.student_id
  and mark.attendance_date=alert.attendance_date and mark.status='late'
 join public.students student on student.id=alert.student_id and student.school_id=alert.school_id
 join public.student_parents link on link.student_id=alert.student_id and link.parent_id=alert.parent_id
 join public.parents parent on parent.id=link.parent_id and parent.school_id=alert.school_id
 where app_private.guardian_recovery_recipient(alert.recipient_user_id,parent.id,alert.created_at)
  and app_private.gate_guardian_is_eligible(alert.school_id,alert.student_id,parent.id,auth.uid());$$;
create function app_private.eligible_family_notifications_v3(p_role text)
returns table(id uuid,kind text,student_id uuid,student_name text,created_at timestamptz,read_at timestamptz,event_date date,
 source_id uuid,status text,title text,assessment_id uuid,occurred_at timestamptz,delayed boolean)
language sql stable security invoker set search_path=''
as $$select legacy.* from app_private.eligible_family_notifications_v2(p_role) legacy
 union all select late.* from app_private.eligible_guardian_late_alerts() late where p_role='parent';$$;

create function app_private.get_family_notification_inbox_v3(p_role text,p_unread_only boolean default false,p_limit integer default 30,
 p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);result jsonb;begin
 if p_unread_only is null or p_limit is null or p_limit not between 1 and 50
  or num_nonnulls(p_before_created_at,p_before_kind,p_before_id) not in(0,3)
  or(p_before_created_at is not null and(not isfinite(p_before_created_at) or p_before_kind not in('absence','result_published','leave_decision','gate_arrival','gate_exit','late'))) then
  raise exception 'Invalid notification page.' using errcode='22023';end if;
 with eligible as materialized(select * from app_private.eligible_family_notifications_v3(p_role)),
 candidates as materialized(select * from eligible n where(not p_unread_only or n.read_at is null)
  and(p_before_created_at is null or(n.created_at,n.kind collate "C",n.id)<(p_before_created_at,p_before_kind collate "C",p_before_id))
  order by created_at desc,kind collate "C" desc,id desc limit p_limit+1),
 page as materialized(select * from candidates order by created_at desc,kind collate "C" desc,id desc limit p_limit)
 select jsonb_build_object('user_id',actor,'role',p_role,
  'notifications',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc,n.kind collate "C" desc,n.id desc) from page n),'[]'::jsonb),
  'unread_count',(select count(*) from eligible where read_at is null),
  'next_cursor',case when(select count(*) from candidates)>p_limit then(select jsonb_build_object('created_at',n.created_at,'kind',n.kind,'id',n.id)
   from page n order by n.created_at,n.kind collate "C",n.id limit 1) else null end) into result;
 if actor is distinct from app_private.gate_notification_actor(p_role) then raise exception 'Your family access changed.' using errcode='42501';end if;
 return result;
end;$$;
create function app_private.get_family_notification_unread_count_v3(p_role text)
returns bigint language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);result bigint;begin
 select count(*) into result from app_private.eligible_family_notifications_v3(p_role) where read_at is null;
 if actor is distinct from app_private.gate_notification_actor(p_role) then raise exception 'Your family access changed.' using errcode='42501';end if;
 return result;
end;$$;
create function app_private.mark_family_notification_read_v3(p_role text,p_kind text,p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);marked timestamptz;begin
 if p_kind is null or p_kind not in('absence','result_published','leave_decision','gate_arrival','gate_exit','late') or p_id is null then
  raise exception 'Choose a valid notification.' using errcode='22023';end if;
 if p_kind<>'late' then marked:=app_private.mark_family_notification_read_v2(p_role,p_kind,p_id);
 elsif p_role='parent' then
  update app_private.guardian_late_alerts alert set read_at=statement_timestamp() where alert.id=p_id and alert.read_at is null
   and exists(select 1 from app_private.eligible_guardian_late_alerts() eligible where eligible.id=alert.id);
  select eligible.read_at into marked from app_private.eligible_guardian_late_alerts() eligible where eligible.id=p_id;
 end if;
 if actor is distinct from app_private.gate_notification_actor(p_role) then raise exception 'Your family access changed.' using errcode='42501';end if;
 return marked;
end;$$;
create function app_private.mark_all_family_notifications_read_v3(p_role text)
returns bigint language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_notification_actor(p_role);legacy bigint;late bigint:=0;begin
 legacy:=app_private.mark_all_family_notifications_read_v2(p_role);
 if p_role='parent' then
  with updated as(update app_private.guardian_late_alerts alert set read_at=statement_timestamp() where alert.read_at is null
   and exists(select 1 from app_private.eligible_guardian_late_alerts() eligible where eligible.id=alert.id) returning alert.id)
  select count(*) into late from updated;
 end if;
 if actor is distinct from app_private.gate_notification_actor(p_role) then raise exception 'Your family access changed.' using errcode='42501';end if;
 return legacy+late;
end;$$;

create function public.get_school_late_alert_settings(p_school_id uuid)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_school_late_alert_settings(p_school_id);$$;
create function public.set_school_late_alert_settings(p_school_id uuid,p_expected_version bigint,p_enabled boolean,p_reason text,p_request_id uuid)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.set_school_late_alert_settings(p_school_id,p_expected_version,p_enabled,p_reason,p_request_id);$$;
create function public.get_family_notification_inbox_v3(p_role text,p_unread_only boolean default false,p_limit integer default 30,
 p_before_created_at timestamptz default null,p_before_kind text default null,p_before_id uuid default null)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_family_notification_inbox_v3(p_role,p_unread_only,p_limit,p_before_created_at,p_before_kind,p_before_id);$$;
create function public.get_family_notification_unread_count_v3(p_role text)
returns bigint language sql volatile security invoker set search_path='' as $$select app_private.get_family_notification_unread_count_v3(p_role);$$;
create function public.mark_family_notification_read_v3(p_role text,p_kind text,p_id uuid)
returns timestamptz language sql volatile security invoker set search_path='' as $$select app_private.mark_family_notification_read_v3(p_role,p_kind,p_id);$$;
create function public.mark_all_family_notifications_read_v3(p_role text)
returns bigint language sql volatile security invoker set search_path='' as $$select app_private.mark_all_family_notifications_read_v3(p_role);$$;

revoke all on function app_private.guard_school_late_alert_policy_history(),app_private.record_guardian_late_alerts(),
 app_private.eligible_guardian_late_alerts(),app_private.eligible_family_notifications_v3(text) from public,anon,authenticated,service_role;
do $permissions$declare signature text;begin
 foreach signature in array array['get_school_late_alert_settings(uuid)','set_school_late_alert_settings(uuid,bigint,boolean,text,uuid)',
  'get_family_notification_inbox_v3(text,boolean,integer,timestamptz,text,uuid)','get_family_notification_unread_count_v3(text)',
  'mark_family_notification_read_v3(text,text,uuid)','mark_all_family_notifications_read_v3(text)'] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';
 end loop;
end;$permissions$;
notify pgrst,'reload schema';
commit;
