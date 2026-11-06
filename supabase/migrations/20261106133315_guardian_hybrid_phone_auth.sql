begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_private.guardian_invitations alter column email drop not null;
alter table app_private.guardian_invitations add column phone text;
alter table app_private.guardian_invitations add constraint guardian_invitation_recipient_channel
  check ((email is null) <> (phone is null));
alter table app_private.guardian_invitations add constraint guardian_invitation_indian_phone
  check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$');
create unique index guardian_invitations_pending_phone_recipient
  on app_private.guardian_invitations(student_id,phone)
  where phone is not null and accepted_at is null and revoked_at is null;
create index guardian_invitations_pending_phone
  on app_private.guardian_invitations(phone,expires_at)
  where phone is not null and accepted_at is null and revoked_at is null;

-- A phone challenge must never become a weaker login for a privileged account.
create function app_private.guardian_phone_recipient_allowed(p_phone text,p_school_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select p_phone ~ '^\+91[6-9][0-9]{9}$'
    and not exists (
      select 1 from auth.users u where app_private.guardian_e164_phone(u.phone)=p_phone
        and (u.is_anonymous or u.deleted_at is not null or u.banned_until>statement_timestamp()
          or exists(select 1 from public.user_roles r where r.user_id=u.id and (r.role<>'parent' or r.school_id is distinct from p_school_id))
          or exists(select 1 from public.profiles p where p.id=u.id and (not p.is_active or (p.school_id is not null and p.school_id<>p_school_id)))
          or (u.phone_confirmed_at is null and u.email_confirmed_at is not null
            and exists(select 1 from public.parents p where p.profile_id=u.id)))
    )
    and not exists (
      select 1 from public.parents p left join auth.users u on u.id=p.profile_id
      where pg_catalog.regexp_replace(coalesce(p.registered_mobile,''),'[^0-9]','','g')
        in (pg_catalog.substr(p_phone,2),pg_catalog.substr(p_phone,4),'0'||pg_catalog.substr(p_phone,4))
        and (u.id is null or u.phone_confirmed_at is null or app_private.guardian_e164_phone(u.phone) is distinct from p_phone)
    )
    and not exists (
      select 1 from app_private.guardian_invitations i where i.phone=p_phone and i.school_id<>p_school_id
        and i.accepted_at is null and i.revoked_at is null and i.expires_at>statement_timestamp()
    );
$$;

create function app_private.guardian_hybrid_actor()
returns uuid language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.student_leave_actor(); session_text text:=auth.jwt()->>'session_id';
begin
  if session_text is null or session_text!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
    raise exception 'A current verified school session is required.' using errcode='42501';
  end if;
  perform 1 from auth.sessions s where s.id=session_text::uuid and s.user_id=actor
    and(s.not_after is null or s.not_after>statement_timestamp()) for share;
  if not found then raise exception 'A current verified school session is required.' using errcode='42501'; end if;
  return actor;
end;
$$;

create function app_private.write_guardian_phone_invitation(
  p_school_id uuid,p_student_id uuid,p_phone text,p_actor_id uuid,p_revocation_id uuid
)
returns jsonb language plpgsql set search_path=''
as $$
declare invite_token text; invitation app_private.guardian_invitations%rowtype;
begin
  if p_phone is null or p_phone!~'^\+91[6-9][0-9]{9}$' then
    raise exception 'Enter a valid Indian mobile number with +91.' using errcode='22023';
  end if;
  perform 1 from public.students s
    join public.enrollments e on e.student_id=s.id and e.status='active'
    join public.academic_years y on y.id=e.academic_year_id and y.school_id=s.school_id and y.is_current
    where s.id=p_student_id and s.school_id=p_school_id and s.status='active' for share of s,e,y;
  if not found then raise exception 'Choose an active student enrolled in the current year.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guardian-phone-invitation:'||p_phone,0));
  if not app_private.guardian_phone_recipient_allowed(p_phone,p_school_id) then
    raise exception 'This mobile is already associated with an account or school record. Enroll it from the existing guardian account or ask the school to resolve the records.' using errcode='22023';
  end if;
  update app_private.guardian_invitations set revoked_at=clock_timestamp()
    where school_id=p_school_id and student_id=p_student_id and phone=p_phone
      and accepted_at is null and revoked_at is null;
  invite_token:=pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
  insert into app_private.guardian_invitations(school_id,student_id,phone,token_hash,created_by,expires_at,restores_revocation_id)
    values(p_school_id,p_student_id,p_phone,pg_catalog.sha256(pg_catalog.convert_to(invite_token,'UTF8')),p_actor_id,
      clock_timestamp()+interval '72 hours',p_revocation_id) returning * into invitation;
  return pg_catalog.jsonb_build_object('id',invitation.id,'token',invite_token,'expires_at',invitation.expires_at);
end;
$$;

