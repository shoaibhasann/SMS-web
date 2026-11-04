-- Manual hotfix: closes direct user_roles self-grants and cross-school grants
-- through assign_school_role. Other legacy policies are outside this patch.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $preflight$
declare
  role_table oid := pg_catalog.to_regclass('public.user_roles');
  role_type oid := pg_catalog.to_regtype('public.app_role');
  target_users oid := pg_catalog.to_regclass('auth.users');
  target_schools oid := pg_catalog.to_regclass('public.schools');
  actor_role record;
  table_shape record;
  user_column smallint;
  school_column smallint;
  role_column smallint;
  required_column record;
begin
  if role_table is null or role_type is null or target_users is null or target_schools is null then
    raise exception 'Incompatible schema: user_roles, app_role, auth.users and schools are required.';
  end if;
  select * into actor_role from pg_catalog.pg_roles where rolname = current_user;
  select relkind, relowner, relrowsecurity, relforcerowsecurity
    into table_shape from pg_catalog.pg_class where oid = role_table;
  if table_shape.relkind <> 'r' or not table_shape.relrowsecurity then
    raise exception 'Incompatible schema: public.user_roles must be an ordinary RLS-enabled table.';
  end if;
  if not (actor_role.rolsuper or actor_role.rolbypassrls
    or (table_shape.relowner = actor_role.oid and not table_shape.relforcerowsecurity)) then
    raise exception 'Run as a trusted table owner without forced RLS, or a superuser/BYPASSRLS executor.';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    raise exception 'Incompatible schema: expected Supabase API roles are missing.';
  end if;
  if pg_catalog.to_regprocedure('auth.uid()') is null
    or not exists (select 1 from pg_catalog.pg_proc
      where oid = pg_catalog.to_regprocedure('auth.uid()') and prorettype = 'uuid'::regtype) then
    raise exception 'Incompatible schema: auth.uid() must return uuid.';
  end if;
  if not exists (select 1 from pg_catalog.pg_type where oid = role_type and typtype = 'e')
    or not exists (select 1 from pg_catalog.pg_enum where enumtypid = role_type and enumlabel = 'super_admin')
    or not exists (select 1 from pg_catalog.pg_enum where enumtypid = role_type and enumlabel = 'school_admin') then
    raise exception 'Incompatible schema: app_role must contain super_admin and school_admin.';
  end if;

  -- Hold the table shape, policies and grants stable for the complete hotfix.
  lock table public.user_roles in access exclusive mode;

  for required_column in
    select * from (values
      ('id'::text, 'uuid'::regtype::oid, true),
      ('user_id'::text, 'uuid'::regtype::oid, true),
      ('school_id'::text, 'uuid'::regtype::oid, false),
      ('role'::text, role_type, true)
    ) as required(name, type_oid, not_null)
  loop
    if not exists (select 1 from pg_catalog.pg_attribute a
      where a.attrelid = role_table and a.attname = required_column.name
        and a.atttypid = required_column.type_oid and a.attnotnull = required_column.not_null
        and a.attnum > 0 and not a.attisdropped) then
      raise exception 'Incompatible schema: unexpected user_roles column %.', required_column.name;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_attribute a
    where a.attrelid = role_table and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attname not in ('user_id', 'role')
      and a.attidentity = '' and a.attgenerated = ''
      and not exists (select 1 from pg_catalog.pg_attrdef d
        where d.adrelid = a.attrelid and d.adnum = a.attnum)) then
    raise exception 'Incompatible schema: an additional required role column has no default.';
  end if;
  select attnum into user_column from pg_catalog.pg_attribute where attrelid = role_table and attname = 'user_id';
  select attnum into school_column from pg_catalog.pg_attribute where attrelid = role_table and attname = 'school_id';
  select attnum into role_column from pg_catalog.pg_attribute where attrelid = role_table and attname = 'role';
  if not exists (select 1 from pg_catalog.pg_constraint c
    where c.conrelid = role_table and c.contype = 'u' and not c.condeferrable
      and c.convalidated and c.conkey = array[user_column, school_column, role_column]) then
    raise exception 'Incompatible schema: expected nondeferrable role tuple uniqueness is missing.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
    where c.conrelid = role_table and c.contype = 'f' and c.convalidated
      and c.conkey = array[user_column] and c.confrelid = target_users
      and c.confkey = array[(select attnum from pg_catalog.pg_attribute
        where attrelid = target_users and attname = 'id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c
      where c.conrelid = role_table and c.contype = 'f' and c.convalidated
        and c.conkey = array[school_column] and c.confrelid = target_schools
        and c.confkey = array[(select attnum from pg_catalog.pg_attribute
          where attrelid = target_schools and attname = 'id')]::smallint[]) then
    raise exception 'Incompatible schema: expected user/school foreign keys are missing.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.assign_school_role(uuid,uuid,public.app_role)')
      and p.prokind = 'f' and p.prorettype = 'void'::regtype) then
    raise exception 'Incompatible schema: expected public.assign_school_role signature is missing.';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = role_table
    and p.polname not in ('tenant_isolation_user_roles', 'admin_user_roles_select',
      'user_roles_select_own_or_admin', 'user_roles_read_own_or_school_admin')) then
    raise exception 'Unexpected user_roles policies exist. Review them before applying this bounded hotfix.';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = role_table and not t.tgisinternal) then
    raise exception 'Unexpected user_roles triggers exist. Review them before applying this bounded hotfix.';
  end if;
