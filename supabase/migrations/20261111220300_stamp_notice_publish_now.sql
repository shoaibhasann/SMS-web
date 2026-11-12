begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

-- web-notices#4: "Publish now" (admin save with today's date, the list Publish
-- toggle, teacher notices) sends the browser clock. A fast office PC silently
-- scheduled the notice; a slow one backdated it. A published_at within 30 minutes
-- of the database clock is publish-now intent and is stamped with that clock.
-- Real schedules (UI: a future date at 09:00 IST), historic values and unchanged
-- resends are left alone. AFTER triggers (family publication, push timing) see
-- the stamped value.
create function app_private.stamp_notice_publish_now()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  if new.published_at is not null and isfinite(new.published_at)
    and (tg_op = 'INSERT' or new.published_at is distinct from old.published_at)
    and new.published_at between pg_catalog.statement_timestamp() - interval '30 minutes'
                             and pg_catalog.statement_timestamp() + interval '30 minutes' then
    new.published_at := pg_catalog.statement_timestamp();
  end if;
  return new;
end;
$function$;

create trigger stamp_notice_publish_now before insert or update of published_at on public.notices
for each row execute function app_private.stamp_notice_publish_now();

revoke all on function app_private.stamp_notice_publish_now() from public,anon,authenticated,service_role;
commit;