create function app_private.issue_guardian_phone_invitation(p_school_id uuid,p_student_id uuid,p_phone text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.guardian_hybrid_actor();
begin
  if not app_private.can_manage_guardian_invitations(actor,p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode='42501';
  end if;
  return app_private.write_guardian_phone_invitation(p_school_id,p_student_id,p_phone,actor,null);
end;
$$;
create function public.issue_guardian_phone_invitation(p_school_id uuid,p_student_id uuid,p_phone text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.issue_guardian_phone_invitation(p_school_id,p_student_id,p_phone); $$;

-- The server verifies CAPTCHA before issuing these short single-use permits.
create table app_private.guardian_sms_permits(
  id uuid primary key default gen_random_uuid(), phone_hash bytea not null, ip_hash bytea not null,
  issued_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null, consumed_at timestamptz,
  check(pg_catalog.octet_length(phone_hash)=32 and pg_catalog.octet_length(ip_hash)=32),
  check(expires_at>issued_at)
);
alter table app_private.guardian_sms_permits enable row level security;
revoke all on table app_private.guardian_sms_permits from public,anon,authenticated,service_role;
create index guardian_sms_permits_phone_time on app_private.guardian_sms_permits(phone_hash,issued_at desc);
create index guardian_sms_permits_ip_time on app_private.guardian_sms_permits(ip_hash,issued_at desc);
create index guardian_sms_permits_time on app_private.guardian_sms_permits(issued_at);

-- Signed first-signup hooks can precede visibility of auth.users. No Auth FK.
create table app_private.guardian_sms_reservations(
  webhook_hash bytea primary key, user_id uuid not null, school_id uuid not null references public.schools(id),
  phone_hash bytea not null, reserved_at timestamptz not null default clock_timestamp(), budget_day date not null,
  check(pg_catalog.octet_length(webhook_hash)=32 and pg_catalog.octet_length(phone_hash)=32)
);
alter table app_private.guardian_sms_reservations enable row level security;
revoke all on table app_private.guardian_sms_reservations from public,anon,authenticated,service_role;
create index guardian_sms_reservations_day on app_private.guardian_sms_reservations(budget_day);
create index guardian_sms_reservations_school_day on app_private.guardian_sms_reservations(school_id,budget_day);
create index guardian_sms_reservations_phone_time on app_private.guardian_sms_reservations(phone_hash,reserved_at desc);

create function app_private.authorize_guardian_sms_request(p_phone text,p_ip_hash text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare phone_digest bytea; ip_digest bytea; instant timestamptz; day_start timestamptz;
begin
  if p_phone is null or p_phone!~'^\+91[6-9][0-9]{9}$' or p_ip_hash is null or p_ip_hash!~'^[a-f0-9]{64}$' then
    raise exception 'Invalid SMS verification request.' using errcode='22023';
  end if;
  phone_digest:=pg_catalog.sha256(pg_catalog.convert_to(p_phone,'UTF8'));
  ip_digest:=pg_catalog.decode(p_ip_hash,'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guardian-sms-permit',0));
  instant:=clock_timestamp();
  day_start:=pg_catalog.date_trunc('day',instant at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  with expired as(select p.id from app_private.guardian_sms_permits p
    where p.issued_at<instant-interval '7 days' and p.expires_at<instant-interval '7 days'
    order by p.issued_at limit 500)
    delete from app_private.guardian_sms_permits p using expired where p.id=expired.id;
  if exists(select 1 from app_private.guardian_sms_permits p where p.phone_hash=phone_digest and p.issued_at>instant-interval '60 seconds')
    or (select count(*) from app_private.guardian_sms_permits p where p.ip_hash=ip_digest and p.issued_at>instant-interval '1 hour')>=20
    or (select count(*) from app_private.guardian_sms_permits p where p.issued_at>=day_start)>=1000 then
    return false;
  end if;
  insert into app_private.guardian_sms_permits(phone_hash,ip_hash,issued_at,expires_at)
    values(phone_digest,ip_digest,instant,instant+interval '90 seconds');
  return true;
end;
$$;
create function public.authorize_guardian_sms_request(p_phone text,p_ip_hash text)
returns boolean language sql security invoker set search_path=''
as $$ select app_private.authorize_guardian_sms_request(p_phone,p_ip_hash); $$;

create function app_private.reserve_guardian_sms(
  p_user_id uuid,p_phone text,p_webhook_id text,p_global_daily_limit integer,p_school_daily_limit integer,p_phone_daily_limit integer
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  phone_digest bytea; event_digest bytea; budget_school uuid; schools uuid[]; existing app_private.guardian_sms_reservations%rowtype;
  instant timestamptz; today date; account auth.users%rowtype; permit_id uuid;
begin
  if p_user_id is null or p_phone is null or p_phone!~'^\+91[6-9][0-9]{9}$'
    or p_webhook_id is null or pg_catalog.length(p_webhook_id) not between 1 and 256 or p_webhook_id!~'^[!-~]+$'
    or p_global_daily_limit is null or p_global_daily_limit not between 1 and 10000
    or p_school_daily_limit is null or p_school_daily_limit not between 1 and 1000
    or p_phone_daily_limit is null or p_phone_daily_limit not between 1 and 10 then
    raise exception 'Invalid SMS reservation request.' using errcode='22023';
  end if;
  phone_digest:=pg_catalog.sha256(pg_catalog.convert_to(p_phone,'UTF8'));
  event_digest:=pg_catalog.sha256(pg_catalog.convert_to(p_webhook_id,'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guardian-sms-budget',0));
  instant:=clock_timestamp(); today:=(instant at time zone 'Asia/Kolkata')::date;
  with expired as(select r.webhook_hash from app_private.guardian_sms_reservations r
    where r.budget_day<today-29 and r.reserved_at<instant-interval '30 days'
    order by r.budget_day limit 500)
    delete from app_private.guardian_sms_reservations r using expired where r.webhook_hash=expired.webhook_hash;
  select * into existing from app_private.guardian_sms_reservations r where r.webhook_hash=event_digest;
  if found then
    return pg_catalog.jsonb_build_object('send',false,'reason',
      case when existing.user_id=p_user_id and existing.phone_hash=phone_digest then 'duplicate' else 'ineligible' end);
  end if;
  select * into account from auth.users u where u.id=p_user_id;
  if found and(account.is_anonymous or account.deleted_at is not null or account.banned_until>instant
    or exists(select 1 from public.profiles p where p.id=p_user_id and not p.is_active)) then
    return pg_catalog.jsonb_build_object('send',false,'reason','ineligible');
  end if;
  if exists(select 1 from public.user_roles r where r.user_id=p_user_id and r.role<>'parent')
    or exists(select 1 from auth.users u where app_private.guardian_e164_phone(u.phone)=p_phone and u.id<>p_user_id) then
    return pg_catalog.jsonb_build_object('send',false,'reason','ineligible');
  end if;

  select pg_catalog.array_agg(distinct eligible.school_id) into schools from (
    select p.school_id from app_private.guardian_contact_parent(p_user_id) p
      where account.id is not null and account.phone_confirmed_at is not null
        and app_private.guardian_e164_phone(account.phone)=p_phone
    union
    select p.school_id from app_private.guardian_contact_parent(p_user_id) p
      join app_private.guardian_phone_change_authorizations a on a.user_id=p_user_id and a.phone_hash=phone_digest and a.expires_at>instant
      join auth.sessions s on s.id=a.session_id and s.user_id=p_user_id and(s.not_after is null or s.not_after>instant)
    union
    select i.school_id from app_private.guardian_invitations i
      join public.students st on st.id=i.student_id and st.school_id=i.school_id and st.status='active'
      join public.enrollments e on e.student_id=st.id and e.status='active'
      join public.academic_years y on y.id=e.academic_year_id and y.school_id=i.school_id and y.is_current
      where i.phone=p_phone and i.accepted_at is null and i.revoked_at is null and i.expires_at>instant
        and(i.intended_user_id is null or i.intended_user_id=p_user_id)
        and app_private.can_manage_guardian_invitations(i.created_by,i.school_id)
        and exists(select 1 from auth.users issuer where issuer.id=i.created_by and not issuer.is_anonymous
          and issuer.deleted_at is null and(issuer.banned_until is null or issuer.banned_until<=instant)
          and(issuer.email_confirmed_at is not null or issuer.phone_confirmed_at is not null))
        and app_private.guardian_phone_recipient_allowed(p_phone,i.school_id)
        and(account.id is null or app_private.guardian_e164_phone(account.phone)=p_phone)
        and not exists(select 1 from public.user_roles r where r.user_id=p_user_id and r.school_id is distinct from i.school_id)
        and not exists(select 1 from public.profiles p where p.id=p_user_id and p.school_id is not null and p.school_id<>i.school_id)
  ) eligible;
  if pg_catalog.cardinality(schools) is distinct from 1 then
    return pg_catalog.jsonb_build_object('send',false,'reason','ineligible');
  end if;
  budget_school:=schools[1];
  select p.id into permit_id from app_private.guardian_sms_permits p
    where p.phone_hash=phone_digest and p.consumed_at is null and p.expires_at>instant
    order by p.issued_at desc limit 1 for update;
  if not found then return pg_catalog.jsonb_build_object('send',false,'reason','rate_limited'); end if;
  update app_private.guardian_sms_permits set consumed_at=instant where id=permit_id;
  if exists(select 1 from app_private.guardian_sms_reservations r where r.phone_hash=phone_digest and r.reserved_at>instant-interval '60 seconds')
    or(select count(*) from app_private.guardian_sms_reservations r where r.budget_day=today)>=p_global_daily_limit
    or(select count(*) from app_private.guardian_sms_reservations r where r.school_id=budget_school and r.budget_day=today)>=p_school_daily_limit
    or(select count(*) from app_private.guardian_sms_reservations r where r.phone_hash=phone_digest and r.budget_day=today)>=p_phone_daily_limit then
    return pg_catalog.jsonb_build_object('send',false,'reason','rate_limited');
  end if;
  insert into app_private.guardian_sms_reservations(webhook_hash,user_id,school_id,phone_hash,reserved_at,budget_day)
    values(event_digest,p_user_id,budget_school,phone_digest,instant,today);
  return pg_catalog.jsonb_build_object('send',true,'school_id',budget_school);
end;
$$;
create function public.reserve_guardian_sms(
  p_user_id uuid,p_phone text,p_webhook_id text,p_global_daily_limit integer,p_school_daily_limit integer,p_phone_daily_limit integer
)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.reserve_guardian_sms(p_user_id,p_phone,p_webhook_id,p_global_daily_limit,p_school_daily_limit,p_phone_daily_limit); $$;

create or replace function app_private.guard_guardian_invitation_recipient()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  accounts uuid[];
begin
  if tg_op = 'INSERT' then
    if new.phone is not null and not app_private.guardian_phone_recipient_allowed(new.phone,new.school_id) then
      raise exception 'Resolve the existing guardian account before inviting this mobile.' using errcode='22023';
    end if;
    -- A normal MVCC read is deliberate. If an email update is in progress,
    -- attach the invite to the last committed owner rather than waiting for
    -- the address to become reusable or inverting the Auth/approval locks.
    select pg_catalog.array_agg(match.id order by match.id) into accounts from (
      select u.id from auth.users u
      where ((new.phone is null and u.email=new.email) or (new.phone is not null and app_private.guardian_e164_phone(u.phone)=new.phone))
        and not u.is_anonymous and u.deleted_at is null
      order by u.id limit 2
    ) match;
    if pg_catalog.cardinality(accounts) > 1 then
      raise exception 'Resolve the guardian account before issuing an invitation.' using errcode = '22023';
    end if;
    new.intended_user_id := accounts[1];
    if new.restores_revocation_id is not null then
      if not exists (
        select 1 from app_private.guardian_access_audit a
        where a.id = new.restores_revocation_id and a.action = 'revoked' and a.school_id = new.school_id
          and a.student_id = new.student_id and a.guardian_profile_id = new.intended_user_id
      ) then
        raise exception 'This guardian needs an active account with a verified contact.' using errcode = '22023';
      end if;
    elsif new.intended_user_id is not null
      and (app_private.latest_guardian_access_revocation(new.school_id, new.student_id, new.intended_user_id)).id is not null
      and not exists (
        select 1 from public.student_parents sp join public.parents p on p.id = sp.parent_id
        where sp.student_id = new.student_id and p.school_id = new.school_id and p.profile_id = new.intended_user_id
      ) then
      raise exception 'A school administrator must re-invite this guardian from Manage linked guardians.' using errcode = '55000';
    end if;
  elsif old.accepted_at is null and new.accepted_at is not null
    and old.intended_user_id is not null and new.accepted_by is distinct from old.intended_user_id then
    raise exception 'Sign in with the verified account on the invitation.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function app_private.list_guardian_invitations(p_school_id uuid, p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app_private.can_manage_guardian_invitations(auth.uid(), p_school_id)
    or not exists (select 1 from public.students s where s.id = p_student_id and s.school_id = p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;
  return (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.created_at desc, rows.id), '[]'::jsonb)
    from (
      select id, email, phone, created_at, expires_at, accepted_at, revoked_at
      from app_private.guardian_invitations
      where school_id = p_school_id and student_id = p_student_id
      order by created_at desc, id limit 50
    ) rows
  );
end;
$$;

create or replace function app_private.accept_guardian_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  request_actor_id uuid := auth.uid();
  verified_email text;
  verified_phone text;
  invitation app_private.guardian_invitations%rowtype;
  existing_profile public.profiles%rowtype;
  parent_ids uuid[];
  linked_parent_id uuid;
  latest_removal app_private.guardian_access_audit%rowtype;
  relationship_text text := 'guardian';
  is_primary_guardian boolean := false;
  linked_rows integer;
begin
  if request_actor_id is null then
    raise exception 'Sign in with the verified contact on the invitation.' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  -- Serialize acceptances for the same account and prevent a concurrent email
  -- change. A second acceptance of the same token also locks the invitation.
  select case when u.email_confirmed_at is not null then pg_catalog.lower(pg_catalog.btrim(u.email)) end,
    case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end into verified_email,verified_phone
  from auth.users u
  where u.id = request_actor_id and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) and not u.is_anonymous and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if not found or (verified_email is null and verified_phone is null) then
    raise exception 'Sign in with the verified contact on the invitation.' using errcode = '42501';
  end if;

  select * into invitation from app_private.guardian_invitations
  where token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
  for update;
  if not found or invitation.expires_at <= clock_timestamp()
    or invitation.revoked_at is not null or invitation.accepted_at is not null then
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if (invitation.email is not null and invitation.email is distinct from verified_email)
    or (invitation.phone is not null and invitation.phone is distinct from verified_phone)
    or (invitation.intended_user_id is not null and invitation.intended_user_id <> request_actor_id) then
    raise exception 'Sign in with the verified contact on the invitation.' using errcode = '42501';
  end if;

  if invitation.phone is not null then
    perform app_private.guardian_hybrid_actor();
    if not app_private.guardian_phone_recipient_allowed(invitation.phone,invitation.school_id) then
      raise exception 'Resolve the existing guardian account with the school before accepting.' using errcode='42501';
    end if;
    if not exists(select 1 from auth.users issuer where issuer.id=invitation.created_by and not issuer.is_anonymous
      and issuer.deleted_at is null and(issuer.banned_until is null or issuer.banned_until<=clock_timestamp())
      and(issuer.email_confirmed_at is not null or issuer.phone_confirmed_at is not null)) then
      raise exception 'This guardian invitation is unavailable.';
    end if;
    if exists(select 1 from public.user_roles r where r.user_id=request_actor_id and r.role<>'parent') then
      raise exception 'Use the existing staff sign-in for this account.' using errcode='42501';
    end if;
  end if;

  if invitation.phone is not null then
    update app_private.guardian_invitations i set intended_user_id=request_actor_id
      where i.phone=verified_phone and i.school_id=invitation.school_id and i.intended_user_id is null
        and i.accepted_at is null and i.revoked_at is null and i.expires_at>clock_timestamp();
  end if;
  latest_removal := app_private.latest_guardian_access_revocation(invitation.school_id, invitation.student_id, request_actor_id);
  if latest_removal.occurred_at >= invitation.created_at then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  perform 1 from public.students s
  join public.enrollments e on e.student_id = s.id and e.status = 'active'
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  where s.id = invitation.student_id and s.school_id = invitation.school_id and s.status = 'active'
  for share of s, e, y;
  if not found
    or not app_private.can_manage_guardian_invitations(invitation.created_by, invitation.school_id)
    or (invitation.restores_revocation_id is not null
      and not app_private.is_guardian_access_admin(invitation.created_by, invitation.school_id)) then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  select * into existing_profile from public.profiles where id = request_actor_id for update;
  if not found or not existing_profile.is_active
    or (existing_profile.school_id is not null and existing_profile.school_id <> invitation.school_id)
    or exists (
      select 1 from public.user_roles ur where ur.user_id = request_actor_id
        and (ur.role = 'super_admin' or ur.school_id is distinct from invitation.school_id)
    ) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  select array(select p.id from public.parents p where p.profile_id = request_actor_id) into parent_ids;
  if pg_catalog.cardinality(parent_ids) > 1
    or exists (select 1 from public.parents p where p.id = any(parent_ids) and p.school_id <> invitation.school_id) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  linked_parent_id := parent_ids[1];
  if invitation.restores_revocation_id is not null then
    if latest_removal.id is distinct from invitation.restores_revocation_id
      or linked_parent_id is distinct from latest_removal.parent_id
      or exists (
        select 1 from public.student_parents sp where sp.student_id = invitation.student_id and sp.parent_id = linked_parent_id
      ) then
      raise exception 'This guardian invitation is unavailable.';
    end if;
    relationship_text := coalesce(latest_removal.relationship, 'guardian');
    is_primary_guardian := coalesce(latest_removal.was_primary, false);
  elsif latest_removal.id is not null and not exists (
    select 1 from public.student_parents sp where sp.student_id = invitation.student_id and sp.parent_id = linked_parent_id
  ) then
    -- A regular invitation can have been issued before the recipient had this
    -- email. Only an administrator's fresh invitation can restore the pair.
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if linked_parent_id is null then
    insert into public.parents (school_id, profile_id)
    values (invitation.school_id, request_actor_id) returning id into linked_parent_id;
  end if;
  insert into public.student_parents (student_id, parent_id, relationship, is_primary)
  values (invitation.student_id, linked_parent_id, relationship_text, is_primary_guardian)
  on conflict do nothing;

  get diagnostics linked_rows = row_count;
  if linked_rows = 0 and invitation.restores_revocation_id is not null then
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if linked_rows = 1 then
    insert into app_private.guardian_access_audit
      (school_id, student_id, parent_id, guardian_profile_id, actor_id, action, relationship, was_primary)
    values (invitation.school_id, invitation.student_id, linked_parent_id, request_actor_id, request_actor_id,
      'linked', relationship_text, is_primary_guardian);
  end if;
  insert into public.user_roles (user_id, school_id, role)
  values (request_actor_id, invitation.school_id, 'parent')
  on conflict do nothing;
  if verified_phone is not null then
    update public.parents set registered_mobile=verified_phone where id=linked_parent_id and profile_id=request_actor_id;
  end if;
  update public.profiles set school_id = invitation.school_id
  where id = request_actor_id and school_id is null;

  update app_private.guardian_invitations
  set accepted_at = clock_timestamp(), accepted_by = request_actor_id where id = invitation.id;

  return pg_catalog.jsonb_build_object('school_id', invitation.school_id, 'student_id', invitation.student_id);
end;
$$;

create or replace function app_private.reinvite_guardian_access(p_school_id uuid, p_student_id uuid, p_revocation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  removal app_private.guardian_access_audit%rowtype;
  current_removal app_private.guardian_access_audit%rowtype;
  recipient text;
  recipient_phone text;
begin
  if not app_private.is_guardian_access_admin(actor_id, p_school_id) then
    raise exception 'School administrator access is required.' using errcode = '42501';
  end if;

  select * into removal from app_private.guardian_access_audit a
  where a.id = p_revocation_id and a.school_id = p_school_id
    and a.student_id = p_student_id and a.action = 'revoked';
  if not found then
    raise exception 'The guardian removal does not belong to this student and school.' using errcode = '42501';
  end if;

  -- Same account lock as acceptance and removal, also serializing Auth email changes.
  select case when u.email_confirmed_at is not null then nullif(pg_catalog.lower(pg_catalog.btrim(u.email)), '') end,
    case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end into recipient,recipient_phone
  from auth.users u
  where u.id = removal.guardian_profile_id and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
    and not u.is_anonymous and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if recipient is null and recipient_phone is null then
    raise exception 'This guardian needs an active account with a verified contact.' using errcode = '22023';
  end if;

  perform 1 from public.parents p
  join public.profiles profile on profile.id = p.profile_id and profile.is_active
  where p.id = removal.parent_id and p.school_id = p_school_id and p.profile_id = removal.guardian_profile_id
    and (profile.school_id is null or profile.school_id = p_school_id)
    and not exists (
      select 1 from public.parents duplicate where duplicate.profile_id = p.profile_id and duplicate.id <> p.id
    )
    and not exists (
      select 1 from public.user_roles ur where ur.user_id = p.profile_id
        and (ur.role = 'super_admin' or ur.school_id is distinct from p_school_id)
    )
  for share of p, profile;
  if not found then
    raise exception 'This guardian no longer has an eligible account for this school.' using errcode = '22023';
  end if;

  current_removal := app_private.latest_guardian_access_revocation(p_school_id, p_student_id, removal.guardian_profile_id);
  if current_removal.id is distinct from removal.id or exists (
    select 1 from public.student_parents sp where sp.student_id = p_student_id and sp.parent_id = removal.parent_id
  ) then
    raise exception 'Guardian access changed. Reload the student and try again.' using errcode = '55000';
  end if;

  if recipient is not null then
    return app_private.write_guardian_invitation(p_school_id,p_student_id,recipient,actor_id,removal.id)
      || pg_catalog.jsonb_build_object('email',recipient);
  end if;
  perform app_private.guardian_hybrid_actor();
  return app_private.write_guardian_phone_invitation(p_school_id,p_student_id,recipient_phone,actor_id,removal.id)
    || pg_catalog.jsonb_build_object('email',null,'phone',recipient_phone);
end;
$$;

create or replace function app_private.lookup_guardian_access(p_school_id uuid, p_admission_no text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  student_record public.students%rowtype;
begin
  if not app_private.is_guardian_access_admin(auth.uid(), p_school_id) then
    raise exception 'School administrator access is required.' using errcode = '42501';
  end if;

  -- A former student can still have an authorised guardian relationship.
  select * into student_record
  from public.students s
  where s.school_id = p_school_id and s.admission_no = pg_catalog.btrim(p_admission_no);
  if not found then return null; end if;

  return pg_catalog.jsonb_build_object(
    'student_id', student_record.id,
    'student_name', pg_catalog.concat_ws(' ', student_record.first_name, student_record.middle_name, student_record.last_name),
    'admission_no', student_record.admission_no,
    'guardians', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.parent_id), '[]'::jsonb)
      from (
        select p.id as parent_id, p.profile_id is not null as has_account,
          profile.full_name as name, nullif(u.email,'') as email, case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end as phone, sp.relationship
        from public.student_parents sp
        join public.parents p on p.id = sp.parent_id and p.school_id = p_school_id
        left join public.profiles profile on profile.id = p.profile_id
        left join auth.users u on u.id = p.profile_id
        where sp.student_id = student_record.id
      ) rows
    ),
    'reinvitable_guardians', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.name, rows.parent_id), '[]'::jsonb)
      from (
        select a.id as revocation_id, a.parent_id, profile.full_name as name,
          nullif(pg_catalog.lower(pg_catalog.btrim(u.email)),'') as email,
          case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end as phone, a.relationship,
          pending.id as pending_invitation_id, pending.expires_at as pending_expires_at
        from (
          select distinct on (a.guardian_profile_id) a.*
          from app_private.guardian_access_audit a
          where a.school_id = p_school_id and a.student_id = student_record.id and a.action = 'revoked'
          order by a.guardian_profile_id, a.occurred_at desc, a.id desc
        ) a
        join public.parents p on p.id = a.parent_id and p.school_id = p_school_id and p.profile_id = a.guardian_profile_id
        join public.profiles profile on profile.id = p.profile_id and profile.is_active
        join auth.users u on u.id = profile.id and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
          and not u.is_anonymous and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= statement_timestamp())
        left join app_private.guardian_invitations pending on pending.student_id = student_record.id
          and pending.school_id = p_school_id and (pending.email = pg_catalog.lower(pg_catalog.btrim(u.email))
            or pending.phone=app_private.guardian_e164_phone(u.phone))
          and pending.restores_revocation_id = a.id
          and pending.revoked_at is null and pending.accepted_at is null and pending.expires_at > statement_timestamp()
        where student_record.status = 'active'
          and exists (
            select 1 from public.enrollments e
            join public.academic_years y on y.id = e.academic_year_id and y.school_id = p_school_id and y.is_current
            where e.student_id = student_record.id and e.status = 'active'
          )
          and ((u.email_confirmed_at is not null and pg_catalog.lower(pg_catalog.btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
            and pg_catalog.length(pg_catalog.btrim(u.email))<=254)
            or (u.phone_confirmed_at is not null and app_private.guardian_e164_phone(u.phone) ~ '^\+91[6-9][0-9]{9}$'))
          and (profile.school_id is null or profile.school_id = p_school_id)
          and not exists (
            select 1 from public.parents duplicate where duplicate.profile_id = p.profile_id and duplicate.id <> p.id
          )
          and not exists (
            select 1 from public.user_roles ur where ur.user_id = p.profile_id
              and (ur.role = 'super_admin' or ur.school_id is distinct from p_school_id)
          )
          and not exists (
            select 1 from public.student_parents sp where sp.student_id = student_record.id and sp.parent_id = p.id
          )
        order by a.occurred_at desc, a.id desc limit 50
      ) rows
    ),
    'events', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.occurred_at desc, rows.id), '[]'::jsonb)
      from (
        select a.id, a.action, a.reason, a.occurred_at, actor.full_name as actor_name, guardian.full_name as guardian_name
        from app_private.guardian_access_audit a
        left join public.profiles actor on actor.id = a.actor_id
        left join public.profiles guardian on guardian.id = a.guardian_profile_id
        where a.school_id = p_school_id and a.student_id = student_record.id
        order by a.occurred_at desc, a.id limit 50
      ) rows
    )
  );
