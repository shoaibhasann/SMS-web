-- Class Teacher / Attendance Register foundation
-- 1) One teacher can be class teacher for only one class/section in an academic year.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_class_teacher_per_teacher_year
ON public.teacher_subject_assignments (teacher_id, academic_year_id)
WHERE is_class_teacher = true;

-- One class/section can have only one class teacher in an academic year.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_class_teacher_per_class_section_year
ON public.teacher_subject_assignments (
  academic_year_id,
  class_id,
  COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid)
)
WHERE is_class_teacher = true;

-- 2) Register a student directly into the current class-teacher's own class/section.
CREATE OR REPLACE FUNCTION public.register_student_for_class_teacher(p_full_name text)
RETURNS TABLE(student_id uuid, admission_no text, roll_no text, class_id uuid, section_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_teacher_id uuid;
  v_school_id uuid;
  v_year_id uuid;
  v_class_id uuid;
  v_section_id uuid;
  v_first_name text;
  v_middle_name text;
  v_last_name text;
  v_student_id uuid;
  v_admission_no text;
  v_roll_no text;
  v_next_admission bigint;
  v_next_roll bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF trim(coalesce(p_full_name, '')) = '' THEN
    RAISE EXCEPTION 'Student name is required';
  END IF;

  v_teacher_id := app_private.current_teacher_id();
  IF v_teacher_id IS NULL OR NOT app_private.is_teacher() THEN
    RAISE EXCEPTION 'Teacher access required';
  END IF;

  SELECT t.school_id INTO v_school_id
  FROM public.teachers t
  WHERE t.id = v_teacher_id;

  SELECT ay.id INTO v_year_id
  FROM public.academic_years ay
  WHERE ay.school_id = v_school_id AND ay.is_current = true
  ORDER BY ay.start_date DESC
  LIMIT 1;

  SELECT a.class_id, a.section_id INTO v_class_id, v_section_id
  FROM public.teacher_subject_assignments a
  WHERE a.teacher_id = v_teacher_id
    AND a.academic_year_id = v_year_id
    AND a.is_class_teacher = true
  LIMIT 1;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'This teacher is not assigned as a class teacher';
  END IF;

  -- Serialize admission/roll generation per school.
  PERFORM pg_advisory_xact_lock(hashtext(v_school_id::text || ':student-register'));

  SELECT COALESCE(MAX(substring(s.admission_no from 'KC-ST-([0-9]+)')::bigint), 0) + 1
  INTO v_next_admission
  FROM public.students s
  WHERE s.school_id = v_school_id
    AND s.admission_no ~ '^KC-ST-[0-9]+$';

  v_admission_no := 'KC-ST-' || lpad(v_next_admission::text, 3, '0');

  SELECT COALESCE(MAX(e.roll_no::bigint), 0) + 1
  INTO v_next_roll
  FROM public.enrollments e
  WHERE e.academic_year_id = v_year_id
    AND e.class_id = v_class_id
    AND (e.section_id IS NOT DISTINCT FROM v_section_id)
    AND e.roll_no ~ '^[0-9]+$';

  v_roll_no := v_next_roll::text;

  v_first_name := split_part(trim(p_full_name), ' ', 1);
  v_last_name := CASE
    WHEN array_length(regexp_split_to_array(trim(p_full_name), '\s+'), 1) > 1
    THEN (regexp_split_to_array(trim(p_full_name), '\s+'))[array_length(regexp_split_to_array(trim(p_full_name), '\s+'), 1)]
    ELSE NULL
  END;
  v_middle_name := NULL;

  INSERT INTO public.students (
    school_id, admission_no, roll_no, first_name, middle_name, last_name,
    admission_date, status
  ) VALUES (
    v_school_id, v_admission_no, v_roll_no, v_first_name, v_middle_name, v_last_name,
    current_date, 'active'
  )
  RETURNING id INTO v_student_id;

  INSERT INTO public.enrollments (
    student_id, academic_year_id, class_id, section_id, roll_no, status
  ) VALUES (
    v_student_id, v_year_id, v_class_id, v_section_id, v_roll_no, 'active'
  );

  RETURN QUERY SELECT v_student_id, v_admission_no, v_roll_no, v_class_id, v_section_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_student_for_class_teacher(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_student_for_class_teacher(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_student_for_class_teacher(text) TO authenticated;

-- 3) Attendance can be created/updated by the class teacher of the student's enrolled class only.
DROP POLICY IF EXISTS attendance_teacher_assigned ON public.attendance;
CREATE POLICY attendance_class_teacher_manage
ON public.attendance
FOR ALL
TO authenticated
USING (
  app_private.is_teacher()
  AND EXISTS (
    SELECT 1
    FROM public.enrollments e
    JOIN public.teacher_subject_assignments a
      ON a.academic_year_id = e.academic_year_id
     AND a.class_id = e.class_id
     AND a.section_id IS NOT DISTINCT FROM e.section_id
     AND a.teacher_id = app_private.current_teacher_id()
     AND a.is_class_teacher = true
    WHERE e.student_id = attendance.student_id
      AND e.academic_year_id = attendance.academic_year_id
      AND e.status = 'active'
  )
)
WITH CHECK (
  app_private.is_teacher()
  AND EXISTS (
    SELECT 1
    FROM public.enrollments e
    JOIN public.teacher_subject_assignments a
      ON a.academic_year_id = e.academic_year_id
     AND a.class_id = e.class_id
     AND a.section_id IS NOT DISTINCT FROM e.section_id
     AND a.teacher_id = app_private.current_teacher_id()
     AND a.is_class_teacher = true
    WHERE e.student_id = attendance.student_id
      AND e.academic_year_id = attendance.academic_year_id
      AND e.status = 'active'
  )
);

CREATE INDEX IF NOT EXISTS idx_enrollments_class_section_roll
ON public.enrollments (academic_year_id, class_id, section_id, roll_no);

CREATE INDEX IF NOT EXISTS idx_attendance_register_date_section
ON public.attendance (academic_year_id, section_id, attendance_date, student_id);
