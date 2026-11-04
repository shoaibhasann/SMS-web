begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The normalized keys apply to both single additions and CSV batches.
create unique index academic_class_name_normalized_key
  on public.classes (school_id, pg_catalog.lower(pg_catalog.btrim(name)));
create unique index academic_section_name_normalized_key
  on public.sections (class_id, pg_catalog.lower(pg_catalog.btrim(name)));
create unique index academic_subject_name_normalized_key
  on public.subjects (school_id, pg_catalog.lower(pg_catalog.btrim(name)));
create unique index academic_subject_code_normalized_key
  on public.subjects (school_id, pg_catalog.lower(pg_catalog.btrim(code)))
  where pg_catalog.btrim(code) <> '';

create table app_private.academic_setup_import_receipts (
  school_id uuid not null references public.schools(id) on delete cascade,
  request_id uuid not null,
  record_kind text not null check (record_kind in ('classes', 'sections', 'subjects')),
  payload_hash bytea not null,
  imported_by uuid not null,
  imported_at timestamptz not null default clock_timestamp(),
  record_count integer not null check (record_count between 1 and 50),
  primary key (school_id, request_id)
);
create index academic_setup_import_history
  on app_private.academic_setup_import_receipts (school_id, record_kind, imported_at desc, request_id);
alter table app_private.academic_setup_import_receipts enable row level security;
revoke all on table app_private.academic_setup_import_receipts from public, anon, authenticated, service_role;