end;
$preflight$;

create schema if not exists app_private;

do $private_schema$
begin
  if pg_catalog.has_schema_privilege('anon', 'app_private', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'app_private', 'CREATE') then
    raise exception 'The private helper schema permits untrusted CREATE. Review schema ownership/grants first.';
  end if;
end;
$private_schema$;

create or replace function app_private.can_manage_school_roles(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null and exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and (ur.role = 'super_admin'::public.app_role
        or (ur.role = 'school_admin'::public.app_role and ur.school_id = p_school_id))
  );
$function$;

create or replace function app_private.assign_school_role(
  p_user_id uuid,
  p_school_id uuid,
  p_role public.app_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  actor_authorized boolean := false;
  actor_super_admin boolean := false;
  qualifying_role public.app_role;
begin
  if actor_id is null then raise exception 'Authentication required.'; end if;
  if p_user_id is null or p_role is null then raise exception 'Target user and role are required.'; end if;
  if p_school_id is null and p_role <> 'super_admin'::public.app_role then
    raise exception 'A school is required for every ordinary school role.';
  end if;

  -- Stabilize the authority used by this operation against concurrent revocation.
  for qualifying_role in
    select ur.role from public.user_roles ur
    where ur.user_id = actor_id
      and (ur.role = 'super_admin'::public.app_role
        or (ur.role = 'school_admin'::public.app_role and ur.school_id = p_school_id))
    order by ur.id
    for share
  loop
    actor_authorized := true;
    if qualifying_role = 'super_admin'::public.app_role then actor_super_admin := true; end if;
  end loop;
  if not actor_authorized then raise exception 'Not authorized to assign roles for this school.'; end if;
  if p_role = 'super_admin'::public.app_role and not actor_super_admin then
    raise exception 'Only an existing super admin can grant super admin.';
  end if;

  if p_school_id is null then
    -- NULLs are distinct in the existing unique key. Serialize this target and
    -- preserve any existing global grant without creating another duplicate.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'school-role-global:' || p_user_id::text, 0
    ));
    insert into public.user_roles(user_id, school_id, role)
    select p_user_id, null, p_role
    where not exists (select 1 from public.user_roles ur
      where ur.user_id = p_user_id and ur.school_id is null and ur.role = p_role);
  else
    insert into public.user_roles(user_id, school_id, role)
    values (p_user_id, p_school_id, p_role)
    on conflict (user_id, school_id, role) do nothing;
  end if;
end;
$function$;

-- Keep the existing exposed RPC signature. Its caller must have permission to
-- invoke the private, independently authorized implementation.
create or replace function public.assign_school_role(
  p_user_id uuid,
  p_school_id uuid,
  p_role public.app_role
)
returns void
language sql
security invoker
set search_path = ''
as $function$
  select app_private.assign_school_role(p_user_id, p_school_id, p_role);
$function$;

revoke all on function app_private.can_manage_school_roles(uuid) from public, anon, authenticated;
revoke all on function app_private.assign_school_role(uuid, uuid, public.app_role) from public, anon, authenticated;
revoke all on function public.assign_school_role(uuid, uuid, public.app_role) from public, anon;
grant usage on schema app_private to authenticated, service_role;
grant execute on function app_private.can_manage_school_roles(uuid) to authenticated, service_role;
grant execute on function app_private.assign_school_role(uuid, uuid, public.app_role) to authenticated, service_role;
grant execute on function public.assign_school_role(uuid, uuid, public.app_role) to authenticated, service_role;

drop policy if exists tenant_isolation_user_roles on public.user_roles;
drop policy if exists admin_user_roles_select on public.user_roles;
drop policy if exists user_roles_select_own_or_admin on public.user_roles;
drop policy if exists user_roles_read_own_or_school_admin on public.user_roles;
create policy user_roles_read_own_or_school_admin
  on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or app_private.can_manage_school_roles(school_id));

revoke all on table public.user_roles from public, anon, authenticated;
grant select on table public.user_roles to authenticated;

do $postconditions$
declare
  role_table oid := 'public.user_roles'::regclass;
  helper record;
  table_owner oid;
  forced_rls boolean;
begin
  select relowner, relforcerowsecurity into table_owner, forced_rls
    from pg_catalog.pg_class where oid = role_table;
  for helper in
    select p.proname, p.prosecdef, r.oid as owner_oid, r.rolsuper, r.rolbypassrls
    from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner
    where p.oid in (
      'app_private.can_manage_school_roles(uuid)'::regprocedure,
      'app_private.assign_school_role(uuid,uuid,public.app_role)'::regprocedure
    )
  loop
    if not helper.prosecdef or not (helper.rolsuper or helper.rolbypassrls
      or (helper.owner_oid = table_owner and not forced_rls)) then
      raise exception 'Helper % must have a trusted owner able to bypass role-table RLS.', helper.proname;
    end if;
  end loop;
  if pg_catalog.has_table_privilege('anon', role_table, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_table_privilege('authenticated', role_table, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('anon', role_table, 'INSERT,UPDATE,REFERENCES')
    or pg_catalog.has_any_column_privilege('authenticated', role_table, 'INSERT,UPDATE,REFERENCES') then
    raise exception 'Untrusted role-table write privileges remain through column or inherited grants. Transaction rolled back.';
  end if;
end;
$postconditions$;

commit;
