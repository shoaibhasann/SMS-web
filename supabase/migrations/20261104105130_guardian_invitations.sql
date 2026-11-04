begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.guardian_invitations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
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

alter table app_private.guardian_invitations enable row level security;
revoke all on table app_private.guardian_invitations from public, anon, authenticated, service_role;

create unique index guardian_invitations_pending_recipient
  on app_private.guardian_invitations (student_id, email)
  where accepted_at is null and revoked_at is null;
create index guardian_invitations_student_created
  on app_private.guardian_invitations (student_id, created_at desc);

-- Parents have scoped policies for their own links, attendance, fees and
-- academics. A parent role must not grant legacy school-wide policies.
create or replace function public.current_user_school_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select ur.school_id from public.user_roles ur
  where ur.user_id = (select auth.uid()) and ur.school_id is not null
    and ur.role <> 'parent'::public.app_role;
$$;

-- The academic governance patch has a separate school-wide profile read.
-- Keep reads for other school roles and the separate own-profile policy.
alter policy tenant_isolation_profiles on public.profiles
  using (app_private.has_school_roles(
    school_id, pg_catalog.array_remove(pg_catalog.enum_range(null::public.app_role), 'parent'::public.app_role)
  ));

create policy schools_parent_select on public.schools for select to authenticated
  using (exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid()) and ur.school_id = schools.id and ur.role = 'parent'
  ));

alter policy attendance_parent_read on public.attendance
  using (exists (
    select 1
    from public.student_parents sp
    join public.parents p on p.id = sp.parent_id
    join public.students s on s.id = sp.student_id and s.school_id = p.school_id
    where p.id = app_private.current_parent_id()
      and sp.student_id = attendance.student_id
      and s.school_id = attendance.school_id
  ));

alter policy study_materials_parent_read on public.study_materials
  using (exists (
    select 1
    from public.student_parents sp
    join public.enrollments e on e.student_id = sp.student_id
    join public.academic_years y on y.id = e.academic_year_id
    join public.parents p on p.id = sp.parent_id and p.school_id = y.school_id
    where p.id = app_private.current_parent_id()
      and y.school_id = study_materials.school_id
      and (study_materials.class_id is null or study_materials.class_id = e.class_id)
      and (study_materials.section_id is null or study_materials.section_id = e.section_id)
  ));

-- The legacy code-and-phone RPC could grant a role without binding a parent.
-- Application clients must use the invitation path for new bindings.
revoke execute on function public.activate_parent(text, text) from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.parents, public.student_parents from public, anon, authenticated;

create function app_private.can_manage_guardian_invitations(p_user_id uuid, p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = p_user_id
      and ((ur.role = 'super_admin' and ur.school_id is null)
        or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  );
$$;

create function app_private.issue_guardian_invitation(p_school_id uuid, p_student_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  recipient text := pg_catalog.lower(pg_catalog.btrim(p_email));
  invite_token text;
  invitation app_private.guardian_invitations%rowtype;
begin
  if not app_private.can_manage_guardian_invitations(actor_id, p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;
  if recipient is null or pg_catalog.length(recipient) > 254
    or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid guardian email address.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.students s
    join public.enrollments e on e.student_id = s.id and e.status = 'active'
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
    where s.id = p_student_id and s.school_id = p_school_id and s.status = 'active'
  ) then
    raise exception 'Choose an active student enrolled in the current year.';
  end if;

  -- Serialise issuing/reissuing for this student and recipient.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('guardian-invitation:' || p_student_id::text || ':' || recipient, 0)
  );
  update app_private.guardian_invitations
  set revoked_at = clock_timestamp()
  where student_id = p_student_id and email = recipient
    and accepted_at is null and revoked_at is null;

  invite_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into app_private.guardian_invitations
    (school_id, student_id, email, token_hash, created_by, expires_at)
  values
    (p_school_id, p_student_id, recipient,
     pg_catalog.sha256(pg_catalog.convert_to(invite_token, 'UTF8')), actor_id,
     clock_timestamp() + interval '72 hours')
  returning * into invitation;

  return pg_catalog.jsonb_build_object(
    'id', invitation.id, 'token', invite_token, 'expires_at', invitation.expires_at
  );
end;
$$;

create function app_private.list_guardian_invitations(p_school_id uuid, p_student_id uuid)
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
      select id, email, created_at, expires_at, accepted_at, revoked_at
      from app_private.guardian_invitations
      where school_id = p_school_id and student_id = p_student_id
      order by created_at desc, id limit 50
    ) rows
  );
end;
$$;

