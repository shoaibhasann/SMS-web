-- Admission numbers are unique per school case-insensitively (after trimming),
-- matching the fee-batch and activation lookups. Existing collisions are not
-- rewritten: they are reported by count, stay editable, and fail closed in the
-- lookups until the owner corrects them. Find them with:
--   select school_id, lower(btrim(admission_no)), count(*) from public.students
--   group by 1, 2 having count(*) > 1;
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $report$
declare
  groups integer;
  schools integer;
begin
  select count(*), count(distinct school_id) into groups, schools from (
    select school_id from public.students
    group by school_id, pg_catalog.lower(pg_catalog.btrim(admission_no)) having count(*) > 1
  ) collisions;
  if groups > 0 then
    raise notice '% case-insensitive admission number collision group(s) in % school(s) need manual correction.', groups, schools;
  end if;
end;
$report$;

create function app_private.guard_student_admission_no()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  admission_key text;
begin
  if tg_op = 'UPDATE' and new.school_id = old.school_id
    and pg_catalog.lower(pg_catalog.btrim(new.admission_no)) = pg_catalog.lower(pg_catalog.btrim(old.admission_no)) then
    return new;
  end if;
  new.admission_no := pg_catalog.btrim(new.admission_no);
  -- A precomputed key keeps the cached plan on students_fee_admission_lookup_idx.
  admission_key := pg_catalog.lower(new.admission_no);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student-admission:' || new.school_id::text || ':' || admission_key, 0));
  if exists (
    select 1 from public.students s
    where s.school_id = new.school_id and s.id <> new.id
      and pg_catalog.lower(pg_catalog.btrim(s.admission_no)) = admission_key
  ) then
    raise exception 'This admission number is already used in this school.' using errcode = '23505';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.guard_student_admission_no() from public, anon, authenticated, service_role;

-- Named to fire after guard_student_identity (BEFORE ROW triggers run in name order), so an
-- API-role key change fails there before this definer lookup can answer for another school.
create trigger guard_student_key_uniqueness
before insert or update of school_id, admission_no on public.students
for each row execute function app_private.guard_student_admission_no();

-- Guardian CSV matches admission numbers the same way, and reports legacy
-- ambiguity instead of returning one row per matching pupil.
create or replace function app_private.preview_guardian_invitation_import(p_school_id uuid, p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_school_id is null or not app_private.can_manage_guardian_invitations(auth.uid(), p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Provide a list of student admission numbers and guardian emails.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) not between 1 and 50
    or pg_catalog.octet_length(p_rows::text) > 65536 then
    raise exception 'Import between 1 and 50 guardian invitations at a time.' using errcode = '22023';
  end if;

  return (
    with input as (
      select ordinality::integer as row_number,
        case when pg_catalog.jsonb_typeof(value->'admissionNumber') = 'string'
          then pg_catalog.btrim(value->>'admissionNumber') end as admission_no,
        case when pg_catalog.jsonb_typeof(value->'email') = 'string'
          then pg_catalog.lower(pg_catalog.btrim(value->>'email')) end as email
      from pg_catalog.jsonb_array_elements(p_rows) with ordinality
    ), checked as (
      select input.*, case when s.matches = 1 then s.id end as student_id,
        case when s.matches = 1 then pg_catalog.concat_ws(' ', s.first_name, s.middle_name, s.last_name) end as student_name,
        case
          when input.admission_no is null or pg_catalog.length(input.admission_no) not between 1 and 64
            or input.admission_no ~ '[[:cntrl:]]' then 'Enter a valid admission number.'
          when input.email is null or pg_catalog.length(input.email) > 254
            or input.email ~ '[[:cntrl:]]'
            or input.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'Enter a valid guardian email address.'
          when count(*) over (partition by pg_catalog.lower(input.admission_no), input.email) > 1
            then 'This student and email pair is repeated in the CSV.'
          when s.id is null then 'No active student with this admission number was found in the current academic year.'
          when s.matches > 1 then 'This admission number matches more than one pupil. Ask the school office to correct the duplicate.'
          else app_private.guardian_import_pair_error(p_school_id, s.id, input.email)
        end as error
      from input
      left join lateral (
        select s.id, s.first_name, s.middle_name, s.last_name, count(*) over () as matches
        from public.students s
        where s.school_id = p_school_id
          and pg_catalog.lower(pg_catalog.btrim(s.admission_no)) = pg_catalog.lower(input.admission_no)
          and s.status = 'active'
          and exists (
            select 1 from public.enrollments e
            join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
            where e.student_id = s.id and e.status = 'active'
          )
        limit 1
      ) s on true
    )
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(checked) order by checked.row_number) from checked
  );
end;
$$;

