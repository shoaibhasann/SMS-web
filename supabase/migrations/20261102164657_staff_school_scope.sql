-- Scope the 21 legacy office/finance grants to their canonical school and
-- replace one equivalent enrollment-admin lookup to break an RLS cycle.
-- Preserve existing same-school office role permissions. Other coexisting
-- tenant, teacher-own and family policies remain outside this bounded patch.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $preflight$
declare
  expected record;
  actual record;
  actor record;
begin
  select * into actor from pg_catalog.pg_roles where rolname = current_user;
  if pg_catalog.to_regprocedure('app_private.can_manage_school_roles(uuid)') is null
    or not exists (select 1 from pg_catalog.pg_proc
      where oid = pg_catalog.to_regprocedure('public.assign_school_role(uuid,uuid,public.app_role)')
        and not prosecdef)
    or not exists (select 1 from pg_catalog.pg_policy
      where polrelid = pg_catalog.to_regclass('public.user_roles')
        and polname = 'user_roles_read_own_or_school_admin' and polcmd = 'r')
    or pg_catalog.has_table_privilege('authenticated',
      pg_catalog.to_regclass('public.user_roles'), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('authenticated',
      pg_catalog.to_regclass('public.user_roles'), 'INSERT,UPDATE,REFERENCES') then
    raise exception 'Apply and verify the first role-permission hotfix before this staff-school-scope patch.';
  end if;

  for expected in
    select unnest(array['academic_years', 'attendance', 'class_activities', 'class_logs', 'classes', 'enrollments', 'fee_payments', 'fee_structures', 'notices', 'parents', 'sections', 'student_fees', 'student_parents', 'students', 'study_materials', 'teacher_subject_assignments', 'timetables', 'teachers', 'user_roles']) as table_name
  loop
    select c.* into actual from pg_catalog.pg_class c
      where c.oid = pg_catalog.to_regclass('public.' || expected.table_name);
    if not found or actual.relkind <> 'r' or not actual.relrowsecurity then
      raise exception 'Expected ordinary RLS-enabled table public.%.', expected.table_name;
    end if;
    if not (actor.rolsuper or actor.rolbypassrls
      or (actual.relowner = actor.oid and not actual.relforcerowsecurity)) then
      raise exception 'Executor must be a trusted owner without forced RLS, or superuser/BYPASSRLS for public.%.', expected.table_name;
    end if;
    if expected.table_name = any(array['academic_years', 'attendance', 'class_activities', 'class_logs', 'classes', 'enrollments', 'fee_payments', 'fee_structures', 'notices', 'parents', 'sections', 'student_fees', 'student_parents', 'students', 'study_materials', 'teacher_subject_assignments', 'timetables'])
      and not (pg_catalog.has_table_privilege('authenticated', actual.oid, 'SELECT')
        and pg_catalog.has_table_privilege('authenticated', actual.oid, 'INSERT')
        and pg_catalog.has_table_privilege('authenticated', actual.oid, 'UPDATE')
        and pg_catalog.has_table_privilege('authenticated', actual.oid, 'DELETE')) then
      raise exception 'Authenticated DML privileges drifted on %. Review before restoring the snapshot DML quartet.', expected.table_name;
    end if;
  end loop;

  -- Validate only the named policy command/role shape. This is not a complete
  -- expression-drift audit of the other coexisting policies.
  for expected in
    select * from (values
      ('attendance', 'attendance_staff_all', 'ALL', 'direct', 'staff'),
      ('class_activities', 'class_activities_staff_all', 'ALL', 'class_log', 'staff'),
      ('class_logs', 'class_logs_staff_all', 'ALL', 'direct', 'staff'),
      ('enrollments', 'enrollments_staff_all', 'ALL', 'student', 'staff'),
      ('enrollments', 'admin_enrollments_all', 'ALL', 'student', 'admin'),
      ('fee_payments', 'fee_payments_admin_all', 'ALL', 'direct', 'staff'),
      ('fee_structures', 'fee_structures_admin_all', 'ALL', 'direct', 'staff'),
      ('notices', 'notices_staff_all', 'ALL', 'direct', 'notice'),
      ('parents', 'parents_admin_all', 'ALL', 'direct', 'staff'),
      ('student_fees', 'student_fees_admin_all', 'ALL', 'direct', 'staff'),
      ('student_parents', 'student_parents_staff_all', 'ALL', 'student_parent', 'staff'),
      ('students', 'students_staff_all', 'ALL', 'direct', 'staff'),
      ('study_materials', 'study_materials_staff_all', 'ALL', 'direct', 'staff'),
      ('teacher_subject_assignments', 'teacher_assignments_staff_all', 'ALL', 'teacher', 'staff'),
      ('timetables', 'timetables_staff_all', 'ALL', 'direct', 'staff'),
      ('academic_years', 'academic_years_finance_read', 'SELECT', 'direct', 'finance'),
      ('classes', 'classes_finance_read', 'SELECT', 'direct', 'finance'),
      ('fee_payments', 'fee_payments_finance_all', 'ALL', 'direct', 'finance'),
      ('fee_structures', 'fee_structures_finance_all', 'ALL', 'direct', 'finance'),
      ('sections', 'sections_finance_read', 'SELECT', 'direct', 'finance'),
      ('student_fees', 'student_fees_finance_all', 'ALL', 'direct', 'finance'),
      ('students', 'students_finance_read', 'SELECT', 'direct', 'finance')
    ) as p(table_name, policy_name, command_name, scope_kind, role_kind)
  loop
    select p.* into actual from pg_catalog.pg_policy p
      where p.polrelid = pg_catalog.to_regclass('public.' || expected.table_name)
        and p.polname = expected.policy_name;
    if not found or actual.polcmd::text <> (case when expected.command_name = 'ALL' then '*' else 'r' end)
      or not actual.polpermissive
      or actual.polroles <> array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]::oid[] then
      raise exception 'Missing or incompatible named policy %.%.', expected.table_name, expected.policy_name;
    end if;
  end loop;

  -- Reject additional policy names on touched tables. This does not detect
  -- condition changes under an existing coexisting policy name.
  if exists (
    select 1 from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array['academic_years', 'attendance', 'class_activities', 'class_logs', 'classes', 'enrollments', 'fee_payments', 'fee_structures', 'notices', 'parents', 'sections', 'student_fees', 'student_parents', 'students', 'study_materials', 'teacher_subject_assignments', 'timetables'])
      and not exists (select 1 from (values
      ('academic_years', 'academic_years_finance_read'),
      ('academic_years', 'admin_academic_years_all'),
      ('academic_years', 'tenant_isolation_academic_years'),
      ('attendance', 'admin_attendance_all'),
      ('attendance', 'attendance_class_teacher_manage'),
      ('attendance', 'attendance_parent_read'),
      ('attendance', 'attendance_staff_all'),
      ('attendance', 'attendance_student_read'),
      ('class_activities', 'admin_class_activities_all'),
      ('class_activities', 'class_activities_parent_read'),
      ('class_activities', 'class_activities_staff_all'),
      ('class_activities', 'class_activities_student_read'),
      ('class_activities', 'class_activities_teacher_own'),
      ('class_activities', 'teachers_manage_own_class_activities_delete'),
      ('class_activities', 'teachers_manage_own_class_activities_insert'),
      ('class_activities', 'teachers_manage_own_class_activities_update'),
      ('class_logs', 'admin_class_logs_all'),
      ('class_logs', 'class_logs_parent_read'),
      ('class_logs', 'class_logs_staff_all'),
      ('class_logs', 'class_logs_student_read'),
      ('class_logs', 'class_logs_teacher_own'),
      ('class_logs', 'teachers_manage_own_class_logs_delete'),
      ('class_logs', 'teachers_manage_own_class_logs_insert'),
      ('class_logs', 'teachers_manage_own_class_logs_update'),
      ('classes', 'admin_classes_all'),
      ('classes', 'classes_finance_read'),
      ('classes', 'tenant_isolation_classes'),
      ('enrollments', 'admin_enrollments_all'),
      ('enrollments', 'enrollments_parent_children'),
      ('enrollments', 'enrollments_staff_all'),
      ('enrollments', 'enrollments_student_own'),
      ('enrollments', 'enrollments_teacher_assigned_read'),
      ('fee_payments', 'admin_fee_payments_all'),
      ('fee_payments', 'fee_payments_admin_all'),
      ('fee_payments', 'fee_payments_finance_all'),
      ('fee_payments', 'fee_payments_parent_read'),
      ('fee_payments', 'fee_payments_student_read'),
      ('fee_structures', 'admin_fee_structures_all'),
      ('fee_structures', 'fee_structures_admin_all'),
      ('fee_structures', 'fee_structures_finance_all'),
      ('notices', 'notices_school_read'),
      ('notices', 'notices_staff_all'),
      ('parents', 'admin_parents_all'),
      ('parents', 'parents_admin_all'),
      ('parents', 'parents_parent_own'),
      ('sections', 'admin_sections_all'),
      ('sections', 'sections_finance_read'),
      ('sections', 'tenant_isolation_sections'),
      ('student_fees', 'admin_student_fees_all'),
      ('student_fees', 'student_fees_admin_all'),
      ('student_fees', 'student_fees_finance_all'),
      ('student_fees', 'student_fees_parent_read'),
      ('student_fees', 'student_fees_student_read'),
      ('student_parents', 'student_parents_parent_own'),
      ('student_parents', 'student_parents_staff_all'),
      ('students', 'admin_students_all'),
      ('students', 'students_finance_read'),
      ('students', 'students_parent_children'),
      ('students', 'students_staff_all'),
      ('students', 'students_student_own'),
      ('students', 'students_teacher_assigned_read'),
      ('study_materials', 'study_materials_parent_read'),
      ('study_materials', 'study_materials_staff_all'),
      ('study_materials', 'study_materials_student_read'),
      ('study_materials', 'study_materials_teacher_own'),
      ('teacher_subject_assignments', 'admin_teacher_assignments_all'),
      ('teacher_subject_assignments', 'teacher_assignments_staff_all'),
      ('teacher_subject_assignments', 'teacher_assignments_teacher_own_delete'),
      ('teacher_subject_assignments', 'teacher_assignments_teacher_own_insert'),
      ('teacher_subject_assignments', 'teacher_assignments_teacher_own_select'),
      ('teacher_subject_assignments', 'teacher_assignments_teacher_own_update'),
      ('teacher_subject_assignments', 'teachers_manage_own_assignments_delete'),
      ('teacher_subject_assignments', 'teachers_manage_own_assignments_insert'),
      ('teacher_subject_assignments', 'teachers_manage_own_assignments_select'),
      ('teacher_subject_assignments', 'teachers_manage_own_assignments_update'),
      ('timetables', 'timetables_parent_read'),
      ('timetables', 'timetables_staff_all'),
      ('timetables', 'timetables_student_read'),
      ('timetables', 'timetables_teacher_read')
      ) as allowed(table_name, policy_name)
      where allowed.table_name = c.relname and allowed.policy_name = p.polname)
  ) then
    raise exception 'Unknown policy names exist on the touched tables. Review the new policy routes first.';
  end if;

  for expected in
    select * from (values
      ('academic_years','school_id'), ('attendance','school_id'),
      ('class_logs','school_id'), ('classes','school_id'),
      ('fee_payments','school_id'), ('fee_structures','school_id'),
      ('notices','school_id'), ('parents','school_id'),
      ('sections','school_id'), ('student_fees','school_id'),
      ('students','school_id'), ('study_materials','school_id'),
      ('timetables','school_id'), ('teachers','school_id'),
      ('class_logs','id'), ('students','id'), ('parents','id'), ('teachers','id'),
      ('class_activities','class_log_id'), ('enrollments','student_id'),
      ('teacher_subject_assignments','teacher_id'),
      ('student_parents','student_id'), ('student_parents','parent_id')
    ) as c(table_name, column_name)
  loop
    if not exists (select 1 from pg_catalog.pg_attribute a
      where a.attrelid = pg_catalog.to_regclass('public.' || expected.table_name)
        and a.attname = expected.column_name and a.atttypid = 'uuid'::regtype
        and a.attnum > 0 and not a.attisdropped) then
      raise exception 'Expected UUID scope column %.%.', expected.table_name, expected.column_name;
    end if;
  end loop;
  if pg_catalog.has_schema_privilege('anon', 'app_private', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'app_private', 'CREATE') then
    raise exception 'Private helper schema permits untrusted CREATE. Review its grants first.';
  end if;
