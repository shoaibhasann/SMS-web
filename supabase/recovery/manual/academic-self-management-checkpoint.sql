-- Reconstructed application checkpoint, NOT original migration bytes.
-- Source: supabase/schema-snapshots/2026-11-02/schema-metadata.json
-- Source SHA-256: c98134634ffc72d11c94e2042d4b1ee625094db56e21cb90ba0bca75823dad97
-- Offline recovery only; historical permissions are subsequently hardened.
begin;
set local search_path=public,pg_catalog;

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


create policy "teachers_manage_own_class_activities_delete" on "public"."class_activities" as PERMISSIVE for DELETE to "authenticated" using ((EXISTS ( SELECT 1
   FROM (class_logs cl
     JOIN teachers t ON ((t.id = cl.teacher_id)))
  WHERE ((cl.id = class_activities.class_log_id) AND (t.profile_id = ( SELECT auth.uid() AS uid))))));
create policy "teachers_manage_own_class_activities_insert" on "public"."class_activities" as PERMISSIVE for INSERT to "authenticated" with check ((EXISTS ( SELECT 1
   FROM (class_logs cl
     JOIN teachers t ON ((t.id = cl.teacher_id)))
  WHERE ((cl.id = class_activities.class_log_id) AND (t.profile_id = ( SELECT auth.uid() AS uid))))));
create policy "teachers_manage_own_class_activities_update" on "public"."class_activities" as PERMISSIVE for UPDATE to "authenticated" using ((EXISTS ( SELECT 1
   FROM (class_logs cl
     JOIN teachers t ON ((t.id = cl.teacher_id)))
  WHERE ((cl.id = class_activities.class_log_id) AND (t.profile_id = ( SELECT auth.uid() AS uid)))))) with check ((EXISTS ( SELECT 1
   FROM (class_logs cl
     JOIN teachers t ON ((t.id = cl.teacher_id)))
  WHERE ((cl.id = class_activities.class_log_id) AND (t.profile_id = ( SELECT auth.uid() AS uid))))));
create policy "teachers_manage_own_class_logs_delete" on "public"."class_logs" as PERMISSIVE for DELETE to "authenticated" using ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_class_logs_insert" on "public"."class_logs" as PERMISSIVE for INSERT to "authenticated" with check ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_class_logs_update" on "public"."class_logs" as PERMISSIVE for UPDATE to "authenticated" using ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid))))) with check ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_assignments_delete" on "public"."teacher_subject_assignments" as PERMISSIVE for DELETE to "authenticated" using ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_assignments_insert" on "public"."teacher_subject_assignments" as PERMISSIVE for INSERT to "authenticated" with check ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_assignments_select" on "public"."teacher_subject_assignments" as PERMISSIVE for SELECT to "authenticated" using ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
create policy "teachers_manage_own_assignments_update" on "public"."teacher_subject_assignments" as PERMISSIVE for UPDATE to "authenticated" using ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid))))) with check ((teacher_id = ( SELECT t.id
   FROM teachers t
  WHERE (t.profile_id = ( SELECT auth.uid() AS uid)))));
-- The snapshot also records publication checks absent from the older ledger.
drop policy "class_activities_parent_read" on public."class_activities";
create policy "class_activities_parent_read" on "public"."class_activities" as PERMISSIVE for SELECT to "authenticated" using ((EXISTS ( SELECT 1
   FROM ((class_logs l
     JOIN enrollments e ON (((e.class_id = l.class_id) AND (e.academic_year_id = l.academic_year_id) AND ((l.section_id IS NULL) OR (e.section_id = l.section_id)))))
     JOIN student_parents sp ON ((sp.student_id = e.student_id)))
  WHERE ((l.id = class_activities.class_log_id) AND (l.status = 'published'::text) AND (sp.parent_id = app_private.current_parent_id())))));
drop policy "class_activities_student_read" on public."class_activities";
create policy "class_activities_student_read" on "public"."class_activities" as PERMISSIVE for SELECT to "authenticated" using ((EXISTS ( SELECT 1
   FROM (class_logs l
     JOIN enrollments e ON (((e.class_id = l.class_id) AND (e.academic_year_id = l.academic_year_id) AND ((l.section_id IS NULL) OR (e.section_id = l.section_id)))))
  WHERE ((l.id = class_activities.class_log_id) AND (l.status = 'published'::text) AND (e.student_id = app_private.current_student_id())))));
drop policy "class_logs_parent_read" on public."class_logs";
create policy "class_logs_parent_read" on "public"."class_logs" as PERMISSIVE for SELECT to "authenticated" using (((status = 'published'::text) AND (EXISTS ( SELECT 1
   FROM (student_parents sp
     JOIN enrollments e ON ((e.student_id = sp.student_id)))
  WHERE ((sp.parent_id = app_private.current_parent_id()) AND (e.academic_year_id = class_logs.academic_year_id) AND (e.class_id = class_logs.class_id) AND ((class_logs.section_id IS NULL) OR (e.section_id = class_logs.section_id)))))));
drop policy "class_logs_student_read" on public."class_logs";
create policy "class_logs_student_read" on "public"."class_logs" as PERMISSIVE for SELECT to "authenticated" using (((status = 'published'::text) AND (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.student_id = app_private.current_student_id()) AND (e.academic_year_id = class_logs.academic_year_id) AND (e.class_id = class_logs.class_id) AND ((class_logs.section_id IS NULL) OR (e.section_id = class_logs.section_id)))))));
commit;
