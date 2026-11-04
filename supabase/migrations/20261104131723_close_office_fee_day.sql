begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.office_fee_days (
  school_id uuid not null references public.schools(id) on delete cascade,
  business_date date not null,
  revision bigint not null default 0 check (revision >= 0),
  closed_at timestamptz,
  closed_by uuid,
  closed_by_name text,
  summary jsonb,
  counted_cash numeric check (counted_cash >= 0),
  variance_note text,
  primary key (school_id, business_date),
  check (
    (closed_at is null and closed_by is null and closed_by_name is null and summary is null
      and counted_cash is null and variance_note is null)
    or (closed_at is not null and closed_by is not null and summary is not null and counted_cash is not null)
  )
);

alter table app_private.office_fee_days enable row level security;
revoke all on table app_private.office_fee_days from public, anon, authenticated, service_role;

create index fee_payments_school_paid_at_idx
  on public.fee_payments (school_id, paid_at)
  where status = 'paid';

create function app_private.guard_office_fee_day()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  prior_school uuid;
  prior_day date;
  next_school uuid;
  next_day date;
  ledger_day record;
begin
  if tg_op <> 'INSERT' then
    prior_school := old.school_id;
    prior_day := (old.paid_at at time zone 'Asia/Kolkata')::date;
  end if;
  if tg_op <> 'DELETE' then
    next_school := new.school_id;
    next_day := (new.paid_at at time zone 'Asia/Kolkata')::date;
  end if;

  -- An UPDATE can move a receipt between dates. Always touch both day rows in
  -- the same order. The revision write also makes stale transactions at
  -- stronger isolation levels fail rather than record an incomplete close.
  for ledger_day in
    select distinct affected.school_id, affected.business_date
    from (values (prior_school, prior_day), (next_school, next_day)) affected(school_id, business_date)
    join public.schools school on school.id = affected.school_id
    where affected.business_date is not null
    order by affected.school_id, affected.business_date
  loop
    insert into app_private.office_fee_days (school_id, business_date)
    values (ledger_day.school_id, ledger_day.business_date)
    on conflict do nothing;

    update app_private.office_fee_days
    set revision = revision + 1
    where school_id = ledger_day.school_id and business_date = ledger_day.business_date
      and closed_at is null;

    if not found then
      raise exception 'This school day is closed for fee collection.' using errcode = '22023';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger guard_office_fee_day
  before insert or delete or update of school_id, student_id, student_fee_id, receipt_no, amount,
    payment_method, transaction_id, gateway, status, paid_at
  on public.fee_payments for each row execute function app_private.guard_office_fee_day();

create function app_private.summarize_office_fee_day(p_school_id uuid, p_day date)
returns jsonb language sql stable set search_path = ''
as $$
  with grouped as (
    select coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(payment_method)), ''), 'unclassified') as method,
      count(*) as receipt_count,
      coalesce(sum(amount) filter (where amount > 0 and amount <> 'NaN'::numeric), 0) as total,
      count(*) filter (where amount <= 0 or amount = 'NaN'::numeric) as invalid_count
    from public.fee_payments
    where school_id = p_school_id and status = 'paid'
      and paid_at >= (p_day::timestamp at time zone 'Asia/Kolkata')
      and paid_at < ((p_day + 1)::timestamp at time zone 'Asia/Kolkata')
    group by 1
  )
  select pg_catalog.jsonb_build_object(
    'receipt_count', coalesce(sum(receipt_count), 0),
    'recorded_total', coalesce(sum(total), 0),
    'recorded_cash', coalesce(sum(total) filter (where method = 'cash'), 0),
    'invalid_count', coalesce(sum(invalid_count), 0),
    'methods', coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('method', method, 'receipt_count', receipt_count, 'total', total)
      order by method
    ), '[]'::jsonb)
  )
  from grouped;
$$;

create function app_private.office_fee_day_result(day_record app_private.office_fee_days, day_summary jsonb)
returns jsonb language sql stable set search_path = ''
as $$
  select day_summary || pg_catalog.jsonb_build_object(
    'business_date', day_record.business_date,
    'revision', coalesce(day_record.revision, 0),
    'closed_at', day_record.closed_at,
    'closed_by_name', day_record.closed_by_name,
    'counted_cash', day_record.counted_cash,
    'cash_variance', day_record.counted_cash - (day_summary->>'recorded_cash')::numeric,
    'variance_note', day_record.variance_note
  );
$$;