end;
$preflight$;

lock table public.academic_years, public.attendance, public.class_activities, public.class_logs, public.classes, public.enrollments, public.fee_payments, public.fee_structures, public.notices, public.parents, public.sections, public.student_fees, public.student_parents, public.students, public.study_materials, public.teacher_subject_assignments, public.timetables in access exclusive mode;

create or replace function app_private.has_school_roles(
  p_school_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select auth.uid() is not null and exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and (ur.role = 'super_admin'::public.app_role
        or (ur.school_id = p_school_id and ur.role = any(p_roles)))
  );
$function$;

-- Narrow boolean resolvers avoid adding RLS recursion through the canonical
-- parent records. They return no school/person rows or identifiers.
create or replace function app_private.has_school_roles_for_student(
  p_student_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.students s
    where s.id = p_student_id and app_private.has_school_roles(s.school_id, p_roles));
$function$;

create or replace function app_private.has_school_roles_for_teacher(
  p_teacher_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.teachers t
    where t.id = p_teacher_id and app_private.has_school_roles(t.school_id, p_roles));
$function$;

create or replace function app_private.has_school_roles_for_class_log(
  p_class_log_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.class_logs cl
    where cl.id = p_class_log_id and app_private.has_school_roles(cl.school_id, p_roles));
$function$;

