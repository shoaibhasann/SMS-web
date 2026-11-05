begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Intentional business conflicts map to HTTP 409. SQLSTATE 40001 is reserved
-- for actual serialization failures and is retried by PostgREST 14.
CREATE OR REPLACE FUNCTION app_private.close_office_fee_day(p_school_id uuid, p_day date, p_revision bigint, p_counted_cash numeric, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'Payments changed after the review. Refresh the totals before closing.' using errcode = 'PT409';
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
$function$;

commit;
