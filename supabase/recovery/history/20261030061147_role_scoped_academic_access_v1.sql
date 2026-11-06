create schema if not exists app_private;

create or replace function app_private.current_roles()
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(array_agg(ur.role::text), '{}') from public.user_roles ur where ur.user_id = auth.uid(); $$;

create or replace function app_private.is_school_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role::text in ('super_admin','school_admin','principal','accountant','reception_staff')); $$;

create or replace function app_private.is_teacher()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role::text = 'teacher'); $$;

create or replace function app_private.current_teacher_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select t.id from public.teachers t where t.profile_id = auth.uid() limit 1; $$;

create or replace function app_private.current_student_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select s.id from public.students s where s.profile_id = auth.uid() limit 1; $$;

create or replace function app_private.current_parent_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select p.id from public.parents p where p.profile_id = auth.uid() limit 1; $$;

create or replace function app_private.teacher_assignment_exists(p_class_id uuid,p_section_id uuid,p_subject_id uuid,p_academic_year_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.teacher_subject_assignments a where a.teacher_id = app_private.current_teacher_id() and a.class_id = p_class_id and (p_section_id is null or a.section_id = p_section_id) and a.subject_id = p_subject_id and a.academic_year_id = p_academic_year_id); $$;

revoke all on function app_private.current_roles() from public;
revoke all on function app_private.is_school_admin() from public;
revoke all on function app_private.is_teacher() from public;
revoke all on function app_private.current_teacher_id() from public;
revoke all on function app_private.current_student_id() from public;
revoke all on function app_private.current_parent_id() from public;
revoke all on function app_private.teacher_assignment_exists(uuid,uuid,uuid,uuid) from public;
grant execute on function app_private.current_roles() to authenticated;
grant execute on function app_private.is_school_admin() to authenticated;
grant execute on function app_private.is_teacher() to authenticated;
grant execute on function app_private.current_teacher_id() to authenticated;
grant execute on function app_private.current_student_id() to authenticated;
grant execute on function app_private.current_parent_id() to authenticated;
grant execute on function app_private.teacher_assignment_exists(uuid,uuid,uuid,uuid) to authenticated;

drop policy if exists tenant_isolation_class_logs on public.class_logs;
drop policy if exists class_activities_tenant on public.class_activities;
drop policy if exists tenant_isolation_attendance on public.attendance;
drop policy if exists tenant_isolation_study_materials on public.study_materials;
drop policy if exists tenant_isolation_notices on public.notices;
drop policy if exists tenant_isolation_timetables on public.timetables;
drop policy if exists enrollments_tenant on public.enrollments;
drop policy if exists student_parents_tenant on public.student_parents;
drop policy if exists tenant_isolation_students on public.students;
drop policy if exists teacher_assignments_tenant on public.teacher_subject_assignments;

create policy class_logs_staff_all on public.class_logs for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy class_logs_teacher_own on public.class_logs for all to authenticated using (app_private.is_teacher() and teacher_id = app_private.current_teacher_id() and app_private.teacher_assignment_exists(class_id,section_id,subject_id,academic_year_id)) with check (app_private.is_teacher() and teacher_id = app_private.current_teacher_id() and app_private.teacher_assignment_exists(class_id,section_id,subject_id,academic_year_id));
create policy class_logs_student_read on public.class_logs for select to authenticated using (exists (select 1 from public.enrollments e where e.student_id=app_private.current_student_id() and e.academic_year_id=class_logs.academic_year_id and e.class_id=class_logs.class_id and (class_logs.section_id is null or e.section_id=class_logs.section_id)));
create policy class_logs_parent_read on public.class_logs for select to authenticated using (exists (select 1 from public.student_parents sp join public.enrollments e on e.student_id=sp.student_id where sp.parent_id=app_private.current_parent_id() and e.academic_year_id=class_logs.academic_year_id and e.class_id=class_logs.class_id and (class_logs.section_id is null or e.section_id=class_logs.section_id)));

create policy class_activities_staff_all on public.class_activities for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy class_activities_teacher_own on public.class_activities for all to authenticated using (app_private.is_teacher() and exists (select 1 from public.class_logs l where l.id=class_activities.class_log_id and l.teacher_id=app_private.current_teacher_id())) with check (app_private.is_teacher() and exists (select 1 from public.class_logs l where l.id=class_activities.class_log_id and l.teacher_id=app_private.current_teacher_id()));
create policy class_activities_student_read on public.class_activities for select to authenticated using (exists (select 1 from public.class_logs l join public.enrollments e on e.class_id=l.class_id and e.academic_year_id=l.academic_year_id and (l.section_id is null or e.section_id=l.section_id) where l.id=class_activities.class_log_id and e.student_id=app_private.current_student_id()));
create policy class_activities_parent_read on public.class_activities for select to authenticated using (exists (select 1 from public.class_logs l join public.enrollments e on e.class_id=l.class_id and e.academic_year_id=l.academic_year_id and (l.section_id is null or e.section_id=l.section_id) join public.student_parents sp on sp.student_id=e.student_id where l.id=class_activities.class_log_id and sp.parent_id=app_private.current_parent_id()));