create or replace function app_private.has_school_roles_for_student_parent(
  p_student_id uuid, p_parent_id uuid, p_roles public.app_role[]
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.students s
    join public.parents p on p.id = p_parent_id and p.school_id = s.school_id
    where s.id = p_student_id and app_private.has_school_roles(s.school_id, p_roles));
$function$;

do $policies_and_privileges$
declare
  p record;
  signature text;
  table_name text;
  allowed_roles text;
  predicate text;
begin
  foreach signature in array array[
    'app_private.has_school_roles(uuid,public.app_role[])',
        'app_private.has_school_roles_for_student(uuid,public.app_role[])',
        'app_private.has_school_roles_for_teacher(uuid,public.app_role[])',
        'app_private.has_school_roles_for_class_log(uuid,public.app_role[])',
        'app_private.has_school_roles_for_student_parent(uuid,uuid,public.app_role[])'
  ] loop
    execute format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', signature);
    execute format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', signature);
  end loop;
  grant usage on schema app_private to authenticated, service_role;

  for p in
    select * from (values
      ('attendance', 'attendance_staff_all', 'ALL', 'direct', 'staff'),
      ('class_activities', 'class_activities_staff_all', 'ALL', 'class_log', 'staff'),
      ('class_logs', 'class_logs_staff_all', 'ALL', 'direct', 'staff'),
      ('enrollments', 'enrollments_staff_all', 'ALL', 'student', 'staff'),
      ('enrollments', 'admin_enrollments_all', 'ALL', 'student', 'admin'),
      ('fee_payments', 'fee_payments_admin_all', 'ALL', 'direct', 'staff'),
      ('fee_structures', 'fee_structures_admin_all', 'ALL', 'direct', 'staff'),
      ('notices', 'notices_staff_all', 'ALL', 'direct', 'notice'),
      ('parents', 'parents_admin_all', 'ALL', 'direct', 'staff'),
      ('student_fees', 'student_fees_admin_all', 'ALL', 'direct', 'staff'),
      ('student_parents', 'student_parents_staff_all', 'ALL', 'student_parent', 'staff'),
      ('students', 'students_staff_all', 'ALL', 'direct', 'staff'),
      ('study_materials', 'study_materials_staff_all', 'ALL', 'direct', 'staff'),
      ('teacher_subject_assignments', 'teacher_assignments_staff_all', 'ALL', 'teacher', 'staff'),
      ('timetables', 'timetables_staff_all', 'ALL', 'direct', 'staff'),
      ('academic_years', 'academic_years_finance_read', 'SELECT', 'direct', 'finance'),
      ('classes', 'classes_finance_read', 'SELECT', 'direct', 'finance'),
      ('fee_payments', 'fee_payments_finance_all', 'ALL', 'direct', 'finance'),
      ('fee_structures', 'fee_structures_finance_all', 'ALL', 'direct', 'finance'),
      ('sections', 'sections_finance_read', 'SELECT', 'direct', 'finance'),
      ('student_fees', 'student_fees_finance_all', 'ALL', 'direct', 'finance'),
      ('students', 'students_finance_read', 'SELECT', 'direct', 'finance')
    ) as p(table_name, policy_name, command_name, scope_kind, role_kind)
  loop
    allowed_roles := case when p.role_kind = 'finance'
      then 'ARRAY[''accountant'']::public.app_role[]'
      when p.role_kind = 'admin' then 'ARRAY[''school_admin'']::public.app_role[]'
      else 'ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff'']::public.app_role[]' end;
    predicate := case p.scope_kind
      when 'student' then format('app_private.has_school_roles_for_student(student_id, %s)', allowed_roles)
      when 'teacher' then format('app_private.has_school_roles_for_teacher(teacher_id, %s)', allowed_roles)
      when 'class_log' then format('app_private.has_school_roles_for_class_log(class_log_id, %s)', allowed_roles)
      when 'student_parent' then format('app_private.has_school_roles_for_student_parent(student_id, parent_id, %s)', allowed_roles)
      else format('app_private.has_school_roles(school_id, %s)', allowed_roles) end;
    if p.role_kind = 'notice' then
      predicate := '(' || predicate || ') OR (created_by = (SELECT auth.uid()) AND '
        || 'app_private.has_school_roles(school_id, ARRAY[''teacher'']::public.app_role[]))';
    end if;
    execute format('DROP POLICY %I ON public.%I', p.policy_name, p.table_name);
    execute format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR %s TO authenticated USING (%s)%s',
      p.policy_name, p.table_name, p.command_name, predicate,
      case when p.command_name = 'ALL' then ' WITH CHECK (' || predicate || ')' else '' end);
  end loop;

  foreach table_name in array array['academic_years', 'attendance', 'class_activities', 'class_logs', 'classes', 'enrollments', 'fee_payments', 'fee_structures', 'notices', 'parents', 'sections', 'student_fees', 'student_parents', 'students', 'study_materials', 'teacher_subject_assignments', 'timetables'] loop
    -- The snapshot grants auth all DML on these tables. Restore that quartet
    -- after clearing ALL, including column ACLs and version-specific MAINTAIN.
    execute format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    execute format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', table_name);
  end loop;