create or replace function app_private.import_guardian_invitations(
  p_school_id uuid, p_request_id uuid, p_delivery_key text, p_rows jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  payload_hash bytea;
  saved_import app_private.guardian_invitation_imports%rowtype;
  preview_rows jsonb;
  candidate record;
  current_year_id uuid;
  invite_id uuid;
  invite_expiry timestamptz;
  pair_error text;
  receipt_rows jsonb := '[]'::jsonb;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;

  if p_request_id is null or p_delivery_key is null or p_delivery_key !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Review the file and start a valid guardian import request.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) not between 1 and 50
    or pg_catalog.octet_length(p_rows::text) > 65536 then
    raise exception 'Import between 1 and 50 guardian invitations at a time.' using errcode = '22023';
  end if;

  payload_hash := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(p_rows, p_delivery_key)::text, 'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'guardian-import:' || p_school_id::text || ':' || p_request_id::text, 0));
  select i.* into saved_import from app_private.guardian_invitation_imports i
  where i.school_id = p_school_id and i.request_id = p_request_id;

  if found then
    if saved_import.actor_id <> actor_id or saved_import.payload_hash <> payload_hash then
      raise exception 'This import request already has different data or belongs to another reviewer.' using errcode = '23505';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(saved_import.invitations) as item(row_data)
      left join app_private.guardian_invitations i on i.id = (item.row_data->>'id')::uuid
      where i.id is null or i.accepted_at is not null or i.revoked_at is not null or i.expires_at <= clock_timestamp()
        or not exists (
          select 1 from public.students s
          join public.enrollments e on e.student_id = s.id and e.status = 'active'
          join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
          where s.id = i.student_id and s.school_id = i.school_id and s.status = 'active'
        )
    ) then
      raise exception 'This import already finished and at least one link is no longer available. Review the individual invitation histories.' using errcode = '55000';
    end if;
  else
    preview_rows := app_private.preview_guardian_invitation_import(p_school_id, p_rows);
    for candidate in select * from pg_catalog.jsonb_to_recordset(preview_rows)
      as rows(row_number integer, student_id uuid, error text)
      order by row_number
    loop
      if candidate.error is not null then
        raise exception 'Guardian import row %: %', candidate.row_number, candidate.error using errcode = '22023';
      end if;
      if (p_rows->(candidate.row_number - 1)->>'studentId') is distinct from candidate.student_id::text then
        raise exception 'Guardian import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
      end if;
    end loop;

    select y.id into current_year_id from public.academic_years y
    where y.school_id = p_school_id and y.is_current for share;
    if not found then
      raise exception 'Set the school current academic year before importing guardians.' using errcode = '22023';
    end if;
    saved_import.delivery_salt := extensions.gen_random_bytes(32);

    -- Match the lock used by individual invitations. Order by pupil and
    -- recipient so overlapping batches acquire their pair locks consistently.
    for candidate in select * from pg_catalog.jsonb_to_recordset(preview_rows)
      as rows(row_number integer, admission_no text, email text, student_id uuid, student_name text)
      order by student_id, email collate "C"
    loop
      perform 1 from public.students s
      join public.enrollments e on e.student_id = s.id and e.academic_year_id = current_year_id and e.status = 'active'
      where s.id = candidate.student_id and s.school_id = p_school_id
        and s.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(s.admission_no)) = pg_catalog.lower(candidate.admission_no)
      for share of s, e;
      if not found then
        raise exception 'Guardian import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
      end if;

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'guardian-invitation:' || candidate.student_id::text || ':' || candidate.email, 0));
      pair_error := app_private.guardian_import_pair_error(p_school_id, candidate.student_id, candidate.email);
      if pair_error is not null then
        raise exception 'Guardian import row %: %', candidate.row_number, pair_error using errcode = '22023';
      end if;

      update app_private.guardian_invitations set revoked_at = clock_timestamp()
      where school_id = p_school_id and student_id = candidate.student_id and email = candidate.email
        and accepted_at is null and revoked_at is null and expires_at <= clock_timestamp();

      invite_id := pg_catalog.gen_random_uuid();
      insert into app_private.guardian_invitations (id, school_id, student_id, email, token_hash, created_by, expires_at)
      values (invite_id, p_school_id, candidate.student_id, candidate.email,
        pg_catalog.sha256(pg_catalog.convert_to(
          app_private.guardian_import_token(p_delivery_key, saved_import.delivery_salt, invite_id), 'UTF8'
        )), actor_id, clock_timestamp() + interval '72 hours')
      returning expires_at into invite_expiry;
      receipt_rows := receipt_rows || pg_catalog.jsonb_build_object(
        'row_number', candidate.row_number, 'id', invite_id, 'admission_no', candidate.admission_no,
        'email', candidate.email, 'student_id', candidate.student_id, 'student_name', candidate.student_name,
        'expires_at', invite_expiry
      );
    end loop;

    insert into app_private.guardian_invitation_imports (school_id, request_id, actor_id, payload_hash, delivery_salt, invitations)
    values (p_school_id, p_request_id, actor_id, payload_hash, saved_import.delivery_salt, receipt_rows)
    returning * into saved_import;
  end if;

  -- The database stores only token hashes. The exact initiating request can
  -- rederive delivery links using its client-held key and a private salt.
  return pg_catalog.jsonb_build_object('request_id', p_request_id, 'invitations', (
    select pg_catalog.jsonb_agg(item.row_data || pg_catalog.jsonb_build_object('token',
      app_private.guardian_import_token(p_delivery_key, saved_import.delivery_salt, (item.row_data->>'id')::uuid)
    ) order by (item.row_data->>'row_number')::integer)
    from pg_catalog.jsonb_array_elements(saved_import.invitations) as item(row_data)
  ));
