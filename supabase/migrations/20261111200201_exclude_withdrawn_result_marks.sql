begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog;

-- A pupil withdrawn from this assessment's class/section no longer blocks the
-- class publication: their saved mark is kept (still listed in _outside_marks)
-- but is excluded from the snapshot. Other out-of-roster marks still block.
-- The output shape is unchanged, so existing pending source tokens stay valid.
create or replace function app_private.assessment_result_source(p_assessment_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
with metadata as(select * from app_private.assessment_result_metadata where assessment_id=p_assessment_id),
raw_roster as(
  select e.id as enrollment_id,e.student_id,e.section_id,e.roll_no,sec.name as section_name,
    s.admission_no,concat_ws(' ',s.first_name,nullif(s.middle_name,''),nullif(s.last_name,'')) as student_name,
    coalesce(s.school_id=m.school_id and s.status='active' and(e.section_id is null or sec.id is not null),false) as coherent
  from metadata m join public.enrollments e on e.academic_year_id=m.academic_year_id and e.class_id=m.class_id
    and e.status='active' and(m.section_id is null or e.section_id=m.section_id)
  left join public.students s on s.id=e.student_id and s.school_id=m.school_id
  left join public.sections sec on sec.id=e.section_id and sec.class_id=e.class_id and sec.school_id=m.school_id
),roster as(
  select r.*,mark.id as mark_id,mark.marks_obtained,mark.remarks,mark.updated_at as mark_updated_at,mark.updated_by as mark_updated_by
  from raw_roster r left join public.teacher_assessment_marks mark on mark.assessment_id=p_assessment_id and mark.student_id=r.student_id where r.coherent
),outside_marks as(
  select mark.* from public.teacher_assessment_marks mark where mark.assessment_id=p_assessment_id
    and not exists(select 1 from roster r where r.student_id=mark.student_id)
),issues as(
  select array_remove(array[
    case when m.status<>'completed' then 'Complete the assessment before submitting results.' end,
    case when not app_private.result_source_eligible(p_assessment_id) then 'The current assignment or school placement is unavailable.' end,
    case when m.maximum_marks::text in('NaN','Infinity','-Infinity') or m.maximum_marks<=0 or m.maximum_marks<>round(m.maximum_marks,2)
      then 'The assessment maximum must be finite, positive and have at most two decimal places.' end,
    case when not exists(select 1 from roster) then 'No active coherent pupils are available for this assessment.' end,
    case when exists(select 1 from raw_roster where not coherent) then 'Some enrollment records are inconsistent. Contact the school office.' end,
    case when exists(select 1 from roster where mark_id is null) then 'Save a score for every active pupil. Missing scores are not zero.' end,
    case when exists(select 1 from roster where marks_obtained::text in('NaN','Infinity','-Infinity') or marks_obtained<0
      or marks_obtained>m.maximum_marks or marks_obtained<>round(marks_obtained,2) or not isfinite(mark_updated_at))
      then 'Some saved marks or versions are invalid. Review them before submitting.' end,
    case when exists(select 1 from outside_marks o where not exists(select 1 from public.enrollments e where e.student_id=o.student_id
      and e.academic_year_id=m.academic_year_id and e.class_id=m.class_id and(m.section_id is null or e.section_id=m.section_id) and e.status='withdrawn'))
      then 'Saved marks exist outside the current class roster. Resolve placement before submitting.' end,
    case when not isfinite(m.assessment_updated_at) then 'The assessment version is invalid.' end
  ],null) as messages from metadata m
)
select jsonb_build_object('metadata',to_jsonb(m)-'teacher_profile',
  'pupils',coalesce((select jsonb_agg(jsonb_build_object('student_id',r.student_id,'student_name',r.student_name,'admission_no',r.admission_no,
    'roll_no',r.roll_no,'section_id',r.section_id,'section_name',r.section_name,'enrollment_id',r.enrollment_id,
    'mark_id',r.mark_id,'marks_obtained',r.marks_obtained,'remarks',r.remarks,'mark_updated_at',r.mark_updated_at,'mark_updated_by',r.mark_updated_by)
    order by r.student_id,r.enrollment_id) from roster r),'[]'::jsonb),
  '_outside_marks',coalesce((select jsonb_agg(to_jsonb(o) order by o.student_id,o.id) from outside_marks o),'[]'::jsonb),
  '_inconsistent_enrollments',(select count(*) from raw_roster where not coherent),
  'can_submit',cardinality(i.messages)=0,'issues',to_jsonb(i.messages))
from metadata m cross join issues i;
$$;

revoke all on function app_private.assessment_result_source(uuid) from public,anon,authenticated,service_role;
commit;
