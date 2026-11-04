begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- An alert already belongs to exactly one recipient. Existing alerts start unread.
alter table app_private.guardian_absence_alerts add column read_at timestamptz;

create function app_private.eligible_guardian_absence_alerts(p_alert_id uuid)
returns table (
  id uuid,
  student_id uuid,
  student_name text,
  attendance_date date,
  created_at timestamptz,
  read_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select a.id, student.id,
    pg_catalog.concat_ws(' ', student.first_name, student.middle_name, student.last_name),
    mark.attendance_date, a.created_at, a.read_at
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
    and (p_alert_id is null or a.id = p_alert_id)
    and exists (
      select 1 from public.user_roles membership
      where membership.user_id = guardian.profile_id and membership.school_id = mark.school_id
        and membership.role = 'parent'
    );
$$;

-- Keep the older Preview contract and ordering for deployments still calling it.
create or replace function app_private.list_guardian_absence_alerts()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(alert) order by alert.created_at desc, alert.id desc), '[]'::jsonb)
  from (
    select id, student_id, student_name, attendance_date, created_at
    from app_private.eligible_guardian_absence_alerts(null)
    order by created_at desc, id desc
    limit 30
  ) alert;
$$;

create function app_private.get_guardian_absence_inbox()
returns jsonb language sql stable security definer set search_path = ''
as $$
  with eligible as materialized (
    select * from app_private.eligible_guardian_absence_alerts(null)
  )
  select pg_catalog.jsonb_build_object(
    'alerts', coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(alert)
      order by (alert.read_at is not null), alert.created_at desc, alert.id desc), '[]'::jsonb),
    'unread_count', (select count(*) from eligible where read_at is null)
  )
  from (
    select * from eligible
    order by (read_at is not null), created_at desc, id desc
    limit 30
  ) alert;
$$;

create function app_private.mark_guardian_absence_alert_read(p_alert_id uuid)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare
  v_read_at timestamptz;
begin
  if p_alert_id is null then
    return null;
  end if;

  -- A concurrent update can win this write. Keep its timestamp and read it below.
  update app_private.guardian_absence_alerts a
  set read_at = statement_timestamp()
  where a.id = p_alert_id
    and a.recipient_user_id = (select auth.uid())
    and a.read_at is null
    and exists (select 1 from app_private.eligible_guardian_absence_alerts(p_alert_id))
  returning a.read_at into v_read_at;

  if not found then
    select alert.read_at into v_read_at
    from app_private.eligible_guardian_absence_alerts(p_alert_id) alert;
  end if;

  return v_read_at;
end;
$$;

create function public.get_guardian_absence_inbox()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_guardian_absence_inbox(); $$;

create function public.mark_guardian_absence_alert_read(p_alert_id uuid)
returns timestamptz language sql security invoker set search_path = ''
as $$ select app_private.mark_guardian_absence_alert_read(p_alert_id); $$;

revoke all on function
  app_private.eligible_guardian_absence_alerts(uuid),
  app_private.get_guardian_absence_inbox(),
  app_private.mark_guardian_absence_alert_read(uuid),
  public.get_guardian_absence_inbox(),
  public.mark_guardian_absence_alert_read(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  app_private.get_guardian_absence_inbox(),
  app_private.mark_guardian_absence_alert_read(uuid),
  public.get_guardian_absence_inbox(),
  public.mark_guardian_absence_alert_read(uuid)
to authenticated;

commit;
