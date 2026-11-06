begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $preflight$
begin
  if not exists (select 1 from pg_catalog.pg_trigger
    where tgrelid='public.teacher_assessments'::regclass and tgname='aa_guard_assessment_write'
      and tgfoid=pg_catalog.to_regprocedure('app_private.guard_assessment_write()')
      and tgenabled in ('O','A') and not tgisinternal)
    or not exists (select 1 from pg_catalog.pg_trigger
      where tgrelid='public.teacher_assessment_marks'::regclass and tgname='teacher_assessment_marks_validate'
        and tgfoid=pg_catalog.to_regprocedure('app_private.guard_assessment_mark_write()')
        and tgenabled in ('O','A') and not tgisinternal) then
    raise exception 'Apply the assessment access-hardening migration before optimistic mark writes.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc
    where oid=pg_catalog.to_regprocedure('public.teacher_assessment_set_updated_at()')
      and prorettype='pg_catalog.trigger'::regtype) then
    raise exception 'Expected the existing assessment timestamp trigger function.';
  end if;
end;
$preflight$;

-- A no-op update and an ABA edit must still invalidate the old version, even
-- within one transaction or if the system clock moves backwards. Keep its ACL.
create or replace function public.teacher_assessment_set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := greatest(pg_catalog.clock_timestamp(),case when pg_catalog.isfinite(old.updated_at)
    then old.updated_at + interval '1 microsecond' else '-infinity'::timestamptz end);
  return new;
end;
$$;

-- Preserve per-pupil partial-save behavior while making each pupil's parent
-- context and loaded mark comparison one atomic, RLS-governed operation.
create function public.save_assessment_mark(
  p_assessment_id uuid,
  p_expected_assessment_updated_at timestamptz,
  p_student_id uuid,
  p_mark_id uuid,
  p_expected_mark_updated_at timestamptz,
  p_expected_marks numeric,
  p_expected_remarks text,
  p_marks numeric,
  p_remarks text
)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  assessment public.teacher_assessments%rowtype;
  saved public.teacher_assessment_marks%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if p_assessment_id is null or p_student_id is null or p_expected_assessment_updated_at is null
    or not pg_catalog.isfinite(p_expected_assessment_updated_at)
    or p_marks is null or p_marks::text in ('NaN','Infinity','-Infinity')
    or p_marks < 0 or p_marks <> pg_catalog.round(p_marks,2) then
    raise exception 'A valid assessment version, pupil and score are required.' using errcode='22023';
  end if;
  if (p_mark_id is null and (p_expected_mark_updated_at is not null or p_expected_marks is not null or p_expected_remarks is not null))
    or (p_mark_id is not null and (p_expected_mark_updated_at is null or p_expected_marks is null))
    or (p_expected_mark_updated_at is not null and not pg_catalog.isfinite(p_expected_mark_updated_at)) then
    raise exception 'The loaded mark identity and version are incomplete.' using errcode='22023';
  end if;

  -- Start with the strongest parent lock used by the mark guard, avoiding a
  -- SHARE-to-UPDATE upgrade when two grading requests arrive together.
  select * into assessment from public.teacher_assessments
  where id=p_assessment_id for update;
  if not found or assessment.updated_at is distinct from p_expected_assessment_updated_at then
    raise exception 'Assessment changed or access is unavailable. Reload before saving marks.' using errcode='40001';
  end if;
  if assessment.maximum_marks::text in ('NaN','Infinity','-Infinity') or assessment.maximum_marks <= 0
    or p_marks > assessment.maximum_marks then
    raise exception 'Score must be within the current assessment maximum.' using errcode='22023';
  end if;

  if p_mark_id is null then
    -- The existing unique key rejects a competing first mark; never upsert it.
    insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained,remarks)
    values(p_assessment_id,p_student_id,p_marks,nullif(pg_catalog.btrim(p_remarks),''))
    returning * into saved;
  else
    update public.teacher_assessment_marks
    set marks_obtained=p_marks,remarks=nullif(pg_catalog.btrim(p_remarks),'')
    where id=p_mark_id and assessment_id=p_assessment_id and student_id=p_student_id
      and updated_at=p_expected_mark_updated_at and marks_obtained=p_expected_marks
      and remarks is not distinct from p_expected_remarks
    returning * into saved;
    if not found then
      raise exception 'Mark changed or access is unavailable. Your draft must be reloaded before retrying.' using errcode='40001';
    end if;
  end if;
  return pg_catalog.to_jsonb(saved);
end;
$$;

revoke all on function public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)
from public,anon,authenticated,service_role;
grant execute on function public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)
to authenticated,service_role;
commit;
