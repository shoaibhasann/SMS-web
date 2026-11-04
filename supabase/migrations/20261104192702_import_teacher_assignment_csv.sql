begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.teacher_assignment_imports (
  school_id uuid not null references public.schools(id),
  academic_year_id uuid not null references public.academic_years(id),
  request_id uuid not null,
  actor_id uuid not null,
  payload_hash bytea not null,
  assignment_ids uuid[] not null check (cardinality(assignment_ids) between 1 and 50),
  created_at timestamptz not null default clock_timestamp(),
  primary key (school_id, request_id)
);

create index teacher_assignment_imports_history
  on app_private.teacher_assignment_imports (school_id, academic_year_id, created_at desc, request_id);
alter table app_private.teacher_assignment_imports enable row level security;
revoke all on table app_private.teacher_assignment_imports from public, anon, authenticated, service_role;

create function app_private.validate_teacher_assignment_csv(p_rows jsonb)
returns void language plpgsql immutable set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Provide a list of teacher assignment rows.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) not between 1 and 50
    or pg_catalog.octet_length(p_rows::text) > 65536 then
    raise exception 'Import between 1 and 50 teacher assignments at a time.' using errcode = '22023';
  end if;
end;
$$;

create function app_private.preview_teacher_assignment_import(p_school_id uuid, p_academic_year_id uuid, p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_school_id is null or not app_private.can_manage_teachers(auth.uid(), p_school_id) then
    raise exception 'You cannot manage teacher assignments for this school.' using errcode = '42501';
  end if;
  perform app_private.validate_teacher_assignment_csv(p_rows);
  if not exists (
    select 1 from public.academic_years y where y.id = p_academic_year_id and y.school_id = p_school_id and y.is_current
  ) then
    raise exception 'Choose the current academic year for this school.' using errcode = '22023';
  end if;

  return (
    with input as (
      select ordinality::integer as row_number,
        case when pg_catalog.jsonb_typeof(value->'employeeId') = 'string'
          then pg_catalog.btrim(value->>'employeeId') end as employee_id,
        case when pg_catalog.jsonb_typeof(value->'className') = 'string'
          then pg_catalog.btrim(value->>'className') end as class_name,
        case when pg_catalog.jsonb_typeof(value->'sectionName') = 'string'
          then pg_catalog.btrim(value->>'sectionName') end as section_name,
        case when pg_catalog.jsonb_typeof(value->'subjectName') = 'string'
          then pg_catalog.btrim(value->>'subjectName') end as subject_name,
        case when pg_catalog.jsonb_typeof(value->'isClassTeacher') = 'boolean'
          then (value->>'isClassTeacher')::boolean end as is_class_teacher
      from pg_catalog.jsonb_array_elements(p_rows) with ordinality
    ), matches as (
      select i.*, t.id as teacher_id, coalesce(nullif(pg_catalog.btrim(t.full_name), ''), t.employee_id) as teacher_name,
        c.id as class_id, sec.id as section_id, sub.id as subject_id,
        case
          when i.employee_id is null or pg_catalog.char_length(i.employee_id) not between 1 and 64
            or i.employee_id ~ '[[:cntrl:]]' then 'Enter an employee ID of up to 64 characters.'
          when i.class_name is null or pg_catalog.char_length(i.class_name) not between 1 and 100
            or i.class_name ~ '[[:cntrl:]]' then 'Enter a class name of up to 100 characters.'
          when i.section_name is null or pg_catalog.char_length(i.section_name) not between 1 and 100
            or i.section_name ~ '[[:cntrl:]]' then 'Enter a section name of up to 100 characters.'
          when i.subject_name is null or pg_catalog.char_length(i.subject_name) not between 1 and 100
            or i.subject_name ~ '[[:cntrl:]]' then 'Enter a subject name of up to 100 characters.'
          when i.is_class_teacher is null then 'Use true or false for the class teacher field.'
          when t.id is null then 'No teacher matches this employee ID in this school.'
          when c.id is null then 'No active class matches this name in this school.'
          when sec.id is null then 'No section matches this name in the selected class.'
          when sub.id is null then 'No active subject matches this name in this school.'
        end as match_error
      from input i
      left join public.teachers t on t.school_id = p_school_id and t.employee_id = i.employee_id
      left join public.classes c on c.school_id = p_school_id and c.is_active and c.name = i.class_name
      left join public.sections sec on sec.school_id = p_school_id and sec.class_id = c.id and sec.name = i.section_name
      left join public.subjects sub on sub.school_id = p_school_id and sub.is_active and sub.name = i.subject_name
    ), checked as (
      select m.row_number, m.employee_id, m.class_name, m.section_name, m.subject_name, m.is_class_teacher,
        m.teacher_id, m.teacher_name, m.class_id, m.section_id, m.subject_id,
        case
          when m.match_error is not null then m.match_error
          when count(*) filter (where m.match_error is null) over (
            partition by m.teacher_id, m.class_id, m.section_id, m.subject_id
          ) > 1 then 'This teacher, class, section and subject repeat in the CSV.'
          when m.is_class_teacher and count(*) filter (where m.match_error is null and m.is_class_teacher) over (
            partition by m.teacher_id
          ) > 1 then 'This teacher has multiple class teacher duties in the CSV.'
          when m.is_class_teacher and count(*) filter (where m.match_error is null and m.is_class_teacher) over (
            partition by m.class_id, m.section_id
          ) > 1 then 'This section has multiple class teachers in the CSV.'
          when exists (
            select 1 from public.teacher_subject_assignments a
            where a.teacher_id = m.teacher_id and a.academic_year_id = p_academic_year_id
              and a.class_id = m.class_id and a.section_id = m.section_id and a.subject_id = m.subject_id
          ) then 'This teacher assignment already exists in the current academic year.'
          when m.is_class_teacher and exists (
            select 1 from public.teacher_subject_assignments a
            where a.teacher_id = m.teacher_id and a.academic_year_id = p_academic_year_id and a.is_class_teacher
          ) then 'This teacher already has a class teacher duty in the current academic year.'
          when m.is_class_teacher and exists (
            select 1 from public.teacher_subject_assignments a
            where a.academic_year_id = p_academic_year_id and a.class_id = m.class_id
              and a.section_id = m.section_id and a.is_class_teacher
          ) then 'This section already has a class teacher in the current academic year.'
        end as error
      from matches m
    )
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(checked) order by checked.row_number) from checked
  );
