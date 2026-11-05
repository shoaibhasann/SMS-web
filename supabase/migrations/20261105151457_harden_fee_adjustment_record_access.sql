begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The old tables are retained for history. Future reviewed adjustment/refund
-- workflows must own their writes; school membership is not write authority.
do $preflight$
declare
  target text;
  relation_oid oid;
  column_check record;
  policy_check record;
begin
  if to_regprocedure('app_private.can_manage_office_fees(uuid)') is null then
    raise exception 'Office fee authorization must be installed first.';
  end if;
  if has_schema_privilege('anon', 'app_private', 'CREATE')
    or has_schema_privilege('authenticated', 'app_private', 'CREATE') then
    raise exception 'Untrusted accounts must not create private helpers.';
  end if;
  foreach target in array array['fee_discounts', 'fee_refunds'] loop
    relation_oid := to_regclass('public.' || target);
    if relation_oid is null or not exists (
      select 1 from pg_catalog.pg_class c where c.oid = relation_oid
        and c.relkind = 'r' and c.relrowsecurity
    ) then
      raise exception 'Unexpected fee history table or RLS state: %.', target;
    end if;
    for column_check in
      select * from (values
        ('id', 'uuid'::regtype, true), ('school_id', 'uuid'::regtype, true),
        (case when target = 'fee_discounts' then 'student_id' else 'payment_id' end, 'uuid'::regtype, true),
        (case when target = 'fee_discounts' then 'student_fee_id' else 'processed_by' end, 'uuid'::regtype, false),
        ('amount', 'numeric'::regtype, true)
      ) required(name, type_oid, not_null)
    loop
      if not exists (
        select 1 from pg_catalog.pg_attribute a where a.attrelid = relation_oid
          and a.attname = column_check.name and not a.attisdropped
          and a.atttypid = column_check.type_oid and a.attnotnull = column_check.not_null
      ) then
        raise exception 'Unexpected % column %.', target, column_check.name;
      end if;
    end loop;
    if (select count(*) from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = target) <> 1 then
      raise exception 'Review the complete fee history policy set for %.', target;
    end if;
    select * into policy_check from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = target;
    if policy_check.policyname = 'tenant_isolation_' || target then
      if policy_check.cmd <> 'ALL' or policy_check.permissive <> 'PERMISSIVE'
        or policy_check.roles <> array['public']::name[]
        or pg_catalog.regexp_replace(policy_check.qual, '[[:space:]()]', '', 'g')
          <> 'school_idINSELECTcurrent_user_school_idsAScurrent_user_school_ids'
        or policy_check.with_check is distinct from policy_check.qual then
        raise exception 'Unexpected recovered fee history policy for %.', target;
      end if;
    elsif policy_check.policyname <> (target || '_scoped_read')
      or policy_check.cmd <> 'SELECT' or policy_check.permissive <> 'PERMISSIVE'
      or policy_check.roles <> array['authenticated']::name[] or policy_check.with_check is not null then
      raise exception 'Unexpected fee history policy for %.', target;
    end if;
  end loop;
end;
$preflight$;

