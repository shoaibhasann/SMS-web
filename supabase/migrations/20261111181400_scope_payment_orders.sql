begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- payment_orders authorised by profile school only, so every family and
-- teacher in a school could read and rewrite every family's orders.
do $preflight$
declare
  actual_names text[];
begin
  if to_regclass('public.payment_orders') is null then
    raise exception 'public.payment_orders is missing.';
  end if;
  lock table public.payment_orders in share row exclusive mode;
  -- An unreviewed permissive policy could OR around the replacement policies.
  select array_agg(p.policyname::text order by p.policyname) into actual_names
  from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = 'payment_orders';
  if actual_names is distinct from array['payment_orders_school_access', 'staff_mfa_required']
    and actual_names is distinct from array['payment_orders_family_read', 'payment_orders_office_manage', 'staff_mfa_required'] then
    raise exception 'Review the complete payment_orders policy set: %.', actual_names;
  end if;
  if to_regprocedure('app_private.has_school_roles(uuid,public.app_role[])') is null
    or to_regprocedure('app_private.current_student_id()') is null
    or to_regprocedure('app_private.current_parent_id()') is null then
    raise exception 'Expected school-role and family helpers are missing.';
  end if;
end;
$preflight$;

drop policy if exists payment_orders_school_access on public.payment_orders;
drop policy if exists payment_orders_office_manage on public.payment_orders;
drop policy if exists payment_orders_family_read on public.payment_orders;

-- Office roles of the row's school manage orders that point at their own pupil and fee.
create policy payment_orders_office_manage on public.payment_orders for all to authenticated
using (app_private.has_school_roles(school_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]))
with check (
  app_private.has_school_roles(school_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[])
  and exists (select 1 from public.students s where s.id = payment_orders.student_id and s.school_id = payment_orders.school_id)
  and (student_fee_id is null or exists (
    select 1 from public.student_fees f where f.id = payment_orders.student_fee_id
      and f.student_id = payment_orders.student_id and f.school_id = payment_orders.school_id))
);

-- Families only read their own or linked pupil's orders; writes stay with trusted server code.
-- The live-account helpers run once per statement (initPlan), not once per row.
create policy payment_orders_family_read on public.payment_orders for select to authenticated
using (
  student_id = (select app_private.current_student_id())
  or exists (select 1 from public.student_parents sp
    where sp.student_id = payment_orders.student_id and sp.parent_id = (select app_private.current_parent_id()))
);

revoke all on table public.payment_orders from public, anon, authenticated;
do $column_grants$
declare
  columns_sql text;
begin
  select string_agg(format('%I', a.attname), ',' order by a.attnum) into columns_sql
  from pg_catalog.pg_attribute a where a.attrelid = 'public.payment_orders'::regclass and a.attnum > 0 and not a.attisdropped;
  execute format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) on table public.payment_orders from public, anon, authenticated', columns_sql);
end;
$column_grants$;
grant select, insert, update, delete on table public.payment_orders to authenticated;

do $postconditions$
declare
  actual_names text[];
begin
  select array_agg(p.policyname::text order by p.policyname) into actual_names
  from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = 'payment_orders';
  if actual_names is distinct from array['payment_orders_family_read', 'payment_orders_office_manage', 'staff_mfa_required'] then
    raise exception 'Unexpected payment_orders policy set after scoping. Transaction rolled back.';
  end if;
  if has_table_privilege('anon', 'public.payment_orders', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('anon', 'public.payment_orders', 'SELECT,INSERT,UPDATE,REFERENCES')
    or has_table_privilege('authenticated', 'public.payment_orders', 'TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'Untrusted payment_orders privileges remain. Transaction rolled back.';
  end if;
end;
$postconditions$;

notify pgrst, 'reload schema';
commit;
