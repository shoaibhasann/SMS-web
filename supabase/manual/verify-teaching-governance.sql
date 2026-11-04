-- SELECT-only governance catalog checks: expect all 26 passes flags true.
-- No pupil, teacher, role-membership or other application rows are selected.
-- Checks exact patch conformance; this is not a live-user or complete tenant-safety test.
with expected_tables(table_name, owner_name) as (values
    ('academic_years', 'postgres'),
    ('classes', 'postgres'),
    ('profiles', 'postgres'),
    ('sections', 'postgres'),
    ('subjects', 'postgres'),
    ('teacher_subject_assignments', 'postgres'),
    ('teachers', 'postgres')
), tables as (
  select e.*, c.oid, c.relowner, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from expected_tables e left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass('public.' || e.table_name)
), expected_functions(signature, source_md5, expected_definer, expected_language, expected_volatility, expected_return_type) as (values
    ('app_private.assignment_scope_is_coherent(uuid,uuid,uuid,uuid,uuid,boolean)', '1a60a31b4fd7122ac4b8f3d2f60ab414', true, 'sql', 's', 'bool'),
    ('app_private.is_own_school_teacher(uuid)', '5d0a632e3e27c2fdfaeb31eb59c492a9', true, 'sql', 's', 'bool'),
    ('app_private.validate_teacher_assignment()', '85950f9ebf3480c958ef5efed9afe0e7', true, 'plpgsql', 'v', 'trigger'),
    ('app_private.guard_academic_identity()', '0112856c17d87fdd1b34d06f5f2e09a6', false, 'plpgsql', 'v', 'trigger'),
    ('public.register_student_for_class_teacher(text)', 'd41021ab529605bc68683909bd858169', true, 'plpgsql', 'v', 'record')
), functions as (
  select e.*, p.oid, p.proowner, p.proconfig, p.prosrc, p.prosecdef, p.provolatile,
    p.prorettype, p.prokind, p.proretset, p.proacl, l.lanname, r.rolsuper, r.rolbypassrls
  from expected_functions e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature)
  left join pg_catalog.pg_language l on l.oid=p.prolang left join pg_catalog.pg_roles r on r.oid=p.proowner
), expected_policies(table_name, policy_name, command_code, predicate, check_predicate) as (values
    ('academic_years', 'academic_years_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])', NULL),
    ('academic_years', 'admin_academic_years_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])'),
    ('academic_years', 'tenant_isolation_academic_years', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL),
    ('classes', 'admin_classes_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])'),
    ('classes', 'classes_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])', NULL),
    ('classes', 'tenant_isolation_classes', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL),
    ('profiles', 'admin_profiles_all', 'w', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])'),
    ('profiles', 'profiles_select_own', 'r', '(id=(SELECTauth.uid()ASuid))', NULL),
    ('profiles', 'profiles_update_own', 'w', '(id=(SELECTauth.uid()ASuid))', '(id=(SELECTauth.uid()ASuid))'),
    ('profiles', 'tenant_isolation_profiles', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL),
    ('sections', 'admin_sections_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', '(app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])AND(EXISTS(SELECT1FROMclassescWHERE((c.id=sections.class_id)AND(c.school_id=sections.school_id)))))'),
    ('sections', 'sections_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])', NULL),
    ('sections', 'tenant_isolation_sections', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL),
    ('subjects', 'admin_subjects_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])'),
    ('subjects', 'tenant_isolation_subjects', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL),
    ('teacher_subject_assignments', 'admin_teacher_assignments_all', '*', 'app_private.has_school_roles_for_teacher(teacher_id,ARRAY[''school_admin'',''principal''])', '(app_private.has_school_roles_for_teacher(teacher_id,ARRAY[''school_admin'',''principal''])ANDapp_private.assignment_scope_is_coherent(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher))'),
    ('teacher_subject_assignments', 'teacher_assignments_staff_read', 'r', 'app_private.has_school_roles_for_teacher(teacher_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])', NULL),
    ('teacher_subject_assignments', 'teacher_assignments_teacher_own_select', 'r', 'app_private.is_own_school_teacher(teacher_id)', NULL),
    ('teachers', 'admin_teachers_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal''])'),
    ('teachers', 'tenant_isolation_teachers', 'r', 'app_private.has_school_roles(school_id,enum_range(NULL))', NULL)
), policies as (
  select e.*, p.oid, p.polcmd, p.polpermissive, p.polroles,
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
      pg_catalog.pg_get_expr(p.polqual,p.polrelid),'(public|pg_catalog)[.]','','g'),
      '::app_role(\[\])?','','g'),'[[:space:]]+','','g') as actual_using,
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
      pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'(public|pg_catalog)[.]','','g'),
      '::app_role(\[\])?','','g'),'[[:space:]]+','','g') as actual_check
  from expected_policies e left join pg_catalog.pg_policy p on p.polrelid=pg_catalog.to_regclass('public.' || e.table_name) and p.polname=e.policy_name
), expected_policy_groups(table_name, names) as (values
    ('academic_years', ARRAY['academic_years_finance_read','admin_academic_years_all','tenant_isolation_academic_years']),
    ('classes', ARRAY['admin_classes_all','classes_finance_read','tenant_isolation_classes']),
    ('profiles', ARRAY['admin_profiles_all','profiles_select_own','profiles_update_own','tenant_isolation_profiles']),
    ('sections', ARRAY['admin_sections_all','sections_finance_read','tenant_isolation_sections']),
    ('subjects', ARRAY['admin_subjects_all','tenant_isolation_subjects']),
    ('teacher_subject_assignments', ARRAY['admin_teacher_assignments_all','teacher_assignments_staff_read','teacher_assignments_teacher_own_select']),
    ('teachers', ARRAY['admin_teachers_all','tenant_isolation_teachers'])
), expected_policy_names as (
  select g.table_name,n.policy_name from expected_policy_groups g cross join lateral pg_catalog.unnest(g.names) n(policy_name)
), expected_triggers(table_name, trigger_name) as (values
    ('profiles', 'trg_profiles_updated'),
    ('academic_years', 'trg_guard_academic_identity'),
    ('classes', 'trg_guard_academic_identity'),
    ('profiles', 'trg_guard_academic_identity'),
    ('sections', 'trg_guard_academic_identity'),
    ('subjects', 'trg_guard_academic_identity'),
    ('teacher_subject_assignments', 'trg_guard_academic_identity'),
    ('teachers', 'trg_guard_academic_identity'),
    ('teacher_subject_assignments', 'trg_validate_teacher_assignment')
), expected_indexes(name, definition) as (values
    ('section_one_class_teacher_idx', 'CREATE UNIQUE INDEX section_one_class_teacher_idx ON public.teacher_subject_assignments USING btree (section_id) WHERE (is_class_teacher = true)'),
    ('teacher_one_class_teacher_idx', 'CREATE UNIQUE INDEX teacher_one_class_teacher_idx ON public.teacher_subject_assignments USING btree (teacher_id) WHERE (is_class_teacher = true)'),
    ('uq_one_class_teacher_per_class_section_year', 'CREATE UNIQUE INDEX uq_one_class_teacher_per_class_section_year ON public.teacher_subject_assignments USING btree (academic_year_id, class_id, COALESCE(section_id, ''00000000-0000-0000-0000-000000000000''::uuid)) WHERE (is_class_teacher = true)'),
    ('uq_one_class_teacher_per_teacher_year', 'CREATE UNIQUE INDEX uq_one_class_teacher_per_teacher_year ON public.teacher_subject_assignments USING btree (teacher_id, academic_year_id) WHERE (is_class_teacher = true)')
), canonical_tables as (
  select c.* from pg_catalog.pg_class c where c.oid in (
    pg_catalog.to_regclass('public.user_roles'),pg_catalog.to_regclass('public.teachers'),pg_catalog.to_regclass('public.profiles'),
    pg_catalog.to_regclass('public.academic_years'),pg_catalog.to_regclass('public.classes'),pg_catalog.to_regclass('public.sections'),
    pg_catalog.to_regclass('public.subjects'),pg_catalog.to_regclass('public.students'),pg_catalog.to_regclass('public.enrollments'))
), checks(check_name, passes) as (
  select 'first_role_hotfix_metadata_present',
    pg_catalog.to_regprocedure('app_private.can_manage_school_roles(uuid)') is not null
    and exists (select 1 from pg_catalog.pg_proc where oid =
      pg_catalog.to_regprocedure('public.assign_school_role(uuid,uuid,public.app_role)') and not prosecdef)
    and (select count(*) = 1 and bool_and(polname = 'user_roles_read_own_or_school_admin' and polcmd = 'r')
      from pg_catalog.pg_policy where polrelid = pg_catalog.to_regclass('public.user_roles'))
    and not pg_catalog.has_table_privilege('authenticated', pg_catalog.to_regclass('public.user_roles'),
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('authenticated', pg_catalog.to_regclass('public.user_roles'),
      'INSERT,UPDATE,REFERENCES')
  union all
  select 'expected_7_rls_tables_and_owners', (select count(*) = 7 and bool_and(
    coalesce(oid is not null and relkind = 'r' and relrowsecurity
      and relowner = (select oid from pg_catalog.pg_roles where rolname = t.owner_name), false)) from tables t)
  union all
  select 'expected_20_named_policy_shapes', (select count(*) = 20 and bool_and(
    coalesce(oid is not null and polcmd::text = command_code and polpermissive
      and polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]::oid[], false)) from policies)
  union all
  select 'expected_20_using_predicates', (select count(*) = 20 and bool_and(
    coalesce(actual_using = predicate, false)) from policies)
  union all
  select 'expected_20_with_check_predicates', (select count(*) = 20 and bool_and(
    case when command_code in ('*','w') then coalesce(actual_check = check_predicate, false)
      else actual_check is null end) from policies)
  union all
  select 'expected_20_policy_name_allowlist',
    (select count(*) = 20 from expected_policy_names)
    and not exists (select 1 from expected_policy_names e where not exists (
      select 1 from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.' || e.table_name)
        and p.polname = e.policy_name))
    and not exists (select 1 from pg_catalog.pg_policy p join tables t on t.oid = p.polrelid
      where not exists (select 1 from expected_policy_names e
        where e.table_name = t.table_name and e.policy_name = p.polname))
  union all
  select 'no_legacy_global_staff_calls_in_policies', not exists (
    select 1 from pg_catalog.pg_policy p where
      coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') ~ 'app_private[.]is_(school_admin|finance)[(][)]'
      or coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'app_private[.]is_(school_admin|finance)[(][)]')
  union all
  select 'five_governance_function_security_contracts', (select count(*) = 5 and bool_and(coalesce(
    oid is not null and prokind = 'f' and prosecdef = expected_definer and provolatile::text = expected_volatility
      and prorettype = pg_catalog.to_regtype('pg_catalog.' || expected_return_type) and lanname = expected_language, false)) from functions)
  union all
  select 'five_helpers_empty_search_path', (select count(*) = 5 and bool_and(
    coalesce(proconfig @> array['search_path=""']::text[], false)) from functions)
  union all
  select 'five_helper_sources_match_patch', (select count(*) = 5 and bool_and(coalesce(
    pg_catalog.md5(pg_catalog.regexp_replace(prosrc, '[[:space:]]+', '', 'g')) = source_md5, false)) from functions)
  union all
  select 'helper_owners_bypass_canonical_tables',
    (select count(*) = 9 from canonical_tables)
    and (select count(*) = 36 and bool_and(coalesce(f.rolsuper or f.rolbypassrls
      or (f.proowner = t.relowner and not t.relforcerowsecurity), false))
      from functions f cross join canonical_tables t where f.expected_definer)
  union all
  select 'helper_owners_not_inherited_by_api_roles', (select count(*) = 5 and bool_and(coalesce(
    not pg_catalog.pg_has_role('anon', proowner, 'USAGE')
      and not pg_catalog.pg_has_role('authenticated', proowner, 'USAGE'), false)) from functions)
  union all
  select 'private_schema_usage_without_api_create',
    pg_catalog.has_schema_privilege('authenticated', 'app_private', 'USAGE')
    and pg_catalog.has_schema_privilege('service_role', 'app_private', 'USAGE')
    and not pg_catalog.has_schema_privilege('authenticated', 'app_private', 'CREATE')
    and not pg_catalog.has_schema_privilege('anon', 'app_private', 'CREATE')
  union all
  select 'helper_execute_authenticated_and_service', (select count(*) = 5 and bool_and(coalesce(
    pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'), false)) from functions)
  union all
  select 'helper_execute_denied_public_and_anon', (select count(*) = 5 and bool_and(coalesce(
    not pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE') and not exists (
      select 1 from pg_catalog.aclexplode(coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'), false)) from functions f)
  union all
  select 'no_public_table_or_column_acl_7_targets',
    not exists (select 1 from tables t cross join lateral
      pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) a where a.grantee = 0)
    and not exists (select 1 from tables t join pg_catalog.pg_attribute c on c.attrelid = t.oid
      cross join lateral pg_catalog.aclexplode(c.attacl) a
      where c.attnum > 0 and not c.attisdropped and a.grantee = 0)
  union all
  select 'anon_no_effective_table_column_or_maintain', (select count(*) = 7 and bool_and(coalesce(
    not pg_catalog.has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('anon', oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    and not (case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('anon', oid, 'MAINTAIN') else false end), false)) from tables)
  union all
  select 'authenticated_has_all_four_dml_privileges',
    (select count(*) = 28 and bool_and(coalesce(pg_catalog.has_table_privilege('authenticated', t.oid, p.name), false))
      from tables t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(name))
  union all
  select 'authenticated_has_no_non_dml_privileges', (select count(*) = 7 and bool_and(coalesce(
    not pg_catalog.has_table_privilege('authenticated', oid, 'TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('authenticated', oid, 'REFERENCES')
    and not (case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('authenticated', oid, 'MAINTAIN') else false end), false)) from tables)
  union all
  select 'trusted_service_table_privileges_preserved',
    (select count(*) = 49 and bool_and(coalesce(pg_catalog.has_table_privilege('service_role', t.oid, p.name), false))
      from tables t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(name))
    and (select count(*) = 7 and bool_and(coalesce(case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('service_role', oid, 'MAINTAIN') else true end, false)) from tables)
  union all
  select 'assignment_scope_validation_trigger_enabled', exists (
    select 1 from pg_catalog.pg_trigger where tgrelid = pg_catalog.to_regclass('public.teacher_subject_assignments')
      and tgname = 'trg_validate_teacher_assignment' and not tgisinternal and tgenabled = 'O'
      and tgtype = 23 and tgfoid = pg_catalog.to_regprocedure('app_private.validate_teacher_assignment()')
      and tgqual is null and tgnargs = 0 and tgattr::text = '')
  union all
  select 'seven_academic_identity_guards_enabled', (select count(*) = 7 and bool_and(coalesce(
    g.oid is not null and not g.tgisinternal and g.tgenabled = 'O' and g.tgtype = 19
      and g.tgfoid = pg_catalog.to_regprocedure('app_private.guard_academic_identity()')
      and g.tgqual is null and g.tgnargs = 0 and g.tgattr::text = '', false))
    from tables t left join pg_catalog.pg_trigger g on g.tgrelid = t.oid and g.tgname = 'trg_guard_academic_identity')
  union all
  select 'expected_nine_custom_trigger_names',
    (select count(*) = 9 from expected_triggers)
    and not exists (select 1 from expected_triggers e where not exists (
      select 1 from pg_catalog.pg_trigger g where g.tgrelid = pg_catalog.to_regclass('public.' || e.table_name)
        and g.tgname = e.trigger_name and not g.tgisinternal))
    and not exists (select 1 from tables t join pg_catalog.pg_trigger g on g.tgrelid = t.oid
      where not g.tgisinternal and not exists (select 1 from expected_triggers e
        where e.table_name = t.table_name and e.trigger_name = g.tgname))
  union all
  select 'registration_public_signature_preserved', exists (
    select 1 from functions where signature = 'public.register_student_for_class_teacher(text)'
      and proretset and prosecdef and lanname = 'plpgsql'
      and pg_catalog.regexp_replace(pg_catalog.pg_get_function_result(oid),'[[:space:]]+','','g')
        = 'TABLE(student_iduuid,admission_notext,roll_notext,class_iduuid,section_iduuid)')
  union all
  select 'four_existing_class_teacher_unique_indexes_preserved', (select count(*) = 4 and bool_and(coalesce(
    i.indexrelid is not null and i.indisunique and i.indisvalid and i.indisready
      and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid),'[[:space:]]+','','g')
        = pg_catalog.regexp_replace(e.definition,'[[:space:]]+','','g'),false))
    from expected_indexes e left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('public.' || e.name)
    left join pg_catalog.pg_index i on i.indexrelid = c.oid and i.indrelid = pg_catalog.to_regclass('public.teacher_subject_assignments'))
  union all
  select 'assignment_writes_have_only_the_manager_policy',
    (select count(*) = 3 from pg_catalog.pg_policy where polrelid = pg_catalog.to_regclass('public.teacher_subject_assignments'))
    and not exists (select 1 from pg_catalog.pg_policy where polrelid = pg_catalog.to_regclass('public.teacher_subject_assignments')
      and (polname <> 'admin_teacher_assignments_all' and polcmd <> 'r'))
)
select check_name,coalesce(passes,false) as passes from checks order by check_name;