create policy attendance_staff_all on public.attendance for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy attendance_teacher_assigned on public.attendance for all to authenticated using (app_private.is_teacher() and exists (select 1 from public.enrollments e join public.teacher_subject_assignments a on a.class_id=e.class_id and a.academic_year_id=e.academic_year_id and (a.section_id is null or a.section_id=e.section_id) where e.student_id=attendance.student_id and e.academic_year_id=attendance.academic_year_id and a.teacher_id=app_private.current_teacher_id())) with check (app_private.is_teacher() and exists (select 1 from public.enrollments e join public.teacher_subject_assignments a on a.class_id=e.class_id and a.academic_year_id=e.academic_year_id and (a.section_id is null or a.section_id=e.section_id) where e.student_id=attendance.student_id and e.academic_year_id=attendance.academic_year_id and a.teacher_id=app_private.current_teacher_id()));
create policy attendance_student_read on public.attendance for select to authenticated using (student_id=app_private.current_student_id());
create policy attendance_parent_read on public.attendance for select to authenticated using (exists (select 1 from public.student_parents sp where sp.student_id=attendance.student_id and sp.parent_id=app_private.current_parent_id()));

create policy study_materials_staff_all on public.study_materials for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy study_materials_teacher_own on public.study_materials for all to authenticated using (app_private.is_teacher() and teacher_id=app_private.current_teacher_id()) with check (app_private.is_teacher() and teacher_id=app_private.current_teacher_id());
create policy study_materials_student_read on public.study_materials for select to authenticated using (exists (select 1 from public.enrollments e where e.student_id=app_private.current_student_id() and (study_materials.class_id is null or study_materials.class_id=e.class_id) and (study_materials.section_id is null or study_materials.section_id=e.section_id)));
create policy study_materials_parent_read on public.study_materials for select to authenticated using (exists (select 1 from public.student_parents sp join public.enrollments e on e.student_id=sp.student_id where sp.parent_id=app_private.current_parent_id() and (study_materials.class_id is null or study_materials.class_id=e.class_id) and (study_materials.section_id is null or study_materials.section_id=e.section_id)));

create policy timetables_staff_all on public.timetables for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy timetables_teacher_read on public.timetables for select to authenticated using (teacher_id=app_private.current_teacher_id());
create policy timetables_student_read on public.timetables for select to authenticated using (exists (select 1 from public.enrollments e where e.student_id=app_private.current_student_id() and e.class_id=timetables.class_id and (timetables.section_id is null or e.section_id=timetables.section_id) and e.academic_year_id=timetables.academic_year_id));
create policy timetables_parent_read on public.timetables for select to authenticated using (exists (select 1 from public.student_parents sp join public.enrollments e on e.student_id=sp.student_id where sp.parent_id=app_private.current_parent_id() and e.class_id=timetables.class_id and (timetables.section_id is null or e.section_id=timetables.section_id) and e.academic_year_id=timetables.academic_year_id));

create policy enrollments_staff_all on public.enrollments for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy enrollments_student_own on public.enrollments for select to authenticated using (student_id=app_private.current_student_id());
create policy enrollments_parent_children on public.enrollments for select to authenticated using (exists (select 1 from public.student_parents sp where sp.student_id=enrollments.student_id and sp.parent_id=app_private.current_parent_id()));

create policy students_staff_all on public.students for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy students_teacher_assigned_read on public.students for select to authenticated using (app_private.is_teacher() and exists (select 1 from public.enrollments e join public.teacher_subject_assignments a on a.class_id=e.class_id and a.academic_year_id=e.academic_year_id and (a.section_id is null or a.section_id=e.section_id) where e.student_id=students.id and a.teacher_id=app_private.current_teacher_id()));
create policy students_student_own on public.students for select to authenticated using (id=app_private.current_student_id());
create policy students_parent_children on public.students for select to authenticated using (exists (select 1 from public.student_parents sp where sp.student_id=students.id and sp.parent_id=app_private.current_parent_id()));

create policy student_parents_staff_all on public.student_parents for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy student_parents_parent_own on public.student_parents for select to authenticated using (parent_id=app_private.current_parent_id());

create policy teacher_assignments_staff_all on public.teacher_subject_assignments for all to authenticated using (app_private.is_school_admin()) with check (app_private.is_school_admin());
create policy teacher_assignments_teacher_own on public.teacher_subject_assignments for select to authenticated using (teacher_id=app_private.current_teacher_id());

create policy notices_staff_all on public.notices for all to authenticated using (app_private.is_school_admin() or (app_private.is_teacher() and created_by=auth.uid())) with check (app_private.is_school_admin() or (app_private.is_teacher() and created_by=auth.uid()));
create policy notices_school_read on public.notices for select to authenticated using (school_id in (select public.current_user_school_ids()));