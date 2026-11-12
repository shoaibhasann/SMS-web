begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
-- Deterministic deparse for the exact-text checks; every name below is schema-qualified.
set local search_path = public, pg_temp;

-- One lock point in a fixed order; a busy table aborts the whole run inside lock_timeout.
lock table public.students, public.enrollments, public.attendance, public.student_fees,
  public.fee_payments, public.class_logs, public.class_activities in access exclusive mode;

do $preflight$
begin
  -- The equivalence proofs below were made against these exact bodies; any drift stops the run.
  if exists (
    select 1 from (values
    ('app_private.has_school_roles(uuid,public.app_role[])', '7dbf18afaf4d823d6e1a6591895c97be'),
    ('public.is_school_admin_for_school(uuid)', 'cd5eb661aec9cd102759f30a0208bacf'),
    ('app_private.has_school_roles_for_student(uuid,public.app_role[])', '46b5389d2f7a19268d6aa7b10d2916c0'),
    ('app_private.substitute_roster_access(uuid,uuid,uuid,uuid)', '55ec5c0044d5890798f77ae2152952ce'),
    ('app_private.my_active_attendance_coverages(date)', '1c0c7ba1af03a58b604a9e44e0920fa2'),
    ('app_private.teacher_owns_attendance_register_on(uuid,uuid,uuid,uuid,date)', '3bedc50837615867b2ef5f896ae8ad23'),
    ('app_private.teacher_owns_attendance_register(uuid,uuid,uuid,uuid)', '68222feb3143ec8b494347d532331fc6'),
    ('app_private.teacher_has_attendance_coverage(uuid,uuid,uuid,uuid,date)', '70c356d02b0f03c4a4ac8cbea9287ba3'),
    ('app_private.academic_family_scope(uuid,uuid,uuid,uuid)', 'f231b760d568723745009a20293a85b1'),
    ('app_private.academic_manager(uuid)', '1d392da36ac795051992f3a7714c25c3'),
    ('app_private.academic_office_read(uuid)', 'f487e1874a86499815b5c9f0f29f31b4'),
    ('app_private.academic_log_manager(uuid)', '2a5106ecc8e617cfc18a235dcf286024'),
    ('app_private.teacher_academic_scope(uuid,uuid,uuid,uuid,uuid,uuid,boolean)', 'e42ae1388073078af47b4249c1ada200'),
    ('app_private.current_teacher_id()', '97a7cf31e53655e32e7206c5ec501aa0'),
    ('app_private.is_teacher()', 'febf72026d68cb7c40a566f863e94321'),
    ('app_private.current_student_id()', 'd290371f58d8ab57daf0a62a6af99e2d'),
    ('app_private.current_parent_id()', '2194818c63d46ccc72f68d5a74f8406a')
    ) as pin(fn, body_md5)
    where to_regprocedure(pin.fn) is null
       or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(pin.fn)) <> pin.body_md5
  ) then
    raise exception 'staff policy helpers differ from the reviewed definitions';
  end if;
  if to_regprocedure('app_private.caller_is_super_admin()') is not null
    or to_regprocedure('app_private.caller_role_school_ids(public.app_role[])') is not null
    or to_regprocedure('app_private.caller_has_active_attendance_coverage()') is not null then
    raise exception 'staff policy set helpers already exist';
  end if;
  -- Every policy this file alters must still be the reviewed permissive authenticated policy, word for word.
  if exists (
    select 1 from (values
    ('students', 'admin_students_all', 'ALL', $q$is_school_admin_for_school(school_id)$q$, $q$is_school_admin_for_school(school_id)$q$),
    ('students', 'students_finance_read', 'SELECT', $q$app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])$q$, null),
    ('students', 'students_staff_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$),
    ('students', 'students_substitute_attendance_read', 'SELECT', $q$app_private.substitute_roster_access(id, NULL::uuid, NULL::uuid, NULL::uuid)$q$, null),
    ('students', 'students_teacher_assigned_read', 'SELECT', $q$(app_private.is_teacher() AND (EXISTS ( SELECT 1 FROM (enrollments e JOIN teacher_subject_assignments a ON (((a.class_id = e.class_id) AND (a.academic_year_id = e.academic_year_id) AND ((a.section_id IS NULL) OR (a.section_id = e.section_id))))) WHERE ((e.student_id = students.id) AND (a.teacher_id = app_private.current_teacher_id())))))$q$, null),
    ('enrollments', 'admin_enrollments_all', 'ALL', $q$app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role])$q$, $q$app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role])$q$),
    ('enrollments', 'enrollments_staff_all', 'ALL', $q$app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$, $q$app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$),
    ('enrollments', 'enrollments_substitute_attendance_read', 'SELECT', $q$((status = 'active'::text) AND app_private.substitute_roster_access(student_id, academic_year_id, class_id, section_id))$q$, null),
    ('enrollments', 'enrollments_teacher_assigned_read', 'SELECT', $q$((status <> ALL (ARRAY['staged'::text, 'cancelled'::text])) AND app_private.is_teacher() AND (EXISTS ( SELECT 1 FROM teacher_subject_assignments a WHERE ((a.teacher_id = app_private.current_teacher_id()) AND (a.academic_year_id = enrollments.academic_year_id) AND (a.class_id = enrollments.class_id) AND ((a.section_id IS NULL) OR (a.section_id = enrollments.section_id))))))$q$, null),
    ('attendance', 'admin_attendance_all', 'ALL', $q$is_school_admin_for_school(school_id)$q$, $q$is_school_admin_for_school(school_id)$q$),
    ('attendance', 'attendance_class_teacher_manage', 'ALL', $q$app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date)$q$, $q$app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date)$q$),
    ('attendance', 'attendance_staff_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$),
    ('student_fees', 'admin_student_fees_all', 'ALL', $q$is_school_admin_for_school(school_id)$q$, $q$is_school_admin_for_school(school_id)$q$),
    ('student_fees', 'student_fees_admin_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$),
    ('student_fees', 'student_fees_finance_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])$q$),
    ('fee_payments', 'admin_fee_payments_all', 'ALL', $q$is_school_admin_for_school(school_id)$q$, $q$is_school_admin_for_school(school_id)$q$),
    ('fee_payments', 'fee_payments_admin_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])$q$),
    ('fee_payments', 'fee_payments_finance_all', 'ALL', $q$app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])$q$, $q$app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])$q$),
    ('class_logs', 'academic_logs_family', 'SELECT', $q$((status = 'published'::text) AND app_private.academic_family_scope(school_id, academic_year_id, class_id, section_id))$q$, null),
    ('class_logs', 'academic_logs_manager', 'ALL', $q$app_private.academic_manager(school_id)$q$, $q$app_private.academic_manager(school_id)$q$),
    ('class_logs', 'academic_logs_office_read', 'SELECT', $q$app_private.academic_office_read(school_id)$q$, null),
    ('class_logs', 'academic_logs_teacher_read', 'SELECT', $q$app_private.teacher_academic_scope(teacher_id, school_id, academic_year_id, class_id, section_id, subject_id, false)$q$, null),
    ('class_activities', 'academic_activities_manager', 'ALL', $q$app_private.academic_log_manager(class_log_id)$q$, $q$app_private.academic_log_manager(class_log_id)$q$)
    ) as e(tbl, pol, cmd, qual, chk)
    left join pg_policies p on p.schemaname = 'public' and p.tablename = e.tbl and p.policyname = e.pol
    where p.policyname is null or p.permissive <> 'PERMISSIVE' or p.roles <> array['authenticated']::name[] or p.cmd <> e.cmd
       or regexp_replace(p.qual, '\s+', ' ', 'g') is distinct from e.qual
       or regexp_replace(p.with_check, '\s+', ' ', 'g') is distinct from e.chk
  ) then
    raise exception 'staff policies differ from the reviewed production definitions';
  end if;
