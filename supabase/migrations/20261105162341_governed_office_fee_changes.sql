begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Source demands and receipts remain evidence. Approved changes are separate
-- entries; a recorded reversal is a cashbook correction, not a bank refund.
create table app_private.office_fee_change_requests (
  id uuid primary key,
  school_id uuid not null references public.schools(id),
  fee_id uuid not null references public.student_fees(id),
  student_id uuid not null references public.students(id),
  kind text not null check(kind in ('reduction','additional_charge','payment_reversal')),
  amount numeric(12,2) not null check(amount>0 and amount<>'NaN'::numeric),
  payment_id uuid references public.fee_payments(id),
  request_payload jsonb not null,
  request_reason text not null,
  requested_by uuid not null,
  requester_name text not null,
  requested_at timestamptz not null default clock_timestamp(),
  financial_token text not null check(financial_token ~ '^[0-9a-f]{64}$'),
  before_position jsonb not null,
  after_position jsonb not null,
  state text not null default 'pending' check(state in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewer_name text,
  review_reason text,
  reviewed_at timestamptz,
  entry_id uuid,
  reference text,
  effective_day date,
  check((kind='payment_reversal')=(payment_id is not null)),
  check((state='pending' and reviewed_by is null and reviewer_name is null and review_reason is null and reviewed_at is null and entry_id is null and reference is null and effective_day is null)
    or (state='rejected' and reviewed_by is not null and reviewer_name is not null and review_reason is not null and reviewed_at is not null and entry_id is null and reference is null and effective_day is null)
    or (state='approved' and reviewed_by is not null and reviewer_name is not null and review_reason is not null and reviewed_at is not null and entry_id is not null and reference is not null)),
  check(reviewed_by is null or reviewed_by<>requested_by)
);
create index office_fee_change_requests_school_state_idx on app_private.office_fee_change_requests(school_id,state,requested_at desc,id);
create index office_fee_change_requests_fee_idx on app_private.office_fee_change_requests(fee_id);

create table app_private.office_fee_adjustment_entries (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references app_private.office_fee_change_requests(id),
  school_id uuid not null references public.schools(id),
  fee_id uuid not null references public.student_fees(id),
  student_id uuid not null references public.students(id),
  signed_amount numeric(12,2) not null check(signed_amount<>0 and signed_amount<>'NaN'::numeric),
  approved_by uuid not null,
  approved_at timestamptz not null,
  reference text not null,
  unique(school_id,reference)
);
create index office_fee_adjustment_entries_fee_idx on app_private.office_fee_adjustment_entries(fee_id);

create table app_private.office_fee_payment_reversals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references app_private.office_fee_change_requests(id),
  payment_id uuid not null unique references public.fee_payments(id),
  school_id uuid not null references public.schools(id),
  fee_id uuid not null references public.student_fees(id),
  student_id uuid not null references public.students(id),
  amount numeric(12,2) not null check(amount>0 and amount<>'NaN'::numeric),
  payment_method text not null check(payment_method in ('cash','upi','bank_transfer','card','cheque')),
  approved_by uuid not null,
  approved_at timestamptz not null,
  business_date date not null,
  reference text not null,
  unique(school_id,reference)
);
create index office_fee_payment_reversals_fee_idx on app_private.office_fee_payment_reversals(fee_id);
create index office_fee_payment_reversals_school_day_idx on app_private.office_fee_payment_reversals(school_id,business_date);
create index student_fees_school_financial_idx on public.student_fees(school_id,student_id,created_at,id);

alter table app_private.office_fee_change_requests enable row level security;
alter table app_private.office_fee_adjustment_entries enable row level security;
alter table app_private.office_fee_payment_reversals enable row level security;
revoke all on app_private.office_fee_change_requests,app_private.office_fee_adjustment_entries,app_private.office_fee_payment_reversals
  from public,anon,authenticated,service_role;

create function app_private.guard_billed_fee_structure_identity()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if auth.uid() is not null and (new.id,new.school_id,new.academic_year_id,new.class_id)
      is distinct from (old.id,old.school_id,old.academic_year_id,old.class_id)
    and exists(select 1 from public.student_fees fee where fee.fee_structure_id=old.id) then
    raise exception 'A billed fee structure must retain its school, academic year and class. Create a new structure for a different scope.' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger guard_billed_fee_structure_identity
  before update of id,school_id,academic_year_id,class_id on public.fee_structures
  for each row execute function app_private.guard_billed_fee_structure_identity();