end;
$$;

create or replace function app_private.authorize_my_guardian_phone_change(p_phone text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  requested_phone text := app_private.guardian_e164_phone(p_phone);
  previous_phone text;
begin
  select case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end into previous_phone
  from auth.users u
  where u.id = actor_id and not u.is_anonymous and u.deleted_at is null
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if not found or not exists (select 1 from app_private.guardian_contact_parent(actor_id))
    or not exists (
      select 1 from auth.sessions s
      join auth.mfa_amr_claims amr on amr.session_id = s.id
        and(amr.authentication_method='password' or(amr.authentication_method='otp' and previous_phone is not null
          and exists(select 1 from auth.users proof_user where proof_user.id=actor_id and proof_user.email_confirmed_at is null)))
      where s.id = actor_session_id and s.user_id = actor_id
        and (s.not_after is null or s.not_after > statement_timestamp())
        and amr.created_at between statement_timestamp() - interval '5 minutes' and statement_timestamp()
    ) then
    raise exception 'Verify your current password or current mobile again before changing the number.' using errcode = '42501';
  end if;
  if requested_phone is null or requested_phone is not distinct from previous_phone then
    raise exception 'Enter a different mobile number in international format.' using errcode = '22023';
  end if;

  insert into app_private.guardian_phone_change_authorizations(user_id, session_id, phone_hash, expires_at)
  values (actor_id, actor_session_id, pg_catalog.sha256(pg_catalog.convert_to(requested_phone, 'UTF8')),
    clock_timestamp() + interval '5 minutes')
  on conflict (user_id) do update set session_id = excluded.session_id, phone_hash = excluded.phone_hash,
    expires_at = excluded.expires_at, started_at = null;
  return true;
end;
$$;

create or replace function app_private.follow_guardian_auth_contact()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  previous_email text := nullif(pg_catalog.lower(pg_catalog.btrim(old.email)), '');
  current_email text := nullif(pg_catalog.lower(pg_catalog.btrim(new.email)), '');
  previous_mobile text:=case when old.phone_confirmed_at is not null then app_private.guardian_e164_phone(old.phone) end;
  current_mobile text:=case when new.phone_confirmed_at is not null then app_private.guardian_e164_phone(new.phone) end;
  retired_invites integer := 0;
  guardian public.parents%rowtype;
begin
  if previous_email is not null and previous_email is distinct from current_email then
    -- The former address is retired by Auth itself. Invalidate outstanding
    -- links to that address without touching verified child relationships.
    update app_private.guardian_invitations i
    set revoked_at = clock_timestamp()
    where i.email = previous_email and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > clock_timestamp()
      and (i.intended_user_id is null or i.intended_user_id = old.id);
    get diagnostics retired_invites = row_count;
  end if;

  if previous_mobile is not null and previous_mobile is distinct from current_mobile then
    update app_private.guardian_invitations i set revoked_at=clock_timestamp()
      where i.phone=previous_mobile and i.accepted_at is null and i.revoked_at is null
        and(i.intended_user_id is null or i.intended_user_id=old.id);
  end if;

  if new.is_anonymous or new.deleted_at is not null
    or (new.banned_until is not null and new.banned_until > clock_timestamp()) then
    return new;
  end if;
  select * into guardian from app_private.guardian_contact_parent(new.id);
  if not found then return new; end if;

  if current_email is not null and previous_email is distinct from current_email and new.email_confirmed_at is not null then
    insert into app_private.guardian_contact_audit(school_id, parent_id, actor_id, action, revoked_invite_count)
    values (guardian.school_id, guardian.id, new.id, 'email_changed', retired_invites);
  end if;

  if current_mobile is distinct from previous_mobile then
    if current_mobile is not null then
      update public.parents set registered_mobile = current_mobile
      where id = guardian.id and profile_id = new.id and registered_mobile is distinct from current_mobile;
      insert into app_private.guardian_contact_audit(school_id, parent_id, actor_id, action)
      values (guardian.school_id, guardian.id, new.id, 'mobile_verified');
    elsif previous_mobile is not null then
      -- Only clear a value that mirrors the removed Auth phone. A preexisting
      -- school-recorded number is separate and is not proof of verification.
      update public.parents set registered_mobile = null
      where id = guardian.id and profile_id = new.id and registered_mobile = previous_mobile;
      insert into app_private.guardian_contact_audit(school_id, parent_id, actor_id, action)
      values (guardian.school_id, guardian.id, new.id, 'mobile_removed');
    end if;
  end if;

  return new;
end;
$$;

create or replace function app_private.guard_guardian_auth_contact()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  previous_email text := nullif(pg_catalog.lower(pg_catalog.btrim(old.email)), '');
  current_email text := nullif(pg_catalog.lower(pg_catalog.btrim(new.email)), '');
  new_mobile text := app_private.guardian_e164_phone(new.phone);
  pending_mobile text := app_private.guardian_e164_phone(new.phone_change);
begin
  if new.deleted_at is not null or not exists (
    select 1 from public.parents p
    join public.student_parents sp on sp.parent_id = p.id
    join public.students s on s.id = sp.student_id and s.school_id = p.school_id
    where p.profile_id = old.id
  ) then
    return new;
  end if;

  if old.phone_confirmed_at is not null and app_private.guardian_e164_phone(old.phone) is not null
    and new_mobile is null and new.email_confirmed_at is null then
    raise exception 'Verify a replacement sign-in contact before removing this mobile.' using errcode='42501';
  end if;

  -- GoTrue records the first secure-email challenge as 1. It clears the
  -- pending address and resets the status only after both inboxes confirm.
  if previous_email is not null and current_email is distinct from previous_email
    and (current_email is null or current_email is distinct from pg_catalog.lower(pg_catalog.btrim(old.email_change))
      or old.email_change_confirm_status is distinct from 1 or nullif(new.email_change, '') is not null
      or new.email_change_confirm_status is distinct from 0 or new.email_confirmed_at is null) then
    raise exception 'Confirm the change in both the current and new email inboxes.' using errcode = '42501';
  end if;

  if nullif(new.phone_change, '') is not null and (new.phone_change is distinct from old.phone_change
    or new.phone_change_sent_at is distinct from old.phone_change_sent_at
    or (nullif(new.phone_change_token, '') is not null and new.phone_change_token is distinct from old.phone_change_token)) then
    update app_private.guardian_phone_change_authorizations a set started_at = clock_timestamp()
    where a.user_id = old.id and a.started_at is null and a.expires_at > clock_timestamp()
      and a.phone_hash = pg_catalog.sha256(pg_catalog.convert_to(pending_mobile, 'UTF8'))
      and new.phone_change_sent_at is not null and nullif(new.phone_change_token, '') is not null;
    if not found then
      raise exception 'Verify your current sign-in again before requesting a mobile code.' using errcode = '42501';
    end if;
  end if;

  if nullif(new.phone, '') is not null and new.phone is distinct from old.phone then
    if new_mobile is null or new_mobile is distinct from app_private.guardian_e164_phone(old.phone_change)
      or nullif(new.phone_change, '') is not null or new.phone_confirmed_at is null
      or new.phone_confirmed_at is not distinct from old.phone_confirmed_at then
      raise exception 'Verify the new mobile number using its confirmation code.' using errcode = '42501';
    end if;
    delete from app_private.guardian_phone_change_authorizations a
    where a.user_id = old.id and a.started_at is not null and a.expires_at > clock_timestamp()
      and a.phone_hash = pg_catalog.sha256(pg_catalog.convert_to(new_mobile, 'UTF8'));
    if not found then
      raise exception 'Request a fresh mobile code after verifying your current sign-in.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guardian_phone_recipient_allowed(text,uuid),app_private.guardian_hybrid_actor(),
  app_private.write_guardian_phone_invitation(uuid,uuid,text,uuid,uuid),
  app_private.issue_guardian_phone_invitation(uuid,uuid,text),public.issue_guardian_phone_invitation(uuid,uuid,text),
  app_private.authorize_guardian_sms_request(text,text),public.authorize_guardian_sms_request(text,text),
  app_private.reserve_guardian_sms(uuid,text,text,integer,integer,integer),public.reserve_guardian_sms(uuid,text,text,integer,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function app_private.issue_guardian_phone_invitation(uuid,uuid,text),public.issue_guardian_phone_invitation(uuid,uuid,text) to authenticated;
grant execute on function app_private.authorize_guardian_sms_request(text,text),public.authorize_guardian_sms_request(text,text),
  app_private.reserve_guardian_sms(uuid,text,text,integer,integer,integer),public.reserve_guardian_sms(uuid,text,text,integer,integer,integer) to service_role;

commit;