end;
$$;

-- Teacher self-registration skips every case variant of the generated KC-ST number,
-- otherwise an office-entered 'kc-st-001' blocks the class-teacher flow with 23505.
create or replace function public.register_student_for_class_teacher(p_full_name text)
returns table(student_id uuid,admission_no text,roll_no text,class_id uuid,section_id uuid)
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  teacher_record record;
  year_record record;
  assignment_record record;
  v_teacher_id uuid;
  v_school_id uuid;
  v_year_id uuid;
  v_class_id uuid;
  v_section_id uuid;
  v_subject_id uuid;
  matches integer;
  v_student_id uuid;
  v_admission_no text;
  v_roll_no text;
  v_next_admission bigint;
  v_next_roll bigint;
  normalized_name text;
  name_parts text[];
  name_count integer;
begin
  if actor_id is null then raise exception 'Authentication required.'; end if;
  normalized_name := btrim(regexp_replace(coalesce(p_full_name,''),'[[:space:]]+',' ','g'));
  if normalized_name='' then raise exception 'Student name is required.'; end if;
  if length(normalized_name)>1000 then raise exception 'Student name is too long.'; end if;
  perform 1 from public.profiles p where p.id=actor_id and p.is_active for share;
  if not found then raise exception 'An active school profile is required.'; end if;

  matches:=0;
  for teacher_record in select t.id,t.school_id from public.teachers t
    where t.profile_id=actor_id order by t.id for share
  loop
    matches:=matches+1; v_teacher_id:=teacher_record.id; v_school_id:=teacher_record.school_id;
  end loop;
  if matches<>1 then raise exception 'Exactly one linked teacher context is required.'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id
    and ur.school_id=v_school_id and ur.role='teacher'::public.app_role for share;
  if not found then raise exception 'Teacher access is required for this school.'; end if;

  matches:=0;
  for year_record in select y.id from public.academic_years y
    where y.school_id=v_school_id and y.is_current order by y.id for share
  loop matches:=matches+1; v_year_id:=year_record.id; end loop;
  if matches<>1 then raise exception 'Exactly one current academic year is required.'; end if;

  matches:=0;
  for assignment_record in select a.* from public.teacher_subject_assignments a
    where a.teacher_id=v_teacher_id and a.academic_year_id=v_year_id and a.is_class_teacher
    order by a.id for share
  loop
    matches:=matches+1; v_class_id:=assignment_record.class_id;
    v_section_id:=assignment_record.section_id; v_subject_id:=assignment_record.subject_id;
  end loop;
  if matches<>1 or not app_private.assignment_scope_is_coherent(v_teacher_id,v_year_id,
    v_class_id,v_section_id,v_subject_id,true) then
    raise exception 'One approved, coherent class-teacher section is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_school_id::text || ':student-register'));
  select coalesce(max(substring(upper(btrim(s.admission_no)) from 'KC-ST-([0-9]+)')::bigint),0)+1
    into v_next_admission from public.students s
    where s.school_id=v_school_id and upper(btrim(s.admission_no)) ~ '^KC-ST-[0-9]+$';
  v_admission_no:='KC-ST-' || lpad(v_next_admission::text,greatest(3,length(v_next_admission::text)),'0');
  select coalesce(max(e.roll_no::bigint),0)+1 into v_next_roll from public.enrollments e
    where e.academic_year_id=v_year_id and e.class_id=v_class_id
      and e.section_id is not distinct from v_section_id and e.roll_no ~ '^[0-9]+$';
  v_roll_no:=v_next_roll::text;
  name_parts:=string_to_array(normalized_name,' '); name_count:=array_length(name_parts,1);
  insert into public.students(school_id,admission_no,roll_no,first_name,middle_name,last_name,admission_date,status)
    values(v_school_id,v_admission_no,v_roll_no,name_parts[1],
      case when name_count>2 then array_to_string(name_parts[2:(name_count-1)],' ') else null end,
      case when name_count>1 then name_parts[name_count] else null end,
      (current_timestamp at time zone 'Asia/Kolkata')::date,'active')
    returning id into v_student_id;
  insert into public.enrollments(student_id,academic_year_id,class_id,section_id,roll_no,status)
    values(v_student_id,v_year_id,v_class_id,v_section_id,v_roll_no,'active');
  return query select v_student_id,v_admission_no,v_roll_no,v_class_id,v_section_id;
end;
$function$;
revoke all on function public.register_student_for_class_teacher(text) from public,anon,authenticated;
grant execute on function public.register_student_for_class_teacher(text) to authenticated,service_role;

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

revoke all on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.import_roster_students(uuid, uuid, uuid, uuid, uuid, jsonb)
  to authenticated;


notify pgrst, 'reload schema';
commit;
