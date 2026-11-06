begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table app_private.family_push_preferences(
  user_id uuid not null references public.profiles(id),
  recipient_role text not null check(recipient_role in('parent','student')),
  enabled boolean not null default false,
  absence boolean not null default true,
  result_published boolean not null default true,
  leave_decision boolean not null default true,
  version integer not null default 1 check(version>0),
  primary key(user_id,recipient_role)
);
create table app_private.family_push_devices(
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null unique,
  installation_hash bytea not null,
  user_id uuid not null references public.profiles(id),
  recipient_role text not null check(recipient_role in('parent','student')),
  school_id uuid not null references public.schools(id),
  session_id uuid not null,
  device_fid text not null,
  fid_hash bytea not null unique,
  platform text not null check(platform in('android','ios')),
  label text not null check(length(label) between 1 and 80),
  generation integer not null default 1 check(generation>0),
  created_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz not null default statement_timestamp(),
  revoked_at timestamptz
);
create index family_push_devices_owner on app_private.family_push_devices(user_id,recipient_role,created_at desc,id desc);
create index family_push_devices_school on app_private.family_push_devices(school_id);
create index family_push_devices_session on app_private.family_push_devices(session_id);
create table app_private.family_push_jobs(
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in('absence','result_published','leave_decision')),
  event_id uuid not null,
  device_id uuid not null references app_private.family_push_devices(id),
  device_generation integer not null,
  user_id uuid not null references public.profiles(id),
  recipient_role text not null check(recipient_role in('parent','student')),
  school_id uuid not null references public.schools(id),
  status text not null default 'queued' check(status in('queued','leased','accepted','cancelled','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  next_attempt_at timestamptz not null default statement_timestamp(),
  batch_id uuid,
  lease_id uuid,
  lease_until timestamptz,
  prepared_at timestamptz,
  finished_at timestamptz,
  last_outcome text,
  result_code text,
  provider_id text,
  unique(kind,event_id,device_id,device_generation)
);
create index family_push_jobs_ready on app_private.family_push_jobs(next_attempt_at,created_at,id) where status in('queued','leased');
create index family_push_jobs_device on app_private.family_push_jobs(device_id);
create index family_push_jobs_user on app_private.family_push_jobs(user_id,recipient_role);
create index family_push_jobs_school on app_private.family_push_jobs(school_id);
create table app_private.family_push_batches(
  id uuid primary key,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  jobs jsonb not null
);

alter table app_private.family_push_preferences enable row level security;
alter table app_private.family_push_devices enable row level security;
alter table app_private.family_push_jobs enable row level security;
alter table app_private.family_push_batches enable row level security;
revoke all on table app_private.family_push_preferences,app_private.family_push_devices,app_private.family_push_jobs,app_private.family_push_batches from public,anon,authenticated,service_role;

create function app_private.family_push_service()
returns void language plpgsql security definer set search_path=''
as $$
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.jwt()->>'role' is distinct from 'service_role' then
    raise exception 'A trusted dispatch service is required.' using errcode='42501';
  end if;
end;
$$;

create function app_private.get_my_family_push_settings(p_role text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);result jsonb;
begin
  select pg_catalog.jsonb_build_object('preferences',coalesce((select pg_catalog.jsonb_build_object('enabled',p.enabled,'absence',p.absence,
    'result_published',p.result_published,'leave_decision',p.leave_decision,'version',p.version)
    from app_private.family_push_preferences p where p.user_id=actor and p.recipient_role=p_role),
    '{"enabled":false,"absence":true,"result_published":true,"leave_decision":true,"version":0}'::jsonb),
    'devices',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) order by (d.revoked_at is null) desc,d.created_at desc,d.id desc) from(
      select device.id,device.platform,device.label,device.created_at,device.last_seen_at,device.revoked_at
      from app_private.family_push_devices device where device.user_id=actor and device.recipient_role=p_role
      order by (device.revoked_at is null) desc,device.created_at desc,device.id desc limit 50)d),'[]'::jsonb)) into result;
  return result;
end;
$$;

