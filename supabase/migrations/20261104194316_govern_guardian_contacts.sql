begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Bind links to a known Auth account at issuance. Keep this UUID even if the
-- account is deleted so a later owner of the same address cannot reuse a link.
alter table app_private.guardian_invitations
  add column intended_user_id uuid,
  add constraint guardian_invitation_intended_user_check check (
    accepted_by is null or intended_user_id is null or accepted_by = intended_user_id
  );

create index guardian_invitations_pending_email
  on app_private.guardian_invitations (email)
  where accepted_at is null and revoked_at is null;

with candidates as (
  select i.id, pg_catalog.array_agg(u.id order by u.id) as accounts
  from app_private.guardian_invitations i
  join auth.users u on u.email = i.email and not u.is_anonymous and u.deleted_at is null
  where i.accepted_at is null and i.revoked_at is null and i.expires_at > statement_timestamp()
  group by i.id
)
update app_private.guardian_invitations i
set intended_user_id = case when pg_catalog.cardinality(c.accounts) = 1 then c.accounts[1] end,
    revoked_at = case when pg_catalog.cardinality(c.accounts) > 1 then clock_timestamp() end
from candidates c
where i.id = c.id;

create function app_private.guard_guardian_invitation_recipient()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  accounts uuid[];
begin
  if tg_op = 'INSERT' then
    -- A normal MVCC read is deliberate. If an email update is in progress,
    -- attach the invite to the last committed owner rather than waiting for
    -- the address to become reusable or inverting the Auth/approval locks.
    select pg_catalog.array_agg(match.id order by match.id) into accounts from (
      select u.id from auth.users u
      where u.email = new.email and not u.is_anonymous and u.deleted_at is null
      order by u.id limit 2
    ) match;
    if pg_catalog.cardinality(accounts) > 1 then
      raise exception 'Resolve the guardian email account before issuing an invitation.' using errcode = '22023';
    end if;
    new.intended_user_id := accounts[1];
  elsif old.accepted_at is null and new.accepted_at is not null
    and old.intended_user_id is not null and new.accepted_by is distinct from old.intended_user_id then
    raise exception 'Sign in with the verified account on the invitation.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_guardian_invitation_recipient
before insert or update of accepted_at on app_private.guardian_invitations
for each row execute function app_private.guard_guardian_invitation_recipient();

create table app_private.guardian_contact_audit (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  parent_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in ('email_changed', 'mobile_verified', 'mobile_removed', 'mobile_synced')),
  revoked_invite_count integer not null default 0 check (revoked_invite_count >= 0),
  occurred_at timestamptz not null default clock_timestamp()
);
alter table app_private.guardian_contact_audit enable row level security;
revoke all on table app_private.guardian_contact_audit from public, anon, authenticated, service_role;

create index guardian_contact_audit_parent_history
  on app_private.guardian_contact_audit (school_id, parent_id, occurred_at desc);

create function app_private.guardian_contact_parent(p_user_id uuid)
returns setof public.parents language sql stable set search_path = ''
as $$
  with candidates as (
    select p.* from public.parents p
    join public.profiles profile on profile.id = p.profile_id and profile.school_id = p.school_id and profile.is_active
    where p.profile_id = p_user_id and exists (
      select 1 from public.user_roles r
      where r.user_id = p_user_id and r.school_id = p.school_id and r.role = 'parent'
    ) and exists (
      select 1 from public.student_parents sp
      join public.students s on s.id = sp.student_id and s.school_id = p.school_id
      where sp.parent_id = p.id
    )
  )
  select c.* from candidates c where (select count(*) from candidates) = 1;
$$;

create function app_private.guardian_e164_phone(p_phone text)
returns text language sql immutable strict set search_path = ''
as $$
  select case when p_phone ~ '^\+?[1-9][0-9]{7,14}$'
    then '+' || pg_catalog.ltrim(p_phone, '+') end;
$$;

create table app_private.guardian_phone_change_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null,
  phone_hash bytea not null,
  expires_at timestamptz not null,
  started_at timestamptz
);
alter table app_private.guardian_phone_change_authorizations enable row level security;
revoke all on table app_private.guardian_phone_change_authorizations from public, anon, authenticated, service_role;

