begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Office policies using this legacy helper must never grant office access
-- solely because someone has a teaching or family membership.
create or replace function public.current_user_school_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select ur.school_id from public.user_roles ur
  where ur.user_id = (select auth.uid()) and ur.school_id is not null
    and ur.role in ('school_admin', 'principal', 'accountant', 'reception_staff');
$$;

alter policy tenant_isolation_profiles on public.profiles
using (app_private.has_school_roles(
  school_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]
));

create policy schools_academic_member_select on public.schools for select to authenticated
  using (exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid()) and ur.school_id = schools.id
      and ur.role in ('teacher', 'student')
  ));

-- These older verification paths matched identifiers and phone numbers
-- without binding the authenticated account to the corresponding staff record.
revoke execute on function public.activate_teacher(text, text), public.activate_accountant(text, text)
from public, anon, authenticated;
revoke insert on public.teachers from public, anon, authenticated;

create table app_private.teacher_invitations (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  email text not null,
  token_hash bytea not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (accepted_at is null or revoked_at is null)
);

alter table app_private.teacher_invitations enable row level security;
revoke all on table app_private.teacher_invitations from public, anon, authenticated, service_role;
create unique index teacher_invitations_pending
  on app_private.teacher_invitations (teacher_id)
  where accepted_at is null and revoked_at is null;
create index teacher_invitations_history on app_private.teacher_invitations (teacher_id, created_at desc, id);

-- Keep existing links and trusted imports while requiring the verified
-- invitation workflow for application clients that link a teacher login.
create function app_private.guard_teacher_auth_link()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = current_user
    and (r.rolsuper or r.rolbypassrls)) or exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
    where c.oid = tg_relid and r.rolname = current_user and not c.relforcerowsecurity
  ) then
    return new;
  end if;
  if new.profile_id is not distinct from old.profile_id then
    return new;
  end if;
  raise exception 'Use a teacher invitation to link a school login.' using errcode = '42501';
end;
$$;
revoke all on function app_private.guard_teacher_auth_link() from public, anon, authenticated, service_role;
create trigger trg_guard_teacher_auth_link before update of profile_id on public.teachers
for each row execute function app_private.guard_teacher_auth_link();

create function app_private.can_manage_teachers(p_actor_id uuid, p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = p_actor_id
      and ((ur.role = 'super_admin' and ur.school_id is null)
        or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  );
$$;

create function app_private.create_teacher_record(p_school_id uuid, p_employee_id text, p_full_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  employee_number text := pg_catalog.btrim(p_employee_id);
  teacher_name text := pg_catalog.btrim(p_full_name);
  new_teacher_id uuid;
begin
  if not app_private.can_manage_teachers(auth.uid(), p_school_id) then
    raise exception 'You cannot manage teachers for this school.' using errcode = '42501';
  end if;
  if employee_number is null or pg_catalog.length(employee_number) not between 1 and 64
    or employee_number ~ '[[:cntrl:]]' or teacher_name is null
    or pg_catalog.length(teacher_name) not between 1 and 160 or teacher_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid employee ID and teacher name.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'teacher-employee:' || p_school_id::text || ':' || pg_catalog.lower(employee_number), 0
  ));
  if exists (select 1 from public.teachers t where t.school_id = p_school_id
    and pg_catalog.lower(pg_catalog.btrim(t.employee_id)) = pg_catalog.lower(employee_number)) then
    raise exception 'This employee ID is already used in this school.' using errcode = '23505';
  end if;

  insert into public.teachers (school_id, employee_id, full_name)
  values (p_school_id, employee_number, teacher_name)
  returning id into new_teacher_id;
  return new_teacher_id;
end;
$$;

create function app_private.issue_teacher_invitation(p_teacher_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  recipient text := pg_catalog.lower(pg_catalog.btrim(p_email));
  invite_token text;
  invitation app_private.teacher_invitations%rowtype;
begin
  -- Lock the teacher before touching their invitations in every write path.
  perform 1 from public.teachers t
  where t.id = p_teacher_id and app_private.can_manage_teachers(actor_id, t.school_id)
  for update;
  if not found then
    raise exception 'You cannot manage this teacher.' using errcode = '42501';
  end if;
  if exists (select 1 from public.teachers where id = p_teacher_id and profile_id is not null) then
    raise exception 'This teacher already has a linked account.';
  end if;
  if recipient is null or pg_catalog.length(recipient) > 254
    or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid teacher email address.' using errcode = '22023';
  end if;

  update app_private.teacher_invitations set revoked_at = clock_timestamp()
  where teacher_id = p_teacher_id and accepted_at is null and revoked_at is null;

  invite_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into app_private.teacher_invitations (teacher_id, email, token_hash, created_by, expires_at)
  values (p_teacher_id, recipient, pg_catalog.sha256(pg_catalog.convert_to(invite_token, 'UTF8')),
    actor_id, clock_timestamp() + interval '72 hours')
  returning * into invitation;

  return pg_catalog.jsonb_build_object('id', invitation.id, 'token', invite_token, 'expires_at', invitation.expires_at);
end;
$$;

create function app_private.list_teacher_invitations(p_teacher_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.teachers t
    where t.id = p_teacher_id and app_private.can_manage_teachers(auth.uid(), t.school_id)) then
    raise exception 'You cannot manage this teacher.' using errcode = '42501';
  end if;
  return (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.created_at desc, rows.id), '[]'::jsonb)
    from (
      select id, email, created_at, expires_at, accepted_at, revoked_at
      from app_private.teacher_invitations where teacher_id = p_teacher_id
      order by created_at desc, id limit 50
    ) rows
  );
