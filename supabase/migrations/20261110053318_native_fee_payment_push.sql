begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.family_push_jobs
  drop constraint family_push_jobs_kind_check,
  add constraint family_push_jobs_kind_check check (
    kind in ('absence', 'result_published', 'leave_decision', 'exam_schedule', 'homework_assigned', 'announcement', 'fee_due', 'fee_payment')
  );

-- The payment RPC and marker use clock_timestamp() within the triggering statement.
create function app_private.family_fee_payment_push_recipients(p_payment_id uuid)
returns table (user_id uuid, recipient_role text, school_id uuid, expires_at timestamptz)
language sql volatile security invoker set search_path = ''
as $$
  select recipient.recipient_user_id, recipient.recipient_role, publication.school_id,
    publication.recorded_at + interval '24 hours'
  from app_private.family_fee_payment_publications publication
  join public.schools school on school.id = publication.school_id and school.is_active
  join public.fee_payments payment on payment.id = publication.payment_id and payment.school_id = publication.school_id
    and payment.student_id = publication.student_id and payment.student_fee_id = publication.fee_id
  cross join lateral app_private.family_notification_recipients(publication.school_id, publication.student_id) recipient
  where publication.payment_id = p_payment_id and payment.status = 'paid'
    and publication.recorded_at between timestamptz '0001-01-01 00:00:00+00' and clock_timestamp()
    and app_private.coherent_office_fee_payment(payment.id)
    and payment.amount > 0 and payment.amount < 'Infinity'::numeric and payment.amount = trunc(payment.amount, 2)
    and payment.receipt_no ~ '[^[:space:]]'
    and payment.paid_at between timestamptz '0001-01-01 00:00:00+00' and clock_timestamp()
    and not exists (select 1 from public.fee_refunds refund where refund.payment_id = payment.id)
    and not exists (select 1 from app_private.office_fee_payment_reversals reversal where reversal.payment_id = payment.id);
$$;

revoke all on function app_private.family_fee_payment_push_recipients(uuid) from public, anon, authenticated, service_role;

