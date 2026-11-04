-- Teaching assignment governance after the role and staff-school-scope patches.
-- Existing rows are preserved. Invalid/ambiguous existing scopes abort the patch.
-- Legacy rollover indexes and unrelated academic/activation policies are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $preflight$
declare
  item record;
  relation record;
  executor record;
begin
  select * into executor from pg_catalog.pg_roles where rolname = current_user;
  if pg_catalog.to_regprocedure('app_private.has_school_roles(uuid,public.app_role[])') is null
    or pg_catalog.to_regprocedure('app_private.can_manage_school_roles(uuid)') is null
    or pg_catalog.to_regprocedure('app_private.assign_school_role(uuid,uuid,public.app_role)') is null
    or not exists (select 1 from pg_catalog.pg_proc
      where oid=pg_catalog.to_regprocedure('public.assign_school_role(uuid,uuid,public.app_role)')
        and not prosecdef)
    or not exists (select 1 from pg_catalog.pg_policy
      where polrelid=pg_catalog.to_regclass('public.user_roles')
        and polname='user_roles_read_own_or_school_admin' and polcmd='r')
    or pg_catalog.has_table_privilege('authenticated', 'public.user_roles', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('authenticated', 'public.user_roles', 'INSERT,UPDATE,REFERENCES')
    or exists (select 1 from pg_catalog.pg_policy p where
      coalesce(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'') ~ 'app_private[.]is_(school_admin|finance)[(][)]'
      or coalesce(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'') ~ 'app_private[.]is_(school_admin|finance)[(][)]') then
    raise exception 'Apply and verify the first role and staff-school-scope patches first.';
  end if;
  for item in select unnest(array['academic_years', 'classes', 'profiles', 'sections', 'subjects', 'teacher_subject_assignments', 'teachers', 'user_roles']) as table_name loop
    select c.* into relation from pg_catalog.pg_class c
      where c.oid = pg_catalog.to_regclass('public.' || item.table_name);
    if not found or relation.relkind <> 'r' or not relation.relrowsecurity then
      raise exception 'Expected ordinary RLS-enabled table public.%.', item.table_name;
    end if;
    if not (executor.rolsuper or executor.rolbypassrls
      or (executor.oid = relation.relowner and not relation.relforcerowsecurity)) then
      raise exception 'Trusted executor cannot bypass RLS on public.%.', item.table_name;
    end if;
    if item.table_name <> 'user_roles' and not (
      pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT')
      and pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
      and pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
      and pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')) then
      raise exception 'Authenticated DML grants changed on %. Review privilege drift first.', item.table_name;
    end if;
  end loop;
  if pg_catalog.has_schema_privilege('anon','app_private','CREATE')
    or pg_catalog.has_schema_privilege('authenticated','app_private','CREATE') then
    raise exception 'Untrusted CREATE in the helper schema must be reviewed first.';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid=p.polrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any(array['academic_years', 'classes', 'profiles', 'sections', 'subjects', 'teacher_subject_assignments', 'teachers'])
      and not exists (select 1 from (values
      ('academic_years', 'academic_years_finance_read'),
      ('academic_years', 'admin_academic_years_all'),
      ('academic_years', 'tenant_isolation_academic_years'),
      ('classes', 'admin_classes_all'),
      ('classes', 'classes_finance_read'),
      ('classes', 'tenant_isolation_classes'),
      ('profiles', 'admin_profiles_all'),
      ('profiles', 'profiles_update_own'),
      ('profiles', 'tenant_isolation_profiles'),
      ('sections', 'admin_sections_all'),
      ('sections', 'sections_finance_read'),
      ('sections', 'tenant_isolation_sections'),
      ('subjects', 'admin_subjects_all'),
      ('subjects', 'tenant_isolation_subjects'),
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
      ('teachers', 'admin_teachers_all'),
      ('teachers', 'tenant_isolation_teachers'),
      ('teacher_subject_assignments', 'teacher_assignments_staff_read'),
      ('profiles', 'profiles_select_own')
      ) as allowed(table_name,policy_name)
      where allowed.table_name=c.relname and allowed.policy_name=p.polname)) then
    raise exception 'Unknown policy names exist on a governance table. Review those routes first.';
  end if;
  -- Reject additional custom trigger names before installing the guards.
  -- Existing-name source changes remain a separate schema-review concern.
  if exists (select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='public'
      and c.relname=any(array['academic_years', 'classes', 'profiles', 'sections', 'subjects', 'teacher_subject_assignments', 'teachers'])
      and not (t.tgname='trg_guard_academic_identity'
        or (c.relname='profiles' and t.tgname='trg_profiles_updated')
        or (c.relname='teacher_subject_assignments' and t.tgname='trg_validate_teacher_assignment'))) then
    raise exception 'Unknown custom trigger names exist on a governance table. Review those hooks first.';
  end if;
end;
$preflight$;

lock table public.academic_years, public.classes, public.profiles, public.sections, public.subjects, public.teacher_subject_assignments, public.teachers in access exclusive mode;

create or replace function app_private.assignment_scope_is_coherent(
  p_teacher_id uuid, p_academic_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_subject_id uuid, p_is_class_teacher boolean
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.teachers t
    join public.academic_years y on y.id=p_academic_year_id and y.school_id=t.school_id
    join public.classes c on c.id=p_class_id and c.school_id=t.school_id
    join public.subjects s on s.id=p_subject_id and s.school_id=t.school_id
    where t.id=p_teacher_id and p_is_class_teacher is not null
      and (p_section_id is not null or not p_is_class_teacher)
      and (p_section_id is null or exists (select 1 from public.sections sec
        where sec.id=p_section_id and sec.school_id=t.school_id and sec.class_id=c.id))
  );
$function$;

create or replace function app_private.is_own_school_teacher(p_teacher_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select auth.uid() is not null and exists (
    select 1 from public.teachers t
    join public.profiles p on p.id=t.profile_id and p.is_active
    join public.user_roles ur on ur.user_id=p.id and ur.school_id=t.school_id
      and ur.role='teacher'::public.app_role
    where t.id=p_teacher_id and p.id=auth.uid()
  );
$function$;

create or replace function app_private.validate_teacher_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  -- SHARE locks also serialize non-key ownership changes by trusted backends.
  perform 1 from public.teachers where id=new.teacher_id for share;
  perform 1 from public.academic_years where id=new.academic_year_id for share;
  perform 1 from public.classes where id=new.class_id for share;
  perform 1 from public.subjects where id=new.subject_id for share;
  if new.section_id is not null then
    perform 1 from public.sections where id=new.section_id for share;
  end if;
  if not app_private.assignment_scope_is_coherent(new.teacher_id,new.academic_year_id,
    new.class_id,new.section_id,new.subject_id,new.is_class_teacher) then
    raise exception 'Assignment teacher, year, class, subject and section must form one school scope; class teachers require a section.';
  end if;
  return new;
end;
$function$;

create or replace function app_private.guard_academic_identity()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
declare
  trusted_backend boolean;
  previous jsonb := pg_catalog.to_jsonb(old);
  proposed jsonb := pg_catalog.to_jsonb(new);
begin
  select r.rolsuper or r.rolbypassrls or (c.relowner=r.oid and not c.relforcerowsecurity)
    into trusted_backend
    from pg_catalog.pg_roles r join pg_catalog.pg_class c on c.oid=tg_relid
    where r.rolname=current_user;
  if coalesce(trusted_backend,false) then return new; end if;
  if proposed->'id' is distinct from previous->'id' then
    raise exception 'API clients cannot change record identity.';
  end if;
  if tg_table_name <> 'teacher_subject_assignments'
    and proposed->'school_id' is distinct from previous->'school_id' then
    raise exception 'API clients cannot move academic or identity records between schools.';
  end if;
  if tg_table_name='sections' and proposed->'class_id' is distinct from previous->'class_id' then
    raise exception 'API clients cannot reparent a section. Use a reviewed transfer workflow.';
  end if;
  if tg_table_name='profiles' and not app_private.has_school_roles(
    (previous->>'school_id')::uuid, array['school_admin','principal']::public.app_role[]) then
    if (proposed - array['full_name','phone','avatar_url','updated_at'])
      is distinct from (previous - array['full_name','phone','avatar_url','updated_at']) then
      raise exception 'Own-profile edits are limited to name, phone and avatar.';
    end if;
  end if;
  return new;
end;
$function$;

do $data_preflight$
begin
  if exists (select 1 from public.teacher_subject_assignments a
    where not app_private.assignment_scope_is_coherent(a.teacher_id,a.academic_year_id,
      a.class_id,a.section_id,a.subject_id,a.is_class_teacher)) then
    raise exception 'Existing assignments contain incoherent school/class/section scope. Review and repair explicitly; no rows were changed.';
  end if;
  if exists (select 1 from public.teachers where profile_id is not null
    group by profile_id having count(*)>1) then
    raise exception 'Multiple teacher records share a login. Resolve the ambiguous login context explicitly before this patch.';
  end if;
  if exists (select 1 from public.academic_years where is_current
    group by school_id having count(*)>1) then
    raise exception 'A school has multiple current academic years. Resolve the ambiguity explicitly before this patch.';
  end if;
  if exists (select 1 from public.teacher_subject_assignments where is_class_teacher
    group by teacher_id,academic_year_id having count(*)>1) then
    raise exception 'A teacher has ambiguous class-teacher assignments for one year.';
  end if;
end;
$data_preflight$;

do $policies_triggers_privileges$
declare
  item record;
  table_name text;
  signature text;
  managers text := 'ARRAY[''school_admin'',''principal'']::public.app_role[]';
  office_roles text := 'ARRAY[''school_admin'',''principal'',''accountant'',''reception_staff'']::public.app_role[]';
  predicate text;
begin
  for item in select policyname from pg_catalog.pg_policies
    where schemaname='public' and tablename='teacher_subject_assignments'
  loop
    execute format('DROP POLICY %I ON public.teacher_subject_assignments',item.policyname);
  end loop;
  execute format('CREATE POLICY admin_teacher_assignments_all ON public.teacher_subject_assignments FOR ALL TO authenticated USING (app_private.has_school_roles_for_teacher(teacher_id,%s)) WITH CHECK (app_private.has_school_roles_for_teacher(teacher_id,%s) AND app_private.assignment_scope_is_coherent(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher))',managers,managers);
  execute format('CREATE POLICY teacher_assignments_staff_read ON public.teacher_subject_assignments FOR SELECT TO authenticated USING (app_private.has_school_roles_for_teacher(teacher_id,%s))',office_roles);
  create policy teacher_assignments_teacher_own_select on public.teacher_subject_assignments
    for select to authenticated using (app_private.is_own_school_teacher(teacher_id));

  for item in select * from (values
    ('academic_years','admin_academic_years_all','tenant_isolation_academic_years'),
    ('classes','admin_classes_all','tenant_isolation_classes'),
    ('sections','admin_sections_all','tenant_isolation_sections'),
    ('subjects','admin_subjects_all','tenant_isolation_subjects'),
    ('teachers','admin_teachers_all','tenant_isolation_teachers')
  ) as p(table_name,admin_policy,member_policy)
  loop
    execute format('DROP POLICY IF EXISTS %I ON public.%I',item.admin_policy,item.table_name);
    execute format('DROP POLICY IF EXISTS %I ON public.%I',item.member_policy,item.table_name);
    predicate := format('app_private.has_school_roles(school_id,%s)',managers);
    execute format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s%s)',
      item.admin_policy,item.table_name,predicate,predicate,
      case when item.table_name='sections' then ' AND EXISTS (SELECT 1 FROM public.classes c WHERE c.id=sections.class_id AND c.school_id=sections.school_id)' else '' end);
    execute format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app_private.has_school_roles(school_id,pg_catalog.enum_range(NULL::public.app_role)))',item.member_policy,item.table_name);
  end loop;

  drop policy if exists admin_profiles_all on public.profiles;
  drop policy if exists tenant_isolation_profiles on public.profiles;
  drop policy if exists profiles_update_own on public.profiles;
  drop policy if exists profiles_select_own on public.profiles;
  create policy admin_profiles_all on public.profiles for update to authenticated
    using (app_private.has_school_roles(school_id,array['school_admin','principal']::public.app_role[]))
    with check (app_private.has_school_roles(school_id,array['school_admin','principal']::public.app_role[]));
  create policy tenant_isolation_profiles on public.profiles for select to authenticated
    using (app_private.has_school_roles(school_id,pg_catalog.enum_range(NULL::public.app_role)));
  create policy profiles_select_own on public.profiles for select to authenticated using (id=(select auth.uid()));
  create policy profiles_update_own on public.profiles for update to authenticated
    using (id=(select auth.uid())) with check (id=(select auth.uid()));

  foreach table_name in array array['academic_years', 'classes', 'profiles', 'sections', 'subjects', 'teacher_subject_assignments', 'teachers'] loop
    execute format('DROP TRIGGER IF EXISTS trg_guard_academic_identity ON public.%I',table_name);
    execute format('CREATE TRIGGER trg_guard_academic_identity BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.guard_academic_identity()',table_name);
    execute format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',table_name);
    execute format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO authenticated',table_name);
  end loop;
  drop trigger if exists trg_validate_teacher_assignment on public.teacher_subject_assignments;
  create trigger trg_validate_teacher_assignment before insert or update on public.teacher_subject_assignments
    for each row execute function app_private.validate_teacher_assignment();
  foreach signature in array array[
    'app_private.assignment_scope_is_coherent(uuid,uuid,uuid,uuid,uuid,boolean)',
    'app_private.is_own_school_teacher(uuid)',
    'app_private.validate_teacher_assignment()',
    'app_private.guard_academic_identity()'
  ] loop
    execute format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',signature);
    execute format('GRANT EXECUTE ON FUNCTION %s TO authenticated,service_role',signature);
  end loop;
  grant usage on schema app_private to authenticated,service_role;