create function app_private.can_review_office_fee_changes(p_school_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select p_school_id is not null and exists(select 1 from public.user_roles membership
    join public.profiles profile on profile.id=membership.user_id and profile.is_active
    where membership.user_id=auth.uid() and ((membership.school_id=p_school_id and membership.role in ('school_admin','principal'))
      or (membership.school_id is null and membership.role='super_admin')));
$$;

create function app_private.guard_immutable_fee_counterentry()
returns trigger language plpgsql set search_path=''
as $$
begin
  if auth.uid() is not null then
    raise exception 'Approved financial counterentries cannot be rewritten or deleted.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger immutable_office_fee_adjustment_entries before update or delete on app_private.office_fee_adjustment_entries
  for each row execute function app_private.guard_immutable_fee_counterentry();
create trigger immutable_office_fee_payment_reversals before update or delete on app_private.office_fee_payment_reversals
  for each row execute function app_private.guard_immutable_fee_counterentry();

create function app_private.guard_office_fee_reversal_day()
returns trigger language plpgsql security definer set search_path=''
as $$
declare original public.fee_payments%rowtype; event_time timestamptz;
begin
  if not app_private.can_review_office_fee_changes(new.school_id) or new.approved_by is distinct from auth.uid() then
    raise exception 'A school reviewer must approve this recorded-payment reversal.' using errcode='42501';
  end if;
  select * into original from public.fee_payments p where p.id=new.payment_id;
  if not found or original.school_id<>new.school_id or original.student_fee_id<>new.fee_id or original.student_id<>new.student_id
    or original.status<>'paid' or original.amount<>new.amount or original.payment_method is distinct from new.payment_method
    or original.paid_at is null or exists(select 1 from public.fee_refunds r where r.payment_id=original.id) then
    raise exception 'Review the original payment and any legacy refund before reversing it.' using errcode='22023';
  end if;
  new.approved_at:=clock_timestamp();
  new.business_date:=(new.approved_at at time zone 'Asia/Kolkata')::date;
  insert into app_private.office_fee_days(school_id,business_date) values(new.school_id,new.business_date) on conflict do nothing;
  update app_private.office_fee_days set revision=revision+1
    where school_id=new.school_id and business_date=new.business_date and closed_at is null;
  if not found then
    raise exception 'Today is closed for fee collection. Keep this request pending and review it on an open business day.' using errcode='22023';
  end if;
  event_time:=clock_timestamp();
  if (event_time at time zone 'Asia/Kolkata')::date<>new.business_date then
    raise exception 'The business date changed while waiting. Refresh and review this request on the current day.' using errcode='22023';
  end if;
  new.approved_at:=event_time;
  return new;
end;
$$;
create trigger guard_office_fee_reversal_day before insert on app_private.office_fee_payment_reversals
  for each row execute function app_private.guard_office_fee_reversal_day();

-- One set-based accounting definition powers the ledger, collection guard and
-- all-school summary. Dormant legacy discount/refund rows are never replayed.
create function app_private.office_fee_positions(p_school_id uuid,p_fee_id uuid default null,p_student_id uuid default null)
returns table(
  demand_id uuid,student_id uuid,fee_structure_id uuid,admission_no text,student_name text,
  academic_year_id uuid,academic_year_name text,fee_name text,kind text,billing_period text,due_date date,
  amount numeric,discount numeric,late_fee numeric,base_net_amount numeric,adjustment_amount numeric,
  net_amount numeric,gross_paid_amount numeric,reversed_amount numeric,paid_amount numeric,balance numeric,
  status text,as_of_date date,source_reference text,reason text,invalid boolean,created_at timestamptz
) language sql stable set search_path=''
as $$
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
  source as(select f.*,student.admission_no,concat_ws(' ',student.first_name,student.middle_name,student.last_name) as student_name,
    y.id as year_id,y.name as year_name,structure.name as fee_name,
    case when opening.student_fee_id is not null then 'opening' when structure.frequency='monthly' then 'monthly' else 'structure' end as kind,
    opening.as_of_date,opening.source_reference,opening.reason,
    f.amount-f.discount+f.late_fee as base_net,
    coalesce(a.total,0) as adjustment,coalesce(p.total,0) as gross_paid,coalesce(r.total,0) as reversed,
    student.id is null or structure.id is null or y.id is null or f.amount<0 or f.amount='NaN'::numeric
      or f.discount<0 or f.discount='NaN'::numeric or f.late_fee<0 or f.late_fee='NaN'::numeric
      or f.amount-f.discount+f.late_fee<0 or coalesce(a.invalid_count,0)>0 or coalesce(p.invalid_count,0)>0
      or coalesce(r.invalid_count,0)>0 or coalesce(legacy.count,0)>0 or f.status::text not in ('pending','partial','paid') as base_invalid
    from fees f
    left join public.students student on student.id=f.student_id and student.school_id=p_school_id
    left join public.fee_structures structure on structure.id=f.fee_structure_id and structure.school_id=p_school_id
    left join public.academic_years y on y.id=structure.academic_year_id and y.school_id=p_school_id
    left join app_private.office_fee_openings opening on opening.student_fee_id=f.id
    left join adjustments a on a.fee_id=f.id left join payments p on p.student_fee_id=f.id
    left join reversals r on r.fee_id=f.id left join legacy_refunds legacy on legacy.student_fee_id=f.id),
  canonical as(select *,base_net+adjustment as net,gross_paid-reversed as paid,
    base_invalid or base_net+adjustment<0 or gross_paid-reversed<0 or gross_paid-reversed>base_net+adjustment as invalid from source)
  select id,student_id,fee_structure_id,admission_no,student_name,year_id,year_name,fee_name,kind,billing_period,due_date,
    amount,discount,late_fee,base_net,adjustment,net,gross_paid,reversed,paid,net-paid,
    case when invalid then 'review_required' when net=paid then 'paid' when paid>0 then 'partial' else 'pending' end,
    as_of_date,source_reference,reason,invalid,created_at from canonical;
$$;

create function app_private.coherent_office_fee_payment(p_payment_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select exists(select 1 from public.fee_payments payment
    join public.student_fees fee on fee.id=payment.student_fee_id and fee.school_id=payment.school_id and fee.student_id=payment.student_id
    join public.students student on student.id=fee.student_id and student.school_id=fee.school_id
    join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=fee.school_id
    join public.academic_years year on year.id=structure.academic_year_id and year.school_id=fee.school_id
    where payment.id=p_payment_id and fee.amount>=0 and fee.amount<>'NaN'::numeric and fee.discount>=0 and fee.discount<>'NaN'::numeric
      and fee.late_fee>=0 and fee.late_fee<>'NaN'::numeric and fee.amount-fee.discount+fee.late_fee>=0
      and fee.status::text in ('pending','partial','paid')
      and (payment.status<>'paid' or (payment.amount>0 and payment.amount<>'NaN'::numeric and payment.paid_at is not null and isfinite(payment.paid_at))));
$$;

create function app_private.office_fee_financial_state(p_school_id uuid,p_fee_id uuid)
returns jsonb language plpgsql stable set search_path=''
as $$
declare position record; snapshot jsonb; amounts jsonb;
begin
  select * into position from app_private.office_fee_positions(p_school_id,p_fee_id);
  if not found then return null; end if;
  amounts:=jsonb_build_object('base_net_amount',position.base_net_amount::text,'adjustment_amount',position.adjustment_amount::text,
    'net_amount',position.net_amount::text,'gross_paid_amount',position.gross_paid_amount::text,'reversed_amount',position.reversed_amount::text,
    'paid_amount',position.paid_amount::text,'balance',position.balance::text);
  snapshot:=jsonb_build_object('fee',(select to_jsonb(sf) from public.student_fees sf where sf.id=p_fee_id),
    'amounts',amounts,'invalid',position.invalid,
    'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.fee_payments p where p.student_fee_id=p_fee_id),
    'adjustments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from app_private.office_fee_adjustment_entries a where a.fee_id=p_fee_id),
    'reversals',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from app_private.office_fee_payment_reversals r where r.fee_id=p_fee_id),
    'legacy_refunds',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.fee_refunds r
      join public.fee_payments p on p.id=r.payment_id where p.student_fee_id=p_fee_id));
  return jsonb_build_object('valid',not position.invalid,'position',to_jsonb(position),'amounts',amounts,
    'financial_token',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
end;
$$;

create function app_private.locked_office_fee_financial_state(p_school_id uuid,p_fee_id uuid)
returns jsonb language plpgsql volatile set search_path=''
as $$
declare fresh_state jsonb;
begin
  select app_private.office_fee_financial_state(p_school_id,p_fee_id) into fresh_state;
  return fresh_state;
end;
$$;

create function app_private.office_fee_change_result(p_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  select jsonb_build_object('id',q.id,'school_id',q.school_id,'fee_id',q.fee_id,'student_id',q.student_id,
    'admission_no',s.admission_no,'student_name',concat_ws(' ',s.first_name,s.middle_name,s.last_name),'fee_name',structure.name,
    'kind',q.kind,'amount',q.amount::text,'payment_id',q.payment_id,'receipt_no',payment.receipt_no,
    'request_reason',q.request_reason,'requested_by',q.requested_by,'requester_name',q.requester_name,'requested_at',q.requested_at,
    'state',q.state,'before',q.before_position,'after',q.after_position,'financial_token',q.financial_token,
    'reviewed_by',q.reviewed_by,'reviewer_name',q.reviewer_name,'review_reason',q.review_reason,'reviewed_at',q.reviewed_at,
    'entry_id',q.entry_id,'reference',q.reference,'effective_day',q.effective_day)
  from app_private.office_fee_change_requests q join public.student_fees fee on fee.id=q.fee_id
    join public.students s on s.id=q.student_id and s.school_id=q.school_id
    join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=q.school_id
    left join public.fee_payments payment on payment.id=q.payment_id where q.id=p_id;
$$;

create function app_private.request_office_fee_change(
  p_school_id uuid,p_fee_id uuid,p_kind text,p_amount numeric,p_payment_id uuid,p_reason text,p_expected_token text,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); actor_name text; reason_text text:=btrim(p_reason); payload jsonb;
  prior app_private.office_fee_change_requests%rowtype; fee public.student_fees%rowtype; payment public.fee_payments%rowtype;
  state jsonb; before_amounts jsonb; after_amounts jsonb; amount_value numeric; net numeric; paid numeric; adjustment numeric; reversed numeric;
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot request fee changes for this school.' using errcode='42501'; end if;
  select full_name into actor_name from public.profiles where id=actor_id and is_active for share;
  if not found then raise exception 'Your active account could not be verified.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id and ((ur.school_id=p_school_id and ur.role in ('school_admin','principal','accountant'))
    or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Your finance permission has changed.' using errcode='42501'; end if;
  if p_request_id is null or p_fee_id is null or p_kind is null or p_kind not in ('reduction','additional_charge','payment_reversal')
    or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]'
    or coalesce(p_expected_token,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose a fee and change type, refresh its balance, and enter a reason of 5 to 500 characters.' using errcode='22023';
  end if;
  if (p_kind='payment_reversal' and (p_payment_id is null or p_amount is not null))
    or (p_kind<>'payment_reversal' and (p_payment_id is not null or p_amount is null or p_amount<=0 or p_amount='NaN'::numeric
      or p_amount>9999999999.99 or p_amount<>trunc(p_amount,2))) then
    raise exception 'Use a positive adjustment with up to two decimal places, or select one full original payment for reversal.' using errcode='22023';
  end if;
  payload:=jsonb_build_object('school_id',p_school_id,'fee_id',p_fee_id,'kind',p_kind,'amount',p_amount,
    'payment_id',p_payment_id,'reason',reason_text,'financial_token',p_expected_token);
  perform pg_advisory_xact_lock(hashtextextended('office-fee-change-request:'||p_request_id::text,0));
  select * into prior from app_private.office_fee_change_requests where id=p_request_id;
  if found then
    if prior.requested_by<>actor_id or prior.request_payload is distinct from payload then
      raise exception 'This request identifier already records a different fee-change proposal.' using errcode='23505';
    end if;
    return app_private.office_fee_change_result(prior.id);
  end if;
  select * into fee from public.student_fees sf where sf.id=p_fee_id and sf.school_id=p_school_id for update;
  if not found then raise exception 'Fee demand not found in this school.' using errcode='42501'; end if;
  perform 1 from public.fee_payments p where p.student_fee_id=fee.id order by p.id for share;
  state:=app_private.locked_office_fee_financial_state(p_school_id,p_fee_id);
  if state->>'financial_token' is distinct from p_expected_token then
    raise exception 'The fee balance changed. Refresh it before requesting a change.' using errcode='PT409';
  end if;
  if not coalesce((state->>'valid')::boolean,false) then
    raise exception 'The fee or its legacy payments require reconciliation before changes can be requested.' using errcode='22023';
  end if;
  before_amounts:=state->'amounts'; net:=(before_amounts->>'net_amount')::numeric; paid:=(before_amounts->>'paid_amount')::numeric;
  adjustment:=(before_amounts->>'adjustment_amount')::numeric; reversed:=(before_amounts->>'reversed_amount')::numeric;
  amount_value:=p_amount;
  if p_kind='payment_reversal' then
    select * into payment from public.fee_payments p where p.id=p_payment_id and p.student_fee_id=fee.id
      and p.student_id=fee.student_id and p.school_id=p_school_id;
    if not found or payment.status<>'paid' or payment.paid_at is null or payment.amount<=0 or payment.amount='NaN'::numeric
      or payment.payment_method is null or payment.payment_method not in ('cash','upi','bank_transfer','card','cheque')
      or exists(select 1 from app_private.office_fee_payment_reversals r where r.payment_id=payment.id)
      or exists(select 1 from public.fee_refunds r where r.payment_id=payment.id) then
      raise exception 'Choose an unreversed recorded payment without an unresolved legacy refund.' using errcode='22023';
    end if;
    amount_value:=payment.amount; paid:=paid-amount_value; reversed:=reversed+amount_value;
  elsif p_kind='reduction' then
    net:=net-amount_value; adjustment:=adjustment-amount_value;
  else
    net:=net+amount_value; adjustment:=adjustment+amount_value;
  end if;
  if net<0 or net<paid or paid<0 or net>999999999999.99 then
    raise exception 'The proposed charge must remain nonnegative, cover recorded net payments, and stay within the supported limit.' using errcode='22023';
  end if;
  after_amounts:=before_amounts||jsonb_build_object('adjustment_amount',adjustment::text,'net_amount',net::text,
    'reversed_amount',reversed::text,'paid_amount',paid::text,'balance',(net-paid)::text);
  insert into app_private.office_fee_change_requests(id,school_id,fee_id,student_id,kind,amount,payment_id,request_payload,
    request_reason,requested_by,requester_name,financial_token,before_position,after_position)
    values(p_request_id,p_school_id,fee.id,fee.student_id,p_kind,amount_value,p_payment_id,payload,
      reason_text,actor_id,coalesce(actor_name,'Office user'),p_expected_token,before_amounts,after_amounts);
  return app_private.office_fee_change_result(p_request_id);
end;
$$;

create function app_private.review_office_fee_change(p_request_id uuid,p_decision text,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); actor_name text; reason_text text:=btrim(p_reason);
  change_row app_private.office_fee_change_requests%rowtype; fee public.student_fees%rowtype;
  state jsonb; new_entry_id uuid:=gen_random_uuid(); new_reference text; review_time timestamptz:=clock_timestamp(); reversal_day date;
begin
  select * into change_row from app_private.office_fee_change_requests where id=p_request_id;
  if not found or not app_private.can_review_office_fee_changes(change_row.school_id) then
    raise exception 'You cannot review this school''s fee-change request.' using errcode='42501';
  end if;
  if change_row.requested_by=actor_id then raise exception 'Another school administrator or principal must review your request.' using errcode='42501'; end if;
  select full_name into actor_name from public.profiles where id=actor_id and is_active for share;
  if not found then raise exception 'Your active account could not be verified.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id and ((ur.school_id=change_row.school_id and ur.role in ('school_admin','principal'))
    or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Your review permission has changed.' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Choose a decision and enter a review reason of 5 to 500 characters.' using errcode='22023';
  end if;
  -- Request lock makes identical review retries recover the original decision.
  select * into change_row from app_private.office_fee_change_requests where id=p_request_id for update;
  if change_row.state<>'pending' then
    if change_row.state=p_decision and change_row.reviewed_by=actor_id and change_row.review_reason=reason_text then
      return app_private.office_fee_change_result(change_row.id);
    end if;
    raise exception 'This request already has a different review. Refresh its history.' using errcode='23505';
  end if;
  review_time:=clock_timestamp();
  if p_decision='approved' then
    -- Same fee-before-day order as collection. No original receipt is touched.
    select * into fee from public.student_fees sf where sf.id=change_row.fee_id and sf.school_id=change_row.school_id for update;
    perform 1 from public.fee_payments p where p.student_fee_id=fee.id order by p.id for share;
    state:=app_private.locked_office_fee_financial_state(change_row.school_id,change_row.fee_id);
    if state->>'financial_token' is distinct from change_row.financial_token then
      raise exception 'The fee balance changed after this request. Reject it and request a new change from refreshed records.' using errcode='PT409';
    end if;
    if not coalesce((state->>'valid')::boolean,false) then raise exception 'Reconcile this fee and its legacy payments before approval.' using errcode='22023'; end if;
    if change_row.kind='payment_reversal' then
      new_reference:='REV-'||upper(replace(new_entry_id::text,'-',''));
      insert into app_private.office_fee_payment_reversals(id,request_id,payment_id,school_id,fee_id,student_id,amount,payment_method,
        approved_by,approved_at,business_date,reference)
        select new_entry_id,change_row.id,p.id,change_row.school_id,change_row.fee_id,change_row.student_id,p.amount,p.payment_method,
          actor_id,review_time,(review_time at time zone 'Asia/Kolkata')::date,new_reference
        from public.fee_payments p where p.id=change_row.payment_id
        returning business_date,approved_at into reversal_day,review_time;
    else
      new_reference:='ADJ-'||upper(replace(new_entry_id::text,'-',''));
      insert into app_private.office_fee_adjustment_entries(id,request_id,school_id,fee_id,student_id,signed_amount,approved_by,approved_at,reference)
        values(new_entry_id,change_row.id,change_row.school_id,change_row.fee_id,change_row.student_id,
          case when change_row.kind='reduction' then -change_row.amount else change_row.amount end,actor_id,review_time,new_reference);
    end if;
  end if;
  update app_private.office_fee_change_requests q set state=p_decision,reviewed_by=actor_id,reviewer_name=coalesce(actor_name,'School reviewer'),
    review_reason=reason_text,reviewed_at=review_time,
    entry_id=case when p_decision='approved' then new_entry_id end,
    reference=case when p_decision='approved' then new_reference end,effective_day=reversal_day where q.id=change_row.id;
  return app_private.office_fee_change_result(change_row.id);
end;
$$;

create function app_private.list_office_fee_changes(p_school_id uuid,p_state text,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot view fee changes for this school.' using errcode='42501'; end if;
  if p_state is null or p_state not in ('all','pending','approved','rejected') or p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid fee-change history page.' using errcode='22023'; end if;
  select jsonb_build_object('rows',coalesce((select jsonb_agg(app_private.office_fee_change_result(q.id) order by q.requested_at desc,q.id)
      from(select id,requested_at from app_private.office_fee_change_requests where school_id=p_school_id and (p_state='all' or state=p_state)
        order by requested_at desc,id limit p_limit offset p_offset)q),'[]'::jsonb),
    'total_count',(select count(*) from app_private.office_fee_change_requests where school_id=p_school_id and (p_state='all' or state=p_state))) into result;
  return result;
end;
$$;

create function app_private.office_fee_ledger_result(
  p_school_id uuid,p_year_id uuid,p_student_id uuid,p_limit integer,p_offset integer,p_family boolean
)
returns jsonb language sql stable set search_path=''
as $$
  with source as materialized(select * from app_private.office_fee_positions(p_school_id,null,p_student_id)
    where (p_student_id is null or student_id=p_student_id) and (p_year_id is null or academic_year_id=p_year_id or academic_year_id is null)),
  page as(select jsonb_build_object('demand_id',demand_id,'student_id',student_id,'fee_structure_id',fee_structure_id,
    'admission_no',admission_no,'student_name',student_name,'academic_year_id',academic_year_id,'academic_year_name',academic_year_name,
    'fee_name',coalesce(fee_name,'Unassigned legacy charge'),'kind',kind,'billing_period',billing_period,'due_date',due_date,
    'amount',case when not invalid then amount::text end,'discount',case when not invalid then discount::text end,
    'late_fee',case when not invalid then late_fee::text end,'base_net_amount',case when not invalid then base_net_amount::text end,
    'adjustment_amount',case when not invalid then adjustment_amount::text end,'net_amount',case when not invalid then net_amount::text end,
    'gross_paid_amount',case when not invalid then gross_paid_amount::text end,'reversed_amount',case when not invalid then reversed_amount::text end,
    'paid_amount',case when not invalid then paid_amount::text end,'balance',case when not invalid then balance::text end,
    'status',status,'as_of_date',as_of_date,'invalid',invalid)
    ||case when p_family then '{}'::jsonb else jsonb_build_object('source_reference',source_reference,'reason',reason,
      'financial_token',case when not invalid then app_private.office_fee_financial_state(p_school_id,demand_id)->>'financial_token' end) end as item,
    due_date,created_at,demand_id
    from source order by due_date nulls last,created_at,demand_id limit p_limit offset p_offset)
  select jsonb_build_object('academic_year_id',p_year_id,'limit',p_limit,'offset',p_offset,
    'rows',coalesce((select jsonb_agg(item order by due_date nulls last,created_at,demand_id) from page),'[]'::jsonb),
    'summary',jsonb_build_object('demand_count',count(*),'invalid_count',count(*) filter(where invalid),
      'pending_count',count(*) filter(where not invalid and balance>0),
      'overdue_count',count(*) filter(where not invalid and balance>0 and due_date<(statement_timestamp() at time zone 'Asia/Kolkata')::date),
      'net_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net_amount),0)::text end,
      'adjustment_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(adjustment_amount),0)::text end,
      'gross_paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(gross_paid_amount),0)::text end,
      'reversed_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(reversed_amount),0)::text end,
      'paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_amount),0)::text end,
      'balance',case when count(*) filter(where invalid)=0 then coalesce(sum(balance),0)::text end,
      'opening_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net_amount) filter(where kind='opening'),0)::text end)) from source;
$$;

create or replace function app_private.get_office_fee_ledger(p_school_id uuid,p_year_id uuid,p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot view the fee ledger for this school.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid fee-ledger page.' using errcode='22023'; end if;
  if (p_year_id is not null and not exists(select 1 from public.academic_years y where y.id=p_year_id and y.school_id=p_school_id))
    or (p_student_id is not null and not exists(select 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id)) then
    raise exception 'The ledger filter is outside this school.' using errcode='42501'; end if;
  return app_private.office_fee_ledger_result(p_school_id,p_year_id,p_student_id,p_limit,p_offset,false);
end;
$$;

create function app_private.can_read_family_fee_student(p_student_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select exists(select 1 from public.students student where student.id=p_student_id and (
    exists(select 1 from public.profiles profile join public.user_roles membership on membership.user_id=profile.id
      and membership.school_id=student.school_id and membership.role='student'
      where profile.id=student.profile_id and profile.id=auth.uid() and profile.is_active and profile.school_id=student.school_id)
    or exists(select 1 from public.student_parents link join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=student.school_id
      join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=student.school_id
      join public.user_roles membership on membership.user_id=profile.id and membership.school_id=student.school_id and membership.role='parent'
      where link.student_id=student.id and profile.id=auth.uid())));
$$;

create function app_private.get_family_fee_ledger(p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare school_id uuid;
begin
  if not app_private.can_read_family_fee_student(p_student_id) then raise exception 'You cannot read this pupil''s fee history.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid family-ledger page.' using errcode='22023'; end if;
  select s.school_id into school_id from public.students s where s.id=p_student_id;
  return app_private.office_fee_ledger_result(school_id,null,p_student_id,p_limit,p_offset,true);
end;
$$;

create function app_private.office_fee_receipts_result(p_school_id uuid,p_student_id uuid,p_limit integer,p_offset integer,p_family boolean)
returns jsonb language sql stable set search_path=''
as $$
  with eligible as materialized(select p.*,r.id as reversal_id,r.reference as reversal_reference,r.approved_at as reversed_at,
    coalesce(r.amount,0) as reversal_amount,exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id) as legacy_refund,
    not app_private.coherent_office_fee_payment(p.id)
      or (p.status='paid' and (p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null))
      or (r.id is not null and (r.school_id<>p.school_id or r.fee_id<>p.student_fee_id or r.student_id<>p.student_id or r.amount<>p.amount or p.status<>'paid')) as source_invalid
    from public.fee_payments p left join app_private.office_fee_payment_reversals r on r.payment_id=p.id
    where p.school_id=p_school_id and (p_student_id is null or p.student_id=p_student_id) and (not p_family or p.status='paid')),
  page as(select jsonb_build_object('id',id,'student_fee_id',student_fee_id,'student_id',student_id,'receipt_no',receipt_no,
    'amount',case when amount<>'NaN'::numeric then amount::text end,'payment_method',payment_method,'recorded_status',status,
    'status',case when legacy_refund or source_invalid then 'review_required' when reversal_id is not null then 'reversed' else status::text end,
    'paid_at',paid_at,'reversed_amount',reversal_amount::text,
    'net_amount',case when not legacy_refund and not source_invalid and amount<>'NaN'::numeric then case when status='paid' then amount-reversal_amount else 0 end::text end,
    'reversed_at',reversed_at,'reversal_id',reversal_id,'reversal_reference',reversal_reference)
    ||case when p_family then '{}'::jsonb else jsonb_build_object('legacy_refund',legacy_refund,
      'financial_token',case when (app_private.office_fee_financial_state(p_school_id,student_fee_id)->>'valid')::boolean
        then app_private.office_fee_financial_state(p_school_id,student_fee_id)->>'financial_token' end) end as item,paid_at,id
    from eligible where not p_family or not source_invalid order by paid_at desc nulls last,id limit p_limit offset p_offset)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(item order by paid_at desc nulls last,id) from page),'[]'::jsonb),
    'count',(select count(*) from eligible where not p_family or not source_invalid),'limit',p_limit,'offset',p_offset);
$$;

create function app_private.list_office_fee_receipts(p_school_id uuid,p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot read receipts for this school.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid receipt page.' using errcode='22023'; end if;
  if p_student_id is not null and not exists(select 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id) then
    raise exception 'The receipt filter is outside this school.' using errcode='42501'; end if;
  return app_private.office_fee_receipts_result(p_school_id,p_student_id,p_limit,p_offset,false);
end;
$$;

create function app_private.list_family_fee_receipts(p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare school_id uuid;
begin
  if not app_private.can_read_family_fee_student(p_student_id) then raise exception 'You cannot read this pupil''s receipts.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid family receipt page.' using errcode='22023'; end if;
  select s.school_id into school_id from public.students s where s.id=p_student_id;
  return app_private.office_fee_receipts_result(school_id,p_student_id,p_limit,p_offset,true);
end;
$$;

create function app_private.office_fee_collection_totals(p_school_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  with boundaries as(select (statement_timestamp() at time zone 'Asia/Kolkata')::date as today),
  events as(select p.amount as gross,0::numeric as reversed,p.paid_at as posted_at,
    p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null or not isfinite(p.paid_at)
      or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id)
      or not app_private.coherent_office_fee_payment(p.id) as invalid
    from public.fee_payments p where p.school_id=p_school_id and p.status='paid'
    union all select 0,r.amount,r.approved_at,r.amount<=0 or r.amount='NaN'::numeric
      or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=r.payment_id)
      or not app_private.coherent_office_fee_payment(r.payment_id)
      or not exists(select 1 from public.fee_payments p where p.id=r.payment_id and p.school_id=r.school_id
        and p.student_fee_id=r.fee_id and p.student_id=r.student_id and p.status='paid' and p.amount=r.amount)
      from app_private.office_fee_payment_reversals r where r.school_id=p_school_id),
  totals as(select count(*) filter(where invalid) as invalid_count,
    coalesce(sum(gross) filter(where not invalid),0) as gross,coalesce(sum(reversed) filter(where not invalid),0) as reversed,
    coalesce(sum(gross) filter(where not invalid and posted_at>=today::timestamp at time zone 'Asia/Kolkata'
      and posted_at<(today+1)::timestamp at time zone 'Asia/Kolkata'),0) as today_gross,
    coalesce(sum(reversed) filter(where not invalid and posted_at>=today::timestamp at time zone 'Asia/Kolkata'
      and posted_at<(today+1)::timestamp at time zone 'Asia/Kolkata'),0) as today_reversed,
    coalesce(sum(gross) filter(where not invalid and posted_at>=date_trunc('month',today::timestamp) at time zone 'Asia/Kolkata'
      and posted_at<(date_trunc('month',today::timestamp)+interval '1 month') at time zone 'Asia/Kolkata'),0) as month_gross,
    coalesce(sum(reversed) filter(where not invalid and posted_at>=date_trunc('month',today::timestamp) at time zone 'Asia/Kolkata'
      and posted_at<(date_trunc('month',today::timestamp)+interval '1 month') at time zone 'Asia/Kolkata'),0) as month_reversed
    from events cross join boundaries)
  select jsonb_build_object('business_date',(select today from boundaries),'month',(select to_char(today,'YYYY-MM') from boundaries),
    'invalid_count',invalid_count,'gross_amount',case when invalid_count=0 then gross::text end,
    'reversal_amount',case when invalid_count=0 then reversed::text end,'net_amount',case when invalid_count=0 then (gross-reversed)::text end,
    'today_gross',case when invalid_count=0 then today_gross::text end,'today_reversal',case when invalid_count=0 then today_reversed::text end,
    'today_net',case when invalid_count=0 then (today_gross-today_reversed)::text end,
    'month_gross',case when invalid_count=0 then month_gross::text end,'month_reversal',case when invalid_count=0 then month_reversed::text end,
    'month_net',case when invalid_count=0 then (month_gross-month_reversed)::text end) from totals;
$$;

create function app_private.get_office_finance_summary(p_school_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare ledger jsonb; collections jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot read finance totals for this school.' using errcode='42501'; end if;
  ledger:=app_private.office_fee_ledger_result(p_school_id,null,null,1,0,false);
  collections:=app_private.office_fee_collection_totals(p_school_id);
  return (ledger->'summary')||jsonb_build_object('collections',collections,
    'invalid_count',(ledger->'summary'->>'invalid_count')::bigint+(collections->>'invalid_count')::bigint);
end;
$$;

create or replace function app_private.summarize_office_fee_day(p_school_id uuid,p_day date)
returns jsonb language sql stable set search_path=''
as $$
  with events as(
    select coalesce(nullif(lower(btrim(p.payment_method)),''),'unclassified') as method,
      p.amount as gross,0::numeric as reversed,1::bigint as receipt_count,0::bigint as reversal_count,
      p.amount<=0 or p.amount='NaN'::numeric or not app_private.coherent_office_fee_payment(p.id)
      or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id) as invalid
    from public.fee_payments p where p.school_id=p_school_id and p.status='paid'
      and p.paid_at>=(p_day::timestamp at time zone 'Asia/Kolkata') and p.paid_at<((p_day+1)::timestamp at time zone 'Asia/Kolkata')
    union all select r.payment_method,0,r.amount,0,1,r.amount<=0 or r.amount='NaN'::numeric
      or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=r.payment_id)
      or not app_private.coherent_office_fee_payment(r.payment_id)
      or not exists(select 1 from public.fee_payments p where p.id=r.payment_id and p.school_id=r.school_id
        and p.student_fee_id=r.fee_id and p.student_id=r.student_id and p.status='paid' and p.amount=r.amount)
    from app_private.office_fee_payment_reversals r where r.school_id=p_school_id and r.business_date=p_day
  ), grouped as(select method,sum(receipt_count) as receipt_count,sum(reversal_count) as reversal_count,
    coalesce(sum(gross) filter(where not invalid),0) as gross,coalesce(sum(reversed) filter(where not invalid),0) as reversed,
    count(*) filter(where invalid) as invalid_count from events group by method)
  select jsonb_build_object('receipt_count',coalesce(sum(receipt_count),0),'reversal_count',coalesce(sum(reversal_count),0),
    'gross_total',coalesce(sum(gross),0),'reversed_total',coalesce(sum(reversed),0),
    'recorded_total',coalesce(sum(gross-reversed),0),'recorded_cash',coalesce(sum(gross-reversed) filter(where method='cash'),0),
    'invalid_count',coalesce(sum(invalid_count),0),'methods',coalesce(jsonb_agg(jsonb_build_object('method',method,
      'receipt_count',receipt_count,'reversal_count',reversal_count,'gross_total',gross,'reversed_total',reversed,'total',gross-reversed)
      order by method),'[]'::jsonb)) from grouped;
$$;

-- Collection uses the same effective position as approvals and readers.
CREATE OR REPLACE FUNCTION app_private.record_office_fee_payment(p_school_id uuid, p_student_fee_id uuid, p_amount numeric, p_payment_method text, p_request_id uuid, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor_id uuid := auth.uid();
  method text := pg_catalog.lower(pg_catalog.btrim(p_payment_method));
  payment_reference text := nullif(pg_catalog.btrim(p_reference), '');
  fee public.student_fees%rowtype;
  payment public.fee_payments%rowtype;
  amount_due numeric;
  amount_paid numeric;
  receipt text;
  financial_state jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot record payments for this school.' using errcode = '42501';
  end if;
  perform 1 from public.profiles profile where profile.id=actor_id and profile.is_active for share;
  if not found then raise exception 'Your active finance account could not be verified.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id and ((ur.school_id=p_school_id and ur.role in ('school_admin','principal','accountant'))
    or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Your finance permission has changed.' using errcode='42501'; end if;


  if p_student_fee_id is null or p_request_id is null then
    raise exception 'Choose a fee and reopen the payment form.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 9999999999.99
    or p_amount <> pg_catalog.trunc(p_amount, 2) then
    raise exception 'Enter a positive amount with up to two decimal places.' using errcode = '22023';
  end if;
  if method is null or method not in ('cash', 'upi', 'bank_transfer', 'card', 'cheque') then
    raise exception 'Choose a supported payment method.' using errcode = '22023';
  end if;
  if pg_catalog.length(payment_reference) > 120
    or (method <> 'cash' and payment_reference is null) then
    raise exception 'Enter a payment reference of up to 120 characters.' using errcode = '22023';
  end if;

  -- A request can only commit once even if concurrent retries name different fees.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'office-fee-payment:' || p_school_id::text || ':' || p_request_id::text, 0
  ));
  select * into payment
  from public.fee_payments
  where school_id = p_school_id and office_request_id = p_request_id;
  if found then
    if payment.student_fee_id <> p_student_fee_id or payment.amount <> p_amount
      or payment.payment_method is distinct from method
      or payment.transaction_id is distinct from payment_reference then
      raise exception 'This payment request already has a different receipt.' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('payment_id', payment.id, 'receipt_no', payment.receipt_no);
  end if;

  -- Each payment allocates to one fee. Lock that fee before calculating its balance.
  select sf.* into fee
  from public.student_fees sf
  join public.students student on student.id = sf.student_id and student.school_id = sf.school_id
  join public.fee_structures structure on structure.id = sf.fee_structure_id and structure.school_id = sf.school_id
  where sf.id = p_student_fee_id and sf.school_id = p_school_id
  for update of sf;
  if not found then
    raise exception 'Fee demand not found in this school.' using errcode = '42501';
  end if;
  perform 1 from public.fee_payments p where p.student_fee_id=fee.id order by p.id for share;
  financial_state := app_private.locked_office_fee_financial_state(p_school_id,fee.id);
  if not coalesce((financial_state->>'valid')::boolean,false) then
    raise exception 'Review this demand and any legacy payments before collecting.' using errcode='22023';
  end if;
  amount_due := (financial_state->'amounts'->>'net_amount')::numeric;
  amount_paid := (financial_state->'amounts'->>'paid_amount')::numeric;
  if amount_due <= amount_paid then
    raise exception 'This fee has no outstanding balance. Refresh the fee records.' using errcode='22023';
  end if;
  if p_amount > amount_due-amount_paid then
    raise exception 'The payment exceeds the effective outstanding balance. Refresh the fee records.' using errcode='22023';
  end if;

  receipt := 'RCPT-' || pg_catalog.upper(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''));
  insert into public.fee_payments (
    school_id, student_fee_id, student_id, receipt_no, amount, payment_method,
    transaction_id, status, paid_at, office_request_id, recorded_by
  )
  values (
    fee.school_id, fee.id, fee.student_id, receipt, p_amount, method,
    payment_reference, 'paid', clock_timestamp(), p_request_id, actor_id
  )
  returning * into payment;

  update public.student_fees
  set status = case when amount_paid + p_amount = amount_due
    then 'paid'::public.payment_status else 'partial'::public.payment_status end
  where id = fee.id;

  return pg_catalog.jsonb_build_object('payment_id', payment.id, 'receipt_no', payment.receipt_no);
end;
$function$
;

create function public.request_office_fee_change(p_school_id uuid,p_fee_id uuid,p_kind text,p_amount numeric,p_payment_id uuid,p_reason text,p_expected_token text,p_request_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.request_office_fee_change(p_school_id,p_fee_id,p_kind,p_amount,p_payment_id,p_reason,p_expected_token,p_request_id); $$;
create function public.review_office_fee_change(p_request_id uuid,p_decision text,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.review_office_fee_change(p_request_id,p_decision,p_reason); $$;
create function public.list_office_fee_changes(p_school_id uuid,p_state text default 'all',p_limit integer default 50,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.list_office_fee_changes(p_school_id,p_state,p_limit,p_offset); $$;
create function public.list_office_fee_receipts(p_school_id uuid,p_student_id uuid default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.list_office_fee_receipts(p_school_id,p_student_id,p_limit,p_offset); $$;
create function public.list_family_fee_receipts(p_student_id uuid,p_limit integer default 30,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.list_family_fee_receipts(p_student_id,p_limit,p_offset); $$;
create function public.get_family_fee_ledger(p_student_id uuid,p_limit integer default 30,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.get_family_fee_ledger(p_student_id,p_limit,p_offset); $$;
create function public.get_office_finance_summary(p_school_id uuid)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.get_office_finance_summary(p_school_id); $$;

revoke all on function app_private.can_review_office_fee_changes(uuid),app_private.guard_billed_fee_structure_identity(),app_private.guard_immutable_fee_counterentry(),
  app_private.guard_office_fee_reversal_day(),app_private.office_fee_positions(uuid,uuid,uuid),
  app_private.coherent_office_fee_payment(uuid),app_private.office_fee_financial_state(uuid,uuid),app_private.locked_office_fee_financial_state(uuid,uuid),
  app_private.office_fee_change_result(uuid),app_private.office_fee_ledger_result(uuid,uuid,uuid,integer,integer,boolean),
  app_private.can_read_family_fee_student(uuid),app_private.office_fee_receipts_result(uuid,uuid,integer,integer,boolean),
  app_private.office_fee_collection_totals(uuid)
  from public,anon,authenticated,service_role;

revoke all on function app_private.request_office_fee_change(uuid,uuid,text,numeric,uuid,text,text,uuid),public.request_office_fee_change(uuid,uuid,text,numeric,uuid,text,text,uuid),
  app_private.review_office_fee_change(uuid,text,text),public.review_office_fee_change(uuid,text,text),
  app_private.list_office_fee_changes(uuid,text,integer,integer),public.list_office_fee_changes(uuid,text,integer,integer),
  app_private.list_office_fee_receipts(uuid,uuid,integer,integer),public.list_office_fee_receipts(uuid,uuid,integer,integer),
  app_private.list_family_fee_receipts(uuid,integer,integer),public.list_family_fee_receipts(uuid,integer,integer),
  app_private.get_family_fee_ledger(uuid,integer,integer),public.get_family_fee_ledger(uuid,integer,integer),
  app_private.get_office_finance_summary(uuid),public.get_office_finance_summary(uuid)
  from public,anon,authenticated,service_role;
grant execute on function app_private.request_office_fee_change(uuid,uuid,text,numeric,uuid,text,text,uuid),public.request_office_fee_change(uuid,uuid,text,numeric,uuid,text,text,uuid),
  app_private.review_office_fee_change(uuid,text,text),public.review_office_fee_change(uuid,text,text),
  app_private.list_office_fee_changes(uuid,text,integer,integer),public.list_office_fee_changes(uuid,text,integer,integer),
  app_private.list_office_fee_receipts(uuid,uuid,integer,integer),public.list_office_fee_receipts(uuid,uuid,integer,integer),
  app_private.list_family_fee_receipts(uuid,integer,integer),public.list_family_fee_receipts(uuid,integer,integer),
  app_private.get_family_fee_ledger(uuid,integer,integer),public.get_family_fee_ledger(uuid,integer,integer),
  app_private.get_office_finance_summary(uuid),public.get_office_finance_summary(uuid)
  to authenticated;

commit;