create function app_private.set_my_family_push_preferences(p_role text,p_enabled boolean,p_absence boolean,p_result_published boolean,p_leave_decision boolean,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);previous app_private.family_push_preferences;
begin
  if p_enabled is null or p_absence is null or p_result_published is null or p_leave_decision is null or p_expected_version is null or p_expected_version<0 then
    raise exception 'Choose valid notification preferences.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_preferences:'||actor::text||':'||p_role,0));
  select * into previous from app_private.family_push_preferences where user_id=actor and recipient_role=p_role for update;
  if found and(previous.enabled,previous.absence,previous.result_published,previous.leave_decision)=(p_enabled,p_absence,p_result_published,p_leave_decision) then
    return app_private.get_my_family_push_settings(p_role);
  end if;
  if coalesce(previous.version,0)<>p_expected_version then raise exception 'Notification settings changed. Refresh before saving.' using errcode='PT409'; end if;
  insert into app_private.family_push_preferences(user_id,recipient_role,enabled,absence,result_published,leave_decision,version)
    values(actor,p_role,p_enabled,p_absence,p_result_published,p_leave_decision,coalesce(previous.version,0)+1)
    on conflict(user_id,recipient_role) do update set enabled=excluded.enabled,absence=excluded.absence,
      result_published=excluded.result_published,leave_decision=excluded.leave_decision,version=excluded.version;
  update app_private.family_push_jobs set status='cancelled',finished_at=statement_timestamp(),result_code='preferences_changed'
    where user_id=actor and recipient_role=p_role and status in('queued','leased')
      and(not p_enabled or kind='absence' and not p_absence or kind='result_published' and not p_result_published or kind='leave_decision' and not p_leave_decision);
  return app_private.get_my_family_push_settings(p_role);
end;
$$;

create function app_private.register_my_family_push_device(p_role text,p_installation_id uuid,p_installation_secret text,p_fid text,p_platform text,p_label text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);school uuid;session uuid:=(auth.jwt()->>'session_id')::uuid;
  previous app_private.family_push_devices;fid_owner app_private.family_push_devices;proof bytea;fid_digest bytea;device uuid;revision integer;
begin
  if p_installation_id is null or p_installation_secret is null or p_installation_secret!~'^[0-9a-f]{64}$'
    or p_fid is null or p_fid!~'^[A-Za-z0-9_-]{22}$'
    or p_platform is null or p_platform not in('android','ios') or p_label is null or length(btrim(p_label)) not between 1 and 80 then
    raise exception 'Choose valid native device details.' using errcode='22023';
  end if;
  select school_id into school from public.profiles where id=actor;
  proof:=pg_catalog.sha256(pg_catalog.convert_to(p_installation_secret,'UTF8'));
  fid_digest:=pg_catalog.sha256(pg_catalog.convert_to(p_fid,'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_owner:'||actor::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_installation:'||p_installation_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_fid:'||pg_catalog.encode(fid_digest,'hex'),0));
  select * into previous from app_private.family_push_devices where installation_id=p_installation_id for update;
  if found and(previous.installation_hash<>proof or previous.user_id<>actor or previous.recipient_role<>p_role or previous.school_id<>school) then
    raise exception 'This device registration cannot be claimed by this account.' using errcode='42501';
  end if;
  select * into fid_owner from app_private.family_push_devices where fid_hash=fid_digest;
  if found and fid_owner.installation_id<>p_installation_id then
    raise exception 'This device FID belongs to another registration. Refresh the native FID.' using errcode='42501';
  end if;
  if(previous.id is null or previous.revoked_at is not null) and(select count(*) from app_private.family_push_devices d where d.user_id=actor and d.revoked_at is null)>=10 then
    raise exception 'Remove an old device before adding another.' using errcode='22023';
  end if;
  if previous.id is null and(select count(*) from app_private.family_push_devices d where d.user_id=actor and d.created_at>=statement_timestamp()-interval '1 day')>=100 then
    raise exception 'Too many new device registrations. Try again later.' using errcode='22023';
  end if;
  if previous.id is null then
    insert into app_private.family_push_devices(installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label)
      values(p_installation_id,proof,actor,p_role,school,session,p_fid,fid_digest,p_platform,btrim(p_label)) returning id,generation into device,revision;
  else
    revision:=previous.generation+case when previous.device_fid<>p_fid or previous.session_id<>session or previous.revoked_at is not null then 1 else 0 end;
    update app_private.family_push_devices set session_id=session,device_fid=p_fid,fid_hash=fid_digest,platform=p_platform,label=btrim(p_label),
      generation=revision,last_seen_at=statement_timestamp(),revoked_at=null where id=previous.id returning id into device;
    if revision<>previous.generation then
      update app_private.family_push_jobs set status='cancelled',finished_at=statement_timestamp(),result_code='device_changed'
        where device_id=device and status in('queued','leased') and device_generation<>revision;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('device_id',device,'generation',revision);
