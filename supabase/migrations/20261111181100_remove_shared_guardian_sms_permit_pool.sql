-- Anonymous CAPTCHA permits no longer draw from one platform-wide daily pool that unregistered numbers
-- could exhaust for every school. Permits stay limited per phone (60 s) and per client IP bucket
-- (IPv4 address or IPv6 /64, hashed by the app; 20/hour). Billed SMS remains capped per school, per
-- phone and by a configured global ceiling in reserve_guardian_sms, which only counts eligible accounts.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function app_private.authorize_guardian_sms_request(p_phone text,p_ip_hash text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare phone_digest bytea; ip_digest bytea; instant timestamptz;
begin
  if p_phone is null or p_phone!~'^\+91[6-9][0-9]{9}$' or p_ip_hash is null or p_ip_hash!~'^[a-f0-9]{64}$' then
    raise exception 'Invalid SMS verification request.' using errcode='22023';
  end if;
  phone_digest:=pg_catalog.sha256(pg_catalog.convert_to(p_phone,'UTF8'));
  ip_digest:=pg_catalog.decode(p_ip_hash,'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guardian-sms-permit',0));
  instant:=clock_timestamp();
  with expired as(select p.id from app_private.guardian_sms_permits p
    where p.issued_at<instant-interval '7 days' and p.expires_at<instant-interval '7 days'
    order by p.issued_at limit 500)
    delete from app_private.guardian_sms_permits p using expired where p.id=expired.id;
  if exists(select 1 from app_private.guardian_sms_permits p where p.phone_hash=phone_digest and p.issued_at>instant-interval '60 seconds')
    or (select count(*) from app_private.guardian_sms_permits p where p.ip_hash=ip_digest and p.issued_at>instant-interval '1 hour')>=20 then
    return false;
  end if;
  insert into app_private.guardian_sms_permits(phone_hash,ip_hash,issued_at,expires_at)
    values(phone_digest,ip_digest,instant,instant+interval '90 seconds');
  return true;
end;
$$;
revoke all on function app_private.authorize_guardian_sms_request(text,text),public.authorize_guardian_sms_request(text,text)
  from public,anon,authenticated,service_role;
grant execute on function app_private.authorize_guardian_sms_request(text,text),public.authorize_guardian_sms_request(text,text) to service_role;

commit;
