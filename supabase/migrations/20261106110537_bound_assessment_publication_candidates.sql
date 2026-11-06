begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
begin
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=pg_catalog.to_regprocedure('app_private.list_assessment_publication_candidates()')
      and p.prosecdef and p.prorettype='jsonb'::regtype and p.proconfig @> array['search_path=""']) then
    raise exception 'Apply the governed assessment-publication workflow before bounding its candidate read.';
  end if;
end;
$preflight$;

-- Bound the expensive permission predicate to this teacher before expanding metadata joins.
create or replace function app_private.list_assessment_publication_candidates()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform app_private.result_actor();
  return coalesce((select jsonb_agg(to_jsonb(m)-'teacher_profile' order by m.assessment_date desc,m.assessment_id)
    from app_private.assessment_result_metadata m where m.teacher_profile=(select auth.uid())
      and app_private.result_teacher_access(m.assessment_id)),'[]'::jsonb);
end;
$$;
commit;
