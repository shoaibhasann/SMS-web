begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.guardian_absence_alerts (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance(id) on delete cascade,
  student_id uuid not null,
  parent_id uuid not null,
  recipient_user_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (attendance_id, recipient_user_id),
  foreign key (student_id, parent_id)
    references public.student_parents(student_id, parent_id) on delete cascade
);

alter table app_private.guardian_absence_alerts enable row level security;
revoke all on app_private.guardian_absence_alerts from public, anon, authenticated, service_role;
create index guardian_absence_alerts_link on app_private.guardian_absence_alerts (student_id, parent_id);
create index guardian_absence_alerts_recipient
  on app_private.guardian_absence_alerts (recipient_user_id, created_at desc, id desc);

create function app_private.record_guardian_absence_alerts()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status
      and (new.school_id, new.student_id, new.attendance_date)
        is not distinct from (old.school_id, old.student_id, old.attendance_date) then
      return new;
    end if;

    delete from app_private.guardian_absence_alerts where attendance_id = old.id;
    if new.status is not distinct from old.status then
      return new;
    end if;
  end if;

  if new.status is distinct from 'absent' then
    return new;
  end if;

  -- Serialize with link removal without locking the guardian account. If a
  -- removal waits for this insert, its cascade also removes the new alert.
  insert into app_private.guardian_absence_alerts (attendance_id, student_id, parent_id, recipient_user_id)
  select new.id, new.student_id, link.parent_id, guardian.profile_id
  from public.students student
  join public.student_parents link on link.student_id = student.id
  join public.parents guardian on guardian.id = link.parent_id and guardian.school_id = student.school_id
  join public.profiles profile on profile.id = guardian.profile_id and profile.is_active
  join auth.users account on account.id = profile.id and not account.is_anonymous and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= statement_timestamp())
  where student.id = new.student_id and student.school_id = new.school_id
    and exists (
      select 1 from public.user_roles membership
      where membership.user_id = guardian.profile_id and membership.school_id = new.school_id
        and membership.role = 'parent'
    )
  order by link.parent_id
  for key share of link
  on conflict (attendance_id, recipient_user_id) do nothing;

  return new;
end;
$$;

create trigger record_guardian_absence_alerts
after insert or update of status, school_id, student_id, attendance_date on public.attendance
for each row execute function app_private.record_guardian_absence_alerts();

create function app_private.list_guardian_absence_alerts()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(alert) order by alert.created_at desc, alert.id desc), '[]'::jsonb)
  from (
    select a.id, student.id as student_id,
      pg_catalog.concat_ws(' ', student.first_name, student.middle_name, student.last_name) as student_name,
      mark.attendance_date, a.created_at
    from app_private.guardian_absence_alerts a
    join public.attendance mark on mark.id = a.attendance_id and mark.student_id = a.student_id and mark.status = 'absent'
    join public.students student on student.id = a.student_id and student.school_id = mark.school_id
    join public.student_parents link on link.student_id = a.student_id and link.parent_id = a.parent_id
    join public.parents guardian on guardian.id = link.parent_id and guardian.school_id = mark.school_id
      and guardian.profile_id = a.recipient_user_id
    join public.profiles profile on profile.id = guardian.profile_id and profile.is_active
    join auth.users account on account.id = profile.id and not account.is_anonymous and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= statement_timestamp())
    where a.recipient_user_id = (select auth.uid())
      and exists (
        select 1 from public.user_roles membership
        where membership.user_id = guardian.profile_id and membership.school_id = mark.school_id
          and membership.role = 'parent'
      )
    order by a.created_at desc, a.id desc
    limit 30
  ) alert;
$$;

create function public.list_guardian_absence_alerts()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_guardian_absence_alerts(); $$;

revoke all on function
  app_private.record_guardian_absence_alerts(),
  app_private.list_guardian_absence_alerts(),
  public.list_guardian_absence_alerts()
from public, anon, authenticated, service_role;
grant execute on function app_private.list_guardian_absence_alerts(), public.list_guardian_absence_alerts()
to authenticated;

commit;
