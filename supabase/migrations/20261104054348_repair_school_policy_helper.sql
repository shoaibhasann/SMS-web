-- Use the private school-scope helper after revoking the legacy public role RPC.
-- Match the existing admin_schools_all access: local school admins and global super admins.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter policy schools_admin_all on public.schools
  to authenticated
  using (app_private.has_school_roles(id, array['school_admin']::public.app_role[]))
  with check (app_private.has_school_roles(id, array['school_admin']::public.app_role[]));

commit;