end;
$policies_triggers_privileges$;

create or replace function public.register_student_for_class_teacher(p_full_name text)
returns table(student_id uuid,admission_no text,roll_no text,class_id uuid,section_id uuid)
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  teacher_record record;
  year_record record;
  assignment_record record;
  v_teacher_id uuid;
  v_school_id uuid;
  v_year_id uuid;
  v_class_id uuid;
  v_section_id uuid;
  v_subject_id uuid;
  matches integer;
  v_student_id uuid;
  v_admission_no text;
  v_roll_no text;
  v_next_admission bigint;
  v_next_roll bigint;
  normalized_name text;
  name_parts text[];
  name_count integer;
begin
  if actor_id is null then raise exception 'Authentication required.'; end if;
  normalized_name := btrim(regexp_replace(coalesce(p_full_name,''),'[[:space:]]+',' ','g'));
  if normalized_name='' then raise exception 'Student name is required.'; end if;
  if length(normalized_name)>1000 then raise exception 'Student name is too long.'; end if;
  perform 1 from public.profiles p where p.id=actor_id and p.is_active for share;
  if not found then raise exception 'An active school profile is required.'; end if;

  matches:=0;
  for teacher_record in select t.id,t.school_id from public.teachers t
    where t.profile_id=actor_id order by t.id for share
  loop
    matches:=matches+1; v_teacher_id:=teacher_record.id; v_school_id:=teacher_record.school_id;
  end loop;
  if matches<>1 then raise exception 'Exactly one linked teacher context is required.'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id
    and ur.school_id=v_school_id and ur.role='teacher'::public.app_role for share;
  if not found then raise exception 'Teacher access is required for this school.'; end if;

  matches:=0;
  for year_record in select y.id from public.academic_years y
    where y.school_id=v_school_id and y.is_current order by y.id for share
  loop matches:=matches+1; v_year_id:=year_record.id; end loop;
  if matches<>1 then raise exception 'Exactly one current academic year is required.'; end if;

  matches:=0;
  for assignment_record in select a.* from public.teacher_subject_assignments a
    where a.teacher_id=v_teacher_id and a.academic_year_id=v_year_id and a.is_class_teacher
    order by a.id for share
  loop
    matches:=matches+1; v_class_id:=assignment_record.class_id;
    v_section_id:=assignment_record.section_id; v_subject_id:=assignment_record.subject_id;
  end loop;
  if matches<>1 or not app_private.assignment_scope_is_coherent(v_teacher_id,v_year_id,
    v_class_id,v_section_id,v_subject_id,true) then
    raise exception 'One approved, coherent class-teacher section is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_school_id::text || ':student-register'));
  select coalesce(max(substring(s.admission_no from 'KC-ST-([0-9]+)')::bigint),0)+1
    into v_next_admission from public.students s
    where s.school_id=v_school_id and s.admission_no ~ '^KC-ST-[0-9]+$';
  v_admission_no:='KC-ST-' || lpad(v_next_admission::text,greatest(3,length(v_next_admission::text)),'0');
  select coalesce(max(e.roll_no::bigint),0)+1 into v_next_roll from public.enrollments e
    where e.academic_year_id=v_year_id and e.class_id=v_class_id
      and e.section_id is not distinct from v_section_id and e.roll_no ~ '^[0-9]+$';
  v_roll_no:=v_next_roll::text;
  name_parts:=string_to_array(normalized_name,' '); name_count:=array_length(name_parts,1);
  insert into public.students(school_id,admission_no,roll_no,first_name,middle_name,last_name,admission_date,status)
    values(v_school_id,v_admission_no,v_roll_no,name_parts[1],
      case when name_count>2 then array_to_string(name_parts[2:(name_count-1)],' ') else null end,
      case when name_count>1 then name_parts[name_count] else null end,
      (current_timestamp at time zone 'Asia/Kolkata')::date,'active')
    returning id into v_student_id;
  insert into public.enrollments(student_id,academic_year_id,class_id,section_id,roll_no,status)
    values(v_student_id,v_year_id,v_class_id,v_section_id,v_roll_no,'active');
  return query select v_student_id,v_admission_no,v_roll_no,v_class_id,v_section_id;
