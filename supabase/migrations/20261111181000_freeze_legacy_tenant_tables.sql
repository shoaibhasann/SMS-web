begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The remaining recovered tenant tables and legacy buckets have no live client
-- writer (live flows use governed RPCs, hr_* tables and service-role storage).
-- Keep their history readable by active office readers only, like payroll/marks.
do $preflight$
declare
  target text;
  relation_oid oid;
  actual_names text[];
  expected_names text[];
begin
  foreach target in array array[
    'admissions', 'communication_logs', 'documents', 'employees', 'events', 'exam_subjects', 'exams',
    'inventory_items', 'inventory_transactions', 'leave_balances', 'leave_requests', 'library_books',
    'library_issues', 'notification_logs', 'notification_templates', 'notifications', 'report_cards',
    'role_activation_requests', 'streams', 'teacher_attendance', 'transport_assignments', 'transport_routes'
  ] loop
    relation_oid := to_regclass('public.' || target);
    if relation_oid is null or not exists (
      select 1 from pg_catalog.pg_class c where c.oid = relation_oid and c.relkind = 'r' and c.relrowsecurity
    ) then
      raise exception 'Unexpected legacy table or RLS state: %.', target;
    end if;
    execute format('lock table public.%I in share row exclusive mode', target);
    -- An unreviewed permissive policy could OR around the replacement policy.
    select array_agg(p.policyname::text order by p.policyname) into actual_names
    from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = target and p.permissive = 'PERMISSIVE';
    expected_names := case target
      when 'exam_subjects' then array['exam_subjects_tenant']
      when 'inventory_transactions' then array['inventory_transactions_school_member']
      when 'leave_balances' then array['leave_balances_school_member']
      when 'notification_logs' then array['notification_logs_school_member']
      when 'report_cards' then array['report_cards_school_member']
      when 'transport_assignments' then array['transport_assignments_school_member']
      when 'transport_routes' then array['tenant_isolation_transport_routes', 'transport_routes_school_admin_all']
      when 'admissions' then array['admin_admissions_all', 'admissions_school_admin_all', 'tenant_isolation_admissions']
      when 'inventory_items' then array['admin_inventory_items_all', 'inventory_items_school_admin_all', 'tenant_isolation_inventory_items']
      when 'library_books' then array['admin_library_books_all', 'library_books_school_admin_all', 'tenant_isolation_library_books']
      when 'library_issues' then array['admin_library_issues_all', 'library_issues_school_admin_all', 'tenant_isolation_library_issues']
      else array['tenant_isolation_' || target] end;
    if actual_names is distinct from expected_names
      and actual_names is distinct from array[target || '_legacy_office_read'] then
      raise exception 'Review the complete legacy policy set for %.', target;
    end if;
  end loop;
  if to_regprocedure('app_private.legacy_office_reader(uuid,boolean)') is null then
    raise exception 'The legacy office reader must exist before freezing tenant tables.';
  end if;
  if (select count(*) from pg_catalog.pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
      and p.policyname in ('student_documents_authenticated_access', 'school_assets_authenticated_access',
        'report_cards_authenticated_access', 'student_documents_legacy_office_read',
        'school_assets_legacy_office_read', 'report_cards_legacy_office_read')) <> 3 then
    raise exception 'Review the legacy storage bucket policies.';
  end if;
end;
$preflight$;

-- Inactive profiles lose office membership everywhere this legacy helper is used
-- (including schools_member_select); the role list is unchanged.
create or replace function public.current_user_school_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select ur.school_id from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = (select auth.uid()) and ur.school_id is not null
    and ur.role in ('school_admin', 'principal', 'accountant', 'reception_staff');
$$;

