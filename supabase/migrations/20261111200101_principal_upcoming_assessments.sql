-- Principals stay denied raw teacher_assessments / marks rows, but their
-- dashboard needs the school's real upcoming test schedule (read-only).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.list_principal_upcoming_assessments(p_school_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_school_id is null or not app_private.has_school_roles(p_school_id, array['principal']::public.app_role[]) then
    raise exception 'Principal access to this school is required.' using errcode = '42501';
  end if;
  -- Both ends count: a 31-day window spans p_to - p_from = 30.
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    raise exception 'Choose an upcoming window of at most 31 days.' using errcode = '22023';
  end if;
  with permitted as (
    select assessment.id, assessment.name, assessment.assessment_date, assessment.maximum_marks,
      assessment.class_id, assessment.section_id, assessment.subject_id
    from public.teacher_assessments assessment
    where assessment.school_id = p_school_id and assessment.assessment_date between p_from and p_to
      and app_private.assessment_scope_is_coherent(assessment.teacher_id, assessment.school_id, assessment.academic_year_id,
        assessment.class_id, assessment.section_id, assessment.subject_id)
  ), page as (select * from permitted order by assessment_date, id limit 10)
  select jsonb_build_object('total_count', (select count(*) from permitted),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by page.assessment_date, page.id) from page), '[]'::jsonb)) into result;
  return result;
end;
$$;

create function public.list_principal_upcoming_assessments(p_school_id uuid, p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_principal_upcoming_assessments(p_school_id, p_from, p_to); $$;

revoke all on function app_private.list_principal_upcoming_assessments(uuid, date, date),
  public.list_principal_upcoming_assessments(uuid, date, date) from public, anon, authenticated, service_role;
grant execute on function app_private.list_principal_upcoming_assessments(uuid, date, date),
  public.list_principal_upcoming_assessments(uuid, date, date) to authenticated;

commit;
