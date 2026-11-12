begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The due-today scan asked the fee ledger about every fee due today: the planner ran the ledger check while scanning
-- student_fees, before the device filter. With thousands of fees due on one day, every claim ran past the API statement
-- timeout and no push was dispatched. The device filter now completes in its own materialized step first.
create or replace function app_private.enqueue_family_fee_due_push(p_limit integer, p_school_id uuid default null)
returns void language plpgsql security invoker set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  expires_at timestamptz := (today + 1)::timestamp at time zone 'Asia/Kolkata';
  scan_scope text := coalesce(p_school_id::text, 'all');
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid dispatch batch.' using errcode = '22023';
  end if;
  if not app_private.family_fee_due_push_open(statement_timestamp()) then return; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('family_push_fee_due_enqueue', 0)) then return; end if;
  if exists (select 1 from app_private.family_fee_due_push_scans scan
    where scan.scope = scan_scope and scan.scanned_at > statement_timestamp() - interval '1 minute') then return; end if;
  insert into app_private.family_fee_due_push_scans(scope, scanned_at) values (scan_scope, statement_timestamp())
    on conflict (scope) do update set scanned_at = excluded.scanned_at;

  with pupil_devices as materialized (
    select device.id, device.generation, device.user_id, device.recipient_role, device.school_id, pupil.student_id
    from app_private.family_push_devices device
    join app_private.family_push_preferences pref
      on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
    join auth.sessions session on session.id = device.session_id and session.user_id = device.user_id
      and (session.not_after is null or session.not_after > statement_timestamp())
    join public.schools school on school.id = device.school_id and school.is_active
    cross join lateral (
      select student.id as student_id from public.students student
      where device.recipient_role = 'student' and student.profile_id = device.user_id and student.school_id = school.id
      union
      select link.student_id from public.parents guardian
      join public.student_parents link on link.parent_id = guardian.id
      where device.recipient_role = 'parent' and guardian.profile_id = device.user_id and guardian.school_id = school.id
    ) pupil
    where (p_school_id is null or device.school_id = p_school_id)
      and device.revoked_at is null and device.last_seen_at > statement_timestamp() - interval '90 days'
  ), device_fees as materialized (
    -- Only fees of a pupil with a device still waiting for this reminder go on to the ledger check.
    select fee.id, fee.school_id, fee.student_id from public.student_fees fee
    where fee.due_date = today and (p_school_id is null or fee.school_id = p_school_id)
      and exists (select 1 from pupil_devices device where device.student_id = fee.student_id and device.school_id = fee.school_id
        and not exists (select 1 from app_private.family_push_jobs job
          where job.kind = 'fee_due' and job.event_id = fee.id and job.device_id = device.id))
  ), open_fees as materialized (
    -- Settled demands drop out once per fee, before the ledger is consulted again for every device.
    -- shortcut: one ledger check per waiting fee per scan (about 13 ms each on production). The dispatcher gives each
    -- claim 2 seconds, so bound or batch this check before about 150 such fees can fall due on one day.
    select fee.id, fee.school_id, fee.student_id from device_fees fee
    where app_private.family_fee_due_push_position(fee.school_id, fee.id, fee.student_id)
  ), candidates as materialized (
    select fee.id as fee_id, device.id as device_id, device.generation,
      device.user_id, device.recipient_role, device.school_id, device.student_id
    from pupil_devices device
    join open_fees fee on fee.student_id = device.student_id and fee.school_id = device.school_id
    where not exists (
      select 1 from app_private.family_push_jobs job
      where job.kind = 'fee_due' and job.event_id = fee.id and job.device_id = device.id
    )
    order by fee.id, device.id
  )
  insert into app_private.family_push_jobs(kind, event_id, device_id, device_generation, user_id, recipient_role, school_id, expires_at)
  select 'fee_due', candidate.fee_id, candidate.device_id, candidate.generation,
    candidate.user_id, candidate.recipient_role, candidate.school_id, expires_at
  from candidates candidate
  where exists (
      select 1 from app_private.family_notification_recipients(candidate.school_id, candidate.student_id) recipient
      where recipient.recipient_user_id = candidate.user_id and recipient.recipient_role = candidate.recipient_role
    )
  limit p_limit
  on conflict (event_id, device_id) where kind = 'fee_due' do nothing;
end;
$$;

commit;
