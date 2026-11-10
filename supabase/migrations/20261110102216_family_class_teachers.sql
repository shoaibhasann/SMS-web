begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Families get classroom labels through their verified own/linked child only.
create function app_private.get_family_class_teachers(p_role text, p_student_id uuid)
returns jsonb language sql volatile security definer set search_path = ''
as $$
  with scope as materialized (
    select app_private.family_attendance_report_school(p_role, p_student_id) as school_id
  ), placement as (
    select e.academic_year_id, y.name as year_name, c.id as class_id, c.name as class_name,
      e.section_id, section.name as section_name
    from scope
    join public.schools school on school.id = scope.school_id and school.is_active
    join public.students student on student.id = p_student_id and student.school_id = school.id and student.status = 'active'
    join public.enrollments e on e.student_id = student.id and e.status = 'active'
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = school.id and y.is_current
    join public.classes c on c.id = e.class_id and c.school_id = school.id and c.is_active
    left join public.sections section on section.id = e.section_id and section.school_id = school.id and section.class_id = c.id
    where (e.section_id is null or section.id is not null)
      and (select count(*) from public.academic_years current_year where current_year.school_id = school.id and current_year.is_current) = 1
  ), teachers as (
    select t.id, btrim(t.full_name) as name, bool_or(a.is_class_teacher) as is_class_teacher,
      array_agg(distinct subject.name order by subject.name) as subjects
    from scope
    cross join placement
    join public.teacher_subject_assignments a on a.academic_year_id = placement.academic_year_id and a.class_id = placement.class_id
      and (a.section_id is null or a.section_id = placement.section_id)
      and (not a.is_class_teacher or a.section_id = placement.section_id)
    join public.teachers t on t.id = a.teacher_id and t.school_id = scope.school_id and btrim(t.full_name) <> ''
    join public.subjects subject on subject.id = a.subject_id and subject.school_id = scope.school_id and subject.is_active
    where t.profile_id is null or exists (
      select 1 from public.profiles profile
      join public.user_roles role on role.user_id = profile.id and role.school_id = t.school_id and role.role = 'teacher'
      where profile.id = t.profile_id and profile.school_id = t.school_id and profile.is_active
    )
    group by t.id, t.full_name
  )
  select jsonb_build_object('user_id', auth.uid(), 'student_id', p_student_id, 'role', p_role, 'school_id', scope.school_id,
    'academic_year_name', placement.year_name, 'class_name', placement.class_name, 'section_name', placement.section_name,
    'teachers', coalesce((select jsonb_agg(to_jsonb(teachers) order by is_class_teacher desc, name, id) from teachers), '[]'::jsonb))
  from scope left join placement on true;
$$;

create function public.get_family_class_teachers(p_role text, p_student_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$select app_private.get_family_class_teachers(p_role, p_student_id);$$;

revoke all on function public.get_family_class_teachers(text, uuid), app_private.get_family_class_teachers(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_family_class_teachers(text, uuid), app_private.get_family_class_teachers(text, uuid)
  to authenticated;
notify pgrst, 'reload schema';
commit;
