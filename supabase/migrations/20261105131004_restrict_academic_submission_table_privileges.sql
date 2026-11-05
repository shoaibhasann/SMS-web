begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- RLS controls row operations, not TRUNCATE or DDL-related privileges. The
-- legacy blanket grants must not give API roles a table-wide escape hatch.
revoke all on table public.activity_submissions from public, anon;
revoke truncate, references, trigger on table public.activity_submissions from authenticated;
do $$ begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on table public.activity_submissions from public, anon, authenticated';
  end if;
end $$;

-- Authenticated SELECT/INSERT/UPDATE/DELETE grants and trusted service access
-- are unchanged; the academic policies and field guards still authorize DML.
commit;