create or replace function app_private.family_push_job_eligible(p_job app_private.family_push_jobs)
returns boolean language sql volatile security invoker set search_path = ''
as $$
  select p_job.expires_at > statement_timestamp() and exists (
    select 1 from app_private.family_push_devices device
    join app_private.family_push_preferences pref on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
    join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
      and (session.not_after is null or session.not_after > statement_timestamp())
    join public.profiles profile on profile.id = device.user_id and profile.school_id = device.school_id and profile.is_active
    where device.id = p_job.device_id and device.generation = p_job.device_generation and device.user_id = p_job.user_id
      and device.recipient_role = p_job.recipient_role and device.school_id = p_job.school_id and device.revoked_at is null
      and device.last_seen_at > statement_timestamp() - interval '90 days'
      and case p_job.kind
        when 'absence' then pref.absence
        when 'result_published' then pref.result_published
        when 'leave_decision' then pref.leave_decision
        when 'exam_schedule' then true
        when 'homework_assigned' then true
        when 'announcement' then true
        when 'fee_due' then true
        when 'fee_payment' then true
        else false
      end
      and case when p_job.kind = 'exam_schedule' then exists (
        select 1 from app_private.family_exam_schedule_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'homework_assigned' then exists (
        select 1 from app_private.family_homework_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'announcement' then exists (
        select 1 from app_private.family_notice_push_recipients(p_job.event_id, device.user_id, device.recipient_role) event
        where event.school_id = device.school_id
      ) when p_job.kind = 'fee_due' then exists (
        select 1 from public.student_fees fee
        join public.schools school on school.id = fee.school_id and school.is_active
        cross join lateral app_private.family_notification_recipients(fee.school_id, fee.student_id) recipient
        where fee.id = p_job.event_id and fee.school_id = device.school_id
          and recipient.recipient_user_id = device.user_id and recipient.recipient_role = device.recipient_role
          and app_private.family_fee_due_push_position(fee.school_id, fee.id, fee.student_id)
      ) when p_job.kind = 'fee_payment' then exists (
        select 1 from app_private.family_fee_payment_push_recipients(p_job.event_id) event
        where event.school_id = device.school_id and event.user_id = device.user_id and event.recipient_role = device.recipient_role
      ) else exists (
        select 1 from app_private.family_push_event(p_job.kind, p_job.event_id) event
        where event.user_id = device.user_id and event.recipient_role = device.recipient_role and event.school_id = device.school_id
      ) end
  );
$$;

create or replace function app_private.enqueue_family_push_event()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare event_kind text; source_id uuid;
begin
  if tg_table_name = 'family_homework_publications' then
    event_kind := 'homework_assigned';
    source_id := new.activity_id;
  elsif tg_table_name = 'family_notice_publications' then
    event_kind := 'announcement';
    source_id := new.notice_id;
  elsif tg_table_name = 'family_fee_payment_publications' then
    event_kind := 'fee_payment';
    source_id := new.payment_id;
  else
    source_id := new.id;
    if tg_table_name = 'guardian_absence_alerts' then
      event_kind := 'absence';
    elsif tg_table_name = 'family_exam_schedule_events' then
      event_kind := 'exam_schedule';
    else
      event_kind := new.kind;
    end if;
  end if;

  insert into app_private.family_push_jobs(kind, event_id, device_id, device_generation, user_id, recipient_role, school_id, expires_at, next_attempt_at)
  select event_kind, source_id, device.id, device.generation, event.user_id, event.recipient_role, event.school_id,
    event.expires_at, greatest(statement_timestamp(), event.ready_at)
  from (
    select original.user_id, original.recipient_role, original.school_id, original.event_time + interval '24 hours' as expires_at,
      statement_timestamp() as ready_at
    from app_private.family_push_event(event_kind, source_id) original
    where event_kind not in ('exam_schedule', 'homework_assigned', 'announcement', 'fee_payment')
    union all
    select exam.user_id, exam.recipient_role, exam.school_id, exam.expires_at, statement_timestamp()
    from app_private.family_exam_schedule_push_recipients(source_id, null, null) exam
    where event_kind = 'exam_schedule'
    union all
    select homework.user_id, homework.recipient_role, homework.school_id, homework.expires_at, statement_timestamp()
    from app_private.family_homework_push_recipients(source_id, null, null) homework
    where event_kind = 'homework_assigned'
    union all
    select notice.user_id, notice.recipient_role, notice.school_id, notice.expires_at, notice.published_at
    from app_private.family_notice_push_recipients(source_id, null, null) notice
    where event_kind = 'announcement'
    union all
    select payment.user_id, payment.recipient_role, payment.school_id, payment.expires_at, statement_timestamp()
    from app_private.family_fee_payment_push_recipients(source_id) payment
    where event_kind = 'fee_payment'
  ) event
  join app_private.family_push_devices device on device.user_id = event.user_id and device.recipient_role = event.recipient_role
    and device.school_id = event.school_id and device.revoked_at is null
  join app_private.family_push_preferences pref on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
  join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
    and (session.not_after is null or session.not_after > statement_timestamp())
  where event.expires_at > greatest(statement_timestamp(), event.ready_at)
    and device.last_seen_at > statement_timestamp() - interval '90 days'
    and case event_kind
      when 'absence' then pref.absence
      when 'result_published' then pref.result_published
      when 'leave_decision' then pref.leave_decision
      when 'exam_schedule' then true
      when 'homework_assigned' then true
      when 'announcement' then true
      when 'fee_payment' then true
      else false
    end
  on conflict (kind, event_id, device_id, device_generation) do nothing;
  return new;
end;
$$;

create trigger enqueue_native_fee_payment_push after insert on app_private.family_fee_payment_publications
  for each row execute function app_private.enqueue_family_push_event();

commit;