-- Storage folder names are untrusted text; only a UUID first segment can match a school.
create or replace function app_private.legacy_office_folder_reader(p_folder text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_folder is null or p_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return app_private.legacy_office_reader(p_folder::uuid, false);
end;
$$;
revoke all on function app_private.legacy_office_folder_reader(text) from public, anon, authenticated;
grant execute on function app_private.legacy_office_folder_reader(text) to authenticated;

do $policies$
declare
  target text;
  policy_name text;
  read_rule text;
begin
  foreach target in array array[
    'admissions', 'communication_logs', 'documents', 'employees', 'events', 'exam_subjects', 'exams',
    'inventory_items', 'inventory_transactions', 'leave_balances', 'leave_requests', 'library_books',
    'library_issues', 'notification_logs', 'notification_templates', 'notifications', 'report_cards',
    'role_activation_requests', 'streams', 'teacher_attendance', 'transport_assignments', 'transport_routes'
  ] loop
    for policy_name in select p.policyname from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = target and p.permissive = 'PERMISSIVE' loop
      execute format('drop policy %I on public.%I', policy_name, target);
    end loop;
    read_rule := case target
      -- Salary is read like payroll: Admin, Principal and Accountant.
      when 'employees' then 'app_private.legacy_office_reader(school_id, true)'
      when 'exam_subjects' then 'exists (select 1 from public.exams parent where parent.id = exam_subjects.exam_id and app_private.legacy_office_reader(parent.school_id, false))'
      when 'inventory_transactions' then 'exists (select 1 from public.inventory_items parent where parent.id = inventory_transactions.item_id and app_private.legacy_office_reader(parent.school_id, false))'
      when 'leave_balances' then 'exists (select 1 from public.employees parent where parent.id = leave_balances.employee_id and app_private.legacy_office_reader(parent.school_id, false))'
      when 'notification_logs' then 'exists (select 1 from public.notifications parent where parent.id = notification_logs.notification_id and app_private.legacy_office_reader(parent.school_id, false))'
      when 'transport_assignments' then 'exists (select 1 from public.transport_routes parent where parent.id = transport_assignments.route_id and app_private.legacy_office_reader(parent.school_id, false))'
      else 'app_private.legacy_office_reader(school_id, false)' end;
    execute format('create policy %I on public.%I for select to authenticated using (%s)', target || '_legacy_office_read', target, read_rule);
    execute format('revoke all on table public.%I from public, anon, authenticated', target);
    execute (
      select format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) on table public.%2$I from public, anon, authenticated',
        string_agg(format('%I', a.attname), ',' order by a.attnum), target)
      from pg_catalog.pg_attribute a where a.attrelid = ('public.' || target)::regclass and a.attnum > 0 and not a.attisdropped
    );
    execute format('grant select on table public.%I to authenticated', target);
  end loop;
end;
$policies$;

drop policy if exists student_documents_authenticated_access on storage.objects;
drop policy if exists school_assets_authenticated_access on storage.objects;
drop policy if exists report_cards_authenticated_access on storage.objects;
drop policy if exists student_documents_legacy_office_read on storage.objects;
drop policy if exists school_assets_legacy_office_read on storage.objects;
drop policy if exists report_cards_legacy_office_read on storage.objects;
create policy student_documents_legacy_office_read on storage.objects for select to authenticated
using (bucket_id = 'student-documents' and app_private.legacy_office_folder_reader((storage.foldername(name))[1]));
create policy school_assets_legacy_office_read on storage.objects for select to authenticated
using (bucket_id = 'school-assets' and app_private.legacy_office_folder_reader((storage.foldername(name))[1]));
create policy report_cards_legacy_office_read on storage.objects for select to authenticated
using (bucket_id = 'report-cards' and app_private.legacy_office_folder_reader((storage.foldername(name))[1]));

do $postconditions$
declare
  target text;
begin
  foreach target in array array[
    'admissions', 'communication_logs', 'documents', 'employees', 'events', 'exam_subjects', 'exams',
    'inventory_items', 'inventory_transactions', 'leave_balances', 'leave_requests', 'library_books',
    'library_issues', 'notification_logs', 'notification_templates', 'notifications', 'report_cards',
    'role_activation_requests', 'streams', 'teacher_attendance', 'transport_assignments', 'transport_routes'
  ] loop
    if has_table_privilege('anon', 'public.' || target, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('anon', 'public.' || target, 'SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege('authenticated', 'public.' || target, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('authenticated', 'public.' || target, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'Untrusted legacy privileges remain on % through inherited or column grants. Transaction rolled back.', target;
    end if;
    if (select array_agg(p.policyname::text) from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename = target and p.permissive = 'PERMISSIVE')
      is distinct from array[target || '_legacy_office_read'] then
      raise exception 'Legacy read policy for % is not exclusive.', target;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
      and (p.qual ilike '%current_user_school_ids%' or p.with_check ilike '%current_user_school_ids%'))
    or has_function_privilege('anon', 'app_private.legacy_office_folder_reader(text)', 'EXECUTE') then
    raise exception 'Legacy storage access remains open. Transaction rolled back.';
  end if;
end;
$postconditions$;

commit;