create function app_private.get_office_fee_day(p_school_id uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  day_record app_private.office_fee_days%rowtype;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot view fee closing for this school.' using errcode = '42501';
  end if;
  if p_day is null or not pg_catalog.isfinite(p_day) or p_day > (statement_timestamp() at time zone 'Asia/Kolkata')::date then
    raise exception 'Choose today or an earlier date in IST.' using errcode = '22023';
  end if;

  select * into day_record from app_private.office_fee_days
  where school_id = p_school_id and business_date = p_day;
  day_record.business_date := p_day;
  return app_private.office_fee_day_result(day_record,
    coalesce(day_record.summary, app_private.summarize_office_fee_day(p_school_id, p_day)));
end;
$$;

create function app_private.close_office_fee_day(
  p_school_id uuid, p_day date, p_revision bigint, p_counted_cash numeric, p_note text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  note text := nullif(pg_catalog.btrim(p_note), '');
  day_record app_private.office_fee_days%rowtype;
  day_summary jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot close fee collection for this school.' using errcode = '42501';
  end if;
  if p_day is null or not pg_catalog.isfinite(p_day) or p_day > (clock_timestamp() at time zone 'Asia/Kolkata')::date then
    raise exception 'Choose today or an earlier date in IST.' using errcode = '22023';
  end if;
  if p_revision is null or p_revision < 0 or p_counted_cash is null or p_counted_cash < 0
    or p_counted_cash > 999999999999.99 or p_counted_cash <> pg_catalog.trunc(p_counted_cash, 2)
    or pg_catalog.length(note) > 500 then
    raise exception 'Enter a cash count with up to two decimal places and a note of up to 500 characters.' using errcode = '22023';
  end if;

  insert into app_private.office_fee_days (school_id, business_date)
  values (p_school_id, p_day) on conflict do nothing;
  select * into day_record from app_private.office_fee_days
  where school_id = p_school_id and business_date = p_day for update;

  if day_record.closed_at is not null then
    if day_record.counted_cash is distinct from p_counted_cash or day_record.variance_note is distinct from note then
      raise exception 'This day has already closed. Refresh to see the saved cash count.' using errcode = '23505';
    end if;
    return app_private.office_fee_day_result(day_record, day_record.summary);
  end if;
  if day_record.revision <> p_revision then
    raise exception 'Payments changed after the review. Refresh the totals before closing.' using errcode = '40001';
  end if;

  day_summary := app_private.summarize_office_fee_day(p_school_id, p_day);
  if (day_summary->>'invalid_count')::bigint > 0 then
    raise exception 'Review invalid payment amounts before closing this date.' using errcode = '22023';
  end if;
  if p_counted_cash <> (day_summary->>'recorded_cash')::numeric and note is null then
    raise exception 'Add a note to explain the cash difference.' using errcode = '22023';
  end if;

  update app_private.office_fee_days
  set closed_at = clock_timestamp(), closed_by = actor_id,
    closed_by_name = (select full_name from public.profiles where id = actor_id),
    summary = day_summary, counted_cash = p_counted_cash, variance_note = note
  where school_id = p_school_id and business_date = p_day
  returning * into day_record;

  return app_private.office_fee_day_result(day_record, day_summary);
end;
$$;

create function public.get_office_fee_day(p_school_id uuid, p_day date)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select app_private.get_office_fee_day(p_school_id, p_day);
$$;

create function public.close_office_fee_day(
  p_school_id uuid, p_day date, p_revision bigint, p_counted_cash numeric, p_note text default null
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select app_private.close_office_fee_day(p_school_id, p_day, p_revision, p_counted_cash, p_note);
$$;

revoke all on function app_private.guard_office_fee_day() from public, anon, authenticated, service_role;
revoke all on function app_private.summarize_office_fee_day(uuid, date) from public, anon, authenticated, service_role;
revoke all on function app_private.office_fee_day_result(app_private.office_fee_days, jsonb) from public, anon, authenticated, service_role;
revoke all on function app_private.get_office_fee_day(uuid, date) from public, anon, authenticated, service_role;
revoke all on function app_private.close_office_fee_day(uuid, date, bigint, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.get_office_fee_day(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.close_office_fee_day(uuid, date, bigint, numeric, text) from public, anon, authenticated, service_role;

grant execute on function app_private.get_office_fee_day(uuid, date) to authenticated;
grant execute on function app_private.close_office_fee_day(uuid, date, bigint, numeric, text) to authenticated;
grant execute on function public.get_office_fee_day(uuid, date) to authenticated;
grant execute on function public.close_office_fee_day(uuid, date, bigint, numeric, text) to authenticated;

commit;
