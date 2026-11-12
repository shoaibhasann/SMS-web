begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Result reports resolve the pupils behind marks the caller can already read
-- through the assessment's scope. Teacher pupil reads follow current
-- enrollment, so a same-session section move would otherwise hide the pupil
-- behind a still-visible mark and break the whole report.
create function app_private.list_assessment_result_students(p_school_id uuid, p_assessment_ids uuid[])
returns table (id uuid, admission_no text, first_name text, middle_name text, last_name text, roll_no text)
language sql stable security definer set search_path = ''
as $function$
  -- materialized: run the SECURITY DEFINER access check once per assessment, not per mark row.
  with allowed as materialized (
    select a.id from public.teacher_assessments a
    where a.school_id = p_school_id and a.id = any(p_assessment_ids) and app_private.assessment_access(a.id)
  )
  select s.id, s.admission_no, s.first_name, s.middle_name, s.last_name, s.roll_no
  from public.students s
  where s.school_id = p_school_id and exists (
    select 1 from public.teacher_assessment_marks m join allowed on allowed.id = m.assessment_id
    where m.student_id = s.id
  );
$function$;

create function public.list_assessment_result_students(p_school_id uuid, p_assessment_ids uuid[])
returns table (id uuid, admission_no text, first_name text, middle_name text, last_name text, roll_no text)
language sql stable security invoker set search_path = ''
as $function$
  select * from app_private.list_assessment_result_students(p_school_id, p_assessment_ids);
$function$;

revoke all on function
  app_private.list_assessment_result_students(uuid, uuid[]),
  public.list_assessment_result_students(uuid, uuid[])
from public, anon, authenticated, service_role;
grant execute on function
  app_private.list_assessment_result_students(uuid, uuid[]),
  public.list_assessment_result_students(uuid, uuid[])
to authenticated;

commit;
