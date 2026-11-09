begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A marker records the first new paid transition without copying receipts or
-- publishing historical payments. Read state belongs to a family role/account.
create table app_private.family_fee_payment_publications (
  payment_id uuid primary key references public.fee_payments(id) on delete cascade,
  fee_id uuid not null,
  student_id uuid not null,
  school_id uuid not null,
  recorded_at timestamptz not null
);
create index family_fee_payment_publications_pupil on app_private.family_fee_payment_publications(school_id, student_id, payment_id);
create table app_private.family_fee_payment_reads (
  payment_id uuid not null references app_private.family_fee_payment_publications(payment_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('student', 'parent')),
  read_at timestamptz not null,
  primary key (payment_id, recipient_user_id, recipient_role)
);
create index family_fee_payment_reads_recipient on app_private.family_fee_payment_reads(recipient_user_id, recipient_role);
alter table app_private.family_fee_payment_publications enable row level security;
alter table app_private.family_fee_payment_reads enable row level security;
revoke all on table app_private.family_fee_payment_publications, app_private.family_fee_payment_reads
  from public, anon, authenticated, service_role;

create function app_private.record_family_fee_payment_publication()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    insert into app_private.family_fee_payment_publications(payment_id, fee_id, student_id, school_id, recorded_at)
    values (new.id, new.student_fee_id, new.student_id, new.school_id, clock_timestamp())
    on conflict (payment_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger record_family_fee_payment_publication after insert or update of status on public.fee_payments
for each row execute function app_private.record_family_fee_payment_publication();

create function app_private.eligible_family_fee_payments(p_role text, p_student_id uuid default null, p_payment_id uuid default null)
returns table (
  id uuid, student_id uuid, student_name text, fee_name text, receipt_no text,
  amount text, net_amount text, status text, paid_at timestamptz, payment_method text,
  reversed_at timestamptz, reversal_reference text, recorded_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  with actor as materialized (
    select profile.id, profile.school_id
    from public.profiles profile
    join public.schools school on school.id = profile.school_id and school.is_active
    where profile.id = auth.uid() and profile.is_active
      and p_role in ('student', 'parent')
      and exists (
        select 1 from public.user_roles membership
        where membership.user_id = profile.id and membership.school_id = school.id and membership.role::text = p_role
      )
  ), pupils as materialized (
    select student.id, actor.school_id from actor
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id
    where p_role = 'student' and (p_student_id is null or student.id = p_student_id)
    union
    select student.id, actor.school_id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id
    where p_role = 'parent' and (p_student_id is null or student.id = p_student_id)
  )
  select payment.id, payment.student_id,
    coalesce(nullif(regexp_replace(concat_ws(' ', student.first_name, student.middle_name, student.last_name), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Student'),
    coalesce(nullif(regexp_replace(structure.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'School fee'),
    regexp_replace(payment.receipt_no, '^[[:space:]]+|[[:space:]]+$', '', 'g'), trunc(payment.amount, 2)::text,
    case when reversal.id is null then trunc(payment.amount, 2)::text else '0.00' end,
    case when reversal.id is null then 'paid' else 'reversed' end, payment.paid_at,
    case when lower(btrim(payment.payment_method)) in ('cash', 'upi', 'bank_transfer', 'card', 'cheque')
      then lower(btrim(payment.payment_method)) end,
    reversal.approved_at, regexp_replace(reversal.reference, '^[[:space:]]+|[[:space:]]+$', '', 'g'), publication.recorded_at
  from pupils pupil
  join app_private.family_fee_payment_publications publication on publication.school_id = pupil.school_id and publication.student_id = pupil.id
  join public.fee_payments payment on payment.id = publication.payment_id and payment.school_id = publication.school_id
    and payment.student_id = publication.student_id and payment.student_fee_id = publication.fee_id
  join public.students student on student.id = pupil.id and student.school_id = pupil.school_id
  join public.student_fees fee on fee.id = payment.student_fee_id and fee.student_id = payment.student_id and fee.school_id = payment.school_id
  join public.fee_structures structure on structure.id = fee.fee_structure_id and structure.school_id = fee.school_id
  left join app_private.office_fee_payment_reversals reversal on reversal.payment_id = payment.id
  where (p_payment_id is null or payment.id = p_payment_id)
    and payment.status = 'paid' and app_private.coherent_office_fee_payment(payment.id)
    and payment.amount > 0 and payment.amount < 'Infinity'::numeric and payment.amount = trunc(payment.amount, 2)
    and payment.receipt_no ~ '[^[:space:]]'
    and payment.paid_at between timestamptz '0001-01-01 00:00:00+00' and statement_timestamp()
    and not exists (select 1 from public.fee_refunds refund where refund.payment_id = payment.id)
    and (reversal.id is null or (
      reversal.school_id = payment.school_id and reversal.student_id = payment.student_id and reversal.fee_id = payment.student_fee_id
      and reversal.amount = payment.amount and reversal.payment_method is not distinct from payment.payment_method
      and reversal.approved_at between payment.paid_at and statement_timestamp() and reversal.reference ~ '[^[:space:]]'
    ));
$$;

create function app_private.eligible_family_notifications_v7(p_role text)
returns table (id uuid, kind text, student_id uuid, student_name text, created_at timestamptz, read_at timestamptz,
  event_date date, source_id uuid, status text, title text, assessment_id uuid, occurred_at timestamptz, delayed boolean)
language sql stable security invoker set search_path = ''
as $$
  select legacy.* from app_private.eligible_family_notifications_v6(p_role) legacy
  union all
  select payment.id, 'fee_payment', payment.student_id, payment.student_name, payment.recorded_at, receipt.read_at,
    (payment.paid_at at time zone 'Asia/Kolkata')::date, payment.id, payment.status,
    case when payment.status = 'reversed' then 'Payment entry reversed' else 'Fee payment recorded' end,
    null::uuid, null::timestamptz, false
  from app_private.eligible_family_fee_payments(p_role) payment
  left join app_private.family_fee_payment_reads receipt on receipt.payment_id = payment.id
    and receipt.recipient_user_id = auth.uid() and receipt.recipient_role = p_role;
$$;

create function app_private.get_family_notification_inbox_v7(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_unread_only is null or p_limit is null or p_limit not between 1 and 50
    or num_nonnulls(p_before_created_at, p_before_kind, p_before_id) not in (0, 3)
    or (p_before_created_at is not null and (not isfinite(p_before_created_at)
      or p_before_kind not in ('absence', 'result_published', 'leave_decision', 'gate_arrival', 'gate_exit', 'late', 'announcement', 'homework_assigned', 'fee_due', 'fee_payment'))) then
    raise exception 'Invalid notification page.' using errcode = '22023';
  end if;
  with eligible as materialized (select * from app_private.eligible_family_notifications_v7(p_role)),
  candidates as materialized (
    select * from eligible notification where (not p_unread_only or notification.read_at is null)
      and (p_before_created_at is null or (notification.created_at, notification.kind collate "C", notification.id) < (p_before_created_at, p_before_kind collate "C", p_before_id))
    order by created_at desc, kind collate "C" desc, id desc limit p_limit + 1
  ), page as materialized (select * from candidates order by created_at desc, kind collate "C" desc, id desc limit p_limit)
  select jsonb_build_object('user_id', actor, 'role', p_role,
    'notifications', coalesce((select jsonb_agg(to_jsonb(notification) order by notification.created_at desc, notification.kind collate "C" desc, notification.id desc) from page notification), '[]'::jsonb),
    'unread_count', (select count(*) from eligible where read_at is null),
    'next_cursor', case when (select count(*) from candidates) > p_limit then (
      select jsonb_build_object('created_at', notification.created_at, 'kind', notification.kind, 'id', notification.id)
      from page notification order by notification.created_at, notification.kind collate "C", notification.id limit 1
    ) else null end) into result;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.get_family_notification_unread_count_v7(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result bigint;
begin
  select count(*) into result from app_private.eligible_family_notifications_v7(p_role) where read_at is null;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function app_private.mark_family_notification_read_v7(p_role text, p_kind text, p_id uuid)
returns timestamptz language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); marked timestamptz;
begin
  if p_kind is distinct from 'fee_payment' then
    return app_private.mark_family_notification_read_v6(p_role, p_kind, p_id);
  end if;
  if p_id is null then raise exception 'Choose a valid notification.' using errcode = '22023'; end if;
  insert into app_private.family_fee_payment_reads(payment_id, recipient_user_id, recipient_role, read_at)
  select payment.id, actor, p_role, statement_timestamp() from app_private.eligible_family_fee_payments(p_role, null, p_id) payment
  on conflict (payment_id, recipient_user_id, recipient_role) do nothing;
  select receipt.read_at into marked from app_private.family_fee_payment_reads receipt
  join app_private.eligible_family_fee_payments(p_role, null, p_id) payment on payment.id = receipt.payment_id
  where receipt.recipient_user_id = actor and receipt.recipient_role = p_role;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return marked;
end;
$$;

create function app_private.mark_all_family_notifications_read_v7(p_role text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); previous bigint; marked bigint;
begin
  previous := app_private.mark_all_family_notifications_read_v6(p_role);
  with inserted as (
    insert into app_private.family_fee_payment_reads(payment_id, recipient_user_id, recipient_role, read_at)
    select payment.id, actor, p_role, statement_timestamp() from app_private.eligible_family_fee_payments(p_role) payment
    where not exists (
      select 1 from app_private.family_fee_payment_reads receipt where receipt.payment_id = payment.id
        and receipt.recipient_user_id = actor and receipt.recipient_role = p_role
    )
    order by payment.id
    on conflict (payment_id, recipient_user_id, recipient_role) do nothing returning payment_id
  ) select count(*) into marked from inserted;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return previous + marked;
end;
$$;

create function app_private.get_family_fee_payment(p_role text, p_student_id uuid, p_payment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid := app_private.gate_notification_actor(p_role); result jsonb;
begin
  if p_student_id is null or p_payment_id is null then raise exception 'Choose a valid pupil and payment.' using errcode = '22023'; end if;
  select jsonb_build_object(
    'id', payment.id, 'student_id', payment.student_id, 'student_name', payment.student_name, 'fee_name', payment.fee_name,
    'receipt_no', payment.receipt_no, 'amount', payment.amount, 'net_amount', payment.net_amount, 'status', payment.status,
    'paid_at', payment.paid_at, 'payment_method', payment.payment_method, 'reversed_at', payment.reversed_at,
    'reversal_reference', payment.reversal_reference
  ) into result from app_private.eligible_family_fee_payments(p_role, p_student_id, p_payment_id) payment;
  if actor is distinct from app_private.gate_notification_actor(p_role) then
    raise exception 'Your family access changed.' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.get_family_notification_inbox_v7(
  p_role text, p_unread_only boolean default false, p_limit integer default 30,
  p_before_created_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_inbox_v7(p_role, p_unread_only, p_limit, p_before_created_at, p_before_kind, p_before_id); $$;
create function public.get_family_notification_unread_count_v7(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_notification_unread_count_v7(p_role); $$;
create function public.mark_family_notification_read_v7(p_role text, p_kind text, p_id uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_family_notification_read_v7(p_role, p_kind, p_id); $$;
create function public.mark_all_family_notifications_read_v7(p_role text)
returns bigint language sql volatile security invoker set search_path = ''
as $$ select app_private.mark_all_family_notifications_read_v7(p_role); $$;
create function public.get_family_fee_payment(p_role text, p_student_id uuid, p_payment_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.get_family_fee_payment(p_role, p_student_id, p_payment_id); $$;

revoke all on function app_private.record_family_fee_payment_publication(), app_private.eligible_family_fee_payments(text, uuid, uuid), app_private.eligible_family_notifications_v7(text)
  from public, anon, authenticated, service_role;
do $permissions$
declare signature text;
begin
  foreach signature in array array[
    'get_family_notification_inbox_v7(text,boolean,integer,timestamptz,text,uuid)', 'get_family_notification_unread_count_v7(text)',
    'mark_family_notification_read_v7(text,text,uuid)', 'mark_all_family_notifications_read_v7(text)', 'get_family_fee_payment(text,uuid,uuid)'
  ] loop
    execute 'revoke all on function public.' || signature || ',app_private.' || signature || ' from public,anon,authenticated,service_role';
    execute 'grant execute on function public.' || signature || ',app_private.' || signature || ' to authenticated';
  end loop;
end;
$permissions$;
notify pgrst, 'reload schema';
commit;