create function app_private.authorize_my_guardian_phone_change(p_phone text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  requested_phone text := app_private.guardian_e164_phone(p_phone);
  previous_phone text;
begin
  select app_private.guardian_e164_phone(u.phone) into previous_phone
  from auth.users u
  where u.id = actor_id and not u.is_anonymous and u.deleted_at is null
    and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if not found or not exists (select 1 from app_private.guardian_contact_parent(actor_id))
    or not exists (
      select 1 from auth.sessions s
      join auth.mfa_amr_claims amr on amr.session_id = s.id and amr.authentication_method = 'password'
      where s.id = actor_session_id and s.user_id = actor_id
        and (s.not_after is null or s.not_after > statement_timestamp())
        and amr.created_at between statement_timestamp() - interval '5 minutes' and statement_timestamp()
    ) then
    raise exception 'Verify your account password again before changing the mobile number.' using errcode = '42501';
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

create function app_private.guard_guardian_auth_contact()
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
      raise exception 'Verify your account password again before requesting a mobile code.' using errcode = '42501';
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
      raise exception 'Request a fresh mobile code after verifying your password.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger guard_guardian_auth_contact
before update of email, phone, phone_change, phone_change_sent_at, phone_change_token on auth.users
for each row execute function app_private.guard_guardian_auth_contact();

create function app_private.follow_guardian_auth_contact()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  previous_email text := nullif(pg_catalog.lower(pg_catalog.btrim(old.email)), '');
  current_email text := nullif(pg_catalog.lower(pg_catalog.btrim(new.email)), '');
  previous_mobile text;
  current_mobile text;
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

  if old.phone_confirmed_at is not null then previous_mobile := app_private.guardian_e164_phone(old.phone); end if;
  if new.phone_confirmed_at is not null then current_mobile := app_private.guardian_e164_phone(new.phone); end if;
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

create trigger follow_guardian_auth_contact
after update of email, phone, phone_confirmed_at on auth.users
for each row
when (old.email is distinct from new.email or old.phone is distinct from new.phone
  or old.phone_confirmed_at is distinct from new.phone_confirmed_at)
execute function app_private.follow_guardian_auth_contact();

-- Reconcile accounts that already verified a phone before a school linked
-- their parent record. The caller supplies no number or target identifier.
create function app_private.sync_my_guardian_mobile()
returns text language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  verified_mobile text;
  guardian public.parents%rowtype;
begin
  select case when u.phone_confirmed_at is not null then app_private.guardian_e164_phone(u.phone) end
  into verified_mobile from auth.users u
  where u.id = actor_id and not u.is_anonymous and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for share;
  if not found then raise exception 'An active linked guardian account is required.' using errcode = '42501'; end if;

  select * into guardian from app_private.guardian_contact_parent(actor_id);
  if not found then raise exception 'An active linked guardian account is required.' using errcode = '42501'; end if;
  if verified_mobile is null then return null; end if;

  update public.parents set registered_mobile = verified_mobile
  where id = guardian.id and profile_id = actor_id and registered_mobile is distinct from verified_mobile;
  if found then
    insert into app_private.guardian_contact_audit(school_id, parent_id, actor_id, action)
    values (guardian.school_id, guardian.id, actor_id, 'mobile_synced');
  end if;
  return verified_mobile;
end;
$$;

create function public.sync_my_guardian_mobile()
returns text language sql security invoker set search_path = ''
as $$ select app_private.sync_my_guardian_mobile(); $$;

create function public.authorize_my_guardian_phone_change(p_phone text)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.authorize_my_guardian_phone_change(p_phone); $$;

revoke all on function
  app_private.guard_guardian_invitation_recipient(), app_private.guardian_contact_parent(uuid),
  app_private.guardian_e164_phone(text), app_private.guard_guardian_auth_contact(), app_private.follow_guardian_auth_contact(),
  app_private.sync_my_guardian_mobile(), public.sync_my_guardian_mobile(),
  app_private.authorize_my_guardian_phone_change(text), public.authorize_my_guardian_phone_change(text)
from public, anon, authenticated, service_role;

grant execute on function
  app_private.sync_my_guardian_mobile(), public.sync_my_guardian_mobile(),
  app_private.authorize_my_guardian_phone_change(text), public.authorize_my_guardian_phone_change(text)
to authenticated;

commit;
