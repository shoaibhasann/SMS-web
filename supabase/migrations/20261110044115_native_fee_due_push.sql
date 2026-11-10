begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.family_push_jobs
  drop constraint family_push_jobs_kind_check,
  add constraint family_push_jobs_kind_check check (
    kind in ('absence', 'result_published', 'leave_decision', 'exam_schedule', 'homework_assigned', 'announcement', 'fee_due')
  );

-- A device generation change cannot cause a second reminder for the same fee.
create unique index family_push_jobs_fee_due_once_per_device
  on app_private.family_push_jobs(event_id, device_id) where kind = 'fee_due';

create function app_private.family_fee_due_push_position(p_school_id uuid, p_fee_id uuid, p_student_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from app_private.office_fee_positions(p_school_id, p_fee_id, p_student_id) position
    where position.demand_id = p_fee_id and position.student_id = p_student_id
      and position.due_date = (statement_timestamp() at time zone 'Asia/Kolkata')::date
      and position.invalid is false and position.status in ('pending', 'partial')
      and position.balance > 0 and position.balance < 'Infinity'::numeric
      and position.balance = trunc(position.balance, 2)
  );
$$;

create function app_private.enqueue_family_fee_due_push(p_limit integer, p_school_id uuid default null)
returns void language plpgsql security invoker set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  expires_at timestamptz := (today + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'Invalid dispatch batch.' using errcode = '22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('family_push_fee_due_enqueue', 0)) then return; end if;

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
  ), candidates as materialized (
    select fee.id as fee_id, device.id as device_id, device.generation,
      device.user_id, device.recipient_role, device.school_id, device.student_id
    from pupil_devices device
    join public.student_fees fee on fee.student_id = device.student_id and fee.school_id = device.school_id and fee.due_date = today
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
    and app_private.family_fee_due_push_position(candidate.school_id, candidate.fee_id, candidate.student_id)
  limit p_limit
  on conflict (event_id, device_id) where kind = 'fee_due' do nothing;
end;
$$;

revoke all on function app_private.family_fee_due_push_position(uuid, uuid, uuid),
  app_private.enqueue_family_fee_due_push(integer, uuid) from public, anon, authenticated, service_role;

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
      ) else exists (
        select 1 from app_private.family_push_event(p_job.kind, p_job.event_id) event
        where event.user_id = device.user_id and event.recipient_role = device.recipient_role and event.school_id = device.school_id
      ) end
  );
$$;

create or replace function app_private.claim_family_push_jobs(p_batch_id uuid,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare batch app_private.family_push_batches;job app_private.family_push_jobs;items jsonb:='[]'::jsonb;lease uuid;
begin
  perform app_private.family_push_service();
  if p_batch_id is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'Invalid dispatch batch.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_batch:'||p_batch_id::text,0));
  select * into batch from app_private.family_push_batches where id=p_batch_id;
  if found then return case when batch.expires_at>statement_timestamp() then batch.jobs else '[]'::jsonb end; end if;
  perform app_private.enqueue_family_fee_due_push(p_limit);
  for job in select * from app_private.family_push_jobs where(status='queued' and next_attempt_at<=statement_timestamp())
      or(status='leased' and lease_until<=statement_timestamp()) order by next_attempt_at,created_at,id limit p_limit for update skip locked loop
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

commit;
