begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.roster_import_receipts (
  school_id uuid not null references public.schools(id) on delete cascade,
  request_id uuid not null,
  payload_hash bytea not null,
  student_count integer not null check (student_count between 1 and 50),
  primary key (school_id, request_id)
);

alter table app_private.roster_import_receipts enable row level security;
revoke all on table app_private.roster_import_receipts from public, anon, authenticated, service_role;

create function app_private.import_roster_students(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_request_id uuid,
  p_students jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $function$
declare
  roster_row record;
  payload_hash bytea;
  receipt app_private.roster_import_receipts%rowtype;
  student_count integer;
begin
  -- Check authorization before reading a prior receipt or inspecting its batch.
  perform 1
  from public.user_roles role_row
  join public.profiles profile on profile.id = role_row.user_id and profile.is_active
  where role_row.user_id = (select auth.uid())
    and ((role_row.role = 'super_admin' and role_row.school_id is null)
      or (role_row.school_id = p_school_id and role_row.role in ('school_admin', 'principal')))
  for share of role_row, profile;

  if not found then
    raise exception 'You cannot import students for this school.' using errcode = '42501';
  end if;

  if p_school_id is null or p_request_id is null
    or pg_catalog.jsonb_typeof(p_students) is distinct from 'array' then
    raise exception 'Choose a school and provide a valid student batch.' using errcode = '22023';
  end if;

  student_count := pg_catalog.jsonb_array_length(p_students);
  if student_count not between 1 and 50 or pg_catalog.octet_length(p_students::text) > 65536 then
    raise exception 'Import between 1 and 50 students at a time.' using errcode = '22023';
  end if;

  payload_hash := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_academic_year_id, p_class_id, p_section_id, p_students)::text, 'UTF8'
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('roster-import:' || p_school_id::text || ':' || p_request_id::text, 0)
  );

  select existing.* into receipt
  from app_private.roster_import_receipts existing
  where existing.school_id = p_school_id and existing.request_id = p_request_id;

  if found then
    if receipt.payload_hash <> payload_hash then
      raise exception 'This import request has different data. Select the CSV again.' using errcode = '22023';
    end if;
    return receipt.student_count;
  end if;

  for roster_row in
    select value as fields, ordinality as row_number
    from pg_catalog.jsonb_array_elements(p_students) with ordinality
    order by pg_catalog.btrim(value->>'admissionNumber') collate "C"
  loop
    if pg_catalog.jsonb_typeof(roster_row.fields->'admissionNumber') is distinct from 'string'
      or pg_catalog.jsonb_typeof(roster_row.fields->'firstName') is distinct from 'string'
      or pg_catalog.jsonb_typeof(roster_row.fields->'lastName') is distinct from 'string' then
      raise exception 'Student % has invalid fields.', roster_row.row_number using errcode = '22023';
    end if;

    begin
      perform app_private.admit_roster_student(
        p_school_id, p_academic_year_id, p_class_id, p_section_id,
        roster_row.fields->>'admissionNumber', roster_row.fields->>'firstName', roster_row.fields->>'lastName'
      );
    exception when unique_violation then
      raise exception 'Student % has an admission number already used in this school.',
        roster_row.row_number using errcode = '23505';
    end;
  end loop;

  insert into app_private.roster_import_receipts (school_id, request_id, payload_hash, student_count)
  values (p_school_id, p_request_id, payload_hash, student_count);

  return student_count;
end;
$function$;

create function public.import_roster_students(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_request_id uuid,
  p_students jsonb
)
returns integer
language sql security invoker set search_path = ''
as $function$
  select app_private.import_roster_students(
    p_school_id, p_academic_year_id, p_class_id, p_section_id, p_request_id, p_students
  );
$function$;

revoke all on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  to authenticated;
grant execute on function public.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  to authenticated;

commit;
