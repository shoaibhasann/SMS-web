begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Server-side Auth calls share the host's egress IP, so anonymous auth endpoints throttle per client here.
create table app_private.auth_endpoint_attempts(
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('admin_email_request','admin_email_verify','recovery_request','recovery_mfa')),
  subject_hash bytea not null check (pg_catalog.octet_length(subject_hash)=32),
  attempted_at timestamptz not null default clock_timestamp()
);
alter table app_private.auth_endpoint_attempts enable row level security;
revoke all on table app_private.auth_endpoint_attempts from public,anon,authenticated,service_role;
create index auth_endpoint_attempts_bucket on app_private.auth_endpoint_attempts(action,subject_hash,attempted_at);
create index auth_endpoint_attempts_time on app_private.auth_endpoint_attempts(attempted_at);

-- p_ip_hash is the app's keyed HMAC of the client network (IPv6 per /64), so raw addresses never reach the database.
create function public.consume_auth_endpoint_attempt(p_action text,p_ip_hash text,p_subject text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare
  instant timestamptz; ip_digest bytea; subject_digest bytea; lock_key bigint;
  subject_limit integer:=case when p_action in ('admin_email_request','recovery_request') then 3 else 10 end;
begin
  if p_action is null or p_action not in ('admin_email_request','admin_email_verify','recovery_request','recovery_mfa')
    or (p_ip_hash is not null and p_ip_hash!~'^[a-f0-9]{64}$')
    or p_subject is null or pg_catalog.btrim(p_subject)='' or pg_catalog.length(p_subject)>320 then
    raise exception 'Invalid auth throttle request.' using errcode='22023';
  end if;
  ip_digest:=pg_catalog.decode(p_ip_hash,'hex');
  subject_digest:=pg_catalog.sha256(pg_catalog.convert_to('subject:'||pg_catalog.lower(pg_catalog.btrim(p_subject)),'UTF8'));
  -- One lock per (action, key), taken in sorted order so concurrent calls never deadlock or queue behind unrelated targets.
  for lock_key in select distinct pg_catalog.hashtextextended('auth-endpoint-throttle:'||p_action||':'||pg_catalog.encode(keys.digest,'hex'),0)
    from (values(ip_digest),(subject_digest)) keys(digest) where keys.digest is not null order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(lock_key);
  end loop;
  instant:=clock_timestamp();
  with expired as(select a.id from app_private.auth_endpoint_attempts a
    -- skip locked: concurrent callers prune disjoint expired rows instead of queueing on each other.
    where a.attempted_at<instant-interval '1 day' order by a.attempted_at limit 500 for update skip locked)
    delete from app_private.auth_endpoint_attempts a using expired where a.id=expired.id;
  -- Refused attempts are not recorded, so a lockout ends fifteen minutes after the last allowed attempt.
  if (ip_digest is not null and (select count(*) from app_private.auth_endpoint_attempts a
        where a.action=p_action and a.subject_hash=ip_digest and a.attempted_at>instant-interval '15 minutes')>=10)
    or (select count(*) from app_private.auth_endpoint_attempts a
        where a.action=p_action and a.subject_hash=subject_digest and a.attempted_at>instant-interval '15 minutes')>=subject_limit then
    return false;
  end if;
  insert into app_private.auth_endpoint_attempts(action,subject_hash,attempted_at)
    select p_action,digest,instant from (values(ip_digest),(subject_digest)) keys(digest) where digest is not null;
  return true;
end;
$$;

revoke all on function public.consume_auth_endpoint_attempt(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.consume_auth_endpoint_attempt(text,text,text) to service_role;

commit;
