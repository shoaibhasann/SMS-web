begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.mark_all_guardian_absence_alerts_read()
returns bigint language sql security definer set search_path = ''
as $$
  with marked as (
    update app_private.guardian_absence_alerts alert
    set read_at = statement_timestamp()
    where alert.recipient_user_id = (select auth.uid())
      and alert.read_at is null
      and alert.id in (
        select eligible.id
        from app_private.eligible_guardian_absence_alerts(null) eligible
        where eligible.read_at is null
      )
    returning 1
  )
  select count(*) from marked;
$$;

create function public.mark_all_guardian_absence_alerts_read()
returns bigint language sql security invoker set search_path = ''
as $$ select app_private.mark_all_guardian_absence_alerts_read(); $$;

revoke all on function
  app_private.mark_all_guardian_absence_alerts_read(),
  public.mark_all_guardian_absence_alerts_read()
from public, anon, authenticated, service_role;

grant execute on function
  app_private.mark_all_guardian_absence_alerts_read(),
  public.mark_all_guardian_absence_alerts_read()
to authenticated;

commit;