-- The predicate exposes only a boolean for the caller's own pupil/linked child.
-- NULL fee linkage remains office-only. Archived/withdrawn pupils retain access
-- through independently authorized family identities and relationships.
create or replace function app_private.can_read_fee_adjustment(
  p_school_id uuid,
  p_student_id uuid,
  p_student_fee_id uuid,
  p_payment_id uuid
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and p_school_id is not null
    and exists (select 1 from public.profiles actor
      where actor.id = auth.uid() and actor.is_active)
    and (app_private.can_manage_office_fees(p_school_id) or exists (
      select 1
      from public.student_fees fee
      join public.students pupil on pupil.id = fee.student_id and pupil.school_id = fee.school_id
      left join public.fee_structures structure on structure.id = fee.fee_structure_id
      where fee.school_id = p_school_id
        and (fee.fee_structure_id is null or structure.school_id = fee.school_id)
        and (
          (p_payment_id is null and fee.id = p_student_fee_id and fee.student_id = p_student_id)
          or (p_payment_id is not null and p_student_id is null and p_student_fee_id is null
            and exists (select 1 from public.fee_payments payment
              where payment.id = p_payment_id and payment.school_id = fee.school_id
                and payment.student_fee_id = fee.id and payment.student_id = fee.student_id))
        )
        and (
          (pupil.profile_id = auth.uid() and exists (
            select 1 from public.user_roles membership where membership.user_id = auth.uid()
              and membership.school_id = fee.school_id and membership.role = 'student'::public.app_role
          ))
          or exists (
            select 1 from public.student_parents link
            join public.parents guardian on guardian.id = link.parent_id and guardian.school_id = fee.school_id
            join public.user_roles membership on membership.user_id = guardian.profile_id
              and membership.school_id = guardian.school_id and membership.role = 'parent'::public.app_role
            where link.student_id = pupil.id and guardian.profile_id = auth.uid()
          )
        )
    ));
$$;

revoke all on function app_private.can_read_fee_adjustment(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app_private.can_read_fee_adjustment(uuid, uuid, uuid, uuid) to authenticated;

drop policy if exists tenant_isolation_fee_discounts on public.fee_discounts;
drop policy if exists fee_discounts_scoped_read on public.fee_discounts;
create policy fee_discounts_scoped_read on public.fee_discounts for select to authenticated
using (app_private.can_read_fee_adjustment(school_id, student_id, student_fee_id, null));

drop policy if exists tenant_isolation_fee_refunds on public.fee_refunds;
drop policy if exists fee_refunds_scoped_read on public.fee_refunds;
create policy fee_refunds_scoped_read on public.fee_refunds for select to authenticated
using (app_private.can_read_fee_adjustment(school_id, null, null, payment_id));

revoke all on table public.fee_discounts, public.fee_refunds from public, anon, authenticated;
do $column_grants$
declare
  target regclass;
  columns_sql text;
begin
  foreach target in array array['public.fee_discounts'::regclass, 'public.fee_refunds'::regclass] loop
    select string_agg(format('%I', a.attname), ',' order by a.attnum) into columns_sql
    from pg_catalog.pg_attribute a where a.attrelid = target and a.attnum > 0 and not a.attisdropped;
    execute format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) on table %2$s from public, anon, authenticated', columns_sql, target);
  end loop;
end;
$column_grants$;
grant select on table public.fee_discounts, public.fee_refunds to authenticated;

do $postconditions$
declare
  target regclass;
begin
  foreach target in array array['public.fee_discounts'::regclass, 'public.fee_refunds'::regclass] loop
    if has_table_privilege('anon', target, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('anon', target, 'SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege('authenticated', target, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('authenticated', target, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'Untrusted fee history privileges remain through inherited or column grants. Transaction rolled back.';
    end if;
    if not has_table_privilege('authenticated', target, 'SELECT') then
      raise exception 'Scoped fee history reads must remain available.';
    end if;
  end loop;
  if has_function_privilege('anon', 'app_private.can_read_fee_adjustment(uuid,uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'Anonymous fee history helper execution must be denied.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
    where p.oid = 'app_private.can_read_fee_adjustment(uuid,uuid,uuid,uuid)'::regprocedure
      and p.prosecdef and p.proconfig @> array['search_path=""']
      and (owner_role.rolsuper or owner_role.rolbypassrls or not exists (
        select 1 from pg_catalog.pg_class c
        where c.oid in ('public.student_fees'::regclass, 'public.fee_payments'::regclass,
          'public.students'::regclass, 'public.fee_structures'::regclass, 'public.profiles'::regclass,
          'public.parents'::regclass, 'public.student_parents'::regclass, 'public.user_roles'::regclass)
          and (c.relowner <> p.proowner or c.relforcerowsecurity)
      ))
  ) then
    raise exception 'Fee history helper needs a trusted owner and a pinned search path.';
  end if;
end;
$postconditions$;

commit;
