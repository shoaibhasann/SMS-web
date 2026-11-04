-- SELECT-only catalog checks. Expect all 20 passes values to be true.
-- No application/user_roles rows, pupil data or credentials are selected.
-- Exact patch conformance, not proof of complete tenant isolation or live-user behavior.
with expected_tables(table_name, owner_name) as (
  values
    ('academic_years', 'postgres'),
    ('attendance', 'postgres'),
    ('class_activities', 'postgres'),
    ('class_logs', 'postgres'),
    ('classes', 'postgres'),
    ('enrollments', 'postgres'),
    ('fee_payments', 'postgres'),
    ('fee_structures', 'postgres'),
    ('notices', 'postgres'),
    ('parents', 'postgres'),
    ('sections', 'postgres'),
    ('student_fees', 'postgres'),
    ('student_parents', 'postgres'),
    ('students', 'postgres'),
    ('study_materials', 'postgres'),
    ('teacher_subject_assignments', 'postgres'),
    ('timetables', 'postgres')
), tables as (
  select e.*, c.oid, c.relowner, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from expected_tables e left join pg_catalog.pg_class c
    on c.oid = pg_catalog.to_regclass('public.' || e.table_name)
), expected_functions(signature, source_md5) as (
  values
    ('app_private.has_school_roles(uuid,public.app_role[])', '7b350491976610e92ca5d05b7073b6e4'),
    ('app_private.has_school_roles_for_student(uuid,public.app_role[])', 'b3d9c1b2e2ec16e20a562dd9bfb295b2'),
    ('app_private.has_school_roles_for_teacher(uuid,public.app_role[])', '86ec1efe4abc0f4b20c39b08a6b964c4'),
    ('app_private.has_school_roles_for_class_log(uuid,public.app_role[])', 'e00841f9611b6cebd68918a6afe944a2'),
    ('app_private.has_school_roles_for_student_parent(uuid,uuid,public.app_role[])', 'c1739ab9c710d1d936171ab51625d0f7')
), functions as (
  select e.*, p.oid, p.proowner, p.proconfig, p.prosrc, p.prosecdef,
    p.provolatile, p.prorettype, p.prokind, p.proacl, l.lanname,
    r.rolsuper, r.rolbypassrls
  from expected_functions e
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
  left join pg_catalog.pg_language l on l.oid = p.prolang
  left join pg_catalog.pg_roles r on r.oid = p.proowner
), expected_policies(table_name, policy_name, command_code, predicate) as (
  values
    ('attendance', 'attendance_staff_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('class_activities', 'class_activities_staff_all', '*', 'app_private.has_school_roles_for_class_log(class_log_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('class_logs', 'class_logs_staff_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('enrollments', 'enrollments_staff_all', '*', 'app_private.has_school_roles_for_student(student_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('enrollments', 'admin_enrollments_all', '*', 'app_private.has_school_roles_for_student(student_id,ARRAY[''school_admin''])'),
    ('fee_payments', 'fee_payments_admin_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('fee_structures', 'fee_structures_admin_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('notices', 'notices_staff_all', '*', '(app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])OR((created_by=(SELECTauth.uid()ASuid))ANDapp_private.has_school_roles(school_id,ARRAY[''teacher''])))'),
    ('parents', 'parents_admin_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('student_fees', 'student_fees_admin_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('student_parents', 'student_parents_staff_all', '*', 'app_private.has_school_roles_for_student_parent(student_id,parent_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('students', 'students_staff_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('study_materials', 'study_materials_staff_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('teacher_subject_assignments', 'teacher_assignments_staff_all', '*', 'app_private.has_school_roles_for_teacher(teacher_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('timetables', 'timetables_staff_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff''])'),
    ('academic_years', 'academic_years_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('classes', 'classes_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('fee_payments', 'fee_payments_finance_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('fee_structures', 'fee_structures_finance_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('sections', 'sections_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('student_fees', 'student_fees_finance_all', '*', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])'),
    ('students', 'students_finance_read', 'r', 'app_private.has_school_roles(school_id,ARRAY[''accountant''])')
), policies as (
  select e.*, p.oid, p.polcmd, p.polpermissive, p.polroles,
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(
      pg_catalog.pg_get_expr(p.polqual, p.polrelid),
      '::(public[.])?app_role(\[\])?', '', 'g'), '[[:space:]]+', '', 'g') as actual_using,
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
      '::(public[.])?app_role(\[\])?', '', 'g'), '[[:space:]]+', '', 'g') as actual_check
  from expected_policies e left join pg_catalog.pg_policy p
    on p.polrelid = pg_catalog.to_regclass('public.' || e.table_name)
    and p.polname = e.policy_name
), expected_policy_groups(table_name, names) as (
  values
    ('academic_years', ARRAY['academic_years_finance_read','admin_academic_years_all','tenant_isolation_academic_years']),
    ('attendance', ARRAY['admin_attendance_all','attendance_class_teacher_manage','attendance_parent_read','attendance_staff_all','attendance_student_read']),
    ('class_activities', ARRAY['admin_class_activities_all','class_activities_parent_read','class_activities_staff_all','class_activities_student_read','class_activities_teacher_own','teachers_manage_own_class_activities_delete','teachers_manage_own_class_activities_insert','teachers_manage_own_class_activities_update']),
    ('class_logs', ARRAY['admin_class_logs_all','class_logs_parent_read','class_logs_staff_all','class_logs_student_read','class_logs_teacher_own','teachers_manage_own_class_logs_delete','teachers_manage_own_class_logs_insert','teachers_manage_own_class_logs_update']),
    ('classes', ARRAY['admin_classes_all','classes_finance_read','tenant_isolation_classes']),
    ('enrollments', ARRAY['admin_enrollments_all','enrollments_parent_children','enrollments_staff_all','enrollments_student_own','enrollments_teacher_assigned_read']),
    ('fee_payments', ARRAY['admin_fee_payments_all','fee_payments_admin_all','fee_payments_finance_all','fee_payments_parent_read','fee_payments_student_read']),
    ('fee_structures', ARRAY['admin_fee_structures_all','fee_structures_admin_all','fee_structures_finance_all']),
    ('notices', ARRAY['notices_school_read','notices_staff_all']),
    ('parents', ARRAY['admin_parents_all','parents_admin_all','parents_parent_own']),
    ('sections', ARRAY['admin_sections_all','sections_finance_read','tenant_isolation_sections']),
    ('student_fees', ARRAY['admin_student_fees_all','student_fees_admin_all','student_fees_finance_all','student_fees_parent_read','student_fees_student_read']),
    ('student_parents', ARRAY['student_parents_parent_own','student_parents_staff_all']),
    ('students', ARRAY['admin_students_all','students_finance_read','students_parent_children','students_staff_all','students_student_own','students_teacher_assigned_read']),
    ('study_materials', ARRAY['study_materials_parent_read','study_materials_staff_all','study_materials_student_read','study_materials_teacher_own']),
    ('teacher_subject_assignments', ARRAY['admin_teacher_assignments_all','teacher_assignments_staff_all','teacher_assignments_teacher_own_delete','teacher_assignments_teacher_own_insert','teacher_assignments_teacher_own_select','teacher_assignments_teacher_own_update','teachers_manage_own_assignments_delete','teachers_manage_own_assignments_insert','teachers_manage_own_assignments_select','teachers_manage_own_assignments_update']),
    ('timetables', ARRAY['timetables_parent_read','timetables_staff_all','timetables_student_read','timetables_teacher_read'])
), expected_policy_names as (
  select g.table_name, n.policy_name from expected_policy_groups g
  cross join lateral pg_catalog.unnest(g.names) n(policy_name)
), canonical_tables as (
  select c.* from pg_catalog.pg_class c where c.oid in (
    pg_catalog.to_regclass('public.user_roles'), pg_catalog.to_regclass('public.students'),
    pg_catalog.to_regclass('public.teachers'), pg_catalog.to_regclass('public.parents'),
    pg_catalog.to_regclass('public.class_logs'))
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
  select 'expected_17_rls_tables_and_owners', (select count(*) = 17 and bool_and(
    coalesce(oid is not null and relkind = 'r' and relrowsecurity
      and relowner = (select oid from pg_catalog.pg_roles where rolname = t.owner_name), false)) from tables t)
  union all
  select 'expected_22_named_policy_shapes', (select count(*) = 22 and bool_and(
    coalesce(oid is not null and polcmd::text = command_code and polpermissive
      and polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]::oid[], false)) from policies)
  union all
  select 'expected_22_using_predicates', (select count(*) = 22 and bool_and(
    coalesce(actual_using = predicate, false)) from policies)
  union all
  select 'expected_22_with_check_predicates', (select count(*) = 22 and bool_and(
    case when command_code = '*' then coalesce(actual_check = predicate, false)
      else actual_check is null end) from policies)
  union all
  select 'expected_79_policy_name_allowlist',
    (select count(*) = 79 from expected_policy_names)
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
  select 'five_private_boolean_sql_stable_definers', (select count(*) = 5 and bool_and(coalesce(
    oid is not null and prokind = 'f' and prosecdef and provolatile = 's'
      and prorettype = 'pg_catalog.bool'::regtype and lanname = 'sql', false)) from functions)
  union all
  select 'five_helpers_empty_search_path', (select count(*) = 5 and bool_and(
    coalesce(proconfig @> array['search_path=""']::text[], false)) from functions)
  union all
  select 'five_helper_sources_match_patch', (select count(*) = 5 and bool_and(coalesce(
    pg_catalog.md5(pg_catalog.regexp_replace(prosrc, '[[:space:]]+', '', 'g')) = source_md5, false)) from functions)
  union all
  select 'helper_owners_bypass_canonical_tables',
    (select count(*) = 5 from canonical_tables)
    and (select count(*) = 25 and bool_and(coalesce(f.rolsuper or f.rolbypassrls
      or (f.proowner = t.relowner and not t.relforcerowsecurity), false))
      from functions f cross join canonical_tables t)
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
  select 'no_public_table_or_column_acl_17_targets',
    not exists (select 1 from tables t cross join lateral
      pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) a where a.grantee = 0)
    and not exists (select 1 from tables t join pg_catalog.pg_attribute c on c.attrelid = t.oid
      cross join lateral pg_catalog.aclexplode(c.attacl) a
      where c.attnum > 0 and not c.attisdropped and a.grantee = 0)
  union all
  select 'anon_no_effective_table_column_or_maintain', (select count(*) = 17 and bool_and(coalesce(
    not pg_catalog.has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('anon', oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    and not (case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('anon', oid, 'MAINTAIN') else false end), false)) from tables)
  union all
  select 'authenticated_has_all_four_dml_privileges',
    (select count(*) = 68 and bool_and(coalesce(pg_catalog.has_table_privilege('authenticated', t.oid, p.name), false))
      from tables t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(name))
  union all
  select 'authenticated_has_no_non_dml_privileges', (select count(*) = 17 and bool_and(coalesce(
    not pg_catalog.has_table_privilege('authenticated', oid, 'TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('authenticated', oid, 'REFERENCES')
    and not (case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('authenticated', oid, 'MAINTAIN') else false end), false)) from tables)
  union all
  select 'trusted_service_table_privileges_preserved',
    (select count(*) = 119 and bool_and(coalesce(pg_catalog.has_table_privilege('service_role', t.oid, p.name), false))
      from tables t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(name))
    and (select count(*) = 17 and bool_and(coalesce(case when current_setting('server_version_num')::integer >= 170000
      then pg_catalog.has_table_privilege('service_role', oid, 'MAINTAIN') else true end, false)) from tables)
)
select check_name, coalesce(passes, false) as passes from checks order by check_name;
