create policy parents_admin_all on public.parents
for all to authenticated
using (app_private.is_school_admin())
with check (app_private.is_school_admin());

create policy parents_parent_own on public.parents
for select to authenticated
using (id = app_private.current_parent_id());