end;
$$;

create function app_private.revoke_my_family_push_device(p_role text,p_device_id uuid)
returns boolean language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.family_notification_actor(p_role);device uuid;
begin
  select id into device from app_private.family_push_devices where id=p_device_id and user_id=actor and recipient_role=p_role for update;
  if device is null then return false; end if;
  update app_private.family_push_devices set generation=generation+case when revoked_at is null then 1 else 0 end,
    revoked_at=coalesce(revoked_at,statement_timestamp()) where id=device;
  update app_private.family_push_jobs set status='cancelled',finished_at=statement_timestamp(),result_code='device_revoked'
    where device_id=device and status in('queued','leased');
  return true;
end;
$$;

-- Reuse inbox eligibility without borrowing a caller's uid or weakening a family API.
create function app_private.family_push_event(p_kind text,p_event_id uuid)
returns table(user_id uuid,recipient_role text,school_id uuid,student_id uuid,event_time timestamptz)
language sql volatile security invoker set search_path=''
as $$
  select a.recipient_user_id,'parent'::text,st.school_id,st.id,a.created_at
    from app_private.guardian_absence_alerts a
    join public.attendance mark on mark.id=a.attendance_id and mark.student_id=a.student_id and mark.status='absent'
    join public.students st on st.id=a.student_id and st.school_id=mark.school_id
    join public.student_parents link on link.student_id=a.student_id and link.parent_id=a.parent_id
    join public.parents guardian on guardian.id=a.parent_id and guardian.profile_id=a.recipient_user_id and guardian.school_id=st.school_id
    where p_kind='absence' and a.id=p_event_id and exists(select 1 from app_private.family_notification_recipients(st.school_id,st.id) r where r.recipient_user_id=a.recipient_user_id and r.recipient_role='parent')
  union all
  select event.recipient_user_id,event.recipient_role,event.school_id,event.student_id,event.created_at
    from app_private.family_notifications event
    join app_private.assessment_result_submissions result on result.id=event.source_id and result.school_id=event.school_id and result.status='published'
    where p_kind='result_published' and event.kind=p_kind and event.id=p_event_id
      and exists(select 1 from app_private.family_notification_recipients(event.school_id,event.student_id) r where r.recipient_user_id=event.recipient_user_id and r.recipient_role=event.recipient_role)
      and exists(select 1 from pg_catalog.jsonb_array_elements(result.payload->'pupils') pupil where pupil.value->>'student_id'=event.student_id::text)
      and not exists(select 1 from app_private.assessment_result_submissions newer where newer.school_id=result.school_id and newer.assessment_id=result.assessment_id
        and newer.status='published' and newer.revision>result.revision and exists(select 1 from pg_catalog.jsonb_array_elements(newer.payload->'pupils') pupil where pupil.value->>'student_id'=event.student_id::text))
  union all
  select event.recipient_user_id,event.recipient_role,event.school_id,event.student_id,event.created_at
    from app_private.family_notifications event
    join app_private.student_leave_requests request on request.id=event.source_id and request.school_id=event.school_id and request.student_id=event.student_id and request.status in('approved','rejected')
    where p_kind='leave_decision' and event.kind=p_kind and event.id=p_event_id
      and exists(select 1 from app_private.family_notification_recipients(event.school_id,event.student_id) r where r.recipient_user_id=event.recipient_user_id and r.recipient_role=event.recipient_role);
$$;

