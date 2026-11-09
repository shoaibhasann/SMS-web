begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Before publication, an unsent job follows edits to either part of its delivery window.
create or replace function app_private.update_native_announcement_push_timing()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce(isfinite(new.published_at), false) then
    update app_private.family_push_jobs set status = 'cancelled', finished_at = statement_timestamp(), result_code = 'no_longer_eligible'
    where kind = 'announcement' and event_id = new.id and status in ('queued', 'leased');
    return new;
  end if;

  if old.published_at > statement_timestamp() then
    update app_private.family_push_jobs
    set next_attempt_at = greatest(statement_timestamp(), new.published_at),
      expires_at = least(new.published_at + interval '24 hours', new.expires_at)
    where kind = 'announcement' and event_id = new.id and status = 'queued' and attempts = 0;
  end if;

  if new.expires_at is not null and new.expires_at is distinct from old.expires_at then
    update app_private.family_push_jobs set expires_at = new.expires_at
    where kind = 'announcement' and event_id = new.id and status in ('queued', 'leased')
      and expires_at > new.expires_at;
  end if;
  return new;
end;
$$;

commit;
