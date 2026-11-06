-- Local security phase: disabled identities cannot retain staff authority or
-- reactivate themselves through the existing own-profile UPDATE policy.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $preflight$
declare
  signature text;
  helper record;
begin
  if pg_catalog.to_regclass('public.profiles') is null
    or pg_catalog.to_regclass('public.user_roles') is null then
    raise exception 'Profiles and governed user_roles are required.';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='public.profiles'::regclass and attname='is_active'
      and atttypid='boolean'::regtype and attnotnull and not attisdropped) then
    raise exception 'Expected profiles.is_active boolean NOT NULL.';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
    where tgrelid='public.profiles'::regclass and tgname='trg_guard_academic_identity'
      and tgfoid=pg_catalog.to_regprocedure('app_private.guard_academic_identity()')
      and tgenabled in ('O','A') and not tgisinternal) then
    raise exception 'The governed own-profile identity guard must be installed first.';
  end if;
  if pg_catalog.has_schema_privilege('anon','app_private','CREATE')
    or pg_catalog.has_schema_privilege('authenticated','app_private','CREATE') then
    raise exception 'Untrusted CREATE on app_private must be removed first.';
  end if;
  foreach signature in array array[
    'app_private.has_school_roles(uuid,public.app_role[])',
    'app_private.can_manage_school_roles(uuid)',
    'app_private.assign_school_role(uuid,uuid,public.app_role)'
  ] loop
    select p.prosecdef, r.rolsuper, r.rolbypassrls,
      (c.relowner=p.proowner and not c.relforcerowsecurity) as table_owner
      into helper from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid=p.proowner
      join pg_catalog.pg_class c on c.oid='public.user_roles'::regclass
      where p.oid=pg_catalog.to_regprocedure(signature);
    if not found or not helper.prosecdef
      or not (helper.rolsuper or helper.rolbypassrls or helper.table_owner) then
      raise exception 'Expected a trusted, existing security-definer helper: %.', signature;
    end if;
  end loop;
end;
$preflight$;

-- Every staff policy already delegates to this helper. Checking the profile
-- here also closes the admin-profile policy's inactive-self-reactivation path.
create or replace function app_private.has_school_roles(
  p_school_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p
    join public.user_roles ur on ur.user_id=p.id
    where p.id=auth.uid() and p.is_active
      and ((ur.role='super_admin'::public.app_role and ur.school_id is null)
        or (ur.school_id=p_school_id and ur.role<>'super_admin'::public.app_role
          and ur.role=any(p_roles)))
  );
$function$;

create or replace function app_private.can_manage_school_roles(p_school_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select app_private.has_school_roles(p_school_id, array['school_admin']::public.app_role[]);
$function$;

-- The coexisting admin_students_all policy still calls this older public
-- helper. It must use the same active-account rule, rather than OR around it.
create or replace function public.is_school_admin_for_school(p_school_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $function$
  select app_private.has_school_roles(p_school_id, array['school_admin']::public.app_role[]);
$function$;

create or replace function app_private.assign_school_role(
  p_user_id uuid, p_school_id uuid, p_role public.app_role
)
returns void language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  actor_authorized boolean := false;
  actor_super_admin boolean := false;
  qualifying_role public.app_role;
  locked_profile_id uuid;
  actor_profile_locked boolean := false;
  target_profile_locked boolean := false;
begin
  if actor_id is null then raise exception 'Authentication required.'; end if;
  if p_user_id is null or p_role is null then raise exception 'Target user and role are required.'; end if;
  if p_role='super_admin'::public.app_role and p_school_id is not null then
    raise exception 'Super admin is a global role; a school scope is not allowed.';
  end if;
  if p_school_id is null and p_role<>'super_admin'::public.app_role then
    raise exception 'A school is required for every ordinary school role.';
  end if;

  -- Stable ordering avoids A-grants-B/B-grants-A lock inversion. The target
  -- profile is also the mutex used by student activation. NO KEY UPDATE leaves
  -- Auth/profile FK key-share checks compatible with concurrent activation.
  for locked_profile_id in select p.id from public.profiles p
    where p.id in (actor_id,p_user_id) order by p.id for no key update
  loop
    if locked_profile_id=actor_id then actor_profile_locked := true; end if;
    if locked_profile_id=p_user_id then target_profile_locked := true; end if;
  end loop;
  if not actor_profile_locked
    or not exists (select 1 from public.profiles p where p.id=actor_id and p.is_active) then
    raise exception 'An active account is required to assign school roles.';
  end if;
  if not target_profile_locked then
    raise exception 'An existing target profile is required to assign school roles.';
  end if;

  for qualifying_role in
    select ur.role from public.user_roles ur
    where ur.user_id=actor_id
      and ((ur.role='super_admin'::public.app_role and ur.school_id is null)
        or (ur.role='school_admin'::public.app_role and ur.school_id=p_school_id))
    order by ur.id for share
  loop
    actor_authorized := true;
    if qualifying_role='super_admin'::public.app_role then actor_super_admin := true; end if;
  end loop;
  if not actor_authorized then raise exception 'Not authorized to assign roles for this school.'; end if;
  if p_role='super_admin'::public.app_role and not actor_super_admin then
    raise exception 'Only an existing super admin can grant super admin.';
  end if;

  if p_school_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'school-role-global:' || p_user_id::text,0));
    insert into public.user_roles(user_id,school_id,role)
    select p_user_id,null,p_role where not exists (
      select 1 from public.user_roles ur
      where ur.user_id=p_user_id and ur.school_id is null and ur.role=p_role);
  else
    insert into public.user_roles(user_id,school_id,role)
    values(p_user_id,p_school_id,p_role)
    on conflict(user_id,school_id,role) do nothing;
  end if;
end;
$function$;

revoke all on function app_private.has_school_roles(uuid,public.app_role[]) from public,anon,authenticated;
revoke all on function app_private.can_manage_school_roles(uuid) from public,anon,authenticated;
revoke all on function app_private.assign_school_role(uuid,uuid,public.app_role) from public,anon,authenticated;
grant execute on function app_private.has_school_roles(uuid,public.app_role[]) to authenticated,service_role;
grant execute on function app_private.can_manage_school_roles(uuid) to authenticated,service_role;
grant execute on function app_private.assign_school_role(uuid,uuid,public.app_role) to authenticated,service_role;
revoke all on function public.is_school_admin_for_school(uuid) from public,anon,authenticated;
grant execute on function public.is_school_admin_for_school(uuid) to authenticated,service_role;
-- The public security-invoker wrapper, role-table ACL/RLS, and profile edit
-- guard remain governed by their existing migrations. No identity rows change.
commit;