create function app_private.family_push_job_eligible(p_job app_private.family_push_jobs)
returns boolean language sql volatile security invoker set search_path=''
as $$
  select p_job.expires_at>statement_timestamp() and exists(
    select 1 from app_private.family_push_devices device
    join app_private.family_push_preferences pref on pref.user_id=device.user_id and pref.recipient_role=device.recipient_role and pref.enabled
    join auth.sessions session on session.id=device.session_id and session.user_id=device.user_id and(session.not_after is null or session.not_after>statement_timestamp())
    join public.profiles profile on profile.id=device.user_id and profile.school_id=device.school_id and profile.is_active
    where device.id=p_job.device_id and device.generation=p_job.device_generation and device.user_id=p_job.user_id and device.recipient_role=p_job.recipient_role
      and device.school_id=p_job.school_id and device.revoked_at is null and device.last_seen_at>statement_timestamp()-interval '90 days'
      and(case p_job.kind when 'absence' then pref.absence when 'result_published' then pref.result_published when 'leave_decision' then pref.leave_decision else false end)
      and exists(select 1 from app_private.family_push_event(p_job.kind,p_job.event_id) event where event.user_id=device.user_id and event.recipient_role=device.recipient_role and event.school_id=device.school_id)
  );
$$;

create function app_private.enqueue_family_push_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare event_kind text;event record;
begin
  if tg_table_name='guardian_absence_alerts' then event_kind:='absence'; else event_kind:=new.kind; end if;
  select * into event from app_private.family_push_event(event_kind,new.id);
  if not found or event.event_time<=statement_timestamp()-interval '24 hours' then return new; end if;
  insert into app_private.family_push_jobs(kind,event_id,device_id,device_generation,user_id,recipient_role,school_id,expires_at)
    select event_kind,new.id,device.id,device.generation,event.user_id,event.recipient_role,event.school_id,event.event_time+interval '24 hours'
    from app_private.family_push_devices device
    join app_private.family_push_preferences pref on pref.user_id=device.user_id and pref.recipient_role=device.recipient_role and pref.enabled
    join auth.sessions session on session.id=device.session_id and session.user_id=device.user_id and(session.not_after is null or session.not_after>statement_timestamp())
    where device.user_id=event.user_id and device.recipient_role=event.recipient_role and device.school_id=event.school_id and device.revoked_at is null
      and device.last_seen_at>statement_timestamp()-interval '90 days'
      and(case event_kind when 'absence' then pref.absence when 'result_published' then pref.result_published when 'leave_decision' then pref.leave_decision else false end)
    on conflict(kind,event_id,device_id,device_generation) do nothing;
  return new;
end;
$$;
create trigger enqueue_native_absence_push after insert on app_private.guardian_absence_alerts for each row execute function app_private.enqueue_family_push_event();
create trigger enqueue_native_family_push after insert on app_private.family_notifications for each row execute function app_private.enqueue_family_push_event();

create function app_private.claim_family_push_jobs(p_batch_id uuid,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare batch app_private.family_push_batches;job app_private.family_push_jobs;items jsonb:='[]'::jsonb;lease uuid;
begin
  perform app_private.family_push_service();
  if p_batch_id is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'Invalid dispatch batch.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_batch:'||p_batch_id::text,0));
  select * into batch from app_private.family_push_batches where id=p_batch_id;
  if found then return case when batch.expires_at>statement_timestamp() then batch.jobs else '[]'::jsonb end; end if;
  for job in select * from app_private.family_push_jobs where(status='queued' and next_attempt_at<=statement_timestamp())
      or(status='leased' and lease_until<=statement_timestamp()) order by next_attempt_at,created_at,id limit p_limit for update skip locked loop
    if not app_private.family_push_job_eligible(job) or job.attempts>=5 then
      update app_private.family_push_jobs set status=case when attempts>=5 then 'failed' else 'cancelled' end,
        result_code=case when attempts>=5 then 'attempts_exhausted' else 'no_longer_eligible' end,finished_at=statement_timestamp() where id=job.id;
      continue;
    end if;
    lease:=gen_random_uuid();
    update app_private.family_push_jobs set status='leased',batch_id=p_batch_id,lease_id=lease,lease_until=statement_timestamp()+interval '5 minutes',prepared_at=null,
      last_outcome=null,result_code=null,provider_id=null where id=job.id;
    items:=items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',job.id,'lease_id',lease));
  end loop;
  insert into app_private.family_push_batches(id,expires_at,jobs) values(p_batch_id,statement_timestamp()+interval '5 minutes',items);
  return items;
