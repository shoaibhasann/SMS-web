-- web-guardian#3: phone-invitation issuance must not tell one school whether a mobile
-- belongs to an account, school record or pending invitation in ANOTHER school.
-- Issuance now refuses only conflicts inside the issuing school. A cross-school
-- conflict gets the normal issued result, but the row is marked cross_school_held:
-- acceptance, SMS reservation and recovery still re-run the platform-wide
-- guardian_phone_recipient_allowed and fail closed, and a held row is ignored when
-- another school's invitations are checked, so it can never block that school.
-- Copied from 20261106133315_guardian_hybrid_phone_auth.sql (latest definitions);
-- only the marked conditions change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_private.guardian_invitations add column cross_school_held boolean not null default false;

create or replace function app_private.guardian_phone_recipient_allowed(p_phone text,p_school_id uuid)
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
        and not i.cross_school_held -- changed: a held row never blocks the other school
        and i.accepted_at is null and i.revoked_at is null and i.expires_at>statement_timestamp()
    );
$$;

-- The subset of guardian_phone_recipient_allowed failures that come from the
-- issuing school's own accounts and records; only these are reported at issuance.
create function app_private.guardian_phone_locally_blocked(p_phone text,p_school_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select exists (
      select 1 from auth.users u where app_private.guardian_e164_phone(u.phone)=p_phone
        and (exists(select 1 from public.user_roles r where r.user_id=u.id and r.school_id=p_school_id and r.role<>'parent')
          or exists(select 1 from public.profiles p where p.id=u.id and p.school_id=p_school_id and not p.is_active)
          or (u.phone_confirmed_at is null and u.email_confirmed_at is not null
            and exists(select 1 from public.parents p where p.profile_id=u.id and p.school_id=p_school_id)))
    )
    or exists (
      select 1 from public.parents p left join auth.users u on u.id=p.profile_id
      where p.school_id=p_school_id
        and pg_catalog.regexp_replace(coalesce(p.registered_mobile,''),'[^0-9]','','g')
          in (pg_catalog.substr(p_phone,2),pg_catalog.substr(p_phone,4),'0'||pg_catalog.substr(p_phone,4))
        and (u.id is null or u.phone_confirmed_at is null or app_private.guardian_e164_phone(u.phone) is distinct from p_phone)
    );
$$;

create or replace function app_private.write_guardian_phone_invitation(
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
  -- changed: only this school's conflicts are reported; the insert trigger holds cross-school ones.
  if app_private.guardian_phone_locally_blocked(p_phone,p_school_id) then
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

create or replace function app_private.guard_guardian_invitation_recipient()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  accounts uuid[];
begin
  if tg_op = 'INSERT' then
    -- changed: refuse only this school's conflicts; hold a cross-school one without saying so.
    new.cross_school_held := false;
    if new.phone is not null and not app_private.guardian_phone_recipient_allowed(new.phone,new.school_id) then
      if app_private.guardian_phone_locally_blocked(new.phone,new.school_id) then
        raise exception 'Resolve the existing guardian account before inviting this mobile.' using errcode='22023';
      end if;
      new.cross_school_held := true;
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

revoke all on function app_private.guardian_phone_recipient_allowed(text,uuid),app_private.guardian_phone_locally_blocked(text,uuid),
  app_private.write_guardian_phone_invitation(uuid,uuid,text,uuid,uuid)
  from public,anon,authenticated,service_role;

commit;
