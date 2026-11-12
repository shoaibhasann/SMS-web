begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Fee ledger and receipt readers pick the page's keys first and only then evaluate the
-- per-row financial token / payment coherence, so a page costs O(page) on top of one scan
-- instead of also projecting every skipped OFFSET row. Family ledger pages list open
-- (valid, balance > 0) demands first; office order is unchanged. Receipts also name the
-- fee head and billing month they settled.
create or replace function app_private.office_fee_ledger_result(
  p_school_id uuid,p_year_id uuid,p_student_id uuid,p_limit integer,p_offset integer,p_family boolean
)
returns jsonb language sql stable set search_path=''
as $$
  with source as materialized(select *,case when p_family and not invalid and balance>0 then 0 else 1 end as sort_rank
    from app_private.office_fee_positions(p_school_id,null,p_student_id)
    where (p_student_id is null or student_id=p_student_id) and (p_year_id is null or academic_year_id=p_year_id or academic_year_id is null)),
  keyed as materialized(select * from source order by sort_rank,due_date nulls last,created_at,demand_id limit p_limit offset p_offset),
  page as(select jsonb_build_object('demand_id',demand_id,'student_id',student_id,'fee_structure_id',fee_structure_id,
    'admission_no',admission_no,'student_name',student_name,'academic_year_id',academic_year_id,'academic_year_name',academic_year_name,
    'fee_name',coalesce(fee_name,'Unassigned legacy charge'),'kind',kind,'billing_period',billing_period,'due_date',due_date,
    'amount',case when not invalid then amount::text end,'discount',case when not invalid then discount::text end,
    'late_fee',case when not invalid then late_fee::text end,'base_net_amount',case when not invalid then base_net_amount::text end,
    'adjustment_amount',case when not invalid then adjustment_amount::text end,'net_amount',case when not invalid then net_amount::text end,
    'gross_paid_amount',case when not invalid then gross_paid_amount::text end,'reversed_amount',case when not invalid then reversed_amount::text end,
    'advance_applied_amount',case when not invalid then (paid_amount-gross_paid_amount+reversed_amount)::text end,
    'paid_amount',case when not invalid then paid_amount::text end,'balance',case when not invalid then balance::text end,
    'status',status,'as_of_date',as_of_date,'invalid',invalid)
    ||case when p_family then '{}'::jsonb else jsonb_build_object('source_reference',source_reference,'reason',reason,
      'financial_token',case when not invalid then app_private.office_fee_financial_state(p_school_id,demand_id)->>'financial_token' end) end as item,
    sort_rank,due_date,created_at,demand_id
    from keyed)
  select jsonb_build_object('academic_year_id',p_year_id,'limit',p_limit,'offset',p_offset,
    'rows',coalesce((select jsonb_agg(item order by sort_rank,due_date nulls last,created_at,demand_id) from page),'[]'::jsonb),
    'summary',jsonb_build_object('demand_count',count(*),'invalid_count',count(*) filter(where invalid),
      'pending_count',count(*) filter(where not invalid and balance>0),
      'overdue_count',count(*) filter(where not invalid and balance>0 and due_date<(statement_timestamp() at time zone 'Asia/Kolkata')::date),
      'net_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net_amount),0)::text end,
      'adjustment_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(adjustment_amount),0)::text end,
      'gross_paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(gross_paid_amount),0)::text end,
      'reversed_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(reversed_amount),0)::text end,
      'advance_applied_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_amount-gross_paid_amount+reversed_amount),0)::text end,
      'paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_amount),0)::text end,
      'balance',case when count(*) filter(where invalid)=0 then coalesce(sum(balance),0)::text end,
      'opening_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net_amount) filter(where kind='opening'),0)::text end)) from source;
$$;

-- Office pages never need coherence to choose rows (invalid receipts stay listed as review_required),
-- so it is evaluated only for the page; family pages hide invalid receipts, so their (per-pupil) key
-- scan still checks it. payment_id is unique on reversals, so the joins add no rows.
create or replace function app_private.office_fee_receipts_result(p_school_id uuid,p_student_id uuid,p_limit integer,p_offset integer,p_family boolean)
returns jsonb language sql stable set search_path=''
as $$
  with keys as materialized(select p.id,p.paid_at from public.fee_payments p
    left join app_private.office_fee_payment_reversals r on r.payment_id=p.id
    where p.school_id=p_school_id and (p_student_id is null or p.student_id=p_student_id) and (not p_family or p.status='paid')
      and case when p_family then not (not app_private.coherent_office_fee_payment(p.id)
        or (p.status='paid' and (p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null))
        or (r.id is not null and (r.school_id<>p.school_id or r.fee_id<>p.student_fee_id or r.student_id<>p.student_id or r.amount<>p.amount or p.status<>'paid')))
        else true end),
  paged as materialized(select p.*,r.id as reversal_id,r.reference as reversal_reference,r.approved_at as reversed_at,
    coalesce(r.amount,0) as reversal_amount,exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id) as legacy_refund,
    not app_private.coherent_office_fee_payment(p.id)
      or (p.status='paid' and (p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null))
      or (r.id is not null and (r.school_id<>p.school_id or r.fee_id<>p.student_fee_id or r.student_id<>p.student_id or r.amount<>p.amount or p.status<>'paid')) as source_invalid,
    case when p_family then null else app_private.office_fee_financial_state(p_school_id,p.student_fee_id) end as state,
    coalesce(structure.name,'Unassigned legacy charge') as fee_name,fee.billing_period
    from (select id from keys order by paid_at desc nulls last,id limit p_limit offset p_offset) k
    join public.fee_payments p on p.id=k.id
    left join app_private.office_fee_payment_reversals r on r.payment_id=p.id
    left join public.student_fees fee on fee.id=p.student_fee_id and fee.school_id=p.school_id
    left join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=fee.school_id),
  page as(select jsonb_build_object('id',id,'student_fee_id',student_fee_id,'student_id',student_id,'receipt_no',receipt_no,
    'amount',case when amount<>'NaN'::numeric then amount::text end,'payment_method',payment_method,'recorded_status',status,
    'status',case when legacy_refund or source_invalid then 'review_required' when reversal_id is not null then 'reversed' else status::text end,
    'paid_at',paid_at,'reversed_amount',reversal_amount::text,
    'net_amount',case when not legacy_refund and not source_invalid and amount<>'NaN'::numeric then case when status='paid' then amount-reversal_amount else 0 end::text end,
    'reversed_at',reversed_at,'reversal_id',reversal_id,'reversal_reference',reversal_reference,'fee_name',fee_name,'billing_period',billing_period)
    ||case when p_family then '{}'::jsonb else jsonb_build_object('legacy_refund',legacy_refund,
      'financial_token',case when (state->>'valid')::boolean then state->>'financial_token' end) end as item,paid_at,id
    from paged)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(item order by paid_at desc nulls last,id) from page),'[]'::jsonb),
    'count',(select count(*) from keys),'limit',p_limit,'offset',p_offset);
$$;

revoke all on function app_private.office_fee_ledger_result(uuid,uuid,uuid,integer,integer,boolean),
  app_private.office_fee_receipts_result(uuid,uuid,integer,integer,boolean)
  from public,anon,authenticated,service_role;

commit;
