begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.staff add column full_name text,
  add constraint staff_full_name_valid
    check (full_name is null or (char_length(btrim(full_name)) between 1 and 160 and full_name !~ '[[:cntrl:]]'));

-- Directory records may be created without an auth profile. School accounts
-- write through the governed import rather than assigning profile links.
revoke all on public.staff from public, anon, authenticated;
grant select on public.staff to authenticated;

create function app_private.can_read_staff_directory(p_school_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select app_private.can_manage_teachers((select auth.uid()), p_school_id);
$$;

revoke all on function app_private.can_read_staff_directory(uuid) from public, anon, authenticated, service_role;
grant execute on function app_private.can_read_staff_directory(uuid) to authenticated;

drop policy tenant_isolation_staff on public.staff;
create policy staff_directory_manager_read on public.staff
for select to authenticated using (app_private.can_read_staff_directory(school_id));

commit;
