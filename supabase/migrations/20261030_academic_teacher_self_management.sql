-- Kids Corner Academic Engine v2
-- Teacher self-management + draft/publish lifecycle.
-- Review against the existing project's policies before applying in production.

alter table public.class_logs
  add column if not exists status text not null default 'draft',
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid references auth.users(id);

alter table public.class_logs
  drop constraint if exists class_logs_status_check;

alter table public.class_logs
  add constraint class_logs_status_check check (status in ('draft','published'));

create index if not exists class_logs_teacher_date_idx
  on public.class_logs (teacher_id, log_date desc);

create index if not exists class_logs_status_idx
  on public.class_logs (status, log_date desc);

-- Business rules: one class teacher per class/section, and one class-teacher
-- assignment per teacher. Subject-teacher assignments remain unrestricted.
create unique index if not exists teacher_one_class_teacher_idx
  on public.teacher_subject_assignments (teacher_id)
  where is_class_teacher = true;

create unique index if not exists section_one_class_teacher_idx
  on public.teacher_subject_assignments (section_id)
  where is_class_teacher = true;

-- Teacher self-management. These policies are additive: existing school-admin
-- policies continue to work. The teacher can only touch rows tied to their own
-- teacher profile.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='teacher_subject_assignments' and policyname='teachers_manage_own_assignments_select') then
    create policy teachers_manage_own_assignments_select
      on public.teacher_subject_assignments for select to authenticated
      using (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='teacher_subject_assignments' and policyname='teachers_manage_own_assignments_insert') then
    create policy teachers_manage_own_assignments_insert
      on public.teacher_subject_assignments for insert to authenticated
      with check (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='teacher_subject_assignments' and policyname='teachers_manage_own_assignments_update') then
    create policy teachers_manage_own_assignments_update
      on public.teacher_subject_assignments for update to authenticated
      using (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())))
      with check (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='teacher_subject_assignments' and policyname='teachers_manage_own_assignments_delete') then
    create policy teachers_manage_own_assignments_delete
      on public.teacher_subject_assignments for delete to authenticated
      using (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_logs' and policyname='teachers_manage_own_class_logs_insert') then
    create policy teachers_manage_own_class_logs_insert
      on public.class_logs for insert to authenticated
      with check (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_logs' and policyname='teachers_manage_own_class_logs_update') then
    create policy teachers_manage_own_class_logs_update
      on public.class_logs for update to authenticated
      using (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())))
      with check (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_logs' and policyname='teachers_manage_own_class_logs_delete') then
    create policy teachers_manage_own_class_logs_delete
      on public.class_logs for delete to authenticated
      using (teacher_id = (select t.id from public.teachers t where t.user_id = (select auth.uid())));
  end if;
end $$;

-- Activities are editable only through the teacher's own class log.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_activities' and policyname='teachers_manage_own_class_activities_insert') then
    create policy teachers_manage_own_class_activities_insert
      on public.class_activities for insert to authenticated
      with check (exists (
        select 1 from public.class_logs cl
        join public.teachers t on t.id = cl.teacher_id
        where cl.id = class_log_id and t.user_id = (select auth.uid())
      ));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_activities' and policyname='teachers_manage_own_class_activities_update') then
    create policy teachers_manage_own_class_activities_update
      on public.class_activities for update to authenticated
      using (exists (
        select 1 from public.class_logs cl
        join public.teachers t on t.id = cl.teacher_id
        where cl.id = class_log_id and t.user_id = (select auth.uid())
      ));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='class_activities' and policyname='teachers_manage_own_class_activities_delete') then
    create policy teachers_manage_own_class_activities_delete
      on public.class_activities for delete to authenticated
      using (exists (
        select 1 from public.class_logs cl
        join public.teachers t on t.id = cl.teacher_id
        where cl.id = class_log_id and t.user_id = (select auth.uid())
      ));
  end if;
end $$;

-- Student/parent clients should query only status='published' when consuming
-- academic work. Keep existing policies intact rather than replacing unknown
-- project-specific policies in this migration.
