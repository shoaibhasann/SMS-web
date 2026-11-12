begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Due-today fee reminders are queued from 08:00 IST on the due date, never right after midnight.
create function app_private.family_fee_due_push_open(p_at timestamptz)
returns boolean language sql immutable set search_path = ''
as $$
  select (p_at at time zone 'Asia/Kolkata')::time >= time '08:00';
$$;
revoke all on function app_private.family_fee_due_push_open(timestamptz) from public, anon, authenticated, service_role;

-- Claims run every few seconds during a backlog; the due-today scan runs at most once a minute per scope.
create table app_private.family_fee_due_push_scans(
  scope text primary key,
  scanned_at timestamptz not null
);
alter table app_private.family_fee_due_push_scans enable row level security;
revoke all on table app_private.family_fee_due_push_scans from public, anon, authenticated, service_role;

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
  ), open_fees as materialized (
    -- Settled demands drop out once per fee, before the ledger is consulted again for every device.
    select fee.id, fee.school_id, fee.student_id from public.student_fees fee
    where fee.due_date = today and (p_school_id is null or fee.school_id = p_school_id)
      and exists (select 1 from pupil_devices device where device.student_id = fee.student_id and device.school_id = fee.school_id
        and not exists (select 1 from app_private.family_push_jobs job
          where job.kind = 'fee_due' and job.event_id = fee.id and job.device_id = device.id))
      and app_private.family_fee_due_push_position(fee.school_id, fee.id, fee.student_id)
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

-- Retention: replayed batch ids only matter for five minutes; terminal jobs outlive the 7-day monitor by far.
create index family_push_batches_expiry on app_private.family_push_batches(expires_at);
create index family_push_jobs_terminal_finished on app_private.family_push_jobs(finished_at)
  where status in ('accepted', 'cancelled', 'failed');
delete from app_private.family_push_batches where expires_at < statement_timestamp() - interval '1 day';

-- Claims take turns across schools (absence first within a school), so one school's backlog cannot hold back another's.
create or replace function app_private.claim_family_push_jobs(p_batch_id uuid,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare batch app_private.family_push_batches;job app_private.family_push_jobs;items jsonb:='[]'::jsonb;lease uuid;
begin
  perform app_private.family_push_service();
  if p_batch_id is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'Invalid dispatch batch.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_batch:'||p_batch_id::text,0));
  select * into batch from app_private.family_push_batches where id=p_batch_id;
  -- A batch id replayed after its row was pruned (expired over a day ago) is claimed afresh; dispatchers never reuse ids.
  if found then return case when batch.expires_at>statement_timestamp() then batch.jobs else '[]'::jsonb end; end if;
  -- Overlapping claims prune disjoint rows instead of waiting on each other's row locks.
  delete from app_private.family_push_batches where id in(select id from app_private.family_push_batches
    where expires_at<statement_timestamp()-interval '1 day' limit 1000 for update skip locked);
  delete from app_private.family_push_jobs where id in(select id from app_private.family_push_jobs
    where status in('accepted','cancelled','failed') and finished_at<statement_timestamp()-interval '90 days'
      and expires_at<statement_timestamp()-interval '90 days' order by finished_at limit 500 for update skip locked);
  -- The once-a-minute scan queues a larger batch so claims every few seconds still drain the reminders.
  perform app_private.enqueue_family_fee_due_push(500);
  for job in select candidate.* from app_private.family_push_jobs candidate
      join(select ready.id,pg_catalog.row_number() over(partition by ready.school_id
          order by(ready.kind='absence') desc,ready.next_attempt_at,ready.created_at,ready.id) as turn
        from app_private.family_push_jobs ready where(ready.status='queued' and ready.next_attempt_at<=statement_timestamp())
          or(ready.status='leased' and ready.lease_until<=statement_timestamp())) queue on queue.id=candidate.id
      where(candidate.status='queued' and candidate.next_attempt_at<=statement_timestamp())
        or(candidate.status='leased' and candidate.lease_until<=statement_timestamp())
      order by queue.turn,(candidate.kind='absence') desc,candidate.next_attempt_at,candidate.created_at,candidate.id
      limit p_limit for update of candidate skip locked loop
    if not app_private.family_push_job_eligible(job) or job.attempts>=5 then
      update app_private.family_push_jobs set status=case when attempts>=5 then 'failed' else 'cancelled' end,
        result_code=case when attempts>=5 then 'attempts_exhausted' else 'no_longer_eligible' end,finished_at=statement_timestamp() where id=job.id;
      continue;
    end if;
    lease:=gen_random_uuid();
    update app_private.family_push_jobs set status='leased',batch_id=p_batch_id,lease_id=lease,lease_until=statement_timestamp()+interval '5 minutes',prepared_at=null,
      last_outcome=null,result_code=null,provider_id=null where id=job.id;
    items:=items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',job.id,'lease_id',lease));
  end loop;
  insert into app_private.family_push_batches(id,expires_at,jobs) values(p_batch_id,statement_timestamp()+interval '5 minutes',items);
  return items;