end;
$$;

create function app_private.prepare_family_push_job(p_job_id uuid,p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare job app_private.family_push_jobs;device app_private.family_push_devices;target_device uuid;
begin
  perform app_private.family_push_service();
  select device_id into target_device from app_private.family_push_jobs where id=p_job_id;
  perform 1 from app_private.family_push_devices where id=target_device for update;
  select * into job from app_private.family_push_jobs where id=p_job_id for update;
  if not found or job.status<>'leased' or job.lease_id is distinct from p_lease_id or job.lease_until<=statement_timestamp() or job.prepared_at is not null then return null; end if;
  if not app_private.family_push_job_eligible(job) or job.attempts>=5 then
    update app_private.family_push_jobs set status=case when attempts>=5 then 'failed' else 'cancelled' end,
      result_code=case when attempts>=5 then 'attempts_exhausted' else 'no_longer_eligible' end,finished_at=statement_timestamp() where id=job.id;
    return null;
  end if;
  select * into device from app_private.family_push_devices where id=job.device_id;
  update app_private.family_push_jobs set attempts=attempts+1,prepared_at=statement_timestamp() where id=job.id;
  return pg_catalog.jsonb_build_object('job_id',job.id,'lease_id',job.lease_id,'device_fid',device.device_fid,'platform',device.platform,
    'kind',job.kind,'event_id',job.event_id,'recipient_role',job.recipient_role,'expires_at',job.expires_at);
end;
$$;

create function app_private.finish_family_push_job(p_job_id uuid,p_lease_id uuid,p_outcome text,p_code text default null,p_provider_id text default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path=''
as $$
declare job app_private.family_push_jobs;delay integer;target_device uuid;
begin
  perform app_private.family_push_service();
  if p_outcome is null or p_outcome not in('accepted','retry','invalid_token','failed')
    or(p_code is not null and p_code!~'^[A-Za-z0-9_]{1,64}$')
    or(p_provider_id is not null and(length(p_provider_id)>512 or p_provider_id!~'^[A-Za-z0-9_:/%+~.=-]+$'))
    or(p_retry_after_seconds is not null and p_retry_after_seconds not between 1 and 86400) then
    raise exception 'Invalid dispatch outcome.' using errcode='22023';
  end if;
  select device_id into target_device from app_private.family_push_jobs where id=p_job_id;
  perform 1 from app_private.family_push_devices where id=target_device for update;
  select * into job from app_private.family_push_jobs where id=p_job_id for update;
  if not found or job.lease_id is distinct from p_lease_id then return false; end if;
  if job.last_outcome is not null then return job.last_outcome=p_outcome; end if;
  if job.status<>'leased' or job.prepared_at is null or job.lease_until<=statement_timestamp() then return false; end if;
  if not app_private.family_push_job_eligible(job) then
    update app_private.family_push_jobs set status='cancelled',result_code='no_longer_eligible',finished_at=statement_timestamp() where id=job.id;
    return false;
  end if;
  if p_outcome='invalid_token' then
    update app_private.family_push_devices set revoked_at=coalesce(revoked_at,statement_timestamp()),generation=generation+1
      where id=job.device_id and generation=job.device_generation;
    update app_private.family_push_jobs set status='cancelled',result_code='device_invalid',finished_at=statement_timestamp()
      where device_id=job.device_id and device_generation=job.device_generation and id<>job.id and status in('queued','leased');
  end if;
  delay:=least(86400,greatest(60,least(3600,60*(2^(job.attempts-1))::int),coalesce(p_retry_after_seconds,0)));
  update app_private.family_push_jobs set status=case when p_outcome='accepted' then 'accepted' when p_outcome='retry' and attempts<5 and statement_timestamp()+pg_catalog.make_interval(secs=>delay)<expires_at then 'queued' else 'failed' end,
    next_attempt_at=case when p_outcome='retry' then statement_timestamp()+pg_catalog.make_interval(secs=>delay) else next_attempt_at end,
    last_outcome=p_outcome,result_code=p_code,provider_id=case when p_outcome='accepted' then p_provider_id else null end,finished_at=statement_timestamp() where id=job.id;
  return true;
end;
$$;

create function public.get_my_family_push_settings(p_role text) returns jsonb language sql security invoker set search_path='' as $$ select app_private.get_my_family_push_settings(p_role); $$;
create function public.set_my_family_push_preferences(p_role text,p_enabled boolean,p_absence boolean,p_result_published boolean,p_leave_decision boolean,p_expected_version integer)
  returns jsonb language sql security invoker set search_path='' as $$ select app_private.set_my_family_push_preferences(p_role,p_enabled,p_absence,p_result_published,p_leave_decision,p_expected_version); $$;
create function public.register_my_family_push_device(p_role text,p_installation_id uuid,p_installation_secret text,p_fid text,p_platform text,p_label text)
  returns jsonb language sql security invoker set search_path='' as $$ select app_private.register_my_family_push_device(p_role,p_installation_id,p_installation_secret,p_fid,p_platform,p_label); $$;
create function public.revoke_my_family_push_device(p_role text,p_device_id uuid) returns boolean language sql security invoker set search_path='' as $$ select app_private.revoke_my_family_push_device(p_role,p_device_id); $$;
create function public.claim_family_push_jobs(p_batch_id uuid,p_limit integer default 20) returns jsonb language sql security invoker set search_path='' as $$ select app_private.claim_family_push_jobs(p_batch_id,p_limit); $$;
create function public.prepare_family_push_job(p_job_id uuid,p_lease_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select app_private.prepare_family_push_job(p_job_id,p_lease_id); $$;
create function public.finish_family_push_job(p_job_id uuid,p_lease_id uuid,p_outcome text,p_code text default null,p_provider_id text default null,p_retry_after_seconds integer default null)
  returns boolean language sql security invoker set search_path='' as $$ select app_private.finish_family_push_job(p_job_id,p_lease_id,p_outcome,p_code,p_provider_id,p_retry_after_seconds); $$;

revoke all on function app_private.family_push_service(),app_private.family_push_event(text,uuid),app_private.family_push_job_eligible(app_private.family_push_jobs),app_private.enqueue_family_push_event(),
 app_private.get_my_family_push_settings(text),public.get_my_family_push_settings(text),
 app_private.set_my_family_push_preferences(text,boolean,boolean,boolean,boolean,integer),public.set_my_family_push_preferences(text,boolean,boolean,boolean,boolean,integer),
 app_private.register_my_family_push_device(text,uuid,text,text,text,text),public.register_my_family_push_device(text,uuid,text,text,text,text),
 app_private.revoke_my_family_push_device(text,uuid),public.revoke_my_family_push_device(text,uuid),
 app_private.claim_family_push_jobs(uuid,integer),public.claim_family_push_jobs(uuid,integer),
 app_private.prepare_family_push_job(uuid,uuid),public.prepare_family_push_job(uuid,uuid),
 app_private.finish_family_push_job(uuid,uuid,text,text,text,integer),public.finish_family_push_job(uuid,uuid,text,text,text,integer)
 from public,anon,authenticated,service_role;
grant execute on function app_private.get_my_family_push_settings(text),public.get_my_family_push_settings(text),
 app_private.set_my_family_push_preferences(text,boolean,boolean,boolean,boolean,integer),public.set_my_family_push_preferences(text,boolean,boolean,boolean,boolean,integer),
 app_private.register_my_family_push_device(text,uuid,text,text,text,text),public.register_my_family_push_device(text,uuid,text,text,text,text),
 app_private.revoke_my_family_push_device(text,uuid),public.revoke_my_family_push_device(text,uuid) to authenticated;
grant execute on function app_private.claim_family_push_jobs(uuid,integer),public.claim_family_push_jobs(uuid,integer),
 app_private.prepare_family_push_job(uuid,uuid),public.prepare_family_push_job(uuid,uuid),
 app_private.finish_family_push_job(uuid,uuid,text,text,text,integer),public.finish_family_push_job(uuid,uuid,text,text,text,integer) to service_role;
commit;
