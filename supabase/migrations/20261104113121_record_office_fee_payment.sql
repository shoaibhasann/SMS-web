begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.fee_payments
  add column office_request_id uuid,
  add column recorded_by uuid references auth.users(id) on delete set null;

create unique index fee_payments_office_request_key
  on public.fee_payments (school_id, office_request_id)
  where office_request_id is not null;
create index fee_payments_student_fee_id_idx
  on public.fee_payments (student_fee_id);
create index student_fees_demand_lookup_idx
  on public.student_fees (student_id, fee_structure_id, billing_period);

-- Office collection is a single path. Existing office and family reads stay available.
revoke insert, update, delete, truncate, references, trigger
  on table public.fee_payments, public.student_fees from public, anon, authenticated;

create function app_private.can_manage_office_fees(p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select p_school_id is not null and exists (
    select 1
    from public.user_roles ur
    join public.profiles profile on profile.id = ur.user_id and profile.is_active
    where ur.user_id = auth.uid()
      and ((ur.school_id = p_school_id and ur.role in ('school_admin', 'principal', 'accountant'))
        or (ur.school_id is null and ur.role = 'super_admin'))
  );
$$;

create function app_private.issue_office_fee_demand(
  p_school_id uuid,
  p_student_id uuid,
  p_fee_structure_id uuid,
  p_billing_period text,
  p_due_date date
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  structure public.fee_structures%rowtype;
  existing_ids uuid[];
  demand_id uuid;
  billing_month date;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot issue fee demands for this school.' using errcode = '42501';
  end if;
  if p_billing_period is null or p_billing_period !~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a valid billing month.' using errcode = '22023';
  end if;
  if p_student_id is null or p_fee_structure_id is null then
    raise exception 'Choose a student and fee structure.' using errcode = '22023';
  end if;
  billing_month := pg_catalog.make_date(
    pg_catalog.substring(p_billing_period, 1, 4)::integer,
    pg_catalog.substring(p_billing_period, 6, 2)::integer,
    1
  );

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'office-fee-demand:' || p_student_id::text || ':' || p_fee_structure_id::text || ':' || p_billing_period, 0
  ));
  select fs.* into structure
  from public.fee_structures fs
  join public.academic_years y on y.id = fs.academic_year_id and y.school_id = fs.school_id and y.is_current
    and billing_month <= y.end_date and billing_month + interval '1 month' > y.start_date
  join public.students student on student.id = p_student_id and student.school_id = fs.school_id
    and student.status = 'active'
  join public.enrollments enrollment on enrollment.student_id = student.id
    and enrollment.academic_year_id = y.id and enrollment.status = 'active'
  join public.classes cls on cls.id = enrollment.class_id and cls.school_id = fs.school_id
  where fs.id = p_fee_structure_id and fs.school_id = p_school_id
    and (fs.class_id is null or fs.class_id = enrollment.class_id)
  for share of fs, y, student, enrollment, cls;
  if not found then
    raise exception 'Choose an active student, a matching current-year structure, and a month in that school year.' using errcode = '22023';
  end if;

  select array_agg(id) into existing_ids from public.student_fees
  where student_id = p_student_id and fee_structure_id = p_fee_structure_id and billing_period = p_billing_period;
  if existing_ids is not null then
    if pg_catalog.cardinality(existing_ids) <> 1 or not exists (
      select 1 from public.student_fees
      where id = existing_ids[1] and school_id = p_school_id and due_date is not distinct from p_due_date
    ) then
      raise exception 'Review the existing demand for this fee and billing month.' using errcode = '23505';
    end if;
    return existing_ids[1];
  end if;
  if structure.amount <= 0 or structure.amount = 'NaN'::numeric then
    raise exception 'The fee structure must have a positive amount.' using errcode = '22023';
  end if;

  insert into public.student_fees (school_id, student_id, fee_structure_id, billing_period, due_date, amount)
  values (p_school_id, p_student_id, p_fee_structure_id, p_billing_period, p_due_date, structure.amount)
  returning id into demand_id;
  return demand_id;
end;
$$;

create function app_private.record_office_fee_payment(
  p_school_id uuid,
  p_student_fee_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_request_id uuid,
  p_reference text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  method text := pg_catalog.lower(pg_catalog.btrim(p_payment_method));
  payment_reference text := nullif(pg_catalog.btrim(p_reference), '');
  fee public.student_fees%rowtype;
  payment public.fee_payments%rowtype;
  amount_due numeric;
  amount_paid numeric;
  receipt text;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot record payments for this school.' using errcode = '42501';
  end if;

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
  if fee.status not in ('pending', 'partial') then
    raise exception 'This fee is closed for collection. Refresh the fee records.' using errcode = '22023';
  end if;

  amount_due := fee.amount - fee.discount + fee.late_fee;
  if amount_due <= 0 or amount_due = 'NaN'::numeric
    or fee.amount < 0 or fee.discount < 0 or fee.late_fee < 0
    or exists (
      select 1 from public.fee_payments previous
      where previous.student_fee_id = fee.id
        and (previous.school_id <> fee.school_id or previous.student_id <> fee.student_id
          or (previous.status = 'paid' and (previous.amount <= 0 or previous.amount = 'NaN'::numeric)))
    ) then
    raise exception 'Review the fee demand and previous payments before collecting.' using errcode = '22023';
  end if;

  select coalesce(sum(previous.amount), 0) into amount_paid
  from public.fee_payments previous
  where previous.student_fee_id = fee.id and previous.status = 'paid';
  if p_amount > amount_due - amount_paid then
    raise exception 'The payment exceeds the outstanding balance. Refresh the fee records.' using errcode = '22023';
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
$$;

create function public.record_office_fee_payment(
  p_school_id uuid,
  p_student_fee_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_request_id uuid,
  p_reference text default null
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select app_private.record_office_fee_payment(
    p_school_id, p_student_fee_id, p_amount, p_payment_method, p_request_id, p_reference
  );
$$;

create function public.issue_office_fee_demand(
  p_school_id uuid,
  p_student_id uuid,
  p_fee_structure_id uuid,
  p_billing_period text,
  p_due_date date default null
)
returns uuid language sql security invoker set search_path = ''
as $$
  select app_private.issue_office_fee_demand(p_school_id, p_student_id, p_fee_structure_id, p_billing_period, p_due_date);
$$;

revoke all on function app_private.can_manage_office_fees(uuid)
  from public, anon, authenticated, service_role;
revoke all on function app_private.issue_office_fee_demand(uuid, uuid, uuid, text, date)
  from public, anon, authenticated, service_role;
revoke all on function public.issue_office_fee_demand(uuid, uuid, uuid, text, date)
  from public, anon, authenticated, service_role;
revoke all on function app_private.record_office_fee_payment(uuid, uuid, numeric, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_office_fee_payment(uuid, uuid, numeric, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.record_office_fee_payment(uuid, uuid, numeric, text, uuid, text) to authenticated;
grant execute on function public.record_office_fee_payment(uuid, uuid, numeric, text, uuid, text) to authenticated;
grant execute on function app_private.issue_office_fee_demand(uuid, uuid, uuid, text, date) to authenticated;
grant execute on function public.issue_office_fee_demand(uuid, uuid, uuid, text, date) to authenticated;

commit;