end;
$$;

create function app_private.import_teacher_assignments(
  p_school_id uuid, p_academic_year_id uuid, p_request_id uuid, p_rows jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  payload_hash bytea;
  receipt app_private.teacher_assignment_imports%rowtype;
  reviewed_rows jsonb;
  expected_row jsonb;
  candidate record;
  saved_id uuid;
  saved_ids uuid[] := array[]::uuid[];
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot manage teacher assignments for this school.' using errcode = '42501';
  end if;
  perform app_private.validate_teacher_assignment_csv(p_rows);
  if p_request_id is null or p_academic_year_id is null then
    raise exception 'Review the file and start a valid assignment import request.' using errcode = '22023';
  end if;

  payload_hash := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_academic_year_id, p_rows)::text, 'UTF8'
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'teacher-assignment-import:' || p_school_id::text || ':' || p_request_id::text, 0));
  select i.* into receipt from app_private.teacher_assignment_imports i
  where i.school_id = p_school_id and i.request_id = p_request_id;

  if found then
    if receipt.actor_id <> actor_id or receipt.payload_hash <> payload_hash then
      raise exception 'This assignment import request already has different data or belongs to another reviewer.' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('request_id', p_request_id, 'assignment_count', pg_catalog.cardinality(receipt.assignment_ids));
  end if;

  -- Serialize overlapping imports. The existing assignment indexes arbitrate
  -- conflicts with the independent single-assignment workflow.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'teacher-assignment-import-year:' || p_school_id::text || ':' || p_academic_year_id::text, 0));
  perform 1 from public.academic_years y
  where y.id = p_academic_year_id and y.school_id = p_school_id and y.is_current for share;
  if not found then
    raise exception 'Choose the current academic year for this school.' using errcode = '22023';
  end if;
  reviewed_rows := app_private.preview_teacher_assignment_import(p_school_id, p_academic_year_id, p_rows);

  for candidate in select * from pg_catalog.jsonb_to_recordset(reviewed_rows) as rows(
    row_number integer, employee_id text, class_name text, section_name text, subject_name text,
    teacher_id uuid, class_id uuid, section_id uuid, subject_id uuid, is_class_teacher boolean, error text
  ) order by row_number
  loop
    if candidate.error is not null then
      raise exception 'Assignment import row %: %', candidate.row_number, candidate.error using errcode = '22023';
    end if;
    expected_row := p_rows->(candidate.row_number - 1);
    if (expected_row->>'teacherId', expected_row->>'classId', expected_row->>'sectionId', expected_row->>'subjectId')
      is distinct from (candidate.teacher_id::text, candidate.class_id::text, candidate.section_id::text, candidate.subject_id::text) then
      raise exception 'Assignment import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
    end if;

    perform 1 from public.teachers t
    join public.classes c on c.id = candidate.class_id and c.school_id = t.school_id and c.is_active
    join public.sections sec on sec.id = candidate.section_id and sec.class_id = c.id and sec.school_id = c.school_id
    join public.subjects sub on sub.id = candidate.subject_id and sub.school_id = c.school_id and sub.is_active
    where t.id = candidate.teacher_id and t.school_id = p_school_id and t.employee_id = candidate.employee_id
      and c.name = candidate.class_name and sec.name = candidate.section_name and sub.name = candidate.subject_name
    for share of t, c, sec, sub;
    if not found then
      raise exception 'Assignment import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
    end if;

    begin
      insert into public.teacher_subject_assignments
        (teacher_id, academic_year_id, class_id, section_id, subject_id, is_class_teacher)
      values (candidate.teacher_id, p_academic_year_id, candidate.class_id, candidate.section_id,
        candidate.subject_id, candidate.is_class_teacher)
      returning id into saved_id;
    exception when unique_violation then
      raise exception 'Assignment import row % conflicts with an existing assignment or class teacher duty. Review the CSV again.',
        candidate.row_number using errcode = '23505';
    end;
    saved_ids := pg_catalog.array_append(saved_ids, saved_id);
  end loop;

  insert into app_private.teacher_assignment_imports (school_id, academic_year_id, request_id, actor_id, payload_hash, assignment_ids)
  values (p_school_id, p_academic_year_id, p_request_id, actor_id, payload_hash, saved_ids);
  return pg_catalog.jsonb_build_object('request_id', p_request_id, 'assignment_count', pg_catalog.cardinality(saved_ids));
