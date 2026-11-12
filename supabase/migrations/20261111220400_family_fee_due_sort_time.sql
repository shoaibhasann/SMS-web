begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A fee-due reminder sorts at the later of its IST due-date midnight and the
-- demand's creation, so a demand created already overdue surfaces as new.
create or replace function app_private.eligible_family_notifications_v6(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v5(p_role) legacy
  union all
  select fee.id, 'fee_due', fee.student_id, fee.student_name,
    greatest(fee.due_date::timestamp at time zone 'Asia/Kolkata', demand.created_at), receipt.read_at,
    fee.due_date, fee.id, fee.status, fee.fee_name, null::uuid, null::timestamptz, false
  from app_private.eligible_family_fee_due_positions(p_role) fee
  join public.student_fees demand on demand.id = fee.id
  left join app_private.family_fee_due_reads receipt on receipt.fee_id = fee.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

revoke all on function app_private.eligible_family_notifications_v6(text)
  from public, anon, authenticated, service_role;

commit;
