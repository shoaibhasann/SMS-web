begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A SQL function that is not inlined is planned without its parameter values. For a whole school that generic plan
-- re-ran the payment aggregates once per demand: about 3 seconds for 4,000 demands on production, against 50 ms when
-- the same statement is planned with the values. plpgsql with plan_cache_mode=force_custom_plan plans every call with
-- its own values. The statement itself is unchanged.
create or replace function app_private.office_fee_positions(p_school_id uuid,p_fee_id uuid default null,p_student_id uuid default null)
returns table(
  demand_id uuid,student_id uuid,fee_structure_id uuid,admission_no text,student_name text,
  academic_year_id uuid,academic_year_name text,fee_name text,kind text,billing_period text,due_date date,
  amount numeric,discount numeric,late_fee numeric,base_net_amount numeric,adjustment_amount numeric,
  net_amount numeric,gross_paid_amount numeric,reversed_amount numeric,paid_amount numeric,balance numeric,
  status text,as_of_date date,source_reference text,reason text,invalid boolean,created_at timestamptz
) language plpgsql stable set search_path='' set plan_cache_mode=force_custom_plan
as $$
#variable_conflict use_column
begin
  return query
  with fees as materialized(select sf.* from public.student_fees sf where sf.school_id=p_school_id and (p_fee_id is null or sf.id=p_fee_id) and (p_student_id is null or sf.student_id=p_student_id)),
  adjustments as(select a.fee_id,sum(a.signed_amount) as total,
    count(*) filter(where a.school_id<>p_school_id or a.student_id<>f.student_id) as invalid_count
    from app_private.office_fee_adjustment_entries a join fees f on f.id=a.fee_id group by a.fee_id),
  payments as(select p.student_fee_id,sum(p.amount) filter(where p.status='paid' and p.amount>0 and p.amount<>'NaN'::numeric) as total,
    count(*) filter(where p.school_id<>p_school_id or p.student_id<>f.student_id
      or (p.status='paid' and (p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null))) as invalid_count
    from public.fee_payments p join fees f on f.id=p.student_fee_id group by p.student_fee_id),
  reversals as(select r.fee_id,sum(r.amount) as total,
    count(*) filter(where r.school_id<>p_school_id or r.student_id<>f.student_id or p.student_fee_id<>r.fee_id
      or p.school_id<>r.school_id or p.student_id<>r.student_id or p.status<>'paid' or p.amount<>r.amount
      or p.payment_method is distinct from r.payment_method) as invalid_count
    from app_private.office_fee_payment_reversals r join fees f on f.id=r.fee_id
    join public.fee_payments p on p.id=r.payment_id group by r.fee_id),
  legacy_refunds as(select p.student_fee_id,count(*) as count from public.fee_refunds r
    join public.fee_payments p on p.id=r.payment_id join fees f on f.id=p.student_fee_id group by p.student_fee_id),
  advance as(select e.fee_id,sum(case when e.kind='allocation' then e.amount else -e.amount end) as total,
    count(*) filter(where e.school_id<>p_school_id or e.student_id<>f.student_id or not app_private.valid_office_credit_entry(e.id)) as invalid_count
    from app_private.office_student_credit_entries e join fees f on f.id=e.fee_id
    where e.kind in ('allocation','allocation_return') group by e.fee_id),
  source as(select f.*,student.admission_no,concat_ws(' ',student.first_name,student.middle_name,student.last_name) as student_name,
    y.id as year_id,y.name as year_name,structure.name as fee_name,
    case when opening.student_fee_id is not null then 'opening' when structure.frequency='monthly' then 'monthly' else 'structure' end as kind,
    opening.as_of_date,opening.source_reference,opening.reason,
    f.amount-f.discount+f.late_fee as base_net,
    coalesce(a.total,0) as adjustment,coalesce(p.total,0) as gross_paid,coalesce(r.total,0) as reversed,coalesce(advance.total,0) as advance_applied,
    student.id is null or structure.id is null or y.id is null or f.amount<0 or f.amount='NaN'::numeric
      or f.discount<0 or f.discount='NaN'::numeric or f.late_fee<0 or f.late_fee='NaN'::numeric
      or f.amount-f.discount+f.late_fee<0 or coalesce(a.invalid_count,0)>0 or coalesce(p.invalid_count,0)>0
      or coalesce(r.invalid_count,0)>0 or (advance.fee_id is not null and coalesce((app_private.office_student_credit_state(p_school_id,f.student_id)->'summary'->>'invalid')::boolean,true)) or coalesce(advance.invalid_count,0)>0 or coalesce(advance.total,0)<0 or coalesce(legacy.count,0)>0 or f.status::text not in ('pending','partial','paid') as base_invalid
    from fees f
    left join public.students student on student.id=f.student_id and student.school_id=p_school_id
    left join public.fee_structures structure on structure.id=f.fee_structure_id and structure.school_id=p_school_id
    left join public.academic_years y on y.id=structure.academic_year_id and y.school_id=p_school_id
    left join app_private.office_fee_openings opening on opening.student_fee_id=f.id
    left join adjustments a on a.fee_id=f.id left join payments p on p.student_fee_id=f.id
    left join reversals r on r.fee_id=f.id left join advance on advance.fee_id=f.id left join legacy_refunds legacy on legacy.student_fee_id=f.id),
  canonical as(select *,base_net+adjustment as net,gross_paid-reversed+advance_applied as paid,
    base_invalid or base_net+adjustment<0 or gross_paid-reversed+advance_applied<0 or gross_paid-reversed+advance_applied>base_net+adjustment as invalid from source)
  select id,student_id,fee_structure_id,admission_no,student_name,year_id,year_name,fee_name,kind,billing_period,due_date,
    amount,discount,late_fee,base_net,adjustment,net,gross_paid,reversed,paid,net-paid,
    case when invalid then 'review_required' when net=paid then 'paid' when paid>0 then 'partial' else 'pending' end,
    as_of_date,source_reference,reason,invalid,created_at from canonical;
end;
$$;

commit;
