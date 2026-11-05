begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Credit is a per-pupil liability, separate from fee debt and from cash.
-- Only receipt/refund/receipt_reversal entries touch the cashbook. Allocation,
-- allocation return, refund approval and reservation cancellation are noncash.
create table app_private.office_student_credit_accounts (
  school_id uuid not null references public.schools(id),
  student_id uuid not null references public.students(id),
  revision bigint not null default 0 check(revision>=0),
  primary key(school_id,student_id)
);
create table app_private.office_credit_change_requests (
  id uuid primary key,
  school_id uuid not null references public.schools(id),
  student_id uuid not null references public.students(id),
  kind text not null check(kind in ('refund','allocation_return','receipt_reversal')),
  amount numeric(12,2) not null check(amount>0 and amount<>'NaN'::numeric),
  entry_target_id uuid,
  fee_id uuid references public.student_fees(id),
  request_payload jsonb not null,
  request_reason text not null,
  requested_by uuid not null,
  requester_name text not null,
  requested_at timestamptz not null default clock_timestamp(),
  financial_token text not null check(financial_token ~ '^[0-9a-f]{64}$'),
  fee_token text,
  state text not null default 'pending' check(state in ('pending','approved','rejected','cancelled','paid')),
  reviewed_by uuid,
  reviewer_name text,
  review_reason text,
  reviewed_at timestamptz,
  entry_id uuid,
  reference text,
  effective_day date,
  cancelled_by uuid,
  canceller_name text,
  cancel_reason text,
  cancelled_at timestamptz,
  check((kind='refund' and entry_target_id is null and fee_id is null and fee_token is null)
    or (kind='allocation_return' and entry_target_id is not null and fee_id is not null and fee_token is not null)
    or (kind='receipt_reversal' and entry_target_id is not null and fee_id is null and fee_token is null)),
  check(reviewed_by is null or reviewed_by<>requested_by),
  check((state='pending' and reviewed_by is null and review_reason is null and reviewed_at is null and entry_id is null)
    or (state='rejected' and reviewed_by is not null and review_reason is not null and reviewed_at is not null and entry_id is null)
    or (state='approved' and reviewed_by is not null and review_reason is not null and reviewed_at is not null
      and ((kind='refund' and entry_id is null) or (kind<>'refund' and entry_id is not null and reference is not null)))
    or (state='paid' and kind='refund' and reviewed_by is not null and entry_id is not null and reference is not null and effective_day is not null)
    or (state='cancelled' and kind='refund' and reviewed_by is not null and cancelled_by is not null and canceller_name is not null
      and cancel_reason is not null and cancelled_at is not null and entry_id is null))
);
create index office_credit_change_requests_school_state_idx on app_private.office_credit_change_requests(school_id,state,requested_at desc,id);
create index office_credit_change_requests_student_idx on app_private.office_credit_change_requests(school_id,student_id);

create table app_private.office_student_credit_entries (
  id uuid primary key,
  school_id uuid not null references public.schools(id),
  student_id uuid not null references public.students(id),
  kind text not null check(kind in ('receipt','allocation','allocation_return','refund','receipt_reversal')),
  amount numeric(12,2) not null check(amount>0 and amount<>'NaN'::numeric),
  reference text not null,
  payment_method text check(payment_method in ('cash','upi','bank_transfer','card','cheque')),
  fee_id uuid references public.student_fees(id),
  related_entry_id uuid references app_private.office_student_credit_entries(id),
  credit_request_id uuid unique references app_private.office_credit_change_requests(id),
  actor_id uuid not null,
  actor_name text not null,
  reason text not null,
  intent jsonb not null,
  occurred_at timestamptz not null default clock_timestamp(),
  business_date date,
  check((kind in ('receipt','refund','receipt_reversal'))=(payment_method is not null)),
  check((kind in ('receipt','refund','receipt_reversal'))=(business_date is not null)),
  check((kind in ('allocation','allocation_return'))=(fee_id is not null)),
  check((kind in ('allocation_return','receipt_reversal'))=(related_entry_id is not null)),
  check((kind in ('allocation_return','refund','receipt_reversal'))=(credit_request_id is not null))
);
alter table app_private.office_credit_change_requests add constraint office_credit_change_requests_target_fk
  foreign key(entry_target_id) references app_private.office_student_credit_entries(id);
create unique index office_credit_receipt_reversal_once_idx on app_private.office_student_credit_entries(related_entry_id) where kind='receipt_reversal';
create unique index office_credit_cash_proof_once_idx on app_private.office_student_credit_entries(school_id,kind,lower(btrim(reference))) where kind in ('receipt','refund');
create index office_credit_entries_student_idx on app_private.office_student_credit_entries(school_id,student_id,occurred_at desc,id);
create index office_credit_entries_fee_idx on app_private.office_student_credit_entries(fee_id) where fee_id is not null;
create index office_credit_entries_related_idx on app_private.office_student_credit_entries(related_entry_id) where related_entry_id is not null;
create index office_credit_entries_day_idx on app_private.office_student_credit_entries(school_id,business_date) where business_date is not null;

alter table app_private.office_student_credit_accounts enable row level security;
alter table app_private.office_credit_change_requests enable row level security;
alter table app_private.office_student_credit_entries enable row level security;
revoke all on app_private.office_student_credit_accounts,app_private.office_credit_change_requests,app_private.office_student_credit_entries
  from public,anon,authenticated,service_role;
create trigger immutable_office_student_credit_entries before update or delete on app_private.office_student_credit_entries
  for each row execute function app_private.guard_immutable_fee_counterentry();