end;
$$;

-- A provider outcome that already happened is recorded; eligibility only stops a retry from being requeued.
-- Returns null (still confirmed) when a retry was cancelled as no longer eligible, so the dispatcher counts it as suppressed.
create or replace function app_private.finish_family_push_job(p_job_id uuid,p_lease_id uuid,p_outcome text,p_code text default null,p_provider_id text default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path=''
as $$
declare job app_private.family_push_jobs;delay integer;target_device uuid;requeue boolean;
begin
  perform app_private.family_push_service();
  if p_outcome is null or p_outcome not in('accepted','retry','invalid_token','failed')
    or(p_code is not null and p_code!~'^[A-Za-z0-9_]{1,64}$')
    or(p_provider_id is not null and(length(p_provider_id)>512 or p_provider_id!~'^[A-Za-z0-9_:/%+~.=-]+$'))
    or(p_retry_after_seconds is not null and p_retry_after_seconds not between 1 and 86400) then
    raise exception 'Invalid dispatch outcome.' using errcode='22023';
  end if;
  select device_id into target_device from app_private.family_push_jobs where id=p_job_id;
  perform 1 from app_private.family_push_devices where id=target_device for update;
  select * into job from app_private.family_push_jobs where id=p_job_id for update;
  if not found or job.lease_id is distinct from p_lease_id then return false; end if;
  if job.last_outcome is not null then
    return case when job.last_outcome=p_outcome and job.result_code='no_longer_eligible' then null else job.last_outcome=p_outcome end;
  end if;
  if job.status<>'leased' or job.prepared_at is null or job.lease_until<=statement_timestamp() then return false; end if;
  requeue:=p_outcome='retry' and app_private.family_push_job_eligible(job);
  if p_outcome='invalid_token' then
    update app_private.family_push_devices set revoked_at=coalesce(revoked_at,statement_timestamp()),generation=generation+1
      where id=job.device_id and generation=job.device_generation;
    update app_private.family_push_jobs set status='cancelled',result_code='device_invalid',finished_at=statement_timestamp()
      where device_id=job.device_id and device_generation=job.device_generation and id<>job.id and status in('queued','leased');
  end if;
  delay:=least(86400,greatest(60,least(3600,60*(2^(job.attempts-1))::int),coalesce(p_retry_after_seconds,0)));
  update app_private.family_push_jobs set status=case when p_outcome='accepted' then 'accepted' when p_outcome='retry' and not requeue then 'cancelled'
      when p_outcome='retry' and attempts<5 and statement_timestamp()+pg_catalog.make_interval(secs=>delay)<expires_at then 'queued' else 'failed' end,
    next_attempt_at=case when requeue then statement_timestamp()+pg_catalog.make_interval(secs=>delay) else next_attempt_at end,
    last_outcome=p_outcome,result_code=case when p_outcome='retry' and not requeue then 'no_longer_eligible' else p_code end,
    provider_id=case when p_outcome='accepted' then p_provider_id else null end,finished_at=statement_timestamp() where id=job.id;
  if p_outcome='retry' and not requeue then return null; end if;
  return true;
end;
$$;

commit;
