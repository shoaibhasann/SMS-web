begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.staff_import_receipts (
  school_id uuid not null references public.schools(id) on delete cascade,
  request_id uuid not null,
  payload_hash bytea not null,
  imported_by uuid not null,
  imported_at timestamptz not null default clock_timestamp(),
  teacher_count integer not null check (teacher_count >= 0),
  staff_count integer not null check (staff_count >= 0),
  check (teacher_count + staff_count between 1 and 50),
  primary key (school_id, request_id)
);

create index staff_import_receipts_history
  on app_private.staff_import_receipts (school_id, imported_at desc, request_id);
alter table app_private.staff_import_receipts enable row level security;
revoke all on table app_private.staff_import_receipts from public, anon, authenticated, service_role;

-- Both directory tables share one school employee-ID namespace. A single
-- advisory key also serializes bulk imports with individual creates/edits.
create function app_private.guard_school_employee_id()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  employee_key text := pg_catalog.lower(pg_catalog.btrim(new.employee_id));
begin
  if tg_op = 'UPDATE' then
    if (new.school_id, new.employee_id) is not distinct from (old.school_id, old.employee_id) then
      return new;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'teacher-employee:' || new.school_id::text || ':' || employee_key, 0
  ));
  if exists (
    select 1 from public.teachers t where t.school_id = new.school_id
      and pg_catalog.lower(pg_catalog.btrim(t.employee_id)) = employee_key
      and (tg_table_name <> 'teachers' or t.id <> new.id)
  ) or exists (
    select 1 from public.staff s where s.school_id = new.school_id
      and pg_catalog.lower(pg_catalog.btrim(s.employee_id)) = employee_key
      and (tg_table_name <> 'staff' or s.id <> new.id)
  ) then
    raise exception 'This employee ID is already used in this school.' using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger guard_teacher_employee_id
before insert or update of school_id, employee_id on public.teachers
for each row execute function app_private.guard_school_employee_id();
create trigger guard_staff_employee_id
before insert or update of school_id, employee_id on public.staff
for each row execute function app_private.guard_school_employee_id();

create function app_private.create_unlinked_school_employee(
  p_school_id uuid, p_employee_id text, p_full_name text, p_staff_type text
)
returns uuid language plpgsql set search_path = ''
as $$
declare
  employee_number text := pg_catalog.btrim(p_employee_id);
  employee_name text := pg_catalog.btrim(p_full_name);
  employee_row_id uuid;
begin
  if employee_number is null or pg_catalog.length(employee_number) not between 1 and 64
    or employee_number ~ '[[:cntrl:]]' or employee_name is null
    or pg_catalog.length(employee_name) not between 1 and 160 or employee_name ~ '[[:cntrl:]]'
    or p_staff_type is null or p_staff_type not in ('teacher', 'staff') then
    raise exception 'Enter a valid employee ID, full name and staff type.' using errcode = '22023';
  end if;
  if p_staff_type = 'teacher' then
    insert into public.teachers (school_id, employee_id, full_name)
    values (p_school_id, employee_number, employee_name)
    returning id into employee_row_id;
  else
    insert into public.staff (school_id, employee_id, full_name)
    values (p_school_id, employee_number, employee_name)
    returning id into employee_row_id;
  end if;
  return employee_row_id;
end;
$$;

