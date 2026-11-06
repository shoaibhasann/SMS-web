create policy enrollments_teacher_assigned_read on public.enrollments for select to authenticated using (
  app_private.is_teacher()
  and exists (
    select 1
    from public.teacher_subject_assignments a
    where a.teacher_id = app_private.current_teacher_id()
      and a.academic_year_id = enrollments.academic_year_id
      and a.class_id = enrollments.class_id
      and (a.section_id is null or a.section_id = enrollments.section_id)
  )
);