end;
$policies_and_privileges$;

do $postconditions$
declare
  signature text;
  helper record;
  source_table record;
  relation record;
  api_role text;
  maintained boolean;
begin
  foreach signature in array array['app_private.has_school_roles(uuid,public.app_role[])',
        'app_private.has_school_roles_for_student(uuid,public.app_role[])',
        'app_private.has_school_roles_for_teacher(uuid,public.app_role[])',
        'app_private.has_school_roles_for_class_log(uuid,public.app_role[])',
        'app_private.has_school_roles_for_student_parent(uuid,uuid,public.app_role[])'] loop
    select p.*, r.rolsuper, r.rolbypassrls into helper
      from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = pg_catalog.to_regprocedure(signature);
    if not found or not helper.prosecdef or helper.provolatile <> 's'
      or not coalesce(helper.proconfig @> array['search_path=""']::text[], false) then
      raise exception 'Invalid helper security configuration: %.', signature;
    end if;
    if pg_catalog.has_function_privilege('anon', helper.oid, 'EXECUTE')
      or not pg_catalog.has_function_privilege('authenticated', helper.oid, 'EXECUTE')
      or not pg_catalog.has_function_privilege('service_role', helper.oid, 'EXECUTE')
      or exists (select 1 from pg_catalog.aclexplode(
        coalesce(helper.proacl, pg_catalog.acldefault('f', helper.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'Unexpected effective helper execution privileges: %.', signature;
    end if;
    for source_table in
      select c.* from pg_catalog.pg_class c
      where c.oid in ('public.user_roles'::regclass, 'public.students'::regclass,
        'public.teachers'::regclass, 'public.parents'::regclass, 'public.class_logs'::regclass)
    loop
      if not (helper.rolsuper or helper.rolbypassrls
        or (helper.proowner = source_table.relowner and not source_table.relforcerowsecurity)) then
        raise exception 'Helper % owner cannot safely bypass canonical-table RLS.', signature;
      end if;
    end loop;
  end loop;

  for relation in
    select c.* from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any(array['academic_years', 'attendance', 'class_activities', 'class_logs', 'classes', 'enrollments', 'fee_payments', 'fee_structures', 'notices', 'parents', 'sections', 'student_fees', 'student_parents', 'students', 'study_materials', 'teacher_subject_assignments', 'timetables'])
  loop
    if exists (select 1 from pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) a where a.grantee = 0) then
      raise exception 'PUBLIC table privileges remain on %.', relation.relname;
    end if;
    if not (pg_catalog.has_table_privilege('service_role', relation.oid, 'SELECT')
      and pg_catalog.has_table_privilege('service_role', relation.oid, 'INSERT')
      and pg_catalog.has_table_privilege('service_role', relation.oid, 'UPDATE')
      and pg_catalog.has_table_privilege('service_role', relation.oid, 'DELETE')) then
      raise exception 'Trusted service DML access is missing on %.', relation.relname;
    end if;
    foreach api_role in array array['anon','authenticated'] loop
      maintained := case when current_setting('server_version_num')::integer >= 170000
        then pg_catalog.has_table_privilege(api_role, relation.oid, 'MAINTAIN') else false end;
      if (api_role = 'anon' and (
          pg_catalog.has_table_privilege(api_role, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(api_role, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
        or (api_role = 'authenticated' and (
          pg_catalog.has_table_privilege(api_role, relation.oid, 'TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(api_role, relation.oid, 'REFERENCES')))
        or maintained then
        raise exception 'Inherited or column API privileges remain unsafe on % for %.', relation.relname, api_role;
      end if;
    end loop;
  end loop;

  if exists (select 1 from pg_catalog.pg_policy p where
    coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') ~ 'app_private[.]is_(school_admin|finance)[(][)]'
    or coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'app_private[.]is_(school_admin|finance)[(][)]') then
    raise exception 'A policy still calls a legacy global staff/finance helper. Review unexpected callers.';
  end if;
end;
$postconditions$;

commit;