create function app_private.lock_office_credit_actor(p_school_id uuid,p_reviewer boolean)
returns text language plpgsql volatile set search_path=''
as $$
declare actor_name text;
begin
  if (p_reviewer and not app_private.can_review_office_fee_changes(p_school_id))
    or (not p_reviewer and not app_private.can_manage_office_fees(p_school_id)) then
    raise exception 'You cannot perform this credit operation for the school.' using errcode='42501';
  end if;
  select p.full_name into actor_name from public.profiles p where p.id=auth.uid() and p.is_active for share;
  if not found then raise exception 'Your active school account could not be verified.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=auth.uid() and
    ((ur.school_id=p_school_id and ((p_reviewer and ur.role in ('school_admin','principal')) or (not p_reviewer and ur.role in ('school_admin','principal','accountant'))))
      or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Your school credit permission changed.' using errcode='42501'; end if;
  return coalesce(actor_name,'Office user');
end;
$$;
create function app_private.lock_office_student_credit(p_school_id uuid,p_student_id uuid)
returns void language plpgsql volatile set search_path=''
as $$
begin
  -- A shared pupil lock is compatible with payment INSERT foreign-key locks.
  -- The PRIVATE account row, never public.students FOR UPDATE, is the mutex.
  perform 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id for share;
  if not found then raise exception 'Pupil not found in this school.' using errcode='42501'; end if;
  insert into app_private.office_student_credit_accounts(school_id,student_id) values(p_school_id,p_student_id) on conflict do nothing;
  perform 1 from app_private.office_student_credit_accounts where school_id=p_school_id and student_id=p_student_id for update;
end;
$$;

create function app_private.valid_office_credit_entry(p_id uuid)
returns boolean language sql stable set search_path=''
as $$
  select exists(select 1 from app_private.office_student_credit_entries e
    join public.students s on s.id=e.student_id and s.school_id=e.school_id
    left join app_private.office_student_credit_entries related on related.id=e.related_entry_id
    left join app_private.office_credit_change_requests q on q.id=e.credit_request_id
    where e.id=p_id and e.amount>0 and e.amount<>'NaN'::numeric
    and (e.fee_id is null or exists(select 1 from public.student_fees fee
      join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=fee.school_id
      join public.academic_years year on year.id=structure.academic_year_id and year.school_id=fee.school_id
      where fee.id=e.fee_id and fee.school_id=e.school_id and fee.student_id=e.student_id)) and
    (e.kind='receipt'
      or (e.kind='allocation' and exists(select 1 from public.student_fees fee
        join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=fee.school_id
        join public.academic_years y on y.id=structure.academic_year_id and y.school_id=fee.school_id
        where fee.id=e.fee_id and fee.school_id=e.school_id and fee.student_id=e.student_id))
      or (e.kind='allocation_return' and related.kind='allocation' and related.school_id=e.school_id and related.student_id=e.student_id
        and related.fee_id=e.fee_id and q.entry_target_id=e.related_entry_id and q.fee_id=e.fee_id and q.kind='allocation_return' and q.state='approved' and q.entry_id=e.id and q.amount=e.amount)
      or (e.kind='receipt_reversal' and related.kind='receipt' and related.school_id=e.school_id and related.student_id=e.student_id
        and related.amount=e.amount and related.payment_method=e.payment_method and q.entry_target_id=e.related_entry_id and q.kind='receipt_reversal' and q.state='approved'
        and q.entry_id=e.id and q.amount=e.amount)
      or (e.kind='refund' and q.kind='refund' and q.state='paid' and q.entry_id=e.id and q.amount=e.amount))
      and (e.credit_request_id is null or (q.school_id=e.school_id and q.student_id=e.student_id and q.requested_by<>q.reviewed_by)));
$$;

create function app_private.office_student_credit_state(p_school_id uuid,p_student_id uuid)
returns jsonb language plpgsql stable set search_path=''
as $$
declare received numeric; reversed numeric; allocated numeric; refunded numeric; reserved numeric; balance numeric; available numeric;
  invalid boolean; revision bigint; summary jsonb; snapshot jsonb;
begin
  select coalesce(sum(e.amount) filter(where e.kind='receipt'),0),coalesce(sum(e.amount) filter(where e.kind='receipt_reversal'),0),
    coalesce(sum(case when e.kind='allocation' then e.amount when e.kind='allocation_return' then -e.amount else 0 end),0),
    coalesce(sum(e.amount) filter(where e.kind='refund'),0),coalesce(bool_or(not app_private.valid_office_credit_entry(e.id)),false)
    into received,reversed,allocated,refunded,invalid from app_private.office_student_credit_entries e where e.school_id=p_school_id and e.student_id=p_student_id;
  select coalesce(sum(q.amount),0) into reserved from app_private.office_credit_change_requests q
    where q.school_id=p_school_id and q.student_id=p_student_id and q.kind='refund' and q.state='approved';
  balance:=received-reversed-allocated-refunded; available:=balance-reserved;
  invalid:=invalid or allocated<0 or balance<0 or available<0 or exists(
    select 1 from app_private.office_student_credit_entries a where a.school_id=p_school_id and a.student_id=p_student_id and a.kind='allocation'
      and a.amount<(select coalesce(sum(r.amount),0) from app_private.office_student_credit_entries r where r.kind='allocation_return' and r.related_entry_id=a.id));
  select a.revision into revision from app_private.office_student_credit_accounts a where a.school_id=p_school_id and a.student_id=p_student_id;
  summary:=jsonb_build_object('received_amount',case when not invalid then received::text end,'reversed_amount',case when not invalid then reversed::text end,
    'allocated_amount',case when not invalid then allocated::text end,'refunded_amount',case when not invalid then refunded::text end,
    'reserved_amount',case when not invalid then reserved::text end,'balance_amount',case when not invalid then balance::text end,
    'available_amount',case when not invalid then available::text end,'invalid',invalid);
  snapshot:=jsonb_build_object('school_id',p_school_id,'student_id',p_student_id,'revision',coalesce(revision,0),'summary',summary,
    'entries',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from app_private.office_student_credit_entries e where e.school_id=p_school_id and e.student_id=p_student_id),
    'refunds',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'amount',q.amount,'state',q.state,'entry_id',q.entry_id,'cancelled_at',q.cancelled_at) order by q.id),'[]'::jsonb)
      from app_private.office_credit_change_requests q where q.school_id=p_school_id and q.student_id=p_student_id and q.kind='refund' and q.state in ('approved','paid','cancelled')));
  return jsonb_build_object('summary',summary,'financial_token',case when not invalid then encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') end);
end;
$$;
create function app_private.locked_office_student_credit_state(p_school_id uuid,p_student_id uuid)
returns jsonb language plpgsql volatile set search_path=''
as $$ declare current_state jsonb; begin select app_private.office_student_credit_state(p_school_id,p_student_id) into current_state; return current_state; end; $$;

create function app_private.office_credit_activity(p_id uuid,p_context boolean default false)
returns jsonb language sql stable set search_path=''
as $$
  select jsonb_build_object('id',e.id,'kind',e.kind,'amount',e.amount::text,'reference',e.reference,'occurred_at',e.occurred_at,
    'payment_method',e.payment_method,'fee_id',e.fee_id,'fee_name',structure.name,'related_reference',related.reference)
    ||case when p_context then jsonb_build_object('school_id',e.school_id,'student_id',e.student_id) else '{}'::jsonb end
  from app_private.office_student_credit_entries e
    left join public.student_fees fee on fee.id=e.fee_id and fee.school_id=e.school_id and fee.student_id=e.student_id
    left join public.fee_structures structure on structure.id=fee.fee_structure_id and structure.school_id=e.school_id
    left join app_private.office_student_credit_entries related on related.id=e.related_entry_id and related.school_id=e.school_id and related.student_id=e.student_id
  where e.id=p_id;
$$;
create function app_private.office_student_credit_result(p_school_id uuid,p_student_id uuid,p_limit integer,p_offset integer,p_family boolean)
returns jsonb language sql stable set search_path=''
as $$
  select jsonb_build_object('school_id',s.school_id,'student_id',s.id,'admission_no',s.admission_no,
    'student_name',concat_ws(' ',s.first_name,s.middle_name,s.last_name),'summary',state.value->'summary',
    'activities',coalesce((select jsonb_agg(app_private.office_credit_activity(e.id,false) order by e.occurred_at desc,e.id)
      from(select id,occurred_at from app_private.office_student_credit_entries where school_id=p_school_id and student_id=p_student_id and (not p_family or app_private.valid_office_credit_entry(id))
        order by occurred_at desc,id limit p_limit offset p_offset)e),'[]'::jsonb),
    'activity_count',(select count(*) from app_private.office_student_credit_entries where school_id=p_school_id and student_id=p_student_id and (not p_family or app_private.valid_office_credit_entry(id))),
    'limit',p_limit,'offset',p_offset)
    ||case when p_family then '{}'::jsonb else jsonb_build_object('financial_token',state.value->'financial_token') end
  from public.students s cross join lateral(select app_private.office_student_credit_state(p_school_id,p_student_id) as value)state
  where s.id=p_student_id and s.school_id=p_school_id;
$$;

create function app_private.get_office_student_credit(p_school_id uuid,p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not app_private.can_manage_office_fees(p_school_id) or not exists(select 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id) then
    raise exception 'You cannot read this pupil''s school credit account.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid credit history page.' using errcode='22023'; end if;
  return app_private.office_student_credit_result(p_school_id,p_student_id,p_limit,p_offset,false);
end;
$$;
create function app_private.get_family_student_credit(p_student_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$ declare school_id uuid;
begin
  if not app_private.can_read_family_fee_student(p_student_id) then raise exception 'You cannot read this pupil''s credit account.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid credit history page.' using errcode='22023'; end if;
  select s.school_id into school_id from public.students s where s.id=p_student_id;
  return app_private.office_student_credit_result(school_id,p_student_id,p_limit,p_offset,true);
end;
$$;

create function app_private.guard_office_credit_cash_day()
returns trigger language plpgsql security definer set search_path=''
as $$ declare event_time timestamptz;
begin
  if new.kind not in ('receipt','refund','receipt_reversal') then return new; end if;
  if not app_private.can_manage_office_fees(new.school_id) or new.actor_id is distinct from auth.uid() then
    raise exception 'An authorized finance account must record this cash event.' using errcode='42501'; end if;
  new.occurred_at:=clock_timestamp(); new.business_date:=(new.occurred_at at time zone 'Asia/Kolkata')::date;
  insert into app_private.office_fee_days(school_id,business_date) values(new.school_id,new.business_date) on conflict do nothing;
  update app_private.office_fee_days set revision=revision+1 where school_id=new.school_id and business_date=new.business_date and closed_at is null;
  if not found then raise exception 'Today is closed for cashbook entries. The credit or refund remains unchanged.' using errcode='22023'; end if;
  event_time:=clock_timestamp();
  if (event_time at time zone 'Asia/Kolkata')::date<>new.business_date then raise exception 'The business day changed while waiting. Refresh before recording this cash event.' using errcode='22023'; end if;
  new.occurred_at:=event_time;
  return new;
end;
$$;
create trigger guard_office_credit_cash_day before insert on app_private.office_student_credit_entries
  for each row execute function app_private.guard_office_credit_cash_day();

create function app_private.record_office_credit_receipt(p_school_id uuid,p_student_id uuid,p_amount numeric,p_payment_method text,p_reference text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_name text; method text:=lower(btrim(p_payment_method)); proof text:=btrim(p_reference); reason_text text:=btrim(p_reason);
  intent jsonb; prior app_private.office_student_credit_entries%rowtype; current_state jsonb;
begin
  actor_name:=app_private.lock_office_credit_actor(p_school_id,false);
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount='NaN'::numeric or p_amount>9999999999.99 or p_amount<>trunc(p_amount,2)
    or method is null or method not in ('cash','upi','bank_transfer','card','cheque') or coalesce(length(proof),0) not between 3 and 120
    or proof ~ '[[:cntrl:]]' or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Enter a positive two-decimal advance, supported method, unique proof reference and reason.' using errcode='22023'; end if;
  intent:=jsonb_build_object('kind','receipt','school_id',p_school_id,'student_id',p_student_id,'amount',p_amount,'method',method,'reference',proof,'reason',reason_text,'actor_id',auth.uid());
  perform pg_advisory_xact_lock(hashtextextended('office-credit-entry:'||p_request_id::text,0));
  select * into prior from app_private.office_student_credit_entries where id=p_request_id;
  if found then
    if prior.intent is distinct from intent then raise exception 'This operation already records a different credit entry.' using errcode='23505'; end if;
    return app_private.office_credit_activity(prior.id,true);
  end if;
  perform app_private.lock_office_student_credit(p_school_id,p_student_id);
  current_state:=app_private.locked_office_student_credit_state(p_school_id,p_student_id);
  if (current_state->'summary'->>'invalid')::boolean then raise exception 'Reconcile this credit account before recording another receipt.' using errcode='22023'; end if;
  insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,payment_method,actor_id,actor_name,reason,intent,business_date)
    values(p_request_id,p_school_id,p_student_id,'receipt',p_amount,proof,method,auth.uid(),actor_name,reason_text,intent,(clock_timestamp() at time zone 'Asia/Kolkata')::date);
  update app_private.office_student_credit_accounts set revision=revision+1 where school_id=p_school_id and student_id=p_student_id;
  return app_private.office_credit_activity(p_request_id,true);
end;
$$;

create function app_private.allocate_office_credit(p_school_id uuid,p_student_id uuid,p_fee_id uuid,p_amount numeric,p_expected_credit_token text,p_expected_fee_token text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_name text; reason_text text:=btrim(p_reason); intent jsonb; prior app_private.office_student_credit_entries%rowtype;
  current_state jsonb; fee_state jsonb;
begin
  actor_name:=app_private.lock_office_credit_actor(p_school_id,false);
  if p_request_id is null or p_fee_id is null or p_amount is null or p_amount<=0 or p_amount='NaN'::numeric or p_amount>9999999999.99 or p_amount<>trunc(p_amount,2)
    or coalesce(p_expected_credit_token,'') !~ '^[0-9a-f]{64}$' or coalesce(p_expected_fee_token,'') !~ '^[0-9a-f]{64}$'
    or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then raise exception 'Refresh both balances and enter a valid allocation and reason.' using errcode='22023'; end if;
  intent:=jsonb_build_object('kind','allocation','school_id',p_school_id,'student_id',p_student_id,'fee_id',p_fee_id,'amount',p_amount,
    'credit_token',p_expected_credit_token,'fee_token',p_expected_fee_token,'reason',reason_text,'actor_id',auth.uid());
  perform pg_advisory_xact_lock(hashtextextended('office-credit-entry:'||p_request_id::text,0));
  select * into prior from app_private.office_student_credit_entries where id=p_request_id;
  if found then
    if prior.intent is distinct from intent then raise exception 'This operation already records a different credit entry.' using errcode='23505'; end if;
    return app_private.office_credit_activity(prior.id,true);
  end if;
  perform 1 from public.student_fees fee where fee.id=p_fee_id and fee.school_id=p_school_id and fee.student_id=p_student_id for update;
  if not found then raise exception 'The fee is not this pupil''s school demand.' using errcode='42501'; end if;
  perform app_private.lock_office_student_credit(p_school_id,p_student_id);
  current_state:=app_private.locked_office_student_credit_state(p_school_id,p_student_id);
  fee_state:=app_private.locked_office_fee_financial_state(p_school_id,p_fee_id);
  if current_state->>'financial_token' is distinct from p_expected_credit_token or fee_state->>'financial_token' is distinct from p_expected_fee_token then
    raise exception 'The credit or fee balance changed. Refresh both before allocating.' using errcode='PT409'; end if;
  if (current_state->'summary'->>'invalid')::boolean or not coalesce((fee_state->>'valid')::boolean,false)
    or p_amount>(current_state->'summary'->>'available_amount')::numeric or p_amount>(fee_state->'amounts'->>'balance')::numeric then
    raise exception 'Allocate no more than the available unreserved credit and this fee''s outstanding balance.' using errcode='22023'; end if;
  insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,fee_id,actor_id,actor_name,reason,intent)
    values(p_request_id,p_school_id,p_student_id,'allocation',p_amount,'ALLOC-'||upper(replace(p_request_id::text,'-','')),p_fee_id,auth.uid(),actor_name,reason_text,intent);
  update app_private.office_student_credit_accounts set revision=revision+1 where school_id=p_school_id and student_id=p_student_id;
  return app_private.office_credit_activity(p_request_id,true);
end;
$$;

create function app_private.office_credit_change_result(p_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  select jsonb_build_object('id',q.id,'school_id',q.school_id,'student_id',q.student_id,'admission_no',s.admission_no,
    'student_name',concat_ws(' ',s.first_name,s.middle_name,s.last_name),'kind',q.kind,'amount',q.amount::text,
    'entry_target_id',q.entry_target_id,'target_reference',target.reference,'fee_id',q.fee_id,
    'request_reason',q.request_reason,'requested_by',q.requested_by,'requester_name',q.requester_name,'requested_at',q.requested_at,
    'state',q.state,'financial_token',q.financial_token,'fee_token',q.fee_token,'reviewed_by',q.reviewed_by,'reviewer_name',q.reviewer_name,
    'review_reason',q.review_reason,'reviewed_at',q.reviewed_at,'entry_id',q.entry_id,'reference',q.reference,'effective_day',q.effective_day,
    'cancelled_by',q.cancelled_by,'canceller_name',q.canceller_name,'cancel_reason',q.cancel_reason,'cancelled_at',q.cancelled_at)
  from app_private.office_credit_change_requests q join public.students s on s.id=q.student_id and s.school_id=q.school_id
    left join app_private.office_student_credit_entries target on target.id=q.entry_target_id and target.school_id=q.school_id and target.student_id=q.student_id
  where q.id=p_id;
$$;

create function app_private.request_office_credit_change(p_school_id uuid,p_student_id uuid,p_kind text,p_entry_id uuid,p_amount numeric,p_expected_credit_token text,p_expected_fee_token text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_name text; reason_text text:=btrim(p_reason); intent jsonb; prior app_private.office_credit_change_requests%rowtype;
  target app_private.office_student_credit_entries%rowtype; credit jsonb; fee jsonb; amount_value numeric; remaining numeric;
begin
  actor_name:=app_private.lock_office_credit_actor(p_school_id,false);
  if p_request_id is null or p_kind is null or p_kind not in ('refund','allocation_return','receipt_reversal')
    or coalesce(p_expected_credit_token,'') !~ '^[0-9a-f]{64}$' or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]'
    or (p_kind='receipt_reversal' and p_amount is not null)
    or (p_kind<>'receipt_reversal' and (p_amount is null or p_amount<=0 or p_amount='NaN'::numeric or p_amount>9999999999.99 or p_amount<>trunc(p_amount,2)))
    or (p_kind='refund' and (p_entry_id is not null or p_expected_fee_token is not null))
    or (p_kind='allocation_return' and (p_entry_id is null or coalesce(p_expected_fee_token,'') !~ '^[0-9a-f]{64}$'))
    or (p_kind='receipt_reversal' and (p_entry_id is null or p_expected_fee_token is not null)) then
    raise exception 'Choose a supported credit request, refresh its balances and enter a valid amount and reason.' using errcode='22023'; end if;
  intent:=jsonb_build_object('school_id',p_school_id,'student_id',p_student_id,'kind',p_kind,'entry_id',p_entry_id,'amount',p_amount,
    'credit_token',p_expected_credit_token,'fee_token',p_expected_fee_token,'reason',reason_text,'actor_id',auth.uid());
  perform pg_advisory_xact_lock(hashtextextended('office-credit-change:'||p_request_id::text,0));
  select * into prior from app_private.office_credit_change_requests where id=p_request_id;
  if found then
    if prior.request_payload is distinct from intent then raise exception 'This identifier already records a different credit request.' using errcode='23505'; end if;
    return app_private.office_credit_change_result(prior.id);
  end if;
  if p_kind<>'refund' then
    select * into target from app_private.office_student_credit_entries where id=p_entry_id and school_id=p_school_id and student_id=p_student_id
      and ((p_kind='allocation_return' and kind='allocation') or (p_kind='receipt_reversal' and kind='receipt'));
    if not found then raise exception 'The target credit entry does not belong to this pupil and operation.' using errcode='42501'; end if;
  end if;
  if p_kind='allocation_return' then
    perform 1 from public.student_fees f where f.id=target.fee_id and f.school_id=p_school_id and f.student_id=p_student_id for update;
    if not found then raise exception 'The allocated fee no longer has a coherent pupil scope.' using errcode='42501'; end if;
  end if;
  perform app_private.lock_office_student_credit(p_school_id,p_student_id);
  credit:=app_private.locked_office_student_credit_state(p_school_id,p_student_id);
  if credit->>'financial_token' is distinct from p_expected_credit_token then raise exception 'The credit account changed. Refresh it before requesting a change.' using errcode='PT409'; end if;
  if (credit->'summary'->>'invalid')::boolean then raise exception 'Reconcile the credit account before requesting a change.' using errcode='22023'; end if;
  amount_value:=case when p_kind='receipt_reversal' then target.amount else p_amount end;
  if p_kind='allocation_return' then
    fee:=app_private.locked_office_fee_financial_state(p_school_id,target.fee_id);
    if fee->>'financial_token' is distinct from p_expected_fee_token then raise exception 'The allocated fee changed. Refresh it before requesting a return.' using errcode='PT409'; end if;
    select target.amount-coalesce(sum(e.amount),0) into remaining from app_private.office_student_credit_entries e where e.kind='allocation_return' and e.related_entry_id=target.id;
    if not coalesce((fee->>'valid')::boolean,false) or amount_value>remaining or amount_value>(fee->'amounts'->>'paid_amount')::numeric then
      raise exception 'Return no more than the remaining original allocation.' using errcode='22023'; end if;
  else
    if amount_value>(credit->'summary'->>'available_amount')::numeric then raise exception 'The amount exceeds available unreserved credit.' using errcode='22023'; end if;
    if p_kind='receipt_reversal' and exists(select 1 from app_private.office_student_credit_entries e where e.kind='receipt_reversal' and e.related_entry_id=target.id) then
      raise exception 'This advance receipt already has a full recorded reversal.' using errcode='22023'; end if;
  end if;
  insert into app_private.office_credit_change_requests(id,school_id,student_id,kind,amount,entry_target_id,fee_id,request_payload,
    request_reason,requested_by,requester_name,financial_token,fee_token)
    values(p_request_id,p_school_id,p_student_id,p_kind,amount_value,p_entry_id,case when p_kind='allocation_return' then target.fee_id end,
      intent,reason_text,auth.uid(),actor_name,p_expected_credit_token,p_expected_fee_token);
  return app_private.office_credit_change_result(p_request_id);
end;
$$;

create function app_private.review_office_credit_change(p_request_id uuid,p_decision text,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare q app_private.office_credit_change_requests%rowtype; target app_private.office_student_credit_entries%rowtype;
  actor_name text; reason_text text:=btrim(p_reason); credit jsonb; fee jsonb; remaining numeric;
  new_id uuid:=gen_random_uuid(); new_reference text; review_time timestamptz; posted_day date;
begin
  select * into q from app_private.office_credit_change_requests where id=p_request_id;
  if not found then raise exception 'Credit request not found for review.' using errcode='42501'; end if;
  actor_name:=app_private.lock_office_credit_actor(q.school_id,true);
  if q.requested_by=auth.uid() then raise exception 'A different administrator or principal must review your credit request.' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Choose a review decision and a reason of 5 to 500 printable characters.' using errcode='22023'; end if;
  if q.kind='allocation_return' then perform 1 from public.student_fees f where f.id=q.fee_id and f.school_id=q.school_id and f.student_id=q.student_id for update; end if;
  perform app_private.lock_office_student_credit(q.school_id,q.student_id);
  select * into q from app_private.office_credit_change_requests where id=p_request_id for update;
  if q.state<>'pending' then
    if q.reviewed_by=auth.uid() and q.review_reason=reason_text and
      ((p_decision='approved' and q.state in ('approved','paid','cancelled')) or q.state=p_decision) then return app_private.office_credit_change_result(q.id); end if;
    raise exception 'This credit request already has a different review.' using errcode='23505';
  end if;
  review_time:=clock_timestamp();
  if p_decision='rejected' then
    update app_private.office_credit_change_requests set state='rejected',reviewed_by=auth.uid(),reviewer_name=actor_name,review_reason=reason_text,reviewed_at=review_time where id=q.id;
    return app_private.office_credit_change_result(q.id);
  end if;
  credit:=app_private.locked_office_student_credit_state(q.school_id,q.student_id);
  if credit->>'financial_token' is distinct from q.financial_token then raise exception 'The credit account changed after this request. Reject it and request a new change from refreshed records.' using errcode='PT409'; end if;
  if (credit->'summary'->>'invalid')::boolean then raise exception 'Reconcile the credit account before approving changes.' using errcode='22023'; end if;
  if q.kind='allocation_return' then
    fee:=app_private.locked_office_fee_financial_state(q.school_id,q.fee_id);
    if fee->>'financial_token' is distinct from q.fee_token then raise exception 'The allocated fee changed. Reject this request and create a refreshed one.' using errcode='PT409'; end if;
    select target_row.* into target from app_private.office_student_credit_entries target_row where target_row.id=q.entry_target_id;
    select target.amount-coalesce(sum(e.amount),0) into remaining from app_private.office_student_credit_entries e where e.kind='allocation_return' and e.related_entry_id=target.id;
    if not coalesce((fee->>'valid')::boolean,false) or q.amount>remaining or q.amount>(fee->'amounts'->>'paid_amount')::numeric then
      raise exception 'The remaining allocation cannot cover this return.' using errcode='22023'; end if;
    new_reference:='RETURN-'||upper(replace(new_id::text,'-',''));
  else
    if q.amount>(credit->'summary'->>'available_amount')::numeric then raise exception 'The requested amount is no longer available as unreserved credit.' using errcode='22023'; end if;
    if q.kind='receipt_reversal' then
      select * into target from app_private.office_student_credit_entries where id=q.entry_target_id and kind='receipt' and school_id=q.school_id and student_id=q.student_id;
      if not found or target.amount<>q.amount or exists(select 1 from app_private.office_student_credit_entries e where e.kind='receipt_reversal' and e.related_entry_id=target.id) then
        raise exception 'The original advance receipt cannot be fully reversed again.' using errcode='22023'; end if;
      new_reference:='ADV-REV-'||upper(replace(new_id::text,'-','')); posted_day:=(review_time at time zone 'Asia/Kolkata')::date;
    end if;
  end if;
  update app_private.office_credit_change_requests set state='approved',reviewed_by=auth.uid(),reviewer_name=actor_name,review_reason=reason_text,reviewed_at=review_time,
    entry_id=case when q.kind<>'refund' then new_id end,reference=new_reference,effective_day=posted_day where id=q.id;
  if q.kind<>'refund' then
    insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,payment_method,fee_id,related_entry_id,credit_request_id,
      actor_id,actor_name,reason,intent,occurred_at,business_date)
      values(new_id,q.school_id,q.student_id,q.kind,q.amount,new_reference,case when q.kind='receipt_reversal' then target.payment_method end,q.fee_id,q.entry_target_id,q.id,
        auth.uid(),actor_name,reason_text,jsonb_build_object('credit_request_id',q.id,'decision','approved'),review_time,posted_day)
      returning business_date,occurred_at into posted_day,review_time;
    update app_private.office_credit_change_requests set effective_day=posted_day,reviewed_at=review_time where id=q.id;
  end if;
  update app_private.office_student_credit_accounts set revision=revision+1 where school_id=q.school_id and student_id=q.student_id;
  return app_private.office_credit_change_result(q.id);
end;
$$;

create function app_private.pay_office_credit_refund(p_request_id uuid,p_payment_method text,p_reference text,p_reason text,p_payout_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare q app_private.office_credit_change_requests%rowtype; prior app_private.office_student_credit_entries%rowtype; actor_name text;
  method text:=lower(btrim(p_payment_method)); proof text:=btrim(p_reference); reason_text text:=btrim(p_reason); intent jsonb; credit jsonb; posted_day date;
begin
  select * into q from app_private.office_credit_change_requests where id=p_request_id;
  if not found then raise exception 'Refund request not found.' using errcode='42501'; end if;
  actor_name:=app_private.lock_office_credit_actor(q.school_id,false);
  if p_payout_id is null or method is null or method not in ('cash','upi','bank_transfer','card','cheque')
    or coalesce(length(proof),0) not between 3 and 120 or proof ~ '[[:cntrl:]]' or coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Confirm the actual offline payout with its method, unique proof reference and reason.' using errcode='22023'; end if;
  -- Calling this office-only endpoint attests an already completed manual
  -- payout. It NEVER sends funds or claims a provider response/webhook.
  intent:=jsonb_build_object('kind','refund','request_id',q.id,'school_id',q.school_id,'student_id',q.student_id,'amount',q.amount,
    'method',method,'reference',proof,'reason',reason_text,'actor_id',auth.uid(),'confirmed_manual_payout',true);
  perform pg_advisory_xact_lock(hashtextextended('office-credit-entry:'||p_payout_id::text,0));
  select * into prior from app_private.office_student_credit_entries where id=p_payout_id;
  if found then
    if prior.intent is distinct from intent or prior.kind<>'refund' or prior.credit_request_id<>q.id then raise exception 'This payout identifier already records a different cash event.' using errcode='23505'; end if;
    return app_private.office_credit_change_result(q.id);
  end if;
  perform app_private.lock_office_student_credit(q.school_id,q.student_id);
  select * into q from app_private.office_credit_change_requests where id=p_request_id for update;
  if q.kind<>'refund' or q.state<>'approved' then raise exception 'Only an approved, reserved and unpaid refund can record a payout.' using errcode='22023'; end if;
  credit:=app_private.locked_office_student_credit_state(q.school_id,q.student_id);
  if (credit->'summary'->>'invalid')::boolean or (credit->'summary'->>'reserved_amount')::numeric<q.amount then
    raise exception 'Reconcile the approved credit reservation before recording its payout.' using errcode='22023'; end if;
  posted_day:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
  -- Release this reservation and add the equal paid refund atomically. A cash
  -- guard failure rolls BOTH changes back, retaining approved/reserved status.
  update app_private.office_credit_change_requests set state='paid',entry_id=p_payout_id,reference=proof,effective_day=posted_day where id=q.id;
  insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,payment_method,credit_request_id,
    actor_id,actor_name,reason,intent,business_date)
    values(p_payout_id,q.school_id,q.student_id,'refund',q.amount,proof,method,q.id,auth.uid(),actor_name,reason_text,intent,posted_day)
    returning business_date into posted_day;
  update app_private.office_credit_change_requests set effective_day=posted_day where id=q.id;
  update app_private.office_student_credit_accounts set revision=revision+1 where school_id=q.school_id and student_id=q.student_id;
  return app_private.office_credit_change_result(q.id);
end;
$$;

create function app_private.cancel_office_credit_refund(p_request_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare q app_private.office_credit_change_requests%rowtype; actor_name text; reason_text text:=btrim(p_reason);
begin
  select * into q from app_private.office_credit_change_requests where id=p_request_id;
  if not found then raise exception 'Refund request not found.' using errcode='42501'; end if;
  actor_name:=app_private.lock_office_credit_actor(q.school_id,true);
  if coalesce(length(reason_text),0) not between 5 and 500 or reason_text ~ '[[:cntrl:]]' then raise exception 'Enter a cancellation reason of 5 to 500 printable characters.' using errcode='22023'; end if;
  perform app_private.lock_office_student_credit(q.school_id,q.student_id);
  select * into q from app_private.office_credit_change_requests where id=p_request_id for update;
  if q.state='cancelled' then
    if q.cancelled_by=auth.uid() and q.cancel_reason=reason_text then return app_private.office_credit_change_result(q.id); end if;
    raise exception 'This reservation already has a different cancellation.' using errcode='23505';
  end if;
  if q.kind<>'refund' or q.state<>'approved' then raise exception 'Only an approved unpaid refund reservation can be cancelled.' using errcode='22023'; end if;
  update app_private.office_credit_change_requests set state='cancelled',cancelled_by=auth.uid(),canceller_name=actor_name,cancel_reason=reason_text,cancelled_at=clock_timestamp() where id=q.id;
  update app_private.office_student_credit_accounts set revision=revision+1 where school_id=q.school_id and student_id=q.student_id;
  return app_private.office_credit_change_result(q.id);
end;
$$;

create function app_private.list_office_credit_changes(p_school_id uuid,p_student_id uuid,p_state text,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $$ declare result jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot view this school''s credit requests.' using errcode='42501'; end if;
  if p_student_id is not null and not exists(select 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id) then raise exception 'Pupil filter is outside this school.' using errcode='42501'; end if;
  if p_state is null or p_state not in ('all','pending','approved','rejected','cancelled','paid') or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid credit-request page.' using errcode='22023'; end if;
  select jsonb_build_object('rows',coalesce((select jsonb_agg(app_private.office_credit_change_result(q.id) order by q.requested_at desc,q.id)
    from(select id,requested_at from app_private.office_credit_change_requests where school_id=p_school_id and (p_student_id is null or student_id=p_student_id) and (p_state='all' or state=p_state)
      order by requested_at desc,id limit p_limit offset p_offset)q),'[]'::jsonb),
    'total_count',(select count(*) from app_private.office_credit_change_requests where school_id=p_school_id and (p_student_id is null or student_id=p_student_id) and (p_state='all' or state=p_state))) into result;
  return result;
end;
$$;

-- Allocations settle fee debt without creating fee_payments or cash events.
create or replace function app_private.office_fee_positions(p_school_id uuid,p_fee_id uuid default null,p_student_id uuid default null)
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
$$;

-- Keep pre-credit fingerprints identical for fees without credit history.
create or replace function app_private.office_fee_financial_state(p_school_id uuid,p_fee_id uuid)
returns jsonb language plpgsql stable set search_path=''
as $$
declare position record; snapshot jsonb; amounts jsonb; base_amounts jsonb; advance_entries jsonb;
begin
  select * into position from app_private.office_fee_positions(p_school_id,p_fee_id);
  if not found then return null; end if;
  amounts:=jsonb_build_object('base_net_amount',position.base_net_amount::text,'adjustment_amount',position.adjustment_amount::text,
    'net_amount',position.net_amount::text,'gross_paid_amount',position.gross_paid_amount::text,'reversed_amount',position.reversed_amount::text,
    'paid_amount',position.paid_amount::text,'balance',position.balance::text);
  base_amounts:=amounts;
  amounts:=amounts||jsonb_build_object('advance_applied_amount',(position.paid_amount-position.gross_paid_amount+position.reversed_amount)::text);
  snapshot:=jsonb_build_object('fee',(select to_jsonb(sf) from public.student_fees sf where sf.id=p_fee_id),
    'amounts',base_amounts,'invalid',position.invalid,
    'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.fee_payments p where p.student_fee_id=p_fee_id),
    'adjustments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from app_private.office_fee_adjustment_entries a where a.fee_id=p_fee_id),
    'reversals',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from app_private.office_fee_payment_reversals r where r.fee_id=p_fee_id),
    'legacy_refunds',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.fee_refunds r
      join public.fee_payments p on p.id=r.payment_id where p.student_fee_id=p_fee_id));
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) into advance_entries from app_private.office_student_credit_entries e
    where e.fee_id=p_fee_id and e.kind in ('allocation','allocation_return');
  if jsonb_array_length(advance_entries)>0 then snapshot:=snapshot||jsonb_build_object('advance_entries',advance_entries); end if;
  return jsonb_build_object('valid',not position.invalid,'position',to_jsonb(position),'amounts',amounts,
    'financial_token',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
end;
$$;

create or replace function app_private.office_fee_ledger_result(
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
    'advance_applied_amount',case when not invalid then (paid_amount-gross_paid_amount+reversed_amount)::text end,
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
      'advance_applied_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_amount-gross_paid_amount+reversed_amount),0)::text end,
      'paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_amount),0)::text end,
      'balance',case when count(*) filter(where invalid)=0 then coalesce(sum(balance),0)::text end,
      'opening_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net_amount) filter(where kind='opening'),0)::text end)) from source;
$$;

create function app_private.office_school_credit_summary(p_school_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  with scope as(select student_id from app_private.office_student_credit_accounts where school_id=p_school_id
    union select student_id from app_private.office_student_credit_entries where school_id=p_school_id
    union select student_id from app_private.office_credit_change_requests where school_id=p_school_id),
  accounts as(select app_private.office_student_credit_state(p_school_id,a.student_id)->'summary' as summary from scope a),
  totals as(select count(*) filter(where (summary->>'invalid')::boolean) as invalid_count,
    coalesce(sum((summary->>'received_amount')::numeric),0) as received,coalesce(sum((summary->>'reversed_amount')::numeric),0) as reversed,
    coalesce(sum((summary->>'allocated_amount')::numeric),0) as allocated,coalesce(sum((summary->>'refunded_amount')::numeric),0) as refunded,
    coalesce(sum((summary->>'reserved_amount')::numeric),0) as reserved,coalesce(sum((summary->>'balance_amount')::numeric),0) as balance,
    coalesce(sum((summary->>'available_amount')::numeric),0) as available from accounts)
  select jsonb_build_object('invalid',invalid_count>0,'invalid_count',invalid_count,
    'received_amount',case when invalid_count=0 then received::text end,'reversed_amount',case when invalid_count=0 then reversed::text end,
    'allocated_amount',case when invalid_count=0 then allocated::text end,'refunded_amount',case when invalid_count=0 then refunded::text end,
    'reserved_amount',case when invalid_count=0 then reserved::text end,'balance_amount',case when invalid_count=0 then balance::text end,
    'available_amount',case when invalid_count=0 then available::text end) from totals;
$$;

create or replace function app_private.office_fee_collection_totals(p_school_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  with boundaries as(select (statement_timestamp() at time zone 'Asia/Kolkata')::date as today),
  events as(select p.amount as gross,0::numeric as reversed,0::numeric as refunded,p.paid_at as posted_at,
    not app_private.coherent_office_fee_payment(p.id) or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id) as invalid
    from public.fee_payments p where p.school_id=p_school_id and p.status='paid'
    union all select 0,r.amount,0,r.approved_at,not app_private.coherent_office_fee_payment(r.payment_id)
      or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=r.payment_id)
      or not exists(select 1 from public.fee_payments p where p.id=r.payment_id and p.school_id=r.school_id and p.student_fee_id=r.fee_id and p.student_id=r.student_id and p.status='paid' and p.amount=r.amount)
      from app_private.office_fee_payment_reversals r where r.school_id=p_school_id
    union all select case when e.kind='receipt' then e.amount else 0 end,case when e.kind='receipt_reversal' then e.amount else 0 end,
      case when e.kind='refund' then e.amount else 0 end,e.occurred_at,not app_private.valid_office_credit_entry(e.id)
      from app_private.office_student_credit_entries e where e.school_id=p_school_id and e.kind in ('receipt','refund','receipt_reversal')),
  totals as(select count(*) filter(where invalid) as invalid_count,
    coalesce(sum(gross) filter(where not invalid),0) as gross,coalesce(sum(reversed) filter(where not invalid),0) as reversed,
    coalesce(sum(refunded) filter(where not invalid),0) as refunded,
    coalesce(sum(gross) filter(where not invalid and posted_at>=(today::timestamp at time zone 'Asia/Kolkata') and posted_at<((today+1)::timestamp at time zone 'Asia/Kolkata')),0) as today_gross,
    coalesce(sum(reversed) filter(where not invalid and posted_at>=(today::timestamp at time zone 'Asia/Kolkata') and posted_at<((today+1)::timestamp at time zone 'Asia/Kolkata')),0) as today_reversed,
    coalesce(sum(refunded) filter(where not invalid and posted_at>=(today::timestamp at time zone 'Asia/Kolkata') and posted_at<((today+1)::timestamp at time zone 'Asia/Kolkata')),0) as today_refunded,
    coalesce(sum(gross) filter(where not invalid and posted_at>=(date_trunc('month',today::timestamp) at time zone 'Asia/Kolkata') and posted_at<((date_trunc('month',today::timestamp)+interval '1 month') at time zone 'Asia/Kolkata')),0) as month_gross,
    coalesce(sum(reversed) filter(where not invalid and posted_at>=(date_trunc('month',today::timestamp) at time zone 'Asia/Kolkata') and posted_at<((date_trunc('month',today::timestamp)+interval '1 month') at time zone 'Asia/Kolkata')),0) as month_reversed,
    coalesce(sum(refunded) filter(where not invalid and posted_at>=(date_trunc('month',today::timestamp) at time zone 'Asia/Kolkata') and posted_at<((date_trunc('month',today::timestamp)+interval '1 month') at time zone 'Asia/Kolkata')),0) as month_refunded
    from events cross join boundaries)
  select jsonb_build_object('business_date',(select today from boundaries),'month',(select to_char(today,'YYYY-MM') from boundaries),'invalid_count',invalid_count,
    'gross_amount',case when invalid_count=0 then gross::text end,'reversal_amount',case when invalid_count=0 then reversed::text end,
    'refund_amount',case when invalid_count=0 then refunded::text end,'net_amount',case when invalid_count=0 then (gross-reversed-refunded)::text end,
    'today_gross',case when invalid_count=0 then today_gross::text end,'today_reversal',case when invalid_count=0 then today_reversed::text end,
    'today_refund',case when invalid_count=0 then today_refunded::text end,'today_net',case when invalid_count=0 then (today_gross-today_reversed-today_refunded)::text end,
    'month_gross',case when invalid_count=0 then month_gross::text end,'month_reversal',case when invalid_count=0 then month_reversed::text end,
    'month_refund',case when invalid_count=0 then month_refunded::text end,'month_net',case when invalid_count=0 then (month_gross-month_reversed-month_refunded)::text end) from totals;
$$;

create or replace function app_private.summarize_office_fee_day(p_school_id uuid,p_day date)
returns jsonb language sql stable set search_path=''
as $$
  with events as(select coalesce(nullif(lower(btrim(p.payment_method)),''),'unclassified') as method,
    p.amount as gross,0::numeric as reversed,0::numeric as refunded,0::numeric as advance,
    1::bigint as receipt_count,0::bigint as reversal_count,0::bigint as refund_count,0::bigint as advance_count,
    not app_private.coherent_office_fee_payment(p.id) or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=p.id) as invalid
    from public.fee_payments p where p.school_id=p_school_id and p.status='paid'
      and p.paid_at>=(p_day::timestamp at time zone 'Asia/Kolkata') and p.paid_at<((p_day+1)::timestamp at time zone 'Asia/Kolkata')
    union all select r.payment_method,0,r.amount,0,0,0,1,0,0,
      not app_private.coherent_office_fee_payment(r.payment_id) or exists(select 1 from public.fee_refunds legacy where legacy.payment_id=r.payment_id)
      or not exists(select 1 from public.fee_payments p where p.id=r.payment_id and p.school_id=r.school_id and p.student_fee_id=r.fee_id and p.student_id=r.student_id and p.status='paid' and p.amount=r.amount)
      from app_private.office_fee_payment_reversals r where r.school_id=p_school_id and r.business_date=p_day
    union all select e.payment_method,case when e.kind='receipt' then e.amount else 0 end,case when e.kind='receipt_reversal' then e.amount else 0 end,
      case when e.kind='refund' then e.amount else 0 end,case when e.kind='receipt' then e.amount else 0 end,
      case when e.kind='receipt' then 1 else 0 end,case when e.kind='receipt_reversal' then 1 else 0 end,
      case when e.kind='refund' then 1 else 0 end,case when e.kind='receipt' then 1 else 0 end,not app_private.valid_office_credit_entry(e.id)
      from app_private.office_student_credit_entries e where e.school_id=p_school_id and e.business_date=p_day and e.kind in ('receipt','refund','receipt_reversal')),
  grouped as(select method,sum(receipt_count) as receipt_count,sum(reversal_count) as reversal_count,sum(refund_count) as refund_count,sum(advance_count) as advance_count,
    coalesce(sum(gross) filter(where not invalid),0) as gross,coalesce(sum(reversed) filter(where not invalid),0) as reversed,
    coalesce(sum(refunded) filter(where not invalid),0) as refunded,coalesce(sum(advance) filter(where not invalid),0) as advance,
    count(*) filter(where invalid) as invalid_count from events group by method)
  select jsonb_build_object('receipt_count',coalesce(sum(receipt_count),0),'reversal_count',coalesce(sum(reversal_count),0),
    'refund_count',coalesce(sum(refund_count),0),'advance_count',coalesce(sum(advance_count),0),'advance_total',coalesce(sum(advance),0),
    'gross_total',coalesce(sum(gross),0),'reversed_total',coalesce(sum(reversed),0),'refunded_total',coalesce(sum(refunded),0),
    'recorded_total',coalesce(sum(gross-reversed-refunded),0),'recorded_cash',coalesce(sum(gross-reversed-refunded) filter(where method='cash'),0),
    'invalid_count',coalesce(sum(invalid_count),0),'methods',coalesce(jsonb_agg(jsonb_build_object('method',method,'receipt_count',receipt_count,
      'reversal_count',reversal_count,'refund_count',refund_count,'advance_count',advance_count,'gross_total',gross,'reversed_total',reversed,
      'refunded_total',refunded,'advance_total',advance,'total',gross-reversed-refunded) order by method),'[]'::jsonb)) from grouped;
$$;

create or replace function app_private.get_office_finance_summary(p_school_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$ declare ledger jsonb; collections jsonb; advance jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then raise exception 'You cannot read finance totals for this school.' using errcode='42501'; end if;
  ledger:=app_private.office_fee_ledger_result(p_school_id,null,null,1,0,false);
  collections:=app_private.office_fee_collection_totals(p_school_id); advance:=app_private.office_school_credit_summary(p_school_id);
  return (ledger->'summary')||jsonb_build_object('collections',collections,'advance',advance,
    'invalid_count',(ledger->'summary'->>'invalid_count')::bigint+(collections->>'invalid_count')::bigint+(advance->>'invalid_count')::bigint);
end;
$$;

create function public.get_office_student_credit(p_school_id uuid,p_student_id uuid,p_limit integer default 30,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.get_office_student_credit(p_school_id,p_student_id,p_limit,p_offset); $$;

create function public.get_family_student_credit(p_student_id uuid,p_limit integer default 30,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.get_family_student_credit(p_student_id,p_limit,p_offset); $$;

create function public.record_office_credit_receipt(p_school_id uuid,p_student_id uuid,p_amount numeric,p_payment_method text,p_reference text,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.record_office_credit_receipt(p_school_id,p_student_id,p_amount,p_payment_method,p_reference,p_reason,p_request_id); $$;

create function public.allocate_office_credit(p_school_id uuid,p_student_id uuid,p_fee_id uuid,p_amount numeric,p_expected_credit_token text,p_expected_fee_token text,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.allocate_office_credit(p_school_id,p_student_id,p_fee_id,p_amount,p_expected_credit_token,p_expected_fee_token,p_reason,p_request_id); $$;

create function public.request_office_credit_change(p_school_id uuid,p_student_id uuid,p_kind text,p_entry_id uuid,p_amount numeric,p_expected_credit_token text,p_expected_fee_token text,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.request_office_credit_change(p_school_id,p_student_id,p_kind,p_entry_id,p_amount,p_expected_credit_token,p_expected_fee_token,p_reason,p_request_id); $$;

create function public.review_office_credit_change(p_request_id uuid,p_decision text,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.review_office_credit_change(p_request_id,p_decision,p_reason); $$;

create function public.pay_office_credit_refund(p_request_id uuid,p_payment_method text,p_reference text,p_reason text,p_payout_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.pay_office_credit_refund(p_request_id,p_payment_method,p_reference,p_reason,p_payout_id); $$;

create function public.cancel_office_credit_refund(p_request_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.cancel_office_credit_refund(p_request_id,p_reason); $$;

create function public.list_office_credit_changes(p_school_id uuid,p_student_id uuid default null,p_state text default 'all',p_limit integer default 50,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.list_office_credit_changes(p_school_id,p_student_id,p_state,p_limit,p_offset); $$;

revoke all on function app_private.lock_office_credit_actor(uuid,boolean),app_private.lock_office_student_credit(uuid,uuid),app_private.valid_office_credit_entry(uuid),app_private.office_student_credit_state(uuid,uuid),app_private.locked_office_student_credit_state(uuid,uuid),app_private.office_credit_activity(uuid,boolean),app_private.office_student_credit_result(uuid,uuid,integer,integer,boolean),app_private.guard_office_credit_cash_day(),app_private.office_credit_change_result(uuid),app_private.office_school_credit_summary(uuid) from public,anon,authenticated,service_role;
revoke all on function app_private.get_office_student_credit(uuid,uuid,integer,integer),public.get_office_student_credit(uuid,uuid,integer,integer),app_private.get_family_student_credit(uuid,integer,integer),public.get_family_student_credit(uuid,integer,integer),app_private.record_office_credit_receipt(uuid,uuid,numeric,text,text,text,uuid),public.record_office_credit_receipt(uuid,uuid,numeric,text,text,text,uuid),app_private.allocate_office_credit(uuid,uuid,uuid,numeric,text,text,text,uuid),public.allocate_office_credit(uuid,uuid,uuid,numeric,text,text,text,uuid),app_private.request_office_credit_change(uuid,uuid,text,uuid,numeric,text,text,text,uuid),public.request_office_credit_change(uuid,uuid,text,uuid,numeric,text,text,text,uuid),app_private.review_office_credit_change(uuid,text,text),public.review_office_credit_change(uuid,text,text),app_private.pay_office_credit_refund(uuid,text,text,text,uuid),public.pay_office_credit_refund(uuid,text,text,text,uuid),app_private.cancel_office_credit_refund(uuid,text),public.cancel_office_credit_refund(uuid,text),app_private.list_office_credit_changes(uuid,uuid,text,integer,integer),public.list_office_credit_changes(uuid,uuid,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function app_private.get_office_student_credit(uuid,uuid,integer,integer),public.get_office_student_credit(uuid,uuid,integer,integer),app_private.get_family_student_credit(uuid,integer,integer),public.get_family_student_credit(uuid,integer,integer),app_private.record_office_credit_receipt(uuid,uuid,numeric,text,text,text,uuid),public.record_office_credit_receipt(uuid,uuid,numeric,text,text,text,uuid),app_private.allocate_office_credit(uuid,uuid,uuid,numeric,text,text,text,uuid),public.allocate_office_credit(uuid,uuid,uuid,numeric,text,text,text,uuid),app_private.request_office_credit_change(uuid,uuid,text,uuid,numeric,text,text,text,uuid),public.request_office_credit_change(uuid,uuid,text,uuid,numeric,text,text,text,uuid),app_private.review_office_credit_change(uuid,text,text),public.review_office_credit_change(uuid,text,text),app_private.pay_office_credit_refund(uuid,text,text,text,uuid),public.pay_office_credit_refund(uuid,text,text,text,uuid),app_private.cancel_office_credit_refund(uuid,text),public.cancel_office_credit_refund(uuid,text),app_private.list_office_credit_changes(uuid,uuid,text,integer,integer),public.list_office_credit_changes(uuid,uuid,text,integer,integer) to authenticated;

commit;