end;
$$;

create function app_private.list_teacher_assignment_imports(p_school_id uuid, p_academic_year_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_school_id is null or not app_private.can_manage_teachers(auth.uid(), p_school_id) then
    raise exception 'You cannot view teacher assignment imports for this school.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.academic_years y where y.id = p_academic_year_id and y.school_id = p_school_id
  ) then
    raise exception 'Choose an academic year for this school.' using errcode = '22023';
  end if;
  return (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(history) order by history.created_at desc, history.request_id), '[]'::jsonb)
    from (
      select i.request_id, i.created_at, i.assignment_ids, pg_catalog.cardinality(i.assignment_ids) as assignment_count,
        coalesce(p.full_name, 'School staff') as actor_name
      from app_private.teacher_assignment_imports i
      left join public.profiles p on p.id = i.actor_id
      where i.school_id = p_school_id and i.academic_year_id = p_academic_year_id
      order by i.created_at desc, i.request_id limit 50
    ) history
  );
end;
$$;

create function public.preview_teacher_assignment_import(p_school_id uuid, p_academic_year_id uuid, p_rows jsonb)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.preview_teacher_assignment_import(p_school_id, p_academic_year_id, p_rows); $$;

create function public.import_teacher_assignments(p_school_id uuid, p_academic_year_id uuid, p_request_id uuid, p_rows jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.import_teacher_assignments(p_school_id, p_academic_year_id, p_request_id, p_rows); $$;

create function public.list_teacher_assignment_imports(p_school_id uuid, p_academic_year_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_teacher_assignment_imports(p_school_id, p_academic_year_id); $$;

revoke all on function
  app_private.validate_teacher_assignment_csv(jsonb),
  app_private.preview_teacher_assignment_import(uuid, uuid, jsonb),
  public.preview_teacher_assignment_import(uuid, uuid, jsonb),
  app_private.import_teacher_assignments(uuid, uuid, uuid, jsonb),
  public.import_teacher_assignments(uuid, uuid, uuid, jsonb),
  app_private.list_teacher_assignment_imports(uuid, uuid),
  public.list_teacher_assignment_imports(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  app_private.preview_teacher_assignment_import(uuid, uuid, jsonb),
  public.preview_teacher_assignment_import(uuid, uuid, jsonb),
  app_private.import_teacher_assignments(uuid, uuid, uuid, jsonb),
  public.import_teacher_assignments(uuid, uuid, uuid, jsonb),
  app_private.list_teacher_assignment_imports(uuid, uuid),
  public.list_teacher_assignment_imports(uuid, uuid)
to authenticated;

commit;