end;
$$;

create function app_private.revoke_teacher_invitation(p_invitation_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  changed_id uuid;
begin
  perform 1 from public.teachers t
  join app_private.teacher_invitations i on i.teacher_id = t.id
  where i.id = p_invitation_id and app_private.can_manage_teachers(auth.uid(), t.school_id)
  for update of t;
  if not found then
    raise exception 'You cannot manage this teacher invitation.' using errcode = '42501';
  end if;

  update app_private.teacher_invitations set revoked_at = clock_timestamp()
  where id = p_invitation_id and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()
  returning id into changed_id;
  return changed_id is not null;
end;
$$;

create function app_private.accept_teacher_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  verified_email text;
  invite_hash bytea;
  invitation app_private.teacher_invitations%rowtype;
  teacher_record public.teachers%rowtype;
  existing_profile public.profiles%rowtype;
begin
  if actor_id is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This teacher invitation is unavailable.';
  end if;

  -- Serialise link acceptance for the same login across different invites.
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into verified_email
  from auth.users u
  where u.id = actor_id and u.email_confirmed_at is not null and not u.is_anonymous
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if verified_email is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  invite_hash := pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'));
  select t.* into teacher_record from public.teachers t
  join app_private.teacher_invitations i on i.teacher_id = t.id
  where i.token_hash = invite_hash for update of t;
  if not found then
    raise exception 'This teacher invitation is unavailable.';
  end if;

  select * into invitation from app_private.teacher_invitations where token_hash = invite_hash for update;
  if not found or invitation.expires_at <= clock_timestamp() or invitation.revoked_at is not null
    or invitation.accepted_at is not null or teacher_record.profile_id is not null
    or not app_private.can_manage_teachers(invitation.created_by, teacher_record.school_id) then
    raise exception 'This teacher invitation is unavailable.';
  end if;
  if invitation.email <> verified_email then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  select * into existing_profile from public.profiles where id = actor_id for no key update;
  if not found or not existing_profile.is_active
    or (existing_profile.school_id is not null and existing_profile.school_id <> teacher_record.school_id)
    or exists (
      select 1 from public.user_roles ur where ur.user_id = actor_id
      and (ur.role not in ('teacher', 'parent') or ur.school_id is distinct from teacher_record.school_id)
    ) or exists (select 1 from public.teachers t where t.profile_id = actor_id) then
    raise exception 'This account already has a school role or teacher link that cannot be combined with this invitation.' using errcode = '42501';
  end if;

  update public.teachers set profile_id = actor_id where id = teacher_record.id;
  insert into public.user_roles (user_id, school_id, role)
  values (actor_id, teacher_record.school_id, 'teacher') on conflict do nothing;
  update public.profiles set school_id = teacher_record.school_id
  where id = actor_id and school_id is null;
  update app_private.teacher_invitations set accepted_at = clock_timestamp(), accepted_by = actor_id
  where id = invitation.id;

  return pg_catalog.jsonb_build_object('school_id', teacher_record.school_id, 'teacher_id', teacher_record.id);
end;
$$;

-- Keep privileged database logic out of the Data API schema.
create function public.create_teacher_record(p_school_id uuid, p_employee_id text, p_full_name text)
returns uuid language sql security invoker set search_path = ''
as $$ select app_private.create_teacher_record(p_school_id, p_employee_id, p_full_name); $$;

create function public.issue_teacher_invitation(p_teacher_id uuid, p_email text)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.issue_teacher_invitation(p_teacher_id, p_email); $$;

create function public.list_teacher_invitations(p_teacher_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_teacher_invitations(p_teacher_id); $$;

create function public.revoke_teacher_invitation(p_invitation_id uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.revoke_teacher_invitation(p_invitation_id); $$;

create function public.accept_teacher_invitation(p_token text)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.accept_teacher_invitation(p_token); $$;

revoke all on function app_private.can_manage_teachers(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function
  app_private.create_teacher_record(uuid, text, text),
  app_private.issue_teacher_invitation(uuid, text),
  app_private.list_teacher_invitations(uuid),
  app_private.revoke_teacher_invitation(uuid),
  app_private.accept_teacher_invitation(text),
  public.create_teacher_record(uuid, text, text),
  public.issue_teacher_invitation(uuid, text),
  public.list_teacher_invitations(uuid),
  public.revoke_teacher_invitation(uuid),
  public.accept_teacher_invitation(text)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.create_teacher_record(uuid, text, text),
  app_private.issue_teacher_invitation(uuid, text),
  app_private.list_teacher_invitations(uuid),
  app_private.revoke_teacher_invitation(uuid),
  app_private.accept_teacher_invitation(text),
  public.create_teacher_record(uuid, text, text),
  public.issue_teacher_invitation(uuid, text),
  public.list_teacher_invitations(uuid),
  public.revoke_teacher_invitation(uuid),
  public.accept_teacher_invitation(text)
to authenticated;

commit;