create or replace function app_private.create_teacher_record(p_school_id uuid, p_employee_id text, p_full_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  if not app_private.can_manage_teachers(auth.uid(), p_school_id) or p_school_id is null then
    raise exception 'You cannot manage teachers for this school.' using errcode = '42501';
  end if;
  return app_private.create_unlinked_school_employee(p_school_id, p_employee_id, p_full_name, 'teacher');
end;
$$;

create function app_private.import_school_staff(p_school_id uuid, p_request_id uuid, p_staff jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  hash bytea;
  receipt app_private.staff_import_receipts%rowtype;
  staff_row record;
  teacher_total integer := 0;
  staff_total integer := 0;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id and ((ur.role = 'super_admin' and ur.school_id is null)
    or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot import staff for this school.' using errcode = '42501';
  end if;
  if p_request_id is null or pg_catalog.jsonb_typeof(p_staff) is distinct from 'array' then
    raise exception 'Choose a school and provide a valid staff batch.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_staff) not between 1 and 50
    or pg_catalog.octet_length(p_staff::text) > 65536 then
    raise exception 'Import between 1 and 50 staff records at a time.' using errcode = '22023';
  end if;

  hash := pg_catalog.sha256(pg_catalog.convert_to(p_staff::text, 'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'staff-import:' || p_school_id::text || ':' || p_request_id::text, 0));
  select * into receipt from app_private.staff_import_receipts
  where school_id = p_school_id and request_id = p_request_id;
  if found then
    if receipt.payload_hash <> hash or receipt.imported_by <> actor_id then
      raise exception 'This import request does not match the original submission.' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('teacher_count', receipt.teacher_count, 'staff_count', receipt.staff_count);
  end if;

  for staff_row in
    select value as fields, ordinality as row_number
    from pg_catalog.jsonb_array_elements(p_staff) with ordinality
    order by pg_catalog.lower(pg_catalog.btrim(value->>'employeeId')) collate "C", ordinality
  loop
    if pg_catalog.jsonb_typeof(staff_row.fields) is distinct from 'object'
      or pg_catalog.jsonb_typeof(staff_row.fields->'employeeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(staff_row.fields->'fullName') is distinct from 'string'
      or pg_catalog.jsonb_typeof(staff_row.fields->'staffType') is distinct from 'string'
      or staff_row.fields - 'employeeId' - 'fullName' - 'staffType' <> '{}'::jsonb then
      raise exception 'Staff row % has invalid fields.', staff_row.row_number using errcode = '22023';
    end if;

    begin
      perform app_private.create_unlinked_school_employee(
        p_school_id, staff_row.fields->>'employeeId', staff_row.fields->>'fullName', staff_row.fields->>'staffType'
      );
    exception
      when unique_violation then
        raise exception 'Staff row % repeats an employee ID in this file or school.',
          staff_row.row_number using errcode = '23505';
      when invalid_parameter_value then
        raise exception 'Staff row % needs a valid employee ID, full name and staff type.',
          staff_row.row_number using errcode = '22023';
    end;
    if staff_row.fields->>'staffType' = 'teacher' then
      teacher_total := teacher_total + 1;
    else
      staff_total := staff_total + 1;
    end if;
  end loop;

  insert into app_private.staff_import_receipts (school_id, request_id, payload_hash, imported_by, teacher_count, staff_count)
  values (p_school_id, p_request_id, hash, actor_id, teacher_total, staff_total);
  return pg_catalog.jsonb_build_object('teacher_count', teacher_total, 'staff_count', staff_total);
end;
$$;

create function app_private.list_school_staff_imports(p_school_id uuid)
returns table (request_id uuid, teacher_count integer, staff_count integer, imported_by_name text, imported_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app_private.can_manage_teachers(auth.uid(), p_school_id) or p_school_id is null then
    raise exception 'You cannot read staff imports for this school.' using errcode = '42501';
  end if;
  return query
  select r.request_id, r.teacher_count, r.staff_count, coalesce(p.full_name, 'School staff'), r.imported_at
  from app_private.staff_import_receipts r left join public.profiles p on p.id = r.imported_by
  where r.school_id = p_school_id
  order by r.imported_at desc, r.request_id limit 10;
end;
$$;

create function public.import_school_staff(p_school_id uuid, p_request_id uuid, p_staff jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.import_school_staff(p_school_id, p_request_id, p_staff); $$;

create function public.list_school_staff_imports(p_school_id uuid)
returns table (request_id uuid, teacher_count integer, staff_count integer, imported_by_name text, imported_at timestamptz)
language sql stable security invoker set search_path = ''
as $$ select * from app_private.list_school_staff_imports(p_school_id); $$;

revoke all on function
  app_private.guard_school_employee_id(),
  app_private.create_unlinked_school_employee(uuid, text, text, text),
  app_private.import_school_staff(uuid, uuid, jsonb), public.import_school_staff(uuid, uuid, jsonb),
  app_private.list_school_staff_imports(uuid), public.list_school_staff_imports(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.import_school_staff(uuid, uuid, jsonb), public.import_school_staff(uuid, uuid, jsonb),
  app_private.list_school_staff_imports(uuid), public.list_school_staff_imports(uuid)
to authenticated;

commit;
