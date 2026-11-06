create or replace function app_private.is_finance()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_has_any_role(array['accountant'::public.app_role]);
$$;

revoke all on function app_private.is_finance() from public;
grant execute on function app_private.is_finance() to authenticated;

create or replace function public.activate_accountant(p_employee_id text, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select e.* into v_employee
  from public.employees e
  join public.profiles p on p.id = e.profile_id
  where lower(trim(e.employee_id)) = lower(trim(p_employee_id))
    and regexp_replace(coalesce(p.phone,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
    and lower(coalesce(e.department,'')) in ('finance','accounts','account','fee','fees')
  limit 1;

  if v_employee.id is null then
    raise exception 'Finance verification failed';
  end if;

  update public.profiles
     set school_id = v_employee.school_id,
         updated_at = now()
   where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_employee.school_id, 'accountant'::public.app_role)
  on conflict do nothing;

  return v_employee.id;
end;
$$;

revoke all on function public.activate_accountant(text,text) from public;
grant execute on function public.activate_accountant(text,text) to authenticated;

-- Replace broad tenant CRUD on fee data with role-aware access.
drop policy if exists tenant_isolation_fee_structures on public.fee_structures;
drop policy if exists tenant_isolation_student_fees on public.student_fees;
drop policy if exists tenant_isolation_fee_payments on public.fee_payments;
drop policy if exists tenant_isolation_parents on public.parents;

drop policy if exists fee_structures_admin_all on public.fee_structures;
drop policy if exists fee_structures_finance_all on public.fee_structures;
create policy fee_structures_admin_all on public.fee_structures
for all to authenticated
using (app_private.is_school_admin())
with check (app_private.is_school_admin());
create policy fee_structures_finance_all on public.fee_structures
for all to authenticated
using (app_private.is_finance())
with check (app_private.is_finance());

create policy student_fees_admin_all on public.student_fees
for all to authenticated
using (app_private.is_school_admin())
with check (app_private.is_school_admin());
create policy student_fees_finance_all on public.student_fees
for all to authenticated
using (app_private.is_finance())
with check (app_private.is_finance());
create policy student_fees_student_read on public.student_fees
for select to authenticated
using (student_id = app_private.current_student_id());
create policy student_fees_parent_read on public.student_fees
for select to authenticated
using (exists (select 1 from public.student_parents sp where sp.student_id = student_fees.student_id and sp.parent_id = app_private.current_parent_id()));

create policy fee_payments_admin_all on public.fee_payments
for all to authenticated
using (app_private.is_school_admin())
with check (app_private.is_school_admin());
create policy fee_payments_finance_all on public.fee_payments
for all to authenticated
using (app_private.is_finance())
with check (app_private.is_finance());
create policy fee_payments_student_read on public.fee_payments
for select to authenticated
using (student_id = app_private.current_student_id());
create policy fee_payments_parent_read on public.fee_payments
for select to authenticated
using (exists (select 1 from public.student_parents sp where sp.student_id = fee_payments.student_id and sp.parent_id = app_private.current_parent_id()));

-- Finance users may see student identity needed for fee collection, but not edit student records.
drop policy if exists students_finance_read on public.students;
create policy students_finance_read on public.students
for select to authenticated
using (app_private.is_finance());

-- Finance can read the current academic structure needed to prepare fee schedules.
drop policy if exists classes_finance_read on public.classes;
create policy classes_finance_read on public.classes
for select to authenticated
using (app_private.is_finance());
drop policy if exists sections_finance_read on public.sections;
create policy sections_finance_read on public.sections
for select to authenticated
using (app_private.is_finance());
drop policy if exists academic_years_finance_read on public.academic_years;
create policy academic_years_finance_read on public.academic_years
for select to authenticated
using (app_private.is_finance());