create function app_private.import_academic_setup_records(
  p_school_id uuid, p_kind text, p_request_id uuid, p_records jsonb
)
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  hash bytea;
  receipt app_private.academic_setup_import_receipts%rowtype;
  csv_row record;
  record_name text;
  detail text;
  class_id uuid;
  constraint_hit text;
  record_total integer;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id and ((ur.role = 'super_admin' and ur.school_id is null)
    or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot import academic records for this school.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('classes', 'sections', 'subjects') or p_request_id is null
    or pg_catalog.jsonb_typeof(p_records) is distinct from 'array' then
    raise exception 'Choose an academic record type and a valid batch.' using errcode = '22023';
  end if;

  record_total := pg_catalog.jsonb_array_length(p_records);
  if record_total not between 1 and 50 or pg_catalog.octet_length(p_records::text) > 65536 then
    raise exception 'Import between 1 and 50 academic records at a time.' using errcode = '22023';
  end if;

  hash := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(p_kind, p_records)::text, 'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'academic-import-request:' || p_school_id::text || ':' || p_request_id::text, 0));
  select * into receipt from app_private.academic_setup_import_receipts
  where school_id = p_school_id and request_id = p_request_id;
  if found then
    if receipt.payload_hash <> hash or receipt.imported_by <> actor_id then
      raise exception 'This import request does not match the original submission.' using errcode = '22023';
    end if;
    return receipt.record_count;
  end if;

  -- Serialize batches of the same kind to keep independent unique keys (such
  -- as a subject's name and code) from conflicting in different row order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'academic-import-kind:' || p_school_id::text || ':' || p_kind, 0));

  for csv_row in
    select value as fields, ordinality as row_number
    from pg_catalog.jsonb_array_elements(p_records) with ordinality
  loop
    record_name := pg_catalog.btrim(csv_row.fields->>'name');
    if pg_catalog.jsonb_typeof(csv_row.fields) is distinct from 'object'
      or pg_catalog.jsonb_typeof(csv_row.fields->'name') is distinct from 'string'
      or record_name is null or pg_catalog.length(record_name) not between 1 and 100
      or record_name ~ '[[:cntrl:]]' then
      raise exception 'Academic row % needs a valid name.', csv_row.row_number using errcode = '22023';
    end if;

    begin
      case p_kind
        when 'classes' then
          detail := csv_row.fields->>'sortOrder';
          if pg_catalog.jsonb_typeof(csv_row.fields->'sortOrder') is distinct from 'number'
            or detail !~ '^[0-9]{1,3}$' or csv_row.fields - 'name' - 'sortOrder' <> '{}'::jsonb then
            raise exception 'Academic row % needs a display order between 0 and 999.', csv_row.row_number using errcode = '22023';
          end if;
          insert into public.classes (school_id, name, sort_order) values (p_school_id, record_name, detail::integer);
        when 'sections' then
          if pg_catalog.jsonb_typeof(csv_row.fields->'classId') is distinct from 'string'
            or pg_catalog.jsonb_typeof(csv_row.fields->'className') is distinct from 'string'
            or csv_row.fields - 'name' - 'classId' - 'className' <> '{}'::jsonb then
            raise exception 'Academic row % needs an active class in this school.', csv_row.row_number using errcode = '22023';
          end if;
          class_id := (csv_row.fields->>'classId')::uuid;
          perform 1 from public.classes c
          where c.id = class_id and c.school_id = p_school_id and c.is_active and c.name = csv_row.fields->>'className'
          for share;
          if not found then
            raise exception 'Academic row % needs an active class in this school.', csv_row.row_number using errcode = '22023';
          end if;
          insert into public.sections (school_id, class_id, name) values (p_school_id, class_id, record_name);
        when 'subjects' then
          detail := pg_catalog.btrim(csv_row.fields->>'code');
          if pg_catalog.jsonb_typeof(csv_row.fields->'code') is distinct from 'string'
            or pg_catalog.length(detail) > 30 or detail ~ '[[:cntrl:]]'
            or csv_row.fields - 'name' - 'code' <> '{}'::jsonb then
            raise exception 'Academic row % needs a valid subject code of up to 30 characters.', csv_row.row_number using errcode = '22023';
          end if;
          insert into public.subjects (school_id, name, code) values (p_school_id, record_name, nullif(detail, ''));
      end case;
    exception
      when invalid_text_representation then
        raise exception 'Academic row % needs an active class in this school.', csv_row.row_number using errcode = '22023';
      when unique_violation then
        get stacked diagnostics constraint_hit = constraint_name;
        if constraint_hit = 'academic_subject_code_normalized_key' then
          raise exception 'Academic row % repeats a subject code.', csv_row.row_number using errcode = '23505';
        end if;
        raise exception 'Academic row % repeats a name.', csv_row.row_number using errcode = '23505';
    end;
  end loop;

  insert into app_private.academic_setup_import_receipts
    (school_id, request_id, record_kind, payload_hash, imported_by, record_count)
  values (p_school_id, p_request_id, p_kind, hash, actor_id, record_total);
  return record_total;
end;
$$;

create function app_private.list_academic_setup_imports(p_school_id uuid, p_kind text)
returns table (request_id uuid, record_count integer, imported_by_name text, imported_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_school_id is null or not exists (
    select 1 from public.user_roles ur join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = (select auth.uid()) and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  ) then
    raise exception 'You cannot view imports for this school.' using errcode = '42501';
  end if;

  return query
  select r.request_id, r.record_count, coalesce(p.full_name, 'School staff'), r.imported_at
  from app_private.academic_setup_import_receipts r left join public.profiles p on p.id = r.imported_by
  where r.school_id = p_school_id and r.record_kind = p_kind
  order by r.imported_at desc, r.request_id limit 10;
end;
$$;

create function public.import_academic_setup_records(
  p_school_id uuid, p_kind text, p_request_id uuid, p_records jsonb
)
returns integer language sql security invoker set search_path = ''
as $$ select app_private.import_academic_setup_records(p_school_id, p_kind, p_request_id, p_records); $$;

create function public.list_academic_setup_imports(p_school_id uuid, p_kind text)
returns table (request_id uuid, record_count integer, imported_by_name text, imported_at timestamptz)
language sql stable security invoker set search_path = ''
as $$ select * from app_private.list_academic_setup_imports(p_school_id, p_kind); $$;

revoke all on function
  app_private.import_academic_setup_records(uuid, text, uuid, jsonb), public.import_academic_setup_records(uuid, text, uuid, jsonb),
  app_private.list_academic_setup_imports(uuid, text), public.list_academic_setup_imports(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.import_academic_setup_records(uuid, text, uuid, jsonb), public.import_academic_setup_records(uuid, text, uuid, jsonb),
  app_private.list_academic_setup_imports(uuid, text), public.list_academic_setup_imports(uuid, text)
to authenticated;

commit;