create function app_private.revoke_guardian_invitation(p_invitation_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  invitation app_private.guardian_invitations%rowtype;
begin
  select * into invitation
  from app_private.guardian_invitations i
  where i.id = p_invitation_id and app_private.can_manage_guardian_invitations(auth.uid(), i.school_id)
  for update;
  if not found then
    raise exception 'You cannot manage this guardian invitation.' using errcode = '42501';
  end if;
  if invitation.accepted_at is not null or invitation.revoked_at is not null
    or invitation.expires_at <= clock_timestamp() then
    return false;
  end if;

  update app_private.guardian_invitations set revoked_at = clock_timestamp() where id = invitation.id;
  return true;
end;
$$;

create function app_private.accept_guardian_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  verified_email text;
  invitation app_private.guardian_invitations%rowtype;
  existing_profile public.profiles%rowtype;
  parent_ids uuid[];
  linked_parent_id uuid;
begin
  if actor_id is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  -- Serialize acceptances for the same account and prevent a concurrent email
  -- change. A second acceptance of the same token also locks the invitation.
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into verified_email
  from auth.users u
  where u.id = actor_id and u.email_confirmed_at is not null and not u.is_anonymous
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if not found or verified_email is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  select * into invitation from app_private.guardian_invitations
  where token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
  for update;
  if not found or invitation.expires_at <= clock_timestamp()
    or invitation.revoked_at is not null or invitation.accepted_at is not null then
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if invitation.email <> verified_email then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  perform 1 from public.students s
  join public.enrollments e on e.student_id = s.id and e.status = 'active'
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  where s.id = invitation.student_id and s.school_id = invitation.school_id and s.status = 'active'
  for share of s, e, y;
  if not found or not app_private.can_manage_guardian_invitations(invitation.created_by, invitation.school_id) then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  select * into existing_profile from public.profiles where id = actor_id for update;
  if not found or not existing_profile.is_active
    or (existing_profile.school_id is not null and existing_profile.school_id <> invitation.school_id)
    or exists (
      select 1 from public.user_roles ur where ur.user_id = actor_id
        and (ur.role = 'super_admin' or ur.school_id is distinct from invitation.school_id)
    ) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  select array(select p.id from public.parents p where p.profile_id = actor_id) into parent_ids;
  if pg_catalog.cardinality(parent_ids) > 1
    or exists (select 1 from public.parents p where p.id = any(parent_ids) and p.school_id <> invitation.school_id) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  linked_parent_id := parent_ids[1];
  if linked_parent_id is null then
    insert into public.parents (school_id, profile_id)
    values (invitation.school_id, actor_id) returning id into linked_parent_id;
  end if;
  insert into public.student_parents (student_id, parent_id, relationship)
  values (invitation.student_id, linked_parent_id, 'guardian')
  on conflict do nothing;
  insert into public.user_roles (user_id, school_id, role)
  values (actor_id, invitation.school_id, 'parent')
  on conflict do nothing;
  update public.profiles set school_id = invitation.school_id
  where id = actor_id and school_id is null;

  update app_private.guardian_invitations
  set accepted_at = clock_timestamp(), accepted_by = actor_id where id = invitation.id;

  return pg_catalog.jsonb_build_object('school_id', invitation.school_id, 'student_id', invitation.student_id);
end;
$$;

-- Data API endpoints are invoker wrappers. Privileged code stays in the
-- private schema with its own caller and school checks.
create function public.issue_guardian_invitation(p_school_id uuid, p_student_id uuid, p_email text)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.issue_guardian_invitation(p_school_id, p_student_id, p_email); $$;

create function public.list_guardian_invitations(p_school_id uuid, p_student_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_guardian_invitations(p_school_id, p_student_id); $$;

create function public.revoke_guardian_invitation(p_invitation_id uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.revoke_guardian_invitation(p_invitation_id); $$;

create function public.accept_guardian_invitation(p_token text)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.accept_guardian_invitation(p_token); $$;

revoke all on function app_private.can_manage_guardian_invitations(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  app_private.issue_guardian_invitation(uuid, uuid, text),
  app_private.list_guardian_invitations(uuid, uuid),
  app_private.revoke_guardian_invitation(uuid),
  app_private.accept_guardian_invitation(text),
  public.issue_guardian_invitation(uuid, uuid, text),
  public.list_guardian_invitations(uuid, uuid),
  public.revoke_guardian_invitation(uuid),
  public.accept_guardian_invitation(text)
  from public, anon, authenticated, service_role;

grant execute on function
  app_private.issue_guardian_invitation(uuid, uuid, text),
  app_private.list_guardian_invitations(uuid, uuid),
  app_private.revoke_guardian_invitation(uuid),
  app_private.accept_guardian_invitation(text),
  public.issue_guardian_invitation(uuid, uuid, text),
  public.list_guardian_invitations(uuid, uuid),
  public.revoke_guardian_invitation(uuid),
  public.accept_guardian_invitation(text)
  to authenticated;

commit;
