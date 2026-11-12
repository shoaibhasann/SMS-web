-- Student activation needs the pupil's DOB and registered mobile (web-people#1).
-- Admission and the student CSV can now capture them, and the office can edit a
-- pupil's name, DOB and mobile through a governed, audited RPC. Mobiles are stored
-- as the 10-digit Indian number the /activate form asks for. The audit keeps the
-- changed field names only, never the values. Bodies are copied from
-- 20261104112800 (admit) and 20261111180102 (import); grants are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Null for blank or invalid input; callers tell the two apart.
create function app_private.student_registered_mobile(p_value text)
returns text language sql immutable set search_path = ''
as $function$
  select case when digits ~ '^[6-9][0-9]{9}$' then digits end
  from (
    select case
      when pg_catalog.length(raw) = 12 and pg_catalog.left(raw, 2) = '91' then pg_catalog.substr(raw, 3)
      when pg_catalog.length(raw) = 11 and pg_catalog.left(raw, 1) = '0' then pg_catalog.substr(raw, 2)
      else raw end as digits
    from (select pg_catalog.regexp_replace(p_value, '[^0-9]', '', 'g') as raw
      where p_value ~ '^[[:space:]0-9+().-]{1,32}$') input
  ) normalized;
$function$;

create function app_private.check_student_contact(p_dob date, p_registered_mobile text)
returns text language plpgsql stable set search_path = ''
as $function$
declare
  mobile text := app_private.student_registered_mobile(p_registered_mobile);
begin
  if p_dob is not null and (p_dob < '1900-01-01'::date
    or p_dob > (pg_catalog.statement_timestamp() at time zone 'Asia/Kolkata')::date) then
    raise exception 'Enter a valid date of birth.' using errcode = '22023';
  end if;
  if mobile is null and nullif(pg_catalog.btrim(p_registered_mobile), '') is not null then
    raise exception 'Enter a valid 10-digit mobile number.' using errcode = '22023';
  end if;
  return mobile;
end;
$function$;

revoke all on function app_private.student_registered_mobile(text), app_private.check_student_contact(date, text)
  from public, anon, authenticated, service_role;

-- Dropping the 7-argument overload keeps one callable signature (no PGRST203);
-- 7-argument callers still resolve through the new defaults.
drop function public.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text);
drop function app_private.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text);

create function app_private.admit_roster_student(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_admission_no text,
  p_first_name text,
  p_last_name text,
  p_dob date default null,
  p_registered_mobile text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  admission_number text := pg_catalog.btrim(p_admission_no);
  first_name text := pg_catalog.btrim(p_first_name);
  last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  mobile text;
  new_student_id uuid;
begin
  perform 1
  from public.user_roles role_row
  join public.profiles profile on profile.id = role_row.user_id and profile.is_active
  where role_row.user_id = (select auth.uid())
    and ((role_row.role = 'super_admin' and role_row.school_id is null)
      or (role_row.school_id = p_school_id and role_row.role in ('school_admin', 'principal')))
  for share of role_row, profile;

  if not found then
    raise exception 'You cannot admit students for this school.' using errcode = '42501';
  end if;

  if admission_number is null or pg_catalog.length(admission_number) not between 1 and 64
    or admission_number ~ '[[:cntrl:]]'
    or first_name is null or pg_catalog.length(first_name) not between 1 and 100
    or first_name ~ '[[:cntrl:]]'
    or pg_catalog.length(last_name) > 100 or last_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid admission number and student name.' using errcode = '22023';
  end if;
  mobile := app_private.check_student_contact(p_dob, p_registered_mobile);

  perform 1
  from public.academic_years year_row
  join public.classes class_row on class_row.school_id = year_row.school_id
  join public.sections section_row
    on section_row.class_id = class_row.id and section_row.school_id = class_row.school_id
  where year_row.id = p_academic_year_id and year_row.school_id = p_school_id
    and year_row.is_current and class_row.is_active
    and class_row.id = p_class_id and section_row.id = p_section_id
    and not exists (
      select 1 from public.academic_years other_year
      where other_year.school_id = p_school_id and other_year.is_current and other_year.id <> year_row.id
    )
  for share of year_row, class_row, section_row;

  if not found then
    raise exception 'Choose a valid class and section in the current academic year.' using errcode = '22023';
  end if;

  insert into public.students (school_id, admission_no, first_name, last_name, admission_date, status, dob, registered_mobile)
  values (p_school_id, admission_number, first_name, last_name, (current_timestamp at time zone 'Asia/Kolkata')::date, 'active', p_dob, mobile)
  on conflict (school_id, admission_no) do nothing
  returning id into new_student_id;

  if new_student_id is null then
    raise exception 'This admission number is already used in this school.' using errcode = '23505';
  end if;

  insert into public.enrollments (student_id, academic_year_id, class_id, section_id, status)
  values (new_student_id, p_academic_year_id, p_class_id, p_section_id, 'active');

  return new_student_id;
end;
$function$;

create function public.admit_roster_student(
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_admission_no text,
  p_first_name text,
  p_last_name text,
  p_dob date default null,
  p_registered_mobile text default null
)
returns uuid
language sql security invoker set search_path = ''
as $function$
  select app_private.admit_roster_student(
    p_school_id, p_academic_year_id, p_class_id, p_section_id, p_admission_no, p_first_name, p_last_name,
    p_dob, p_registered_mobile
  );
$function$;

revoke all on function app_private.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text, date, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text, date, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text, date, text)
  to authenticated;
