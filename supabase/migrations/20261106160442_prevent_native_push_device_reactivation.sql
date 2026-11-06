begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- A remotely revoked installation cannot silently re-enable itself on app refresh.
create or replace function app_private.register_my_family_push_device(p_role text,p_installation_id uuid,p_installation_secret text,p_fid text,p_platform text,p_label text)
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
  if found and(previous.revoked_at is not null or previous.installation_hash<>proof or previous.user_id<>actor or previous.recipient_role<>p_role or previous.school_id<>school) then
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

commit;