end;
$preflight$;

create temporary table policy_shape_before on commit drop as
  select tablename, policyname, permissive, roles, cmd from pg_policies
  where schemaname = 'public' and tablename in ('students','enrollments','attendance','student_fees','fee_payments','class_logs','class_activities');

-- Once-per-statement facts about the caller only. Same predicates as has_school_roles(), split in two.
create function app_private.caller_is_super_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    where p.id = auth.uid() and p.is_active
      and ur.role = 'super_admin'::public.app_role and ur.school_id is null
  );
$$;

create function app_private.caller_role_school_ids(p_roles public.app_role[])
returns uuid[] language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct ur.school_id), '{}'::uuid[])
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id
  where auth.uid() is not null and p.id = auth.uid() and p.is_active
    and ur.school_id is not null
    and ur.role <> 'super_admin'::public.app_role and ur.role = any(p_roles);
$$;

-- Same coverage source and day as substitute_roster_access(); true only while the caller covers a register today.
create function app_private.caller_has_active_attendance_coverage()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_private.my_active_attendance_coverages((statement_timestamp() at time zone 'Asia/Kolkata')::date)
  );
$$;

revoke all on function app_private.caller_is_super_admin() from public, anon;
revoke all on function app_private.caller_role_school_ids(public.app_role[]) from public, anon;
revoke all on function app_private.caller_has_active_attendance_coverage() from public, anon;
grant execute on function app_private.caller_is_super_admin() to authenticated, service_role;
grant execute on function app_private.caller_role_school_ids(public.app_role[]) to authenticated, service_role;
grant execute on function app_private.caller_has_active_attendance_coverage() to authenticated;


alter policy admin_students_all on public.students
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]));
alter policy students_finance_read on public.students
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['accountant']::public.app_role[]))::uuid[]));
alter policy students_staff_all on public.students
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]));
alter policy students_substitute_attendance_read on public.students
  using ((select app_private.caller_has_active_attendance_coverage()) and app_private.substitute_roster_access(id, null::uuid, null::uuid, null::uuid));
alter policy students_teacher_assigned_read on public.students
  using ((select app_private.is_teacher()) and exists (select 1 from public.enrollments e join public.teacher_subject_assignments a on a.class_id = e.class_id and a.academic_year_id = e.academic_year_id and (a.section_id is null or a.section_id = e.section_id) where e.student_id = students.id and a.teacher_id = (select app_private.current_teacher_id())));
alter policy admin_enrollments_all on public.enrollments
  using (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin']::public.app_role[])) > 0)) and app_private.has_school_roles_for_student(student_id, array['school_admin']::public.app_role[]))
  with check (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin']::public.app_role[])) > 0)) and app_private.has_school_roles_for_student(student_id, array['school_admin']::public.app_role[]));
alter policy enrollments_staff_all on public.enrollments
  using (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[])) > 0)) and app_private.has_school_roles_for_student(student_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))
  with check (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[])) > 0)) and app_private.has_school_roles_for_student(student_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]));
alter policy enrollments_substitute_attendance_read on public.enrollments
  using (status = 'active'::text and (select app_private.caller_has_active_attendance_coverage()) and app_private.substitute_roster_access(student_id, academic_year_id, class_id, section_id));
alter policy enrollments_teacher_assigned_read on public.enrollments
  using (status <> all (array['staged'::text, 'cancelled'::text]) and (select app_private.is_teacher()) and exists (select 1 from public.teacher_subject_assignments a where a.teacher_id = (select app_private.current_teacher_id()) and a.academic_year_id = enrollments.academic_year_id and a.class_id = enrollments.class_id and (a.section_id is null or a.section_id = enrollments.section_id)));
alter policy admin_attendance_all on public.attendance
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]));
alter policy attendance_class_teacher_manage on public.attendance
  using ((select app_private.current_teacher_id()) is not null and app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date))
  with check ((select app_private.current_teacher_id()) is not null and app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date));
alter policy attendance_staff_all on public.attendance
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]));
alter policy admin_student_fees_all on public.student_fees
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]));
alter policy student_fees_admin_all on public.student_fees
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]));
alter policy student_fees_finance_all on public.student_fees
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['accountant']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['accountant']::public.app_role[]))::uuid[]));
alter policy admin_fee_payments_all on public.fee_payments
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin']::public.app_role[]))::uuid[]));
alter policy fee_payments_admin_all on public.fee_payments
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[]));
alter policy fee_payments_finance_all on public.fee_payments
  using ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['accountant']::public.app_role[]))::uuid[]))
  with check ((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['accountant']::public.app_role[]))::uuid[]));
alter policy academic_logs_family on public.class_logs
  using (((select app_private.current_student_id()) is not null or (select app_private.current_parent_id()) is not null) and status = 'published'::text and app_private.academic_family_scope(school_id, academic_year_id, class_id, section_id));
alter policy academic_logs_manager on public.class_logs
  using (((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal']::public.app_role[]))::uuid[])) and app_private.academic_manager(school_id))
  with check (((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal']::public.app_role[]))::uuid[])) and app_private.academic_manager(school_id));
alter policy academic_logs_office_read on public.class_logs
  using (((select app_private.caller_is_super_admin()) or school_id = any ((select app_private.caller_role_school_ids(array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))::uuid[])) and app_private.academic_office_read(school_id));
alter policy academic_logs_teacher_read on public.class_logs
  using ((select app_private.current_teacher_id()) is not null and app_private.teacher_academic_scope(teacher_id, school_id, academic_year_id, class_id, section_id, subject_id, false));
alter policy academic_activities_manager on public.class_activities
  using (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin', 'principal']::public.app_role[])) > 0)) and app_private.academic_log_manager(class_log_id))
  with check (((select app_private.caller_is_super_admin()) or (select cardinality(app_private.caller_role_school_ids(array['school_admin', 'principal']::public.app_role[])) > 0)) and app_private.academic_log_manager(class_log_id));

do $postcondition$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('caller_is_super_admin', 'caller_role_school_ids', 'caller_has_active_attendance_coverage')
      and (not p.prosecdef or p.provolatile <> 's' or p.proconfig is distinct from array['search_path=""']
        or has_function_privilege('anon', p.oid, 'EXECUTE') or not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private'
      and p.proname in ('caller_is_super_admin', 'caller_role_school_ids', 'caller_has_active_attendance_coverage')) <> 3 then
    raise exception 'staff policy set helpers must be stable security definer functions with an empty search_path';
  end if;
  if exists (
    (select tablename, policyname, permissive, roles, cmd from policy_shape_before
     except select tablename, policyname, permissive, roles, cmd from pg_policies where schemaname = 'public'
       and tablename in ('students','enrollments','attendance','student_fees','fee_payments','class_logs','class_activities'))
    union all
    (select tablename, policyname, permissive, roles, cmd from pg_policies where schemaname = 'public'
       and tablename in ('students','enrollments','attendance','student_fees','fee_payments','class_logs','class_activities')
     except select tablename, policyname, permissive, roles, cmd from policy_shape_before)
  ) then
    raise exception 'staff policy names, commands, roles or kinds changed';
  end if;
  -- No row-independent role call may remain per row on these tables.
  if exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename in ('students','enrollments','attendance','student_fees','fee_payments','class_logs','class_activities')
      and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
        'SELECT app_private\.(is_teacher|current_teacher_id|current_student_id|current_parent_id|caller_is_super_admin|caller_has_active_attendance_coverage)\(\)', '', 'g')
        ~ '(app_private\.has_school_roles\(|is_school_admin_for_school\(|app_private\.is_teacher\(\)|app_private\.current_teacher_id\(\))'
  ) then
    raise exception 'staff policies must call row-independent role helpers as initPlans';
  end if;
  -- Every per-row call kept on these tables sits behind its once-per-statement gate.
  if exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename in ('students','enrollments','attendance','class_logs','class_activities')
      and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
      and ((qual ~ 'substitute_roster_access\(' and qual !~ 'SELECT app_private\.caller_has_active_attendance_coverage\(\)')
        or (qual ~ '(has_school_roles_for_student|academic_manager|academic_office_read|academic_log_manager)\(' and qual !~ 'SELECT app_private\.caller_is_super_admin\(\)')
        or (qual ~ '(teacher_owns_attendance_register_on|teacher_academic_scope)\(' and qual !~ 'SELECT app_private\.current_teacher_id\(\)')
        or (qual ~ 'academic_family_scope\(' and qual !~ 'SELECT app_private\.current_student_id\(\)'))
  ) then
    raise exception 'a kept per-row staff check lost its once-per-statement gate';
  end if;
  -- Without a signed-in caller the helpers admit nothing.
  if app_private.caller_is_super_admin() or cardinality(app_private.caller_role_school_ids(enum_range(null::public.app_role))) > 0
    or app_private.caller_has_active_attendance_coverage() then
    raise exception 'staff policy set helpers must be false for a caller without a session';
  end if;
end;
$postcondition$;
commit;
