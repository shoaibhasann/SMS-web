drop policy if exists teacher_assignments_teacher_own on public.teacher_subject_assignments;

create policy teacher_assignments_teacher_own_select
on public.teacher_subject_assignments
for select
to authenticated
using (teacher_id = app_private.current_teacher_id());

create policy teacher_assignments_teacher_own_insert
on public.teacher_subject_assignments
for insert
to authenticated
with check (teacher_id = app_private.current_teacher_id());

create policy teacher_assignments_teacher_own_update
on public.teacher_subject_assignments
for update
to authenticated
using (teacher_id = app_private.current_teacher_id())
with check (teacher_id = app_private.current_teacher_id());

create policy teacher_assignments_teacher_own_delete
on public.teacher_subject_assignments
for delete
to authenticated
using (teacher_id = app_private.current_teacher_id());