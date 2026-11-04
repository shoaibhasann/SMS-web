begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter policy study_materials_student_read on public.study_materials
  using (exists (
    select 1
    from public.enrollments e
    join public.academic_years y on y.id = e.academic_year_id
    join public.students s on s.id = e.student_id and s.school_id = y.school_id
    where s.id = (select app_private.current_student_id())
      and s.school_id = study_materials.school_id
      and (study_materials.class_id is null or study_materials.class_id = e.class_id)
      and (study_materials.section_id is null or study_materials.section_id = e.section_id)
  ));

commit;
