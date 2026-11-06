begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- These recovered tables have no live client write workflow. Preserve their
-- history and trusted server writers; school membership is not mutation authority.
do $preflight$
declare
  target text;
  relation_oid oid;
  expected_names text[];
  actual_names text[];
begin
  if has_schema_privilege('anon', 'app_private', 'CREATE')
    or has_schema_privilege('authenticated', 'app_private', 'CREATE') then
    raise exception 'Untrusted accounts must not create private helpers.';
  end if;
  foreach target in array array['payroll', 'marks', 'audit_logs'] loop
    relation_oid := to_regclass('public.' || target);
    if relation_oid is null or not exists (
      select 1 from pg_catalog.pg_class c where c.oid = relation_oid
        and c.relkind = 'r' and c.relrowsecurity
    ) then
      raise exception 'Unexpected legacy table or RLS state: %.', target;
    end if;
    execute format('lock table public.%I in share row exclusive mode', target);
    -- An unreviewed permissive policy could OR around the replacement policy.
    select array_agg(p.policyname::text order by p.policyname) into actual_names
    from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = target;
    expected_names := case target
      when 'payroll' then array['tenant_isolation_payroll']
      when 'marks' then array['marks_tenant']
      else array['admin_audit_logs_all', 'audit_logs_school_admin_all', 'tenant_isolation_audit_logs'] end;
    if actual_names is distinct from expected_names
      and actual_names is distinct from array[target || '_legacy_office_read'] then
      raise exception 'Review the complete legacy policy set for %.', target;
    end if;
  end loop;
  if to_regprocedure('public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)') is null then
    raise exception 'Review the recovered legacy audit writer before changing its API access.';
  end if;
end;
$preflight$;

-- A profile's active flag applies across its memberships. Authorization comes
-- from the matching school role, including people with roles in two schools.
create or replace function app_private.legacy_office_reader(p_school_id uuid, p_payroll boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles membership
    join public.profiles actor on actor.id = membership.user_id and actor.is_active
    where membership.user_id = (select auth.uid()) and (
      (membership.school_id is null and membership.role = 'super_admin')
      or (membership.school_id = p_school_id and (
        membership.role in ('school_admin', 'principal')
        or (p_payroll and membership.role = 'accountant')
      ))
    )
  );
$$;

create or replace function app_private.can_read_legacy_payroll(p_school_id uuid, p_employee_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.legacy_office_reader(p_school_id, true) and exists (
    select 1 from public.employees employee
    where employee.id = p_employee_id and employee.school_id = p_school_id
  );
$$;

-- Independent foreign keys did not establish tenant coherence in the legacy
-- schema. Validate the whole relationship without requiring current enrollment:
-- transferred/alumni pupils' historical records must remain intact and readable.
create or replace function app_private.can_read_legacy_mark(p_exam_subject_id uuid, p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.exam_subjects item
    join public.exams exam on exam.id = item.exam_id
    join public.academic_years year on year.id = exam.academic_year_id and year.school_id = exam.school_id
    join public.classes class on class.id = item.class_id and class.school_id = exam.school_id
    join public.subjects subject on subject.id = item.subject_id and subject.school_id = exam.school_id
    join public.students pupil on pupil.id = p_student_id and pupil.school_id = exam.school_id
    where item.id = p_exam_subject_id and app_private.legacy_office_reader(exam.school_id, false)
  );
$$;

revoke all on function app_private.legacy_office_reader(uuid, boolean),
  app_private.can_read_legacy_payroll(uuid, uuid), app_private.can_read_legacy_mark(uuid, uuid)
from public, anon, authenticated;
grant execute on function app_private.legacy_office_reader(uuid, boolean),
  app_private.can_read_legacy_payroll(uuid, uuid), app_private.can_read_legacy_mark(uuid, uuid)
to authenticated;

drop policy if exists tenant_isolation_payroll on public.payroll;
drop policy if exists payroll_legacy_office_read on public.payroll;
create policy payroll_legacy_office_read on public.payroll for select to authenticated
using (app_private.can_read_legacy_payroll(school_id, employee_id));

drop policy if exists marks_tenant on public.marks;
drop policy if exists marks_legacy_office_read on public.marks;
create policy marks_legacy_office_read on public.marks for select to authenticated
using (app_private.can_read_legacy_mark(exam_subject_id, student_id));

drop policy if exists admin_audit_logs_all on public.audit_logs;
drop policy if exists audit_logs_school_admin_all on public.audit_logs;
drop policy if exists tenant_isolation_audit_logs on public.audit_logs;
drop policy if exists audit_logs_legacy_office_read on public.audit_logs;
create policy audit_logs_legacy_office_read on public.audit_logs for select to authenticated
using (app_private.legacy_office_reader(school_id, false));

-- The unused invoker writer targets columns absent from the recovered table.
-- Do not expose a forged-audit API or silently invent a replacement workflow.
-- Preserve its body and trusted service/owner ACL for separate retirement work.
revoke execute on function public.write_audit_log(uuid, text, text, text, uuid, text, jsonb)
from public, anon, authenticated;

revoke all on table public.payroll, public.marks, public.audit_logs from public, anon, authenticated;
do $column_grants$
declare
  target regclass;
  columns_sql text;
begin
  foreach target in array array['public.payroll'::regclass, 'public.marks'::regclass, 'public.audit_logs'::regclass] loop
    select string_agg(format('%I', a.attname), ',' order by a.attnum) into columns_sql
    from pg_catalog.pg_attribute a where a.attrelid = target and a.attnum > 0 and not a.attisdropped;
    execute format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) on table %2$s from public, anon, authenticated', columns_sql, target);
  end loop;
end;
$column_grants$;
grant select on table public.payroll, public.marks, public.audit_logs to authenticated;

do $postconditions$
declare
  target regclass;
  helper regprocedure;
begin
  foreach target in array array['public.payroll'::regclass, 'public.marks'::regclass, 'public.audit_logs'::regclass] loop
    if has_table_privilege('anon', target, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('anon', target, 'SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege('authenticated', target, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('authenticated', target, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'Untrusted legacy privileges remain through inherited or column grants. Transaction rolled back.';
    end if;
  end loop;
  foreach helper in array array[
    'app_private.legacy_office_reader(uuid,boolean)'::regprocedure,
    'app_private.can_read_legacy_payroll(uuid,uuid)'::regprocedure,
    'app_private.can_read_legacy_mark(uuid,uuid)'::regprocedure
  ] loop
    if has_function_privilege('anon', helper, 'EXECUTE') or not exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
      where p.oid = helper and p.prosecdef and p.proconfig @> array['search_path=""']
        and (owner_role.rolsuper or owner_role.rolbypassrls or not exists (
          select 1 from pg_catalog.pg_class c
          where c.oid in ('public.employees'::regclass, 'public.exam_subjects'::regclass,
            'public.exams'::regclass, 'public.academic_years'::regclass, 'public.classes'::regclass,
            'public.subjects'::regclass, 'public.students'::regclass, 'public.profiles'::regclass, 'public.user_roles'::regclass)
            and (c.relowner <> p.proowner or c.relforcerowsecurity)
        ))
    ) then
      raise exception 'Legacy reader needs a trusted owner, pinned search path and private API ACL.';
    end if;
  end loop;
  if has_function_privilege('anon', 'public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'The legacy audit writer remains client executable. Transaction rolled back.';
  end if;
end;
$postconditions$;

commit;
