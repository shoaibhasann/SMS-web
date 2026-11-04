-- SELECT-only metadata checks. Every passes value should be true.
-- No role memberships, pupil records, credentials or other application rows
-- are selected. This is a configuration check, not a live impersonation test.
with role_table as (
  select c.* from pg_catalog.pg_class c
  where c.oid = pg_catalog.to_regclass('public.user_roles')
), expected_functions(signature, security_definer, language_name) as (
  values
    ('app_private.can_manage_school_roles(uuid)', true, 'sql'),
    ('app_private.assign_school_role(uuid,uuid,public.app_role)', true, 'plpgsql'),
    ('public.assign_school_role(uuid,uuid,public.app_role)', false, 'sql')
), functions as (
  select e.*, p.oid, p.proowner, p.proconfig, p.prosrc,
    p.prosecdef, p.provolatile, l.lanname, r.rolsuper, r.rolbypassrls,
    p.proacl
  from expected_functions e
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
  left join pg_catalog.pg_language l on l.oid = p.prolang
  left join pg_catalog.pg_roles r on r.oid = p.proowner
), checks(check_name, passes) as (
  select 'role_table_exists_and_rls_enabled',
    exists (select 1 from role_table where relkind = 'r' and relrowsecurity)
  union all
  select 'old_user_roles_policies_removed', not exists (
    select 1 from pg_catalog.pg_policy p
    where p.polrelid = pg_catalog.to_regclass('public.user_roles')
      and p.polname in ('tenant_isolation_user_roles', 'admin_user_roles_select', 'user_roles_select_own_or_admin')
  )
  union all
  select 'only_own_or_scoped_admin_select_policy', (
    select count(*) = 1 and bool_and(
      p.polname = 'user_roles_read_own_or_school_admin'
      and p.polcmd = 'r' and p.polpermissive
      and p.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]::oid[]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) like '%user_id%auth.uid()%'
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) like '%OR%app_private.can_manage_school_roles(school_id)%'
    ) from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.user_roles')
  )
  union all
  select 'no_public_role_table_acl', not exists (
    select 1 from role_table c,
      lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    where a.grantee = 0
  )
  union all
  select 'anon_has_no_role_table_access',
    not pg_catalog.has_table_privilege('anon', pg_catalog.to_regclass('public.user_roles'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('anon', pg_catalog.to_regclass('public.user_roles'), 'SELECT,INSERT,UPDATE,REFERENCES')
  union all
  select 'authenticated_can_select_but_cannot_write_roles',
    pg_catalog.has_table_privilege('authenticated', pg_catalog.to_regclass('public.user_roles'), 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', pg_catalog.to_regclass('public.user_roles'), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('authenticated', pg_catalog.to_regclass('public.user_roles'), 'INSERT,UPDATE,REFERENCES')
  union all
  select 'trusted_service_role_access_preserved',
    pg_catalog.has_table_privilege('service_role', pg_catalog.to_regclass('public.user_roles'), 'SELECT')
    and pg_catalog.has_table_privilege('service_role', pg_catalog.to_regclass('public.user_roles'), 'INSERT')
    and pg_catalog.has_table_privilege('service_role', pg_catalog.to_regclass('public.user_roles'), 'UPDATE')
    and pg_catalog.has_table_privilege('service_role', pg_catalog.to_regclass('public.user_roles'), 'DELETE')
    and pg_catalog.has_schema_privilege('service_role', 'app_private', 'USAGE')
    and (select bool_and(pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')) from functions)
  union all
  select 'expected_function_security_and_languages',
    (select count(*) = 3 and bool_and(oid is not null and prosecdef = security_definer and lanname = language_name) from functions)
  union all
  select 'all_role_helpers_use_empty_search_path',
    (select bool_and(coalesce(proconfig @> array['search_path=""']::text[], false)) from functions)
  union all
  select 'definer_owners_can_bypass_role_table_rls', (
    select bool_and(f.rolsuper or f.rolbypassrls or (f.proowner = t.relowner and not t.relforcerowsecurity))
    from functions f cross join role_table t where f.security_definer
  )
  union all
  select 'authenticated_has_private_schema_usage_without_create',
    pg_catalog.has_schema_privilege('authenticated', 'app_private', 'USAGE')
    and not pg_catalog.has_schema_privilege('authenticated', 'app_private', 'CREATE')
    and not pg_catalog.has_schema_privilege('anon', 'app_private', 'CREATE')
  union all
  select 'role_helper_execute_is_authenticated_not_anon_or_public', (
    select bool_and(pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
      and not exists (select 1
        from pg_catalog.aclexplode(coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    from functions f
  )
  union all
  select 'read_helper_is_stable', exists (
    select 1 from functions where signature = 'app_private.can_manage_school_roles(uuid)' and provolatile = 's'
  )
  union all
  select 'public_rpc_calls_private_authorized_implementation', exists (
    select 1 from functions where signature = 'public.assign_school_role(uuid,uuid,public.app_role)'
      and not prosecdef and prosrc like '%app_private.assign_school_role(p_user_id, p_school_id, p_role)%'
  )
  union all
  select 'private_rpc_has_actor_lock_and_global_duplicate_guard', exists (
    select 1 from functions where signature = 'app_private.assign_school_role(uuid,uuid,public.app_role)'
      and prosrc ~* 'for[[:space:]]+share'
      and prosrc like '%pg_advisory_xact_lock%'
      and prosrc like '%where not exists%'
      and prosrc like '%on conflict (user_id, school_id, role) do nothing%'
  )
)
select check_name, coalesce(passes, false) as passes
from checks
order by check_name;