end;
$function$;
revoke all on function public.register_student_for_class_teacher(text) from public,anon,authenticated;
grant execute on function public.register_student_for_class_teacher(text) to authenticated,service_role;

do $postconditions$
declare
  signature text;
  helper record;
  source_table record;
  relation record;
  api_role text;
  maintained boolean;
begin
  foreach signature in array array[
    'app_private.assignment_scope_is_coherent(uuid,uuid,uuid,uuid,uuid,boolean)',
    'app_private.is_own_school_teacher(uuid)',
    'app_private.validate_teacher_assignment()',
    'app_private.guard_academic_identity()',
    'public.register_student_for_class_teacher(text)'
  ] loop
    select p.*,r.rolsuper,r.rolbypassrls into helper from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid=p.proowner where p.oid=pg_catalog.to_regprocedure(signature);
    if not found or not coalesce(helper.proconfig @> array['search_path=""']::text[],false)
      or helper.prosecdef <> (signature <> 'app_private.guard_academic_identity()') then
      raise exception 'Unexpected governance helper security: %.',signature;
    end if;
    if pg_catalog.has_function_privilege('anon',helper.oid,'EXECUTE')
      or not pg_catalog.has_function_privilege('authenticated',helper.oid,'EXECUTE')
      or not pg_catalog.has_function_privilege('service_role',helper.oid,'EXECUTE') then
      raise exception 'Unexpected governance helper execution privileges: %.',signature;
    end if;
    if helper.prosecdef then
      for source_table in select c.* from pg_catalog.pg_class c
        where c.oid in ('public.user_roles'::regclass,'public.teachers'::regclass,'public.profiles'::regclass,
          'public.academic_years'::regclass,'public.classes'::regclass,'public.sections'::regclass,
          'public.subjects'::regclass,'public.students'::regclass,'public.enrollments'::regclass)
      loop
        if not (helper.rolsuper or helper.rolbypassrls
          or (helper.proowner=source_table.relowner and not source_table.relforcerowsecurity)) then
          raise exception 'Governance definer owner cannot safely bypass source-table RLS: %.',signature;
        end if;
      end loop;
    end if;
  end loop;
  for relation in select c.* from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any(array['academic_years', 'classes', 'profiles', 'sections', 'subjects', 'teacher_subject_assignments', 'teachers'])
  loop
    foreach api_role in array array['anon','authenticated'] loop
      maintained:=case when current_setting('server_version_num')::integer>=170000
        then pg_catalog.has_table_privilege(api_role,relation.oid,'MAINTAIN') else false end;
      if (api_role='anon' and (
          pg_catalog.has_table_privilege(api_role,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(api_role,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        or (api_role='authenticated' and (
          pg_catalog.has_table_privilege(api_role,relation.oid,'TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(api_role,relation.oid,'REFERENCES')))
        or maintained then raise exception 'Unsafe API privileges remain on %.',relation.relname;
      end if;
    end loop;
  end loop;
end;
$postconditions$;
commit;
