begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

-- Notices had no update timestamp or revision. A database-issued token covers
-- every writer and avoids stale publication/audience edits, including ABA.
alter table public.notices add column version uuid not null default pg_catalog.gen_random_uuid();

create function app_private.issue_notice_version()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  new.version := pg_catalog.gen_random_uuid();
  return new;
end;
$function$;

create trigger issue_notice_version before insert or update on public.notices
for each row execute function app_private.issue_notice_version();

revoke all on function app_private.issue_notice_version() from public,anon,authenticated,service_role;
-- RLS and all existing notice grants remain unchanged. Trigger invocation does
-- not require granting callers direct EXECUTE on the trigger function.
commit;