grant execute on function public.admit_roster_student(uuid, uuid, uuid, uuid, text, text, text, date, text)
  to authenticated;

-- CSV rows take their per-key admission locks (guard_student_admission_no) in the same
-- lower(btrim()) order, so overlapping imports cannot deadlock on case variants.
create or replace function app_private.import_roster_students(
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
  birth_text text;
  birth_date date;
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
    order by pg_catalog.lower(pg_catalog.btrim(value->>'admissionNumber')) collate "C",
      pg_catalog.btrim(value->>'admissionNumber') collate "C", ordinality
  loop
    if pg_catalog.jsonb_typeof(roster_row.fields->'admissionNumber') is distinct from 'string'
      or pg_catalog.jsonb_typeof(roster_row.fields->'firstName') is distinct from 'string'
      or pg_catalog.jsonb_typeof(roster_row.fields->'lastName') is distinct from 'string'
      or coalesce(pg_catalog.jsonb_typeof(roster_row.fields->'dateOfBirth'), 'null') not in ('string', 'null')
      or coalesce(pg_catalog.jsonb_typeof(roster_row.fields->'registeredMobile'), 'null') not in ('string', 'null') then
      raise exception 'Student % has invalid fields.', roster_row.row_number using errcode = '22023';
    end if;

    birth_text := nullif(pg_catalog.btrim(roster_row.fields->>'dateOfBirth'), '');
    birth_date := null;
    if birth_text is not null then
      begin
        if birth_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode = '22007'; end if;
        birth_date := birth_text::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'Student % has an invalid date of birth.', roster_row.row_number using errcode = '22023';
      end;
    end if;

    begin
      perform app_private.admit_roster_student(
        p_school_id, p_academic_year_id, p_class_id, p_section_id,
        roster_row.fields->>'admissionNumber', roster_row.fields->>'firstName', roster_row.fields->>'lastName',
        birth_date, roster_row.fields->>'registeredMobile'
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

revoke all on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  to authenticated;

-- app_private.student_detail_changes (the audit table written below) is created by 20261111190202.

create function app_private.update_roster_student_details(
  p_school_id uuid,
  p_student_id uuid,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_dob date,
  p_registered_mobile text
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  new_first text := pg_catalog.btrim(p_first_name);
  new_middle text := nullif(pg_catalog.btrim(p_middle_name), '');
  new_last text := nullif(pg_catalog.btrim(p_last_name), '');
  mobile text;
  pupil public.students%rowtype;
  changed text[];
begin
  perform 1
  from public.user_roles role_row
  join public.profiles profile on profile.id = role_row.user_id and profile.is_active
  where role_row.user_id = actor_id
    and ((role_row.role = 'super_admin' and role_row.school_id is null)
      or (role_row.school_id = p_school_id and role_row.role in ('school_admin', 'principal')))
  for share of role_row, profile;

  if not found then
    raise exception 'You cannot edit students for this school.' using errcode = '42501';
  end if;

  select s.* into pupil from public.students s
  where s.id = p_student_id and s.school_id = p_school_id
  for update;
  if not found then
    raise exception 'Choose a pupil from this school.' using errcode = '22023';
  end if;

  -- Full-replace from the client, but only changed fields are validated and audited, so a
  -- legacy value (say mobile '98765 43210' or an old DOB) never blocks a name fix. Mobiles
  -- compare in normalised form; an unchanged valid one is rewritten to its 10 digits (no audit
  -- row) so a legacy '+91 98765 43210' still matches /activate after any save.
  changed := pg_catalog.array_remove(array[
    case when pupil.first_name is distinct from new_first then 'first_name' end,
    case when pupil.middle_name is distinct from new_middle then 'middle_name' end,
    case when pupil.last_name is distinct from new_last then 'last_name' end,
    case when pupil.dob is distinct from p_dob then 'dob' end,
    case when coalesce(app_private.student_registered_mobile(pupil.registered_mobile), nullif(pg_catalog.btrim(pupil.registered_mobile), ''))
      is distinct from coalesce(app_private.student_registered_mobile(p_registered_mobile), nullif(pg_catalog.btrim(p_registered_mobile), ''))
      then 'registered_mobile' end
  ], null);

  if ('first_name' = any(changed) and (new_first is null or pg_catalog.length(new_first) not between 1 and 100 or new_first ~ '[[:cntrl:]]'))
    or ('middle_name' = any(changed) and (pg_catalog.length(new_middle) > 100 or new_middle ~ '[[:cntrl:]]'))
    or ('last_name' = any(changed) and (pg_catalog.length(new_last) > 100 or new_last ~ '[[:cntrl:]]')) then
    raise exception 'Enter a valid student name.' using errcode = '22023';
  end if;
  if 'dob' = any(changed) then
    perform app_private.check_student_contact(p_dob, null);
  end if;
  mobile := case when 'registered_mobile' = any(changed)
    then app_private.check_student_contact(null, p_registered_mobile)
    else coalesce(app_private.student_registered_mobile(pupil.registered_mobile), pupil.registered_mobile) end;

  if pg_catalog.cardinality(changed) > 0 or mobile is distinct from pupil.registered_mobile then
    update public.students s
    set first_name = new_first, middle_name = new_middle, last_name = new_last,
      dob = p_dob, registered_mobile = mobile
    where s.id = pupil.id;
  end if;
  if pg_catalog.cardinality(changed) > 0 then
    insert into app_private.student_detail_changes (school_id, student_id, changed_fields, changed_by)
    values (p_school_id, pupil.id, changed, actor_id);
  end if;
  return pupil.id;
end;
$function$;

create function public.update_roster_student_details(
  p_school_id uuid,
  p_student_id uuid,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_dob date,
  p_registered_mobile text
)
returns uuid
language sql security invoker set search_path = ''
as $function$
  select app_private.update_roster_student_details(
    p_school_id, p_student_id, p_first_name, p_middle_name, p_last_name, p_dob, p_registered_mobile
  );
$function$;

revoke all on function app_private.update_roster_student_details(uuid, uuid, text, text, text, date, text)
  from public, anon, authenticated, service_role;
revoke all on function public.update_roster_student_details(uuid, uuid, text, text, text, date, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.update_roster_student_details(uuid, uuid, text, text, text, date, text)
  to authenticated;
grant execute on function public.update_roster_student_details(uuid, uuid, text, text, text, date